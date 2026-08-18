/**
 * background.js — Service worker for TTS Reader Chrome extension.
 *
 * Orchestrates the TTS pipeline:
 *   1. Receives messages from popup, context menu, or content script.
 *   2. Extracts text from the active tab via content script.
 *   3. Segments the text.
 *   4. Synthesizes segments using the configured TTS provider.
 *   5. Sends audio to the popup page for playback.
 *
 * Audio playback happens in the extension's POPUP page (popup.html),
 * not in an offscreen document. Offscreen documents are aggressively
 * throttled by Chrome (timers clamped to 1 minute, no user gesture,
 * AudioContext cannot be resumed without interaction), which caused
 * the "background playback keeps breaking" bug. The popup page is a
 * normal extension page with full audio playback capability.
 *
 * The popup is opened automatically when a reading session starts, via
 * chrome.action.openPopup() (Chrome 120+, works when triggered by a user
 * gesture such as a context-menu click). If the user closes the popup,
 * playback stops and the session is cleaned up.
 *
 * User controls playback via right-click context menu:
 *   "Read Page" / "Read Selection" / "Pause" / "Resume" / "Skip" / "Stop"
 */

// Import the TTS engine and segmenter
importScripts("segmenter.js", "ttsEngine.js");

// ─── State ──────────────────────────────────────────────────────────────────

let currentSession = null;
/**
 * {
 *   segments: Segment[],
 *   currentIndex: number,
 *   ttsOpts: object,
 *   status: "idle" | "synthesizing" | "playing" | "paused" | "stopped",
 *   audioBuffers: Map<number, string>,  // cached audio (base64)
 *   inFlight: Map<number, Promise>,
 *   sourceLabel: string,
 * }
 */

/**
 * Monotonically increasing generation counter. Bumped on every stop /
 * start so that:
 *   - queued "play" messages from an old session are dropped by the
 *     popup (it ignores play messages with an older generation than
 *     its last stop),
 *   - stale "segmentEnded" / "playError" messages are ignored here.
 */
let sessionGeneration = 0;

/**
 * Heartbeat timer. While a session is active, the background pings the
 * popup every 3s. If the ping fails (popup was closed by the user),
 * the session is stopped. Without this, the session state stays
 * "playing" forever even though the audio is gone.
 */
let heartbeatTimer = null;

// ─── Default settings ───────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  provider: "edge-tts",
  voice: "en-US-AvaMultilingualNeural",
  rate: "+0%",
  volume: "+0%",
  pitch: "+0Hz",
  maxSegmentChars: 180,
  minSegmentChars: 20,
  segmentMode: "smart",
  preloadSegments: 2,
  playbackRate: 1.0,
  apiUrl: "",
  apiKey: "",
  model: "",
  trustedClientToken: "",
};

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

// ─── Popup document management ──────────────────────────────────────────────
//
// Audio playback happens in the extension's POPUP page (popup.html), not
// in an offscreen document. This is deliberate: offscreen documents are
// aggressively throttled by Chrome (timers clamped to 1 minute, no user
// gesture, AudioContext cannot be resumed without interaction), which
// caused the "background playback keeps breaking" bug. The popup page is
// a normal extension page: it has full audio playback capability and is
// not throttled while open.
//
// The popup is opened automatically when a reading session starts, via
// chrome.action.openPopup() (Chrome 120+, works when triggered by a user
// gesture such as a context-menu click). If the user closes the popup,
// playback stops and the session is cleaned up.

let popupReady = false;

/**
 * Open the popup page so it can host audio playback.
 *
 * chrome.action.openPopup() only works when called from a user gesture
 * (context menu click, action click). It is a no-op otherwise. We call
 * it fire-and-forget: if it fails (e.g. called from a non-gesture
 * context), the user can open the popup manually.
 */
async function ensurePopup() {
  try {
    await chrome.action.openPopup();
    popupReady = true;
  } catch (e) {
    // openPopup failed — the popup may already be open, or the call was
    // not from a user gesture. Ping to check if it's reachable.
    console.warn("[background] openPopup failed:", e.message);
    popupReady = await pingPopup(2000);
  }
}

