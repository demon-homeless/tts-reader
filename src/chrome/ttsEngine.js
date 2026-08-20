/**
 * ttsEngine.js — Provider-agnostic TTS engine.
 *
 * Supports multiple TTS backends through a unified interface:
 *
 *   1. edge-tts   — Microsoft Edge TTS (WebSocket, free, no API key)
 *   2. openai     — OpenAI TTS API (POST /v1/audio/speech, requires API key)
 *   3. google     — Google Cloud TTS (POST /v1/text:synthesize, requires API key)
 *   4. custom     — User-defined HTTP endpoint (for any TTS service)
 *
 * Each provider implements:
 *   synthesize(text, opts) → Promise<ArrayBuffer>
 *
 * The engine selects the active provider based on chrome.storage settings.
 */

// ─── Provider: Edge TTS ─────────────────────────────────────────────────────

/**
 * The Edge TTS endpoint rejects browser WebSocket handshakes that lack
 * the Edge read-aloud extension's Origin header. Browsers do not allow
 * custom headers on WebSocket, so we route the connection through a
 * tiny local WebSocket proxy that injects the required headers.
 *
 * The proxy is a single-file Node.js server (tools/edge-tts-proxy.js).
 * If the proxy is not running, synthesizeEdgeTts falls back to a direct
 * connection (which works in environments where the server does not
 * enforce the Origin check).
 */
const EDGE_TTS_PROXY_HTTP = "https://tts.webextools.com/tts";
// Local proxy fallback (tools/edge-tts-proxy.js) — used when the remote
// proxy is unreachable. The local proxy uses GET with query params.
const EDGE_TTS_PROXY_LOCAL = "http://127.0.0.1:8787/tts";

/**
 * RFC 1123 / JS-style date string, e.g.
 * "Thu Aug 17 2026 01:23:45 GMT+0000 (Coordinated Universal Time)".
 */
