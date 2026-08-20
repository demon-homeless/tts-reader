/**
 * popup.js — Popup UI for TTS Reader.
 *
 * The popup is the main control panel:
 *   - Read buttons (selection / page) when idle
 *   - Stop / Pause / Resume / Skip when playing
 *   - Settings (provider, voice, rate, API key, endpoint)
 */

// ─── State ──────────────────────────────────────────────────────────────────

let settings = {};
let statusTimer = null;
let currentTabId = null;

// ─── DOM refs ───────────────────────────────────────────────────────────────

const $statusDot = document.getElementById("statusDot");
const $statusText = document.getElementById("statusText");
const $segmentCounter = document.getElementById("segmentCounter");
const $progressFill = document.getElementById("progressFill");
const $providerBadge = document.getElementById("providerBadge");
const $providerSelect = document.getElementById("providerSelect");
const $voiceSelect = document.getElementById("voiceSelect");
const $rateSelect = document.getElementById("rateSelect");
const $apiKeyRow = document.getElementById("apiKeyRow");
const $apiKeyInput = document.getElementById("apiKeyInput");
const $apiUrlRow = document.getElementById("apiUrlRow");
const $apiUrlInput = document.getElementById("apiUrlInput");
const $optionsLink = document.getElementById("optionsLink");

// Action buttons
const $idleActions = document.getElementById("idleActions");
const $playingActions = document.getElementById("playingActions");
const $btnReadSelection = document.getElementById("btnReadSelection");
const $btnReadPage = document.getElementById("btnReadPage");
const $btnStop = document.getElementById("btnStop");
const $btnPause = document.getElementById("btnPause");
const $btnResume = document.getElementById("btnResume");
const $btnSkip = document.getElementById("btnSkip");

// ─── Voice lists per provider ───────────────────────────────────────────────

const VOICES = {
  "edge-tts": [
    { name: "en-US-AvaMultilingualNeural", desc: "English (US) — Female, multilingual" },
    { name: "en-US-AriaNeural", desc: "English (US) — Female, friendly" },
    { name: "en-US-GuyNeural", desc: "English (US) — Male, friendly" },
    { name: "en-US-JennyNeural", desc: "English (US) — Female, professional" },
    { name: "en-GB-SoniaNeural", desc: "English (UK) — Female, professional" },
    { name: "zh-CN-XiaoxiaoNeural", desc: "Chinese (Mandarin) — Female, warm" },
    { name: "zh-CN-YunxiNeural", desc: "Chinese (Mandarin) — Male, youthful" },
    { name: "zh-CN-YunjianNeural", desc: "Chinese (Mandarin) — Male, sports" },
    { name: "ja-JP-NanamiNeural", desc: "Japanese — Female, friendly" },
    { name: "ja-JP-KeitaNeural", desc: "Japanese — Male" },
    { name: "ko-KR-SunHiNeural", desc: "Korean — Female, friendly" },
    { name: "fr-FR-DeniseNeural", desc: "French — Female" },
    { name: "de-DE-KatjaNeural", desc: "German — Female" },
    { name: "es-ES-ElviraNeural", desc: "Spanish — Female" },
    { name: "ru-RU-SvetlanaNeural", desc: "Russian — Female" },
    { name: "pt-BR-FranciscaNeural", desc: "Portuguese (Brazil) — Female" },
  ],
  openai: [
    { name: "alloy", desc: "Balanced, versatile voice" },
    { name: "echo", desc: "Male, warm" },
    { name: "fable", desc: "Male, dramatic" },
    { name: "onyx", desc: "Male, deep" },
    { name: "nova", desc: "Female, bright" },
    { name: "shimmer", desc: "Female, soft" },
  ],
  google: [
    { name: "en-US-Standard-A", desc: "English (US) — Standard A" },
    { name: "en-US-Standard-B", desc: "English (US) — Standard B" },
    { name: "en-US-Standard-C", desc: "English (US) — Standard C" },
    { name: "en-US-Neural2-A", desc: "English (US) — Neural A" },
    { name: "en-US-Neural2-B", desc: "English (US) — Neural B" },
    { name: "zh-CN-Standard-A", desc: "Chinese — Standard A" },
    { name: "ja-JP-Standard-A", desc: "Japanese — Standard A" },
    { name: "ko-KR-Standard-A", desc: "Korean — Standard A" },
  ],
  custom: [
    { name: "default", desc: "Default voice" },
  ],
};