/**
 * Ping the popup to check if it's open and responsive.
 * Returns true if the popup responds to a ping within timeoutMs.
 */
function pingPopup(timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    chrome.runtime.sendMessage({ type: "ping" }, (resp) => {
      if (chrome.runtime.lastError) {
        // No receiving end (popup closed) — keep polling briefly.
        if (Date.now() - start > timeoutMs) {
          resolve(false);
        } else {
          setTimeout(() => pingPopup(timeoutMs - (Date.now() - start)).then(resolve), 200);
        }
      } else if (resp && resp.ok) {
        resolve(true);
      } else {
        if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(() => pingPopup(timeoutMs - (Date.now() - start)).then(resolve), 200);
      }
    });
  });
}

/**
 * Send a message to the popup. Retries up to 3 times with increasing
 * delays if the popup is not ready.
 */
async function sendToPopup(msg) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(resp);
        });
      });
      popupReady = true;
      return;
    } catch (e) {
      if (e.message && e.message.includes("Receiving end does not exist")) {
        const delay = 300 * (attempt + 1);
        console.warn(`[background] Popup not ready, retrying in ${delay}ms (attempt ${attempt + 1})`);
        await new Promise((r) => setTimeout(r, delay));
        if (attempt === 1) {
          await ensurePopup();
        }
      } else {
        console.warn("[background] Popup message failed:", e.message);
        return;
      }
    }
  }
  console.warn("[background] Popup message failed after 3 attempts");
}

/**
 * Close the popup (when idle). The popup detects its own close via
 * the "pagehide" event and cleans up its audio.
 */
async function closePopup() {
  stopHeartbeat();
  popupReady = false;
  // We cannot programmatically close the popup. The user closes it, or
  // it closes when the browser window loses focus. We just stop the
  // heartbeat and mark it as not ready.
}

// ─── Heartbeat ──────────────────────────────────────────────────────────────

/**
 * Start the heartbeat: ping the popup every 3s while a session is active.
 * If the ping fails (popup was closed by the user), the session is
 * stopped — the user can restart reading by clicking the context menu
 * again.
 */
