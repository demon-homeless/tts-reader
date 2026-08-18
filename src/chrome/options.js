/**
 * options.js — Options page logic for TTS Reader.
 */

const VOICES = {
  "edge-tts": [
    { name: "en-US-AvaMultilingualNeural", desc: "English (US) — Female, multilingual" },
    { name: "en-US-AriaNeural", desc: "English (US) — Female, friendly" },
    { name: "en-US-GuyNeural", desc: "English (US) — Male, friendly" },
    { name: "en-US-JennyNeural", desc: "English (US) — Female, professional" },
    { name: "en-GB-SoniaNeural", desc: "English (UK) — Female, professional" },
    { name: "en-AU-NatashaNeural", desc: "English (Australia) — Female" },
    { name: "zh-CN-XiaoxiaoNeural", desc: "Chinese (Mandarin) — Female, warm" },
    { name: "zh-CN-YunxiNeural", desc: "Chinese (Mandarin) — Male, youthful" },
    { name: "zh-CN-YunjianNeural", desc: "Chinese (Mandarin) — Male, sports" },
    { name: "zh-CN-XiaoyiNeural", desc: "Chinese (Mandarin) — Female, cute" },
    { name: "zh-CN-YunyangNeural", desc: "Chinese (Mandarin) — Male, news" },
    { name: "zh-HK-HiuhaaNeural", desc: "Chinese (Cantonese) — Female" },
    { name: "zh-TW-HsiaoChenNeural", desc: "Chinese (Taiwan) — Female" },
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
    { name: "alloy", desc: "Balanced, versatile" },
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
    { name: "en-US-Neural2-C", desc: "English (US) — Neural C" },
    { name: "en-US-Neural2-D", desc: "English (US) — Neural D" },
    { name: "zh-CN-Standard-A", desc: "Chinese — Standard A" },
    { name: "zh-CN-Standard-B", desc: "Chinese — Standard B" },
    { name: "ja-JP-Standard-A", desc: "Japanese — Standard A" },
    { name: "ko-KR-Standard-A", desc: "Korean — Standard A" },
  ],
  custom: [
    { name: "default", desc: "Default voice" },
  ],
};

const PROVIDER_DESCS = {
  "edge-tts": "Microsoft Edge TTS — free, no API key needed. Uses WebSocket protocol. Best for general use.",
  "openai": "OpenAI TTS API — high quality, requires API key. POST /v1/audio/speech. Supports models: tts-1, tts-1-hd.",
  "google": "Google Cloud TTS — requires API key. POST /v1/text:synthesize. Wide voice selection per language.",
  "custom": "Custom HTTP endpoint — for any TTS service. Expects POST with JSON {text, voice, rate, volume, pitch} returning audio binary.",
};

const $provider = document.getElementById("provider");
const $apiKey = document.getElementById("apiKey");
const $apiUrl = document.getElementById("apiUrl");
const $model = document.getElementById("model");
const $voice = document.getElementById("voice");
const $rate = document.getElementById("rate");
const $volume = document.getElementById("volume");
const $pitch = document.getElementById("pitch");
const $playbackRate = document.getElementById("playbackRate");
const $segmentMode = document.getElementById("segmentMode");
const $maxChars = document.getElementById("maxChars");
const $minChars = document.getElementById("minChars");
const $preload = document.getElementById("preload");
const $saveBtn = document.getElementById("saveBtn");
const $saveMsg = document.getElementById("saveMsg");
const $providerDesc = document.getElementById("providerDesc");
const $apiKeyRow = document.getElementById("apiKeyRow");
const $apiUrlRow = document.getElementById("apiUrlRow");
const $modelRow = document.getElementById("modelRow");

function updateProviderUI() {
  const i18n = self.i18n;
  const provider = $provider.value;
  $providerDesc.textContent = i18n ? i18n.t("options.providerDesc." + provider) : (PROVIDER_DESCS[provider] || "");
  const needsKey = provider === "openai" || provider === "google" || provider === "custom";
  const needsUrl = provider === "custom";
  const needsModel = provider === "openai";
  $apiKeyRow.style.display = needsKey ? "flex" : "none";
  $apiUrlRow.style.display = needsUrl ? "flex" : "none";
  $modelRow.style.display = needsModel ? "flex" : "none";
}

function populateVoices(provider, selectedVoice) {
  const voices = VOICES[provider] || VOICES["edge-tts"];
  $voice.innerHTML = "";
  for (const v of voices) {
    const opt = document.createElement("option");
    opt.value = v.name;
    opt.textContent = v.desc;
    if (v.name === selectedVoice) opt.selected = true;
    $voice.appendChild(opt);
  }
  if (selectedVoice && !voices.find((v) => v.name === selectedVoice)) {
    const opt = document.createElement("option");
    opt.value = selectedVoice;
    opt.textContent = selectedVoice;
    opt.selected = true;
    $voice.appendChild(opt);
  }
}

async function loadSettings() {
  const settings = await chrome.storage.sync.get({
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
  });

  $provider.value = settings.provider;
  $apiKey.value = settings.apiKey || "";
  $apiUrl.value = settings.apiUrl || "";
  $model.value = settings.model || "";
  $rate.value = settings.rate;
  $volume.value = settings.volume;
  $pitch.value = settings.pitch;
  $playbackRate.value = settings.playbackRate;
  $segmentMode.value = settings.segmentMode;
  $maxChars.value = settings.maxSegmentChars;
  $minChars.value = settings.minSegmentChars;
  $preload.value = settings.preloadSegments;

  updateProviderUI();
  populateVoices(settings.provider, settings.voice);
}

async function saveSettings() {
  const provider = $provider.value;
  const updates = {
    provider,
    voice: $voice.value,
    rate: $rate.value,
    volume: $volume.value,
    pitch: $pitch.value,
    maxSegmentChars: parseInt($maxChars.value, 10),
    minSegmentChars: parseInt($minChars.value, 10),
    segmentMode: $segmentMode.value,
    preloadSegments: parseInt($preload.value, 10),
    playbackRate: parseFloat($playbackRate.value),
  };

  if (provider === "openai" || provider === "google" || provider === "custom") {
    updates.apiKey = $apiKey.value;
  }
  if (provider === "custom") {
    updates.apiUrl = $apiUrl.value;
  }
  if (provider === "openai") {
    updates.model = $model.value;
  }

  await chrome.storage.sync.set(updates);

  $saveMsg.classList.add("show");
  setTimeout(() => $saveMsg.classList.remove("show"), 2000);
}

// Wire up events
$provider.addEventListener("change", () => {
  updateProviderUI();
  populateVoices($provider.value, $voice.value);
});

$saveBtn.addEventListener("click", saveSettings);

// Load on start
loadSettings().then(() => {
  if (self.i18n) self.i18n.apply(document);
});