function edgeTtsDateToString() {
  const d = new Date();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${p(d.getUTCDate())} ` +
    `${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ` +
    `GMT+0000 (Coordinated Universal Time)`
  );
}

/**
 * Parse a header-framed WebSocket message.
 * Binary frames: [uint16 BE headerLength][headers \r\n-terminated][\r\n][body]
 * Text frames:   [headers \r\n-terminated][\r\n][body]
 * Returns { headers: {Name: value}, body: string|ArrayBuffer }.
 */
function parseEdgeTtsMessage(data, isBinary) {
  let headerBlock;
  let body;
  if (isBinary) {
    const buf = new Uint8Array(data);
    const headerLength = (buf[0] << 8) | buf[1];
    const enc = new TextDecoder();
    headerBlock = enc.decode(buf.subarray(0, headerLength));
    body = data.slice(2 + headerLength + 2);
  } else {
    const s = typeof data === "string" ? data : new TextDecoder().decode(data);
    const i = s.indexOf("\r\n\r\n");
    if (i < 0) return { headers: {}, body: s };
    headerBlock = s.slice(0, i);
    body = s.slice(i + 4);
  }
  const headers = {};
  for (const line of headerBlock.split("\r\n")) {
    const j = line.indexOf(":");
    if (j > 0) headers[line.slice(0, j).trim()] = line.slice(j + 1).trim();
  }
  return { headers, body };
}

async function synthesizeEdgeTts(text, opts) {
  const t0 = Date.now();
  const log = (msg) => console.log(`[edge-tts] ${msg}`);
  const clientToken = opts.trustedClientToken || "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
  const baseApiUrl =
    opts.apiUrl ||
    "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";

  // Microsoft's Edge TTS endpoint is WebSocket-only and requires a
  // User-Agent header in the WS handshake (without UA → 403). Browsers
  // do NOT allow custom headers on WebSocket, so direct WS from a
  // Chrome extension will always get 403.
  //
  // The chrome.proxy API cannot help here: it only intercepts HTTP/HTTPS
  // traffic, not WebSocket handshakes. The background service worker's
  // WebSocket constructor also does not accept custom headers (same
  // limitation as the browser).
  //
  // Solution: use an HTTP proxy that does the WS handshake server-side.
  // Default: https://tts.webextools.com/tts (POST JSON {text, voice, ...})
  // The user can override via opts.proxyUrl (settings page).
  //
  // We try the HTTP proxy first, then fall back to a direct WebSocket
  // (which works in non-browser environments like Node.js).

  // 1. HTTP proxy (works in Chrome extensions — no custom WS headers needed)
  //
  // The remote proxy accepts POST with a JSON body { text, voice, rate,
  // volume, pitch }. The local proxy (tools/edge-tts-proxy.js) accepts
  // GET with query params (?text=...&voice=...). Try remote first, then
  // local, then direct WS.
  //
  // opts.proxyUrl (user-configurable, same key as the VSCode extension's
  // ttsReader.proxyUrl) forces a single custom proxy endpoint (POST JSON)
  // and disables the built-in candidates.
  const voice = opts.voice || "en-US-AvaMultilingualNeural";
  const proxyCandidates = opts.proxyUrl
    ? [{ url: opts.proxyUrl, method: "POST" }]
    : [
        { url: EDGE_TTS_PROXY_HTTP, method: "POST" },
        { url: EDGE_TTS_PROXY_LOCAL, method: "GET" },
      ];

  const proxyErrors = [];
  for (const { url: proxyUrl, method } of proxyCandidates) {
    try {
      let fetchUrl = proxyUrl;
      let fetchOpts;
      if (method === "GET") {
        fetchUrl = `${proxyUrl}?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(voice)}`;
        fetchOpts = { method: "GET" };
      } else {
        fetchOpts = {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            voice,
            rate: opts.rate || "+0%",
            volume: opts.volume || "+0%",
            pitch: opts.pitch || "+0Hz",
          }),
        };
      }
      const resp = await fetch(fetchUrl, fetchOpts);
      if (resp.ok) {
        const audio = await resp.arrayBuffer();
        if (audio.byteLength > 0) {
          log(`DONE (proxy ${method} ${proxyUrl}): ${audio.byteLength}B in ${Date.now() - t0}ms`);
          return audio;
        }
        throw new Error("proxy returned empty audio");
      }
      const body = await resp.text();
      throw new Error(`proxy error ${resp.status}: ${body.slice(0, 200)}`);
    } catch (e) {
      const msg = `proxy ${method} ${proxyUrl} failed: ${e.message}`;
      log(`${msg}, trying next...`);
      proxyErrors.push(msg);
    }
  }
  log(`all proxies failed, falling back to direct WS`);
  // Attach the proxy failures so the caller can surface WHY there is no
  // audio (the direct-WS fallback never works in a browser — it cannot
  // send the User-Agent header the Edge endpoint requires).
  const noAudioError = (msg) => {
    const err = new Error(msg);
    err.proxyErrors = proxyErrors;
    return err;
  };

  // 2. Fallback: direct WebSocket (works in Node.js, not in Chrome)
  const token = await generateSecMsGec();
  const targetUrl =
    baseApiUrl +
    `?TrustedClientToken=${clientToken}` +
    `&ConnectionId=${generateMuid()}` +
    `&Sec-MS-GEC=${token}` +
    `&Sec-MS-GEC-Version=${encodeURIComponent(SEC_MS_GEC_VERSION)}`;

  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(targetUrl);
    } catch (e) {
      reject(new Error(`Edge TTS WebSocket construction failed: ${e.message}`));
      return;
    }
    const audioChunks = [];
    let gotOpen = false;
    let settled = false;

    const fail = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      log(`FAIL: ${msg} (after ${Date.now() - t0}ms, open=${gotOpen}, chunks=${audioChunks.length})`);
      try { ws.close(); } catch { /* ignore */ }
      reject(noAudioError(msg));
    };

    const timeout = setTimeout(() => {
      fail("Edge TTS request timed out (45s)");
    }, 45000);

    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      gotOpen = true;
      log(`WS open (after ${Date.now() - t0}ms)`);
      const configJson = JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: {
                sentenceBoundaryEnabled: "true",
                wordBoundaryEnabled: "false",
              },
              outputFormat: "audio-24khz-48kbitrate-mono-mp3",
            },
          },
        },
      });
      ws.send(
        `X-Timestamp:${edgeTtsDateToString()}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        configJson +
        `\r\n`
      );
      setTimeout(() => {
        ws.send(
          `X-RequestId:${generateMuid()}\r\n` +
          `Content-Type:application/ssml+xml\r\n` +
          `X-Timestamp:${edgeTtsDateToString()}Z\r\n` +
          `Path:ssml\r\n\r\n` +
          buildSsml(text, opts)
        );
      }, 300);
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        const { headers, body } = parseEdgeTtsMessage(event.data, true);
        if (headers["Path"] === "audio" && body && body.byteLength > 0) {
          audioChunks.push(body);
        }
      } else {
        const { headers, body } = parseEdgeTtsMessage(event.data, false);
        const path = headers["Path"];
        if (path === "turn.end") {
          finish();
        } else if (path === "response") {
          const detail = String(body).slice(0, 200);
          fail(`Edge TTS service error: ${detail || "unknown"}`);
        }
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (audioChunks.length > 0) {
        const totalLength = audioChunks.reduce((sum, c) => sum + c.byteLength, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of audioChunks) {
          result.set(new Uint8Array(chunk), offset);
          offset += chunk.byteLength;
        }
        log(`DONE (direct WS): ${totalLength}B in ${Date.now() - t0}ms`);
        try { ws.close(); } catch { /* ignore */ }
        resolve(result.buffer);
      } else if (gotOpen) {
        fail("Edge TTS closed without audio");
      }
    };

    ws.onclose = (e) => {
      if (settled) return;
      if (audioChunks.length > 0) finish();
      else if (gotOpen) fail("Edge TTS closed without audio");
    };

    ws.onerror = () => {
      fail("Edge TTS WebSocket error (handshake rejected or connection failed)");
    };
  });
}

