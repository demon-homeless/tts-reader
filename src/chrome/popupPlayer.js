/**
 * popupPlayer.js — Audio playback for the TTS Reader popup.
 *
 * The popup page hosts audio playback. This is a deliberate choice:
 * offscreen documents are aggressively throttled by Chrome (timers
 * clamped to 1 minute, no user gesture, AudioContext cannot be resumed
 * without interaction), which caused the "background playback keeps
 * breaking" bug. The popup page is a normal extension page: it has full
 * audio playback capability and is not throttled while open.
 *
 * The background service worker sends "play" messages with base64 audio.
 * This module decodes the audio into an <audio> element and plays it.
 * When the segment ends, it sends "segmentEnded" back to the background.
 *
 * Messages handled (from background):
 *   { type: "play", audio: base64, index, total, generation }
 *   { type: "pause" }
 *   { type: "resume" }
 *   { type: "stop", generation }
 *   { type: "setRate", rate: number }
 *   { type: "ping" }
 *
 * Messages sent (to background):
 *   { type: "segmentEnded", index, generation }
 *   { type: "playError", error: string, index, generation }
 */

let audioElement = null;
let isPlaying = false;
let isPaused = false;
let playbackRate = 1.0;
let currentGeneration = -1;

// ─── Message handling ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "play":
      onPlay(msg);
      sendResponse({ ok: true });
      break;
    case "pause":
      onPause();
      sendResponse({ ok: true });
      break;
    case "resume":
      onResume();
      sendResponse({ ok: true });
      break;
    case "stop":
      onStop(msg);
      sendResponse({ ok: true });
      break;
    case "setRate":
      playbackRate = msg.rate || 1.0;
      if (audioElement) {
        audioElement.playbackRate = playbackRate;
      }
      sendResponse({ ok: true });
      break;
    case "ping":
      sendResponse({
        ok: true,
        playing: isPlaying,
        paused: isPaused,
        hasElement: !!audioElement,
      });
      break;
    default:
      sendResponse({ error: "Unknown message type" });
  }
});

// ─── Audio playback ─────────────────────────────────────────────────────────

/**
 * Play a single segment using an <audio> element.
 *
 * <audio> elements work in the popup without the AudioContext suspend
 * issue that affects offscreen documents. The popup is a normal extension
 * page with full audio playback capability.
 */
async function onPlay({ audio, index, total, generation }) {
  // A "play" message from a different generation than the one currently
  // active is stale. Drop it.
  if (generation !== undefined && generation !== currentGeneration && currentGeneration !== -1) {
    return;
  }
  // Sync the generation on the first message of a new session
  if (generation !== undefined && generation !== currentGeneration) {
    currentGeneration = generation;
  }

  // If a segment is already playing, ignore this message.
  if (isPlaying) {
    return;
  }

  try {
    // Create or reuse the audio element
    if (!audioElement) {
      audioElement = new Audio();
      audioElement.preload = "auto";
    }

    // Decode base64 → Blob → object URL
    const binaryString = atob(audio);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: "audio/mpeg" });
    const objectUrl = URL.createObjectURL(blob);

    // Set up the audio element
    audioElement.src = objectUrl;
    audioElement.playbackRate = playbackRate;
    isPlaying = true;
    isPaused = false;

    // Wait for the audio to end or error
    await new Promise((resolve) => {
      let settled = false;
      const finish = (wasError, errMsg) => {
        if (settled) return;
        settled = true;
        audioElement.removeEventListener("ended", onEnded);
        audioElement.removeEventListener("error", onError);
        URL.revokeObjectURL(objectUrl);
        isPlaying = false;
        if (wasError) {
          console.warn(`[popupPlayer] audio error for segment ${index}:`, errMsg);
          chrome.runtime
            .sendMessage({ type: "playError", error: errMsg || "audio playback error", index, generation })
            .catch(() => {});
        } else if (generation === currentGeneration) {
          chrome.runtime
            .sendMessage({ type: "segmentEnded", index, generation })
            .catch(() => {});
        }
        resolve();
      };

      const onEnded = () => finish(false);
      const onError = () => finish(true, "audio element error");

      audioElement.addEventListener("ended", onEnded, { once: true });
      audioElement.addEventListener("error", onError, { once: true });

      // Play the audio
      audioElement.play().catch((err) => {
        console.warn(`[popupPlayer] play() rejected for segment ${index}:`, err.message);
        finish(true, err.message);
      });
    });
  } catch (err) {
    console.warn(`[popupPlayer] play failed for segment ${index}:`, err.message);
    isPlaying = false;
    if (audioElement) {
      try { audioElement.pause(); } catch { /* ignore */ }
    }
    chrome.runtime
      .sendMessage({ type: "playError", error: err.message, index, generation })
      .catch(() => {});
  }
}

function onPause() {
  isPaused = true;
  if (audioElement) {
    audioElement.pause();
  }
}

function onResume() {
  isPaused = false;
  if (audioElement) {
    audioElement.play().catch(() => {});
  }
}

/**
 * Stop playback. The generation parameter becomes the new currentGeneration,
 * so any subsequent "play" message from an older session is dropped.
 */
function onStop({ generation } = {}) {
  if (generation !== undefined) {
    currentGeneration = generation;
  }
  if (audioElement) {
    try {
      audioElement.pause();
      audioElement.currentTime = 0;
    } catch { /* ignore */ }
  }
  isPlaying = false;
  isPaused = false;
}

// Clean up the audio element when the popup is closed.
window.addEventListener("pagehide", () => {
  if (audioElement) {
    try {
      audioElement.pause();
      audioElement.src = "";
    } catch { /* ignore */ }
    audioElement = null;
  }
  isPlaying = false;
  isPaused = false;
});
