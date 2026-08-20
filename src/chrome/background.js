/**
 * background.js — Service worker for TTS Reader Chrome extension.
 *
 * Orchestrates the TTS pipeline:
 *   1. Receives messages from popup, context menu, or content script.
 *   2. Extracts text from the active tab via content script.
 *   3. Segments the text.
 *   4. Synthesizes segments using the configured TTS provider.
 *   5. Sends audio to the content script in the active tab for playback.
 *
 * Audio playback happens in the CONTENT SCRIPT (injected <audio> element
 * in the user's active tab). This avoids:
 *   - Popup: closes on focus loss, requires user gesture to open
 *   - Offscreen document: chrome.offscreen API can block the SW event loop
 *   - Background tab: extra tab is intrusive, may be throttled
 *
 * The content script creates a hidden <audio> element and plays segments
 * as they arrive. If the user navigates away, the audio stops and the
 * background detects this via heartbeat and cleans up.
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
 *   tabId: number,          // tab where playback is happening
 * }
 */

/**
 * Monotonically increasing generation counter. Bumped on every stop /
 * start so that:
 *   - queued "play" messages from an old session are dropped by the
 *     content script (it ignores play messages with an older generation),
 *   - stale "segmentEnded" / "playError" messages are ignored here.
 */
let sessionGeneration = 0;

/**
 * Heartbeat timer. While a session is active, the background pings the
 * content script every 3s. If the ping fails (tab was closed or navigated),
 * the session is stopped.
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
  proxyUrl: "",
};

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

// ─── Content script messaging ───────────────────────────────────────────────
//
// Audio playback happens in the content script's <audio> element.
// All messages are sent to a specific tab via chrome.tabs.sendMessage.
// Every send is wrapped with a timeout to prevent the service worker
// from hanging if the tab becomes unresponsive.

/** Timeout for a single chrome.tabs.sendMessage (ms). */
const MSG_TIMEOUT = 5000;

/**
 * Send a message to the content script in a specific tab, with a timeout.
 * Resolves with the response, or rejects on timeout / error.
 */
function sendToTab(tabId, msg, timeoutMs = MSG_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("Tab message timed out"));
      }
    }, timeoutMs);

    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(resp);
          }
        }
      });
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    }
  });
}

/**
 * Ping the content script to check if it's alive and responsive.
 */
async function pingTab(tabId, timeoutMs = 3000) {
  try {
    const resp = await sendToTab(tabId, { type: "ttsPing" }, timeoutMs);
    return !!(resp && resp.ok);
  } catch (e) {
    return false;
  }
}

// ─── Heartbeat ──────────────────────────────────────────────────────────────