// ─── Provider: OpenAI TTS ───────────────────────────────────────────────────

/**
 * OpenAI TTS API: POST https://api.openai.com/v1/audio/speech
 * Body: { model, input, voice, response_format, speed }
 * Returns: audio/mpeg binary
 */
async function synthesizeOpenAI(text, opts) {
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error("OpenAI API key not configured");

  const baseUrl = opts.apiUrl || "https://api.openai.com/v1";
  const url = `${baseUrl}/audio/speech`;

  const body = {
    model: opts.model || "tts-1",
    input: text,
    voice: mapVoiceToOpenAI(opts.voice),
    response_format: "mp3",
    speed: parseRateToFloat(opts.rate),
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`OpenAI TTS error ${response.status}: ${errText.slice(0, 200)}`);
  }

  return await response.arrayBuffer();
}

/**
 * Map Edge TTS voice names to OpenAI voice names.
 * Falls back to "alloy" for unknown voices.
 */
function mapVoiceToOpenAI(edgeVoice) {
  const map = {
    "en-US-AriaNeural": "alloy",
    "en-US-JennyNeural": "nova",
    "en-US-GuyNeural": "echo",
    "en-GB-SoniaNeural": "shimmer",
    "zh-CN-XiaoxiaoNeural": "nova",
    "zh-CN-YunxiNeural": "echo",
    "ja-JP-NanamiNeural": "nova",
    "ja-JP-KeitaNeural": "echo",
    "ko-KR-SunHiNeural": "nova",
    "fr-FR-DeniseNeural": "nova",
    "de-DE-KatjaNeural": "echo",
    "es-ES-ElviraNeural": "nova",
    "ru-RU-SvetlanaNeural": "nova",
    "pt-BR-FranciscaNeural": "nova",
  };
  return map[edgeVoice] || "alloy";
}

