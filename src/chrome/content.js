/**
 * content.js — Content script for TTS Reader Chrome extension.
 *
 * Two responsibilities:
 *   1. Text extraction: finds readable text on the page.
 *   2. Audio playback: hosts a hidden <audio> element that plays TTS
 *      segments sent from the background service worker.
 *
 * The <audio> element is created lazily on the first "ttsPlay" message
 * and removed when the session stops. This keeps the DOM clean when
 * TTS is not in use.
 *
 * Messages handled (from background via chrome.runtime):
 *   { type: "ttsPlay", audio: base64, index, total, generation }
 *   { type: "ttsPause" }
 *   { type: "ttsResume" }
 *   { type: "ttsStop", generation }
 *   { type: "ttsSetRate", rate }
 *   { type: "ttsPing" }
 *
 * Messages sent (to background):
 *   { type: "segmentEnded", index, generation }
 *   { type: "playError", error, index, generation }
 *
 * Messages handled (from page via window.postMessage, for CDP testing):
 *   { type: "ttsStart", text }
 *   { type: "ttsStatus" }
 *   { type: "ttsStop" }
 *   { type: "ttsPause" }
 *   { type: "ttsResume" }
 *   { type: "ttsSkip" }
 */

(function () {
  "use strict";

  // ─── Text extraction ──────────────────────────────────────────────────────

  function findMainContent() {
    const candidates = [
      "article",
      "main",
      '[role="main"]',
      "div#content",
      "div#main",
      "div.content",
      "div.main-content",
      "div.post-content",
      "div.article-content",
    ];

    for (const selector of candidates) {
      const el = document.querySelector(selector);
      if (el && el.textContent.trim().length > 100) {
        return el;
      }
    }

    let bestEl = document.body;
    let bestLength = 0;

    const allElements = document.querySelectorAll("div, article, section, main");
    for (const el of allElements) {
      const textLen = el.textContent.trim().length;
      if (textLen > bestLength && textLen < 500000) {
        if (textLen > 200) {
          bestLength = textLen;
          bestEl = el;
        }
      }
    }

    return bestEl;
  }

  function extractTextFromElement(el) {
    if (!el) return "";

    const clone = el.cloneNode(true);

    const removeSelectors = [
      "script", "style", "noscript", "nav", "footer", "header",
      "aside", "iframe", "canvas", "svg", "button", "form",
      "input", "select", "textarea",
      "[role=navigation]", "[role=banner]", "[role=complementary]",
      "[role=contentinfo]",
      "[class*='ad-']", "[class*='ads-']", "[class*='advert']",
      "[class*='sponsor']", "[class*='cookie']", "[class*='popup']",
      "[class*='modal']", "[class*='sidebar']", "[class*='comment']",
      "[id*='ad-']", "[id*='ads-']",
    ];

    for (const selector of removeSelectors) {
      const elements = clone.querySelectorAll(selector);
      elements.forEach((e) => e.remove());
    }

    let text = clone.textContent || "";
    text = text
      .replace(/[ \t]+/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return text;
  }

  function getSelectionText() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const text = sel.toString().trim();
      if (text) return text;
    }
    return "";
  }

  // ─── Audio playback ───────────────────────────────────────────────────────

  let audioElement = null;
  let isPlaying = false;
  let isPaused = false;
  let playbackRate = 1.0;
  let currentGeneration = -1;

  /**
   * Create (or reuse) the hidden <audio> element.
   */
  function ensureAudioElement() {
    if (audioElement) return audioElement;
    audioElement = new Audio();
    audioElement.preload = "auto";
    return audioElement;
  }

  /**
   * Remove the audio element and reset state.
   */
  function teardownAudio() {
    if (audioElement) {
      try {
        audioElement.pause();
        audioElement.src = "";
      } catch { /* ignore */ }
      audioElement = null;
    }
    isPlaying = false;
    isPaused = false;
  }

  /**
   * Play a base64-encoded MP3 segment.
   * Resolves when the segment ends or errors.
   */
  function playSegment({ audio, index, total, generation }) {
    // Generation check: drop messages from an older session.
    // A new session always has a HIGHER generation than the last stop,
    // so we accept generation >= currentGeneration (or first message).
    if (generation !== undefined && currentGeneration !== -1 && generation < currentGeneration) {
      return;
    }
    if (generation !== undefined && generation !== currentGeneration) {
      currentGeneration = generation;
    }

    // If already playing, ignore
    if (isPlaying) return;

    const el = ensureAudioElement();

    try {
      // Decode base64 → Blob → object URL
      const binaryString = atob(audio);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: "audio/mpeg" });
      const objectUrl = URL.createObjectURL(blob);

      el.src = objectUrl;
      el.playbackRate = playbackRate;
      isPlaying = true;
      isPaused = false;

      // Wait for ended or error
      new Promise((resolve) => {
        let settled = false;
        let watchdog = null;

        const finish = (wasError, errMsg) => {
          if (settled) return;
          settled = true;
          if (watchdog) clearTimeout(watchdog);
          el.removeEventListener("ended", onEnded);
          el.removeEventListener("error", onError);
          URL.revokeObjectURL(objectUrl);
          isPlaying = false;

          if (wasError) {
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
        const onError = () => {
          const code = el && el.error ? el.error.code : 0;
          finish(true, `audio element error (code ${code})`);
        };

        el.addEventListener("ended", onEnded, { once: true });
        el.addEventListener("error", onError, { once: true });

        el.play().then(() => {
          // Watchdog: force-settle if neither ended nor error fires
          watchdog = setTimeout(() => {
            finish(true, "audio watchdog timeout");
          }, 300000);
        }).catch((err) => {
          finish(true, err.message);
        });
      });
    } catch (err) {
      isPlaying = false;
      chrome.runtime
        .sendMessage({ type: "playError", error: err.message, index, generation })
        .catch(() => {});
    }
  }

  // ─── Message handling (from background) ───────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case "ttsPlay":
        playSegment(msg);
        sendResponse({ ok: true });
        break;
      case "ttsPause":
        isPaused = true;
        if (audioElement) audioElement.pause();
        sendResponse({ ok: true });
        break;
      case "ttsResume":
        isPaused = false;
        if (audioElement) audioElement.play().catch(() => {});
        sendResponse({ ok: true });
        break;
      case "ttsStop":
        if (msg.generation !== undefined) {
          currentGeneration = msg.generation;
        }
        teardownAudio();
        sendResponse({ ok: true });
        break;
      case "ttsSetRate":
        playbackRate = msg.rate || 1.0;
        if (audioElement) audioElement.playbackRate = playbackRate;
        sendResponse({ ok: true });
        break;
      case "ttsPing":
        sendResponse({ ok: true, playing: isPlaying, paused: isPaused });
        break;
      // Text extraction messages
      case "extractText": {
        const mainEl = findMainContent();
        const text = extractTextFromElement(mainEl);
        sendResponse({ text, title: document.title, url: window.location.href });
        break;
      }
      case "extractSelection": {
        const selText = getSelectionText();
        if (selText) {
          sendResponse({ text: selText, source: "selection" });
        } else {
          const mainEl = findMainContent();
          const text = extractTextFromElement(mainEl);
          sendResponse({ text, title: document.title, url: window.location.href, source: "page" });
        }
        break;
      }
      case "extractPage": {
        const mainEl = findMainContent();
        const text = extractTextFromElement(mainEl);
        sendResponse({ text, title: document.title, url: window.location.href });
        break;
      }
      case "extractFromElement": {
        if (!msg.selector) {
          sendResponse({ error: "Missing selector" });
          break;
        }
        let el = null;
        try { el = document.querySelector(msg.selector); } catch (e) {
          sendResponse({ error: `Invalid selector: ${e.message}` });
          break;
        }
        sendResponse({ text: extractTextFromElement(el) });
        break;
      }
      default:
        // Don't respond to unknown messages — let them pass through
        // to the background service worker.
        return;
    }
    return true;
  });

  // ─── Page messaging (for CDP testing / future UI) ─────────────────────────

  window.addEventListener("message", (e) => {
    if (!e.data || !e.data.type) return;

    switch (e.data.type) {
      case "ttsStart":
        chrome.runtime.sendMessage(
          { type: "startReading", text: e.data.text, sourceLabel: "CDP Test" },
          (resp) => {
            window.postMessage({ type: "ttsResult", resp: resp || { error: chrome.runtime.lastError?.message } }, "*");
          }
        );
        break;
      case "ttsStatus":
        chrome.runtime.sendMessage(
          { type: "getSessionStatus" },
          (resp) => {
            window.postMessage({ type: "ttsStatusResult", resp: resp || { error: chrome.runtime.lastError?.message } }, "*");
          }
        );
        break;
      case "ttsStop":
        chrome.runtime.sendMessage(
          { type: "stopSession" },
          (resp) => {
            window.postMessage({ type: "ttsResult", resp: resp || { error: chrome.runtime.lastError?.message } }, "*");
          }
        );
        break;
      case "ttsPause":
        chrome.runtime.sendMessage(
          { type: "pausePlayback" },
          (resp) => {
            window.postMessage({ type: "ttsResult", resp: resp || { error: chrome.runtime.lastError?.message } }, "*");
          }
        );
        break;
      case "ttsResume":
        chrome.runtime.sendMessage(
          { type: "resumePlayback" },
          (resp) => {
            window.postMessage({ type: "ttsResult", resp: resp || { error: chrome.runtime.lastError?.message } }, "*");
          }
        );
        break;
      case "ttsSkip":
        chrome.runtime.sendMessage(
          { type: "skipSegment" },
          (resp) => {
            window.postMessage({ type: "ttsResult", resp: resp || { error: chrome.runtime.lastError?.message } }, "*");
          }
        );
        break;
    }
  });

  // ─── Cleanup on page navigation ───────────────────────────────────────────

  window.addEventListener("pagehide", () => {
    teardownAudio();
  });
})();