function startHeartbeat() {
  stopHeartbeat();
  let consecutiveFailures = 0;
  heartbeatTimer = setInterval(async () => {
    if (!currentSession) {
      stopHeartbeat();
      return;
    }
    try {
      const ok = await pingTab(currentSession.tabId, 2000);
      if (ok) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        if (consecutiveFailures >= 2) {
          console.warn("[background] Tab gone — stopping session");
          consecutiveFailures = 0;
          await stopSession();
        }
      }
    } catch (e) {
      consecutiveFailures++;
      if (consecutiveFailures >= 2) {
        console.warn(`[background] Heartbeat failed ${consecutiveFailures}x — stopping.`);
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
async function startReading(text, sourceLabel, tabId) {
  if (!text || !text.trim()) {
    return { error: "No text to read" };
  }

  // Stop any existing session
  await stopSession();

  const settings = await getSettings();

  // Determine the target tab. If not provided, use the active tab.
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      return { error: "No active tab found" };
    }
    tabId = tab.id;
  }

  // Verify the content script is alive in the target tab
  const alive = await pingTab(tabId, 3000);
  if (!alive) {
    return { error: "Content script not available in this tab. Try reloading the page." };
  }

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
    proxyUrl: settings.proxyUrl || undefined,
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
    tabId,
    generation: sessionGeneration,
  };

  // Synthesize first segment
  let firstAudio;
  try {
    firstAudio = await synthesizeSegmentBase64(segments[0].text, ttsOpts);
  } catch (err) {
    currentSession = null;
    updateBadge();
    return { error: `Synthesis failed: ${err.message}` };
  }

  currentSession.audioBuffers.set(0, firstAudio);

  try {
    currentSession.status = "playing";

    // Apply the client-side playback speed multiplier
    if (settings.playbackRate && settings.playbackRate !== 1.0) {
      await sendToTab(tabId, { type: "ttsSetRate", rate: settings.playbackRate });
    }

    // Start playback
    await playSegment(0);

    // Start the heartbeat to detect if the tab is closed/navigated
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
    return { error: `Playback failed: ${err.message}` };
  }
}

/**
 * Play a segment: resolve its audio (cache → in-flight → fresh
 * synthesis), send it to the content script.
 */
async function playSegment(index) {
  const session = currentSession;
  if (!session || index >= session.segments.length) {
    return;
  }
  const { segments, ttsOpts, audioBuffers, inFlight, tabId } = session;
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
    if (currentSession === session) {
      session.currentIndex++;
      if (session.currentIndex < total) {
        void playSegment(session.currentIndex);
      }
    }
    return;
  }

  // Generation check: drop stale segments
  if (currentSession !== session || session.generation !== sessionGeneration) {
    return;
  }

  // Send the segment to the content script.
  try {
    await sendToTab(tabId, {
      type: "ttsPlay",
      audio,
      index,
      total,
      generation: session.generation,
    });
  } catch (e) {
    console.warn(`[background] Failed to send segment ${index + 1}: ${e.message}`);
    return;
  }

  // Look-ahead: start synthesizing the next segment
  const nextIndex = index + 1;
  if (nextIndex < total && !audioBuffers.has(nextIndex) && !inFlight.has(nextIndex)) {
    void synthesizeAndCache(nextIndex, session);
  }
}

/**
 * Synthesize a segment and cache its audio (look-ahead).
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
    .catch(() => {
      if (currentSession === session) {
        session.inFlight.delete(index);
      }
    });
  inFlight.set(index, p);
}

/**
 * Skip to the next segment.
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

  // Drop the current segment
  try {
    await sendToTab(session.tabId, { type: "ttsStop", generation: session.generation });
  } catch (e) {
    console.warn("[background] skipSegment stop failed:", e.message);
  }

  if (!wasLast && currentSession === session) {
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
 * Read clipboard text and start a new session.
 */
async function readClipboard(tabId) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const targetTabId = tabId || (tab && tab.id);
    if (!targetTabId) return { error: "No active tab" };

    // Request clipboard text from the content script (which has the
    // page's context and can use the Clipboard API with user gesture).
    const resp = await sendToTab(targetTabId, { type: "readClipboard" });
    if (resp && resp.text) {
      return await startReading(resp.text, "clipboard", targetTabId);
    }
    return { error: "Clipboard is empty or unreadable" };
  } catch (e) {
    return { error: `Clipboard read failed: ${e.message}` };
  }
}

/**
 * Show the voice list (opens options page scrolled to voice section).
 */
function showVoiceList() {
  chrome.tabs.create({ url: chrome.runtime.getURL("options.html#voices") });
}

/**
 * Clean up cached audio buffers from the current session.
 */
function cleanupTempFiles() {
  if (currentSession) {
    const count = currentSession.audioBuffers.size;
    currentSession.audioBuffers.clear();
    currentSession.inFlight.clear();
    return { ok: true, count };
  }
  return { ok: true, count: 0 };
}

/**
 * Stop the current session.
 */
async function stopSession() {
  const hadSession = !!currentSession;
  if (currentSession) {
    currentSession.status = "stopped";
    sessionGeneration++;
    currentSession.generation = sessionGeneration;
    const tabId = currentSession.tabId;
    currentSession = null;

    stopHeartbeat();

    // Tell the content script to stop playback
    try {
      await sendToTab(tabId, { type: "ttsStop", generation: sessionGeneration });
    } catch (e) {
      // Tab may already be gone — ignore.
    }
  } else {
    stopHeartbeat();
  }

  updateBadge();
  return { ok: true };
}

/**
 * Pause playback.
 */