// ─── Init ───────────────────────────────────────────────────────────────────

async function init() {
  // Get the active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab ? tab.id : null;

  settings = await chrome.runtime.sendMessage({ type: "getSettings" });

  $providerSelect.value = settings.provider || "edge-tts";
  $rateSelect.value = settings.rate || "+0%";
  $apiKeyInput.value = settings.apiKey || "";
  $apiUrlInput.value = settings.apiUrl || "";
  updateProviderUI();
  populateVoices(settings.provider, settings.voice);
  $providerBadge.textContent = settings.provider || "edge-tts";

  // Event listeners
  $providerSelect.addEventListener("change", onProviderChange);
  $voiceSelect.addEventListener("change", onVoiceChange);
  $rateSelect.addEventListener("change", onRateChange);
  $apiKeyInput.addEventListener("change", onApiKeyChange);
  $apiUrlInput.addEventListener("change", onApiUrlChange);
  $optionsLink.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // Action button listeners
  $btnReadPage.addEventListener("click", onReadPage);
  $btnReadSelection.addEventListener("click", onReadSelection);
  $btnStop.addEventListener("click", onStop);
  $btnPause.addEventListener("click", onPause);
  $btnResume.addEventListener("click", onResume);
  $btnSkip.addEventListener("click", onSkip);

  // Show current session status
  const status = await chrome.runtime.sendMessage({ type: "getSessionStatus" });
  updateStatus(status);

  // Apply i18n to all data-i18n elements
  if (self.i18n) self.i18n.apply(document);

  // Poll status every 2s while the popup is open
  startStatusPolling();
}

// ─── Action handlers ────────────────────────────────────────────────────────

async function onReadPage() {
  if (!currentTabId) return;
  try {
    const response = await chrome.tabs.sendMessage(currentTabId, { type: "extractPage" });
    if (response && response.text) {
      chrome.runtime.sendMessage({
        type: "startReading",
        text: response.text,
        sourceLabel: "Page",
        tabId: currentTabId,
      });
    }
  } catch (e) {
    console.warn("[popup] Read page failed:", e.message);
  }
}

async function onReadSelection() {
  if (!currentTabId) return;
  try {
    const response = await chrome.tabs.sendMessage(currentTabId, { type: "extractSelection" });
    if (response && response.text) {
      chrome.runtime.sendMessage({
        type: "startReading",
        text: response.text,
        sourceLabel: "Selection",
        tabId: currentTabId,
      });
    }
  } catch (e) {
    console.warn("[popup] Read selection failed:", e.message);
  }
}

async function onStop() {
  await chrome.runtime.sendMessage({ type: "stopSession" });
}

async function onPause() {
  await chrome.runtime.sendMessage({ type: "pausePlayback" });
}

async function onResume() {
  await chrome.runtime.sendMessage({ type: "resumePlayback" });
}

async function onSkip() {
  await chrome.runtime.sendMessage({ type: "skipSegment" });
}

// ─── Status polling ─────────────────────────────────────────────────────────

function startStatusPolling() {
  if (statusTimer) return;
  statusTimer = setInterval(async () => {
    try {
      const s = await chrome.runtime.sendMessage({ type: "getSessionStatus" });
      updateStatus(s);
      // Check for text selection to show/hide the selection button
      updateSelectionButton();
    } catch (e) {
      stopStatusPolling();
    }
  }, 2000);
}

function stopStatusPolling() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
}

// ─── Settings ───────────────────────────────────────────────────────────────

