/**
 * content.js — Content script for TTS Reader Chrome extension.
 *
 * Extracts readable text from the current web page. Uses a heuristic
 * approach to find the main content area (article, main, or the element
 * with the most text).
 *
 * Messages handled:
 *   - "extractText" → returns { text, title, url }
 *   - "extractSelection" → returns { text } (selected text, or full page)
 *   - "extractFromElement" → returns { text } (text from a specific element)
 */

(function () {
  "use strict";

  /**
   * Find the main content element of the page.
   * Priority: <article> > <main> > [role=main] > <div id=content> > body
   */
  function findMainContent() {
    // Try semantic elements first
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

    // Fallback: find the element with the most text content
    let bestEl = document.body;
    let bestLength = 0;

    const allElements = document.querySelectorAll("div, article, section, main");
    for (const el of allElements) {
      const textLen = el.textContent.trim().length;
      if (textLen > bestLength && textLen < 500000) {
        // Don't pick elements that are too small or too large
        if (textLen > 200) {
          bestLength = textLen;
          bestEl = el;
        }
      }
    }

    return bestEl;
  }

  /**
   * Extract clean, readable text from an element.
   * Removes scripts, styles, nav, footer, header, ads, etc.
   */
  function extractTextFromElement(el) {
    if (!el) return "";

    // Clone the element to avoid modifying the DOM
    const clone = el.cloneNode(true);

    // Remove non-content elements
    const removeSelectors = [
      "script",
      "style",
      "noscript",
      "nav",
      "footer",
      "header",
      "aside",
      "iframe",
      "canvas",
      "svg",
      "button",
      "form",
      "input",
      "select",
      "textarea",
      "[role=navigation]",
      "[role=banner]",
      "[role=complementary]",
      "[role=contentinfo]",
      "[class*='ad-']",
      "[class*='ads-']",
      "[class*='advert']",
      "[class*='sponsor']",
      "[class*='cookie']",
      "[class*='popup']",
      "[class*='modal']",
      "[class*='sidebar']",
      "[class*='comment']",
      "[id*='ad-']",
      "[id*='ads-']",
    ];

    for (const selector of removeSelectors) {
      const elements = clone.querySelectorAll(selector);
      elements.forEach((e) => e.remove());
    }

    // Get text content.
    //
    // Preserve paragraph structure: the segmenter splits on blank lines
    // (paragraph mode) and treats newlines as sentence boundaries, so
    // collapsing ALL whitespace into a single line degrades segmentation
    // quality. We keep newlines, collapse runs of blank lines, and trim
    // trailing whitespace per line.
    let text = clone.textContent || "";
    text = text
      .replace(/[ \t]+/g, " ")          // collapse horizontal whitespace
      .replace(/[ \t]+\n/g, "\n")       // trim trailing spaces before newlines
      .replace(/\n{3,}/g, "\n\n")       // collapse runs of blank lines
      .trim();

    return text;
  }

  /**
   * Get the user's current text selection.
   */
  function getSelectionText() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const text = sel.toString().trim();
      if (text) return text;
    }
    return "";
  }

  // Listen for postMessage from the page (used by CDP tests)
  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "ttsStart") {
      chrome.runtime.sendMessage(
        { type: "startReading", text: e.data.text, sourceLabel: "CDP Test" },
        (resp) => {
          window.postMessage({ type: "ttsResult", resp: resp || { error: chrome.runtime.lastError?.message } }, "*");
        }
      );
    } else if (e.data && e.data.type === "ttsStatus") {
      chrome.runtime.sendMessage(
        { type: "getSessionStatus" },
        (resp) => {
          window.postMessage({ type: "ttsStatusResult", resp: resp || { error: chrome.runtime.lastError?.message } }, "*");
        }
      );
    }
  });

  // Listen for messages from the popup / background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case "extractText": {
        const mainEl = findMainContent();
        const text = extractTextFromElement(mainEl);
        sendResponse({
          text,
          title: document.title,
          url: window.location.href,
        });
        break;
      }

      case "extractSelection": {
        const selText = getSelectionText();
        if (selText) {
          sendResponse({ text: selText, source: "selection" });
        } else {
          // No selection — fall back to full page
          const mainEl = findMainContent();
          const text = extractTextFromElement(mainEl);
          sendResponse({
            text,
            title: document.title,
            url: window.location.href,
            source: "page",
          });
        }
        break;
      }

      case "extractPage": {
        const mainEl = findMainContent();
        const text = extractTextFromElement(mainEl);
        sendResponse({
          text,
          title: document.title,
          url: window.location.href,
          source: "page",
        });
        break;
      }

      case "extractFromElement": {
        // message.selector is a CSS selector
        if (!message.selector) {
          sendResponse({ error: "Missing selector" });
          break;
        }
        let el = null;
        try {
          el = document.querySelector(message.selector);
        } catch (e) {
          sendResponse({ error: `Invalid selector: ${e.message}` });
          break;
        }
        const text = extractTextFromElement(el);
        sendResponse({ text });
        break;
      }

      default:
        sendResponse({ error: "Unknown message type" });
    }
    return true; // Keep message channel open for async response
  });
})();