function startHeartbeat() {
  stopHeartbeat();
  let consecutiveFailures = 0;
  heartbeatTimer = setInterval(async () => {
    if (!currentSession) {
      stopHeartbeat();
      return;
    }
    try {
      const ok = await pingPopup(2000);
      if (ok) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        if (consecutiveFailures >= 2) {
          console.warn("[background] Popup closed — stopping session");
          consecutiveFailures = 0;
          await stopSession();
        }
      }
    } catch (e) {
      consecutiveFailures++;
      if (consecutiveFailures >= 2) {
        console.warn(`[background] Heartbeat failed ${consecutiveFailures}x — popup is gone. Stopping.`);
        consecutiveFailures = 0;
        await stopSession();
      }
    }
  }, 3000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ─── Synthesis ──────────────────────────────────────────────────────────────

/**
 * Synthesize a single segment and return the audio as a base64 string.
 */
async function synthesizeSegmentBase64(text, ttsOpts) {
  const audio = await synthesizeSegment(text, ttsOpts);
  const bytes = new Uint8Array(audio);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

// ─── Session management ─────────────────────────────────────────────────────

/**
 * Start a new reading session.
 */
async function startReading(text, sourceLabel) {
  if (!text || !text.trim()) {
    return { error: "No text to read" };
  }

  // Stop any existing session
  await stopSession();

  const settings = await getSettings();

  // Segment the text
  const segments = segmentText(text, {
    mode: settings.segmentMode,
    maxChars: settings.maxSegmentChars,
    minChars: settings.minSegmentChars,
  });

  if (segments.length === 0) {
    return { error: "No readable text found" };
  }

  // Build TTS options
  const ttsOpts = {
    provider: settings.provider,
    voice: settings.voice,
    rate: settings.rate,
    volume: settings.volume,
    pitch: settings.pitch,
    apiUrl: settings.apiUrl || undefined,
    apiKey: settings.apiKey || undefined,
    model: settings.model || undefined,
    trustedClientToken: settings.trustedClientToken || undefined,
  };

  // Create session
  sessionGeneration++;
  currentSession = {
    segments,
    currentIndex: 0,
    ttsOpts,
    status: "synthesizing",
    audioBuffers: new Map(),
    inFlight: new Map(),
    sourceLabel,
    generation: sessionGeneration,
  };

  // Synthesize first segment (before the popup opens, so a synthesis
  // failure does not leave a popup open with nothing to play)
  let firstAudio;
  try {
    firstAudio = await synthesizeSegmentBase64(segments[0].text, ttsOpts);
  } catch (err) {
    currentSession = null;
    updateBadge();
    return { error: `Synthesis failed: ${err.message}` };
  }

  // Ensure the popup is open and ready (it hosts audio playback).
  await ensurePopup();
  currentSession.audioBuffers.set(0, firstAudio);

  try {
    currentSession.status = "playing";

    // Apply the client-side playback speed multiplier
    if (settings.playbackRate && settings.playbackRate !== 1.0) {
      await sendToPopup({ type: "setRate", rate: settings.playbackRate });
    }

    // Start playback. The popup plays segments strictly in
    // order; the background reports segmentEnded for each one.
    await playSegment(0);

    // Start the heartbeat to detect if the user closes the popup
    // while the session is active.
    startHeartbeat();

    updateBadge();
    return {
      ok: true,
      segments: segments.length,
      source: sourceLabel,
      provider: settings.provider,
      voice: settings.voice,
      firstSegment: segments[0],
    };
  } catch (err) {
    currentSession.status = "stopped";
    currentSession = null;
    stopHeartbeat();
    updateBadge();
    return { error: `Synthesis failed: ${err.message}` };
  }
}

/**
 * Play a segment: resolve its audio (cache → in-flight → fresh
 * synthesis), send it to the popup. The popup plays segments strictly
 * in order, so the next segment is only sent after the current one
 * ends (via the segmentEnded handler).
 *
 * Called from:
 *   - startReading (first segment)
 *   - segmentEnded / playError (next segment)
 *   - skipSegment (skipped-to segment)
 *
 * The segment plays as soon as its own audio is ready — it never waits
 * for the buffer to fill.
 */
async function playSegment(index) {
  const session = currentSession;
  if (!session || index >= session.segments.length) {
    return;
  }
  const { segments, ttsOpts, audioBuffers, inFlight } = session;
  const total = segments.length;

  let audio;
  try {
    if (audioBuffers.has(index)) {
      audio = audioBuffers.get(index);
    } else if (inFlight.has(index)) {
      audio = await inFlight.get(index);
      if (currentSession === session) {
        audioBuffers.set(index, audio);
        inFlight.delete(index);
      }
    } else {
      // Synthesize on demand
      if (currentSession === session) {
        session.status = "synthesizing";
        updateBadge();
      }
      audio = await synthesizeSegmentBase64(segments[index].text, ttsOpts);
      if (currentSession === session) {
        audioBuffers.set(index, audio);
        session.status = "playing";
        updateBadge();
      }
    }
  } catch (err) {
    console.warn(`[background] Synthesis failed for segment ${index + 1}: ${err.message}`);
    // Skip the bad segment and continue with the next one.
    if (currentSession === session) {
      session.currentIndex++;
      if (session.currentIndex < total) {
        void playSegment(session.currentIndex);
      }
    }
    return;
  }

  // A session that ended (or was skipped) while we were resolving this
  // segment must not send a stale "play" message. The generation check
  // catches both stopSession and skipSegment (which bump the generation).
  if (currentSession !== session || session.generation !== sessionGeneration) {
    return;
  }

  // Send the segment to the popup.
  await sendToPopup({
    type: "play",
    audio,
    index,
    total,
    generation: session.generation,
  });

  // Look-ahead: start synthesizing the next segment in the background
  // so it's ready when the current one ends (no gap between segments).
  const nextIndex = index + 1;
  if (nextIndex < total && !audioBuffers.has(nextIndex) && !inFlight.has(nextIndex)) {
    void synthesizeAndCache(nextIndex, session);
  }
}

/**
 * Synthesize a segment and cache its audio. Called as a look-ahead from
 * playSegment so the next segment is ready when the current one ends.
 */
async function synthesizeAndCache(index, session) {
  if (currentSession !== session) return;
  const { segments, ttsOpts, audioBuffers, inFlight } = session;
  if (index < 0 || index >= segments.length) return;
  if (audioBuffers.has(index) || inFlight.has(index)) return;

  const p = synthesizeSegmentBase64(segments[index].text, ttsOpts)
    .then((audio) => {
      if (currentSession === session) {
        session.audioBuffers.set(index, audio);
        session.inFlight.delete(index);
      }
    })
    .catch((err) => {
      if (currentSession === session) {
        session.inFlight.delete(index);
      }
    });
  inFlight.set(index, p);
}

/**
 * Skip to the next segment.
 *
 * Bumping the session generation invalidates every "play" message that
 * was queued for the current segment (the popup drops them),
 * so the skip is clean: only the new segment and its buffer play.
 */
async function skipSegment() {
  if (!currentSession) return { error: "No active session" };
  const session = currentSession;
  const total = session.segments.length;
  if (session.currentIndex >= total) {
    return { ok: true, currentIndex: session.currentIndex, total, done: true };
  }
  const wasLast = session.currentIndex >= total - 1;
  session.currentIndex++;
  sessionGeneration++;
  session.generation = sessionGeneration;

  // Drop the current segment and any queued segments of the old session
  await sendToPopup({ type: "stop", generation: session.generation });

  if (!wasLast && currentSession === session) {
    // Start the new segment (and its buffer)
    void playSegment(session.currentIndex);
  }
  updateBadge();
  return {
    ok: true,
    currentIndex: session.currentIndex,
    total,
    done: wasLast,
  };
}

/**
 * Stop the current session.
 *
 * Bumping the session generation invalidates every queued "play" message
 * (the popup drops them) and every in-flight preload result
 * (preloadSegment only caches into the active session).
 */
async function stopSession() {
  if (currentSession) {
    currentSession.status = "stopped";
    sessionGeneration++;
    currentSession.generation = sessionGeneration;
    currentSession = null;
  }
  stopHeartbeat();
  await sendToPopup({ type: "stop", generation: sessionGeneration });
  updateBadge();
  setTimeout(closePopup, 2000);
  return { ok: true };
}

/**
 * Pause playback.
 */
async function pausePlayback() {
  if (currentSession && currentSession.status === "playing") {
    currentSession.status = "paused";
    await sendToPopup({ type: "pause" });
    updateBadge();
    return { ok: true };
  }
  return { error: "Not playing" };
}

/**
 * Resume playback.
 */
async function resumePlayback() {
  if (currentSession && currentSession.status === "paused") {
    currentSession.status = "playing";
    await sendToPopup({ type: "resume" });
    updateBadge();
    return { ok: true };
  }
  return { error: "Not paused" };
}

/**
 * Get the current session status.
 */
function getSessionStatus() {
  if (!currentSession) {
    return { status: "idle" };
  }
  return {
    status: currentSession.status,
    currentIndex: currentSession.currentIndex,
    total: currentSession.segments.length,
    source: currentSession.sourceLabel,
    provider: currentSession.ttsOpts.provider,
    voice: currentSession.ttsOpts.voice,
  };
}

// ─── Badge ──────────────────────────────────────────────────────────────────

function updateBadge() {
  if (!currentSession) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }
  switch (currentSession.status) {
    case "playing":
      chrome.action.setBadgeText({ text: "▶" });
      chrome.action.setBadgeBackgroundColor({ color: "#4caf50" });
      break;
    case "paused":
      chrome.action.setBadgeText({ text: "⏸" });
      chrome.action.setBadgeBackgroundColor({ color: "#ff9800" });
      break;
    case "synthesizing":
      chrome.action.setBadgeText({ text: "..." });
      chrome.action.setBadgeBackgroundColor({ color: "#2196f3" });
      break;
    default:
      chrome.action.setBadgeText({ text: "" });
  }
}

// ─── Context menu ───────────────────────────────────────────────────────────

function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "tts-read-page",
      title: "🔊 Read This Page",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: "tts-read-selection",
      title: "🔊 Read Selection",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "tts-separator",
      type: "separator",
      contexts: ["page", "selection"],
    });
    chrome.contextMenus.create({
      id: "tts-pause",
      title: "⏸ Pause TTS",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: "tts-resume",
      title: "▶ Resume TTS",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: "tts-skip",
      title: "⏭ Skip Segment",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: "tts-stop",
      title: "⏹ Stop TTS",
      contexts: ["page"],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  switch (info.menuItemId) {
    case "tts-read-page": {
      // Extract full page text
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: "extractPage" });
        if (response && response.text) {
          startReading(response.text, "Page").then((r) => r && r.error && console.warn("[background]", r.error));
        } else {
          // Fallback: try selection
          const sel = await chrome.tabs.sendMessage(tab.id, { type: "extractSelection" });
          if (sel && sel.text) {
            startReading(sel.text, "Selection").then((r) => r && r.error && console.warn("[background]", r.error));
          }
        }
      } catch {
        // Content script not available
      }
      break;
    }
    case "tts-read-selection": {
      if (info.selectionText) {
        startReading(info.selectionText, "Selection").then((r) => r && r.error && console.warn("[background]", r.error));
      }
      break;
    }
    case "tts-pause":
      await pausePlayback();
      break;
    case "tts-resume":
      await resumePlayback();
      break;
    case "tts-skip":
      await skipSegment();
      break;
    case "tts-stop":
      await stopSession();
      break;
  }
});