/**
 * Parse a rate string like "+0%" or "+25%" to a float (1.0, 1.25).
 */
function parseRateToFloat(rate) {
  // Accept both "+25%" (Edge TTS style) and plain numbers like "1.25".
  if (rate == null || rate === "") return 1.0;
  if (typeof rate === "number") {
    return Math.max(0.25, Math.min(4.0, rate));
  }
  const m = String(rate).match(/([+-]?\d+(?:\.\d+)?)\s*%/);
  if (m) {
    const pct = parseFloat(m[1]);
    return Math.max(0.25, Math.min(4.0, 1.0 + pct / 100));
  }
  const n = parseFloat(rate);
  if (!isNaN(n)) return Math.max(0.25, Math.min(4.0, n));
  return 1.0;
}

// ─── Provider: Google Cloud TTS ─────────────────────────────────────────────

/**
 * Google Cloud TTS: POST https://texttospeech.googleapis.com/v1/text:synthesize
 * Body: { input: { text }, voice: { languageCode, name, ssmlGender }, audioConfig: { audioEncoding, speakingRate, volumeGainDb, pitch } }
 * Returns: { audioContent: base64 }
 */
async function synthesizeGoogle(text, opts) {
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error("Google API key not configured");

  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`;

  // Parse voice: "en-US-Standard-A" → languageCode: "en-US", name: "en-US-Standard-A"
  const voiceParts = opts.voice || "en-US-Standard-A";
  const langMatch = voiceParts.match(/^([a-z]{2}-[A-Z]{2})/);
  const languageCode = langMatch ? langMatch[1] : "en-US";

  const body = {
    input: { text },
    voice: {
      languageCode,
      name: voiceParts,
    },
    audioConfig: {
      audioEncoding: "MP3",
      speakingRate: parseRateToFloat(opts.rate),
      volumeGainDb: parseVolumeToDb(opts.volume),
      pitch: parsePitchToFloat(opts.pitch),
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Google TTS error ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  if (!data.audioContent) {
    throw new Error("Google TTS returned no audio");
  }

  // Decode base64 to ArrayBuffer
  const binaryString = atob(data.audioContent);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function parseVolumeToDb(volume) {
  // Accept both "+25%" (Edge TTS style) and plain numbers.
  if (volume == null || volume === "") return 0;
  if (typeof volume === "number") {
    return Math.max(-96, Math.min(24, volume));
  }
  const m = String(volume).match(/([+-]?\d+(?:\.\d+)?)\s*%/);
  if (m) {
    const pct = parseFloat(m[1]);
    // Convert percentage to dB (approximate)
    return Math.max(-96, Math.min(24, (pct / 100) * 20));
  }
  const n = parseFloat(volume);
  if (!isNaN(n)) return Math.max(-96, Math.min(24, n));
  return 0;
}

function parsePitchToFloat(pitch) {
  // Accept both "+25Hz" (Edge TTS style) and plain numbers.
  if (pitch == null || pitch === "") return 0;
  if (typeof pitch === "number") {
    return Math.max(-20, Math.min(20, pitch));
  }
  const m = String(pitch).match(/([+-]?\d+(?:\.\d+)?)\s*Hz/);
  if (m) {
    const hz = parseFloat(m[1]);
    // Convert Hz to semitones (approximate: 12 * log2(1 + hz/440))
    return Math.max(-20, Math.min(20, 12 * Math.log2(1 + Math.abs(hz) / 440) * Math.sign(hz)));
  }
  const n = parseFloat(pitch);
  if (!isNaN(n)) return Math.max(-20, Math.min(20, n));
  return 0;
}

// ─── Provider: Custom HTTP endpoint ─────────────────────────────────────────

/**
 * Custom TTS provider: user defines the endpoint URL and request format.
 *
 * Expected request: POST {url}
 * Body: { text, voice, rate, volume, pitch }
 * Response: audio binary (mp3/wav/ogg)
 *
 * This allows integration with any TTS service that accepts a simple
 * JSON request and returns audio.
 */
async function synthesizeCustom(text, opts) {
  const url = opts.apiUrl;
  if (!url) throw new Error("Custom TTS endpoint not configured");

  const headers = { "Content-Type": "application/json" };
  if (opts.apiKey) {
    headers["Authorization"] = `Bearer ${opts.apiKey}`;
  }

  const body = {
    text,
    voice: opts.voice,
    rate: opts.rate,
    volume: opts.volume,
    pitch: opts.pitch,
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Custom TTS error ${response.status}: ${errText.slice(0, 200)}`);
  }

  return await response.arrayBuffer();
}