async function pausePlayback() {
  if (currentSession && currentSession.status === "playing") {
    currentSession.status = "paused";
    try {
      await sendToTab(currentSession.tabId, { type: "ttsPause" });
    } catch (e) {
      console.warn("[background] pause failed:", e.message);
    }
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
    try {
      await sendToTab(currentSession.tabId, { type: "ttsResume" });
    } catch (e) {
      console.warn("[background] resume failed:", e.message);
    }
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
  // Also update the context menu to reflect the new state
  updateContextMenu();
}

// ─── Context menu ───────────────────────────────────────────────────────────

/**
 * Rebuild the context menu based on current session state.
 *
 * Chrome's contextMenus API doesn't support show/hide, so we rebuild
 * the menu on every state change:
 *   - Idle:    "Read This Page"
 *   - Playing: "Stop Reading"
 *
 * "Read Selection" is handled by Chrome's "selection" context — it only
 * appears when the user has selected text, so no state management needed.
 */
function updateContextMenu() {
  chrome.contextMenus.removeAll(() => {
    // Selection context — Chrome shows this only when text is selected.
    chrome.contextMenus.create({
      id: "tts-read-selection",
      title: chrome.i18n.getMessage("menuReadSelection"),
      contexts: ["selection"],
      icons: { "16": "icons/icon16.png", "32": "icons/icon48.png" },
    });

    if (currentSession && currentSession.status !== "idle") {
      // Playing / paused / synthesizing → show Stop
      chrome.contextMenus.create({
        id: "tts-stop",
        title: chrome.i18n.getMessage("menuStop"),
        contexts: ["page"],
        icons: { "16": "icons/icon16.png", "32": "icons/icon48.png" },
      });
    } else {
      // Idle → show Read This Page
      chrome.contextMenus.create({
        id: "tts-read-page",
        title: chrome.i18n.getMessage("menuReadPage"),
        contexts: ["page"],
        icons: { "16": "icons/icon16.png", "32": "icons/icon48.png" },
      });
    }
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  switch (info.menuItemId) {
    case "tts-read-page": {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: "extractPage" });
        if (response && response.text) {
          startReading(response.text, "Page", tab.id).then((r) => r && r.error && console.warn("[background]", r.error));
        }
      } catch {
        // Content script not available
      }
      break;
    }
    case "tts-read-selection": {
      if (info.selectionText) {
        startReading(info.selectionText, "Selection", tab.id).then((r) => r && r.error && console.warn("[background]", r.error));
      }
      break;
    }
    case "tts-stop":
      await stopSession();
      break;
  }
});

// ─── Message handling ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "startReading": {
      // tabId comes from the sender (content script) or the message
      const tabId = message.tabId || (sender.tab && sender.tab.id);
      startReading(message.text, message.sourceLabel || "page", tabId).then(sendResponse);
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
      // From the content script: a segment finished playing.
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
        } else {
          void playSegment(currentSession.currentIndex);
        }
      }
      sendResponse({ ok: true });
      break;
    }
    case "playError": {
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
    case "playbackBlocked": {
      // CSP or other playback restriction — notify the user
      const msg = message.reason === "csp"
        ? `This site's Content Security Policy (CSP) blocks audio playback.\n\nThe page restricts which media sources are allowed (media-src directive). TTS audio cannot be played on this page.\n\nTry opening the text in a new tab or using a different page.`
        : `Audio playback is blocked: ${message.error}`;
      chrome.notifications.create("tts-blocked", {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "TTS Reader — Playback Blocked",
        message: msg,
      });
      // Stop the session since playback won't work
      if (currentSession) {
        void stopSession();
      }
      sendResponse({ ok: true });
      break;
    }
    case "readClipboard": {
      // Requested by background's readClipboard() — handled in content script
      // This case should not be reached (background sends to content script directly)
      sendResponse({ error: "Not handled in background" });
      break;
    }
    default:
      sendResponse({ error: "Unknown message type" });
  }
});

// ─── Init ───────────────────────────────────────────────────────────────────

updateContextMenu();
chrome.action.setBadgeText({ text: "" });

self.addEventListener("unhandledrejection", (event) => {
  console.error("[background] Unhandled promise rejection:", event.reason);
});