// ─── Message handling ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "startReading": {
      startReading(message.text, message.sourceLabel || "page").then(sendResponse);
      return true;
    }
    case "skipSegment":
      skipSegment().then(sendResponse);
      return true;
    case "stopSession":
      stopSession().then(sendResponse);
      return true;
    case "pausePlayback":
      pausePlayback().then(sendResponse);
      return true;
    case "resumePlayback":
      resumePlayback().then(sendResponse);
      return true;
    case "getSessionStatus":
      sendResponse(getSessionStatus());
      break;
    case "getSettings":
      getSettings().then(sendResponse);
      return true;
    case "segmentEnded": {
      // From the popup: a segment finished playing.
      if (
        currentSession &&
        message.index === currentSession.currentIndex &&
        message.generation === currentSession.generation
      ) {
        currentSession.currentIndex++;
        if (currentSession.currentIndex >= currentSession.segments.length) {
          // All segments done
          currentSession.status = "idle";
          currentSession = null;
          stopHeartbeat();
          updateBadge();
          setTimeout(closePopup, 2000);
        } else {
          // Queue the next segment
          void playSegment(currentSession.currentIndex);
        }
      }
      sendResponse({ ok: true });
      break;
    }
    case "playError": {
      // A segment failed to play in the popup.
      console.warn("[background] Playback error:", message.error);
      if (
        currentSession &&
        message.index === currentSession.currentIndex &&
        message.generation === currentSession.generation
      ) {
        currentSession.currentIndex++;
        if (currentSession.currentIndex < currentSession.segments.length) {
          void playSegment(currentSession.currentIndex);
        }
      }
      sendResponse({ ok: true });
      break;
    }
    default:
      sendResponse({ error: "Unknown message type" });
  }
});

// ─── Init ───────────────────────────────────────────────────────────────────

createContextMenu();
chrome.action.setBadgeText({ text: "" });

// Surface unhandled promise rejections instead of swallowing them
// (e.g. a failed chrome.storage call must not crash the worker silently).
self.addEventListener("unhandledrejection", (event) => {
  console.error("[background] Unhandled promise rejection:", event.reason);
});
