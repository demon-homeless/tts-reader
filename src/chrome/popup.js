/**
 * popup.js — Popup UI for TTS Reader.
 *
 * The popup is a settings panel. Playback is controlled via the
 * right-click context menu. The popup shows current session status
 * and allows changing provider/voice/rate/API settings.
 */

// ─── State ──────────────────────────────────────────────────────────────────

let settings = {};
let statusTimer = null;

// ─── DOM refs ───────────────────────────────────────────────────────────────

const $statusDot = document.getElementById("statusDot");
const $statusText = document.getElementById("statusText");
const $segmentCounter = document.getElementById("segmentCounter");
const $progressFill = document.getElementById("progressFill");
const $currentSegment = document.getElementById("currentSegment");
const $providerBadge = document.getElementById("providerBadge");
const $providerSelect = document.getElementById("providerSelect");
const $voiceSelect = document.getElementById("voiceSelect");
const $rateSelect = document.getElementById("rateSelect");
const $apiKeyRow = document.getElementById("apiKeyRow");
const $apiKeyInput = document.getElementById("apiKeyInput");
const $apiUrlRow = document.getElementById("apiUrlRow");
const $apiUrlInput = document.getElementById("apiUrlInput");
const $optionsLink = document.getElementById("optionsLink");
const $hintText = document.getElementById("hintText");

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
  settings = await chrome.runtime.sendMessage({ type: "getSettings" });

  $providerSelect.value = settings.provider || "edge-tts";
  $rateSelect.value = settings.rate || "+0%";
  $apiKeyInput.value = settings.apiKey || "";
  $apiUrlInput.value = settings.apiUrl || "";
  updateProviderUI();
  populateVoices(settings.provider, settings.voice);
  $providerBadge.textContent = settings.provider || "edge-tts";

  $providerSelect.addEventListener("change", onProviderChange);
  $voiceSelect.addEventListener("change", onVoiceChange);
  $rateSelect.addEventListener("change", onRateChange);
  $apiKeyInput.addEventListener("change", onApiKeyChange);
  $apiUrlInput.addEventListener("change", onApiUrlChange);
  $optionsLink.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // Show current session status
  const status = await chrome.runtime.sendMessage({ type: "getSessionStatus" });
  updateStatus(status);

  // Apply i18n to all data-i18n elements
  if (self.i18n) self.i18n.apply(document);

  // Poll status every 2s while the popup is open
  startStatusPolling();
}

function startStatusPolling() {
  if (statusTimer) return;
  statusTimer = setInterval(async () => {
    try {
      const s = await chrome.runtime.sendMessage({ type: "getSessionStatus" });
      updateStatus(s);
    } catch (e) {
      // Extension context invalidated (e.g. during a reload) — stop polling
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

function onVoiceChange() {
  saveSettings();
}

function onRateChange() {
  saveSettings();
}

function onApiKeyChange() {
  saveSettings();
}

function onApiUrlChange() {
  saveSettings();
}

// ─── Status display ─────────────────────────────────────────────────────────

function updateStatus(status) {
  const i18n = self.i18n;
  if (!status || status.status === "idle") {
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

// ─── Start ──────────────────────────────────────────────────────────────────

// The popup window closes when it loses focus — clear the polling timer
// so it cannot leak (the document is destroyed anyway, but be explicit).
window.addEventListener("pagehide", stopStatusPolling);

init().catch((e) => {
  console.error("[popup] init failed:", e);
});