// ─── Edge TTS helpers (shared) ──────────────────────────────────────────────

const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;

async function generateSecMsGec() {
  const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
  // Round DOWN to the current 5-minute boundary.
  // Empirically (2026-08-17, timing sweep) the server only accepts the
  // token a few seconds AFTER the window boundary — a fresh token at
  // t=0 is silently ignored, while the same token sent ~5s later works.
  // We therefore wait 8s after computing the token before returning it,
  // so that by the time the WebSocket handshake + SSML reach the server
  // the token is inside the accepted window.
  const now = Date.now() / 1000;
  const WIN_EPOCH = 11644473600;
  let ticks = now + WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= 1e7;
  const strToHash = `${Math.floor(ticks)}${TRUSTED_CLIENT_TOKEN}`;

  const encoder = new TextEncoder();
  const data = encoder.encode(strToHash);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  const token = hashHex.toUpperCase();
  await new Promise((resolve) => setTimeout(resolve, 8000));
  return token;
}

function generateMuid() {
  // 16 random bytes → 32 hex chars (matches the reference implementation).
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Derive the BCP-47 language tag from an Edge TTS voice name.
 * "zh-CN-XiaoxiaoNeural" → "zh-CN", "en-US-AvaMultilingualNeural" → "en-US".
 * Falls back to "en-US" for non-Edge voices or unparseable names.
 */
function voiceToLang(voice) {
  const m = (voice || "").match(/^([a-z]{2,3}(?:-[A-Z]{2})?)(?:-|$)/);
  return m ? m[1] : "en-US";
}

function buildSsml(text, opts) {
  const esc = escapeXml(text);
  const lang = voiceToLang(opts.voice);
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">` +
    `<voice name="${opts.voice}">` +
    `<prosody rate="${opts.rate}" volume="${opts.volume}" pitch="${opts.pitch}">` +
    esc +
    `</prosody></voice></speak>`
  );
}

// ─── Main entry: route to the correct provider ──────────────────────────────

/**
 * Synthesize text using the configured TTS provider.
 *
 * @param {string} text - Text to synthesize
 * @param {object} opts - TTS options:
 *   {
 *     provider: "edge-tts" | "openai" | "google" | "custom",
 *     voice: string,
 *     rate: string,      // "+0%"
 *     volume: string,    // "+0%"
 *     pitch: string,     // "+0Hz"
 *     apiUrl?: string,   // endpoint override
 *     apiKey?: string,   // API key (for openai/google/custom)
 *     model?: string,    // model name (for openai)
 *     trustedClientToken?: string,  // (for edge-tts)
 *   }
 * @returns {Promise<ArrayBuffer>} MP3/WAV audio data
 */
async function synthesizeSegment(text, opts) {
  const provider = opts.provider || "edge-tts";

  switch (provider) {
    case "edge-tts":
      return synthesizeEdgeTts(text, opts);
    case "openai":
      return synthesizeOpenAI(text, opts);
    case "google":
      return synthesizeGoogle(text, opts);
    case "custom":
      return synthesizeCustom(text, opts);
    default:
      throw new Error(`Unknown TTS provider: ${provider}`);
  }
}

// Export
if (typeof module !== "undefined") module.exports = { synthesizeSegment };
if (typeof self !== "undefined") self.synthesizeSegment = synthesizeSegment;