function updateProviderUI() {
  const provider = $providerSelect.value;
  const needsKey = provider === "openai" || provider === "google" || provider === "custom";
  const needsUrl = provider === "custom";
  $apiKeyRow.style.display = needsKey ? "flex" : "none";
  $apiUrlRow.style.display = needsUrl ? "flex" : "none";
  $providerBadge.textContent = provider;
}

function populateVoices(provider, selectedVoice) {
  const voices = VOICES[provider] || VOICES["edge-tts"];
  $voiceSelect.innerHTML = "";
  for (const v of voices) {
    const opt = document.createElement("option");
    opt.value = v.name;
    opt.textContent = v.desc;
    if (v.name === selectedVoice) opt.selected = true;
    $voiceSelect.appendChild(opt);
  }
  if (selectedVoice && !voices.find((v) => v.name === selectedVoice)) {
    const opt = document.createElement("option");
    opt.value = selectedVoice;
    opt.textContent = selectedVoice;
    opt.selected = true;
    $voiceSelect.appendChild(opt);
  }
}

async function saveSettings() {
  const provider = $providerSelect.value;
  const updates = {
    provider,
    voice: $voiceSelect.value,
    rate: $rateSelect.value,
  };
  if (provider === "openai" || provider === "google" || provider === "custom") {
    updates.apiKey = $apiKeyInput.value;
  }
  if (provider === "custom") {
    updates.apiUrl = $apiUrlInput.value;
  }
  await chrome.storage.sync.set(updates);
  settings = { ...settings, ...updates };
}

function onProviderChange() {
  updateProviderUI();
  populateVoices($providerSelect.value, settings.voice);
  saveSettings();
}

function onVoiceChange() { saveSettings(); }
function onRateChange() { saveSettings(); }
function onApiKeyChange() { saveSettings(); }
function onApiUrlChange() { saveSettings(); }

// ─── Status display ─────────────────────────────────────────────────────────

function updateStatus(status) {
  const i18n = self.i18n;
  const isIdle = !status || status.status === "idle";
  const isPlaying = status && (status.status === "playing" || status.status === "synthesizing");
  const isPaused = status && status.status === "paused";

  // Toggle button visibility
  $idleActions.style.display = isIdle ? "block" : "none";
  $playingActions.style.display = !isIdle ? "block" : "none";
  $btnPause.style.display = isPaused ? "none" : "flex";
  $btnResume.style.display = isPaused ? "flex" : "none";

  if (isIdle) {
    $statusDot.className = "status-dot";
    $statusText.textContent = i18n.t("status.ready");
    $segmentCounter.textContent = "";
    $progressFill.style.width = "0%";
    return;
  }

  const current = status.currentIndex || 0;
  const total = status.total || 0;
  const pct = total > 0 ? (current / total) * 100 : 0;
  $progressFill.style.width = `${pct}%`;
  $segmentCounter.textContent = `${current + 1} / ${total}`;

  $statusDot.className = "status-dot";
  switch (status.status) {
    case "playing":
      $statusDot.classList.add("playing");
      $statusText.textContent = i18n.t("status.playing");
      break;
    case "paused":
      $statusDot.classList.add("paused");
      $statusText.textContent = i18n.t("status.paused");
      break;
    case "synthesizing":
      $statusDot.classList.add("synthesizing");
      $statusText.textContent = i18n.t("status.synthesizing");
      break;
    default:
      $statusText.textContent = status.status;
  }
}

// ─── Selection detection ────────────────────────────────────────────────────

async function updateSelectionButton() {
  if (!currentTabId) return;
  try {
    const resp = await chrome.tabs.sendMessage(currentTabId, { type: "hasSelection" });
    const hasSel = resp && resp.hasSelection;
    $btnReadSelection.style.display = hasSel ? "flex" : "none";
  } catch {
    // Content script not available
  }
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

window.addEventListener("pagehide", stopStatusPolling);

init().catch((e) => {
  console.error("[popup] init failed:", e);
});
