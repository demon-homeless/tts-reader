/**
 * ttsEngine.ts — Provider-agnostic TTS engine for the VSCode extension.
 *
 * Supports multiple TTS backends through a unified interface:
 *
 *   1. edge-tts   — Microsoft Edge TTS (Python package or Node WebSocket)
 *   2. openai     — OpenAI TTS API (POST /v1/audio/speech)
 *   3. google     — Google Cloud TTS (POST /v1/text:synthesize)
 *   4. custom     — User-defined HTTP endpoint
 *
 * Each provider implements:
 *   synthesize(text, opts) → Promise<Buffer>
 *
 * The engine selects the active provider based on configuration.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile, spawn, ChildProcess } from "child_process";
import * as https from "https";
import * as http from "http";

// ─── Types ──────────────────────────────────────────────────────────────────

export type TtsProvider = "edge-tts" | "openai" | "google" | "custom";

export interface TtsOptions {
  /** Which TTS provider to use. */
  provider: TtsProvider;
  voice: string;
  rate: string; // e.g. "+0%"
  volume: string; // e.g. "+0%"
  pitch: string; // e.g. "+0Hz"
  /** Optional API endpoint override. */
  apiUrl?: string;
  /** Optional API key (for openai/google/custom). */
  apiKey?: string;
  /** Optional model name (for openai). */
  model?: string;
  /** Optional TrustedClientToken override (for edge-tts Node fallback). */
  trustedClientToken?: string;
  /** Optional proxy URL. */
  proxyUrl?: string;
}

// ─── Provider: Edge TTS ─────────────────────────────────────────────────────

/**
 * Check if Python + edge-tts is available.
 * Result is cached after the first check.
 */
let pythonChecked = false;
let pythonAvailable = false;

async function checkPython(): Promise<boolean> {
  if (pythonChecked) return pythonAvailable;
  pythonChecked = true;
  pythonAvailable = await new Promise((resolve) => {
    execFile("python", ["-c", "import edge_tts"], (err) => {
      resolve(!err);
    });
  });
  return pythonAvailable;
}

/**
 * Synthesize using the Python edge-tts package.
 */
function synthesizeWithPython(
  text: string,
  opts: TtsOptions,
  outFile: string
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const textFile = outFile + ".txt";
    fs.writeFileSync(textFile, text, "utf8");

    const rate = opts.rate || "+0%";
    const volume = opts.volume || "+0%";
    const pitch = opts.pitch || "+0Hz";

    const pyScript = `
import asyncio, sys, edge_tts
async def main():
    text = open(${JSON.stringify(textFile)}, encoding='utf-8').read()
    comm = edge_tts.Communicate(
        text,
        ${JSON.stringify(opts.voice)},
        rate=${JSON.stringify(rate)},
        volume=${JSON.stringify(volume)},
        pitch=${JSON.stringify(pitch)},
    )
    await comm.save(${JSON.stringify(outFile)})
asyncio.run(main())
`;

    const proc = spawn("python", ["-c", pyScript], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stderr = "";
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => {
      try { fs.unlinkSync(textFile); } catch { /* ignore */ }
      reject(new Error(`Python edge-tts spawn failed: ${err.message}`));
    });
    proc.on("close", (code) => {
      try { fs.unlinkSync(textFile); } catch { /* ignore */ }
      if (code === 0 && fs.existsSync(outFile)) {
        const audio = fs.readFileSync(outFile);
        try { fs.unlinkSync(outFile); } catch { /* ignore */ }
        resolve(audio);
      } else {
        reject(new Error(`Python edge-tts exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}

// ─── Edge TTS Node WebSocket (fallback) ─────────────────────────────────────

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;

function generateSecMsGec(): string {
  const now = Date.now() / 1000;
  const WIN_EPOCH = 11644473600;
  let ticks = now + WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= 1e7;
  const strToHash = `${Math.floor(ticks)}${TRUSTED_CLIENT_TOKEN}`;
  return crypto
    .createHash("sha256")
    .update(strToHash, "ascii")
    .digest("hex")
    .toUpperCase();
}

function generateMuid(): string {
  return crypto.randomBytes(12).toString("hex").toUpperCase();
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildSsml(text: string, opts: TtsOptions): string {
  const esc = escapeXml(text);
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">` +
    `<voice name="${opts.voice}">` +
    `<prosody rate="${opts.rate}" volume="${opts.volume}" pitch="${opts.pitch}">` +
    esc +
    `</prosody></voice></speak>`
  );
}

class MiniWebSocket {
  private socket: any;
  private ready = false;
  private buffer: Buffer = Buffer.alloc(0);
  private closed = false;
  private handlers: {
    open?: () => void;
    message?: (payload: Buffer, opcode: number) => void;
    close?: () => void;
    error?: (err: Error) => void;
  } = {};

  constructor(url: string, headers: Record<string, string>, proxyUrl?: string) {
    this.connect(url, headers, proxyUrl);
  }

  on(event: string, cb: any) {
    (this.handlers as any)[event] = cb;
  }

  private connect(url: string, headers: Record<string, string>, proxyUrl?: string) {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString("base64");
    const wsHeaders = {
      ...headers,
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Key": key,
      "Sec-WebSocket-Version": "13",
    };

    const mod = u.protocol === "wss:" ? https : http;

    const opts: any = {
      host: u.hostname,
      port: u.port || (u.protocol === "wss:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET",
    };

    const req = mod.request(opts, (res: any) => {
      if (res.statusCode !== 101) {
        this.handlers.error?.(
          new Error(`WebSocket upgrade failed: HTTP ${res.statusCode}`)
        );
        res.resume();
        res.on("end", () => this.handlers.close?.());
        return;
      }
      this.socket = res.socket;
      this.socket.setNoDelay(true);
      this.socket.setKeepAlive(true);
      this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
      this.socket.on("error", (err: Error) => this.handlers.error?.(err));
      this.socket.on("close", () => {
        if (!this.closed) {
          this.closed = true;
          this.handlers.close?.();
        }
      });
      this.ready = true;
      this.handlers.open?.();
    });

    req.on("error", (err: Error) => this.handlers.error?.(err));
    for (const [k, v] of Object.entries(wsHeaders)) req.setHeader(k, v);
    req.end();
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const frame = this.parseFrame();
      if (!frame) break;
      if (frame.opcode === 0x8) {
        this.closed = true;
        this.handlers.close?.();
        return;
      } else if (frame.opcode === 0x9) {
        this.sendRaw(0xa, frame.payload);
      } else if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        this.handlers.message?.(frame.payload, frame.opcode);
      }
    }
  }

  private parseFrame(): { opcode: number; payload: Buffer } | null {
    const b = this.buffer;
    if (b.length < 2) return null;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      len = Number(b.readBigUInt64BE(2));
      offset = 10;
    }
    let maskKey: Buffer | null = null;
    if (masked) {
      if (b.length < offset + 4) return null;
      maskKey = b.slice(offset, offset + 4);
      offset += 4;
    }
    if (b.length < offset + len) return null;
    let payload = b.slice(offset, offset + len);
    if (masked && maskKey) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++)
        payload[i] ^= maskKey[i % 4];
    }
    this.buffer = this.buffer.slice(offset + len);
    return { opcode, payload };
  }

  send(data: string | Buffer) {
    if (!this.ready || this.closed) return;
    if (typeof data === "string") this.sendRaw(0x1, Buffer.from(data, "utf8"));
    else this.sendRaw(0x2, data);
  }

  private sendRaw(opcode: number, payload: Buffer) {
    if (!this.socket) return;
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const maskedPayload = Buffer.from(payload);
    for (let i = 0; i < maskedPayload.length; i++)
      maskedPayload[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, maskedPayload]));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket?.end(); } catch { /* ignore */ }
    this.handlers.close?.();
  }
}

function synthesizeWithNode(
  text: string,
  opts: TtsOptions,
  proxyUrl?: string
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const token = generateSecMsGec();
    const baseApiUrl =
      opts.apiUrl ||
      "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
    const clientToken = opts.trustedClientToken || TRUSTED_CLIENT_TOKEN;
    const muid = generateMuid();
    const url =
      baseApiUrl +
      `?TrustedClientToken=${clientToken}` +
      `&Sec-MS-GEC=${token}` +
      `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

    const headers: Record<string, string> = {
      "Sec-MS-GEC": token,
      "Pragma": "no-cache",
      "Cache-Control": "no-cache",
      "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_FULL_VERSION.split(".")[0]}.0.0.0 Safari/537.36 Edg/${CHROMIUM_FULL_VERSION.split(".")[0]}.0.0.0`,
      "Accept-Language": "en-US,en;q=0.9",
      "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      "Cookie": `muid=${muid};`,
    };

    const ws = new MiniWebSocket(url, headers, proxyUrl);
    const audioChunks: Buffer[] = [];
    let gotOpen = false;
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new Error("Edge TTS (Node) request timed out (30s)"));
      }
    }, 30000);

    ws.on("open", () => {
      gotOpen = true;
      const config = {
        context: {
          synthesis: {
            audio: {
              autostop: true,
              encoding: {
                container: "audio-24khz-48kbitrate-mono-mp3",
                codec: "audio/L16;rate=24000",
              },
              wordboundary: "json",
            },
          },
        },
        configuration: {
          name: opts.voice,
          autostop: true,
          format: "audio-24khz-48kbitrate-mono-mp3",
        },
        version: "1.0",
      };
      ws.send(JSON.stringify(config));
      ws.send(buildSsml(text, opts));
      ws.send(JSON.stringify({ messageid: crypto.randomUUID() }));
    });

    ws.on("message", (payload: Buffer, opcode: number) => {
      if (opcode === 0x2) audioChunks.push(payload);
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (audioChunks.length > 0) {
        resolve(Buffer.concat(audioChunks));
      } else if (gotOpen) {
        reject(new Error("Edge TTS (Node) closed without audio"));
      }
    });

    ws.on("error", (err: Error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

/**
 * Edge TTS provider: tries Python first, falls back to Node WebSocket.
 */
async function synthesizeEdgeTts(
  text: string,
  opts: TtsOptions
): Promise<Buffer> {
  // Skip the Python backend entirely if it's not available (cached check).
  if (await checkPython()) {
    try {
      const outFile = path.join(
        os.tmpdir(),
        `edge-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`
      );
      const audio = await synthesizeWithPython(text, opts, outFile);
      if (audio.length > 0) return audio;
    } catch {
      // Python failed — fall through to Node
    }
  }
  return synthesizeWithNode(text, opts, opts.proxyUrl);
}

// ─── Provider: OpenAI TTS ───────────────────────────────────────────────────

function mapVoiceToOpenAI(edgeVoice: string): string {
  const map: Record<string, string> = {
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

function parseRateToFloat(rate: string): number {
  if (!rate) return 1.0;
  const m = rate.match(/([+-]?\d+(?:\.\d+)?)\s*%/);
  if (m) {
    const pct = parseFloat(m[1]);
    return Math.max(0.25, Math.min(4.0, 1.0 + pct / 100));
  }
  return 1.0;
}

async function synthesizeOpenAI(
  text: string,
  opts: TtsOptions
): Promise<Buffer> {
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error("OpenAI API key not configured");

  const baseUrl = opts.apiUrl || "https://api.openai.com/v1";
  const url = `${baseUrl}/audio/speech`;

  const body = JSON.stringify({
    model: opts.model || "tts-1",
    input: text,
    voice: mapVoiceToOpenAI(opts.voice),
    response_format: "mp3",
    speed: parseRateToFloat(opts.rate),
  });

  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let errData = "";
          res.on("data", (d) => (errData += d));
          res.on("end", () =>
            reject(
              new Error(
                `OpenAI TTS error ${res.statusCode}: ${errData.slice(0, 200)}`
              )
            )
          );
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Provider: Google Cloud TTS ─────────────────────────────────────────────

function parseVolumeToDb(volume: string): number {
  if (!volume) return 0;
  const m = volume.match(/([+-]?\d+(?:\.\d+)?)\s*%/);
  if (m) {
    const pct = parseFloat(m[1]);
    return Math.max(-96, Math.min(24, (pct / 100) * 20));
  }
  return 0;
}

function parsePitchToFloat(pitch: string): number {
  if (!pitch) return 0;
  const m = pitch.match(/([+-]?\d+(?:\.\d+)?)\s*Hz/);
  if (m) {
    const hz = parseFloat(m[1]);
    return Math.max(
      -20,
      Math.min(20, 12 * Math.log2(1 + Math.abs(hz) / 440) * Math.sign(hz))
    );
  }
  return 0;
}

async function synthesizeGoogle(
  text: string,
  opts: TtsOptions
): Promise<Buffer> {
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error("Google API key not configured");

  const voiceParts = opts.voice || "en-US-Standard-A";
  const langMatch = voiceParts.match(/^([a-z]{2}-[A-Z]{2})/);
  const languageCode = langMatch ? langMatch[1] : "en-US";

  const body = JSON.stringify({
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
  });

  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`;

  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let errData = "";
          res.on("data", (d) => (errData += d));
          res.on("end", () =>
            reject(
              new Error(
                `Google TTS error ${res.statusCode}: ${errData.slice(0, 200)}`
              )
            )
          );
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!data.audioContent) {
              reject(new Error("Google TTS returned no audio"));
              return;
            }
            resolve(Buffer.from(data.audioContent, "base64"));
          } catch (err: any) {
            reject(new Error(`Google TTS parse error: ${err.message}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Provider: Custom HTTP endpoint ─────────────────────────────────────────

async function synthesizeCustom(
  text: string,
  opts: TtsOptions
): Promise<Buffer> {
  const url = opts.apiUrl;
  if (!url) throw new Error("Custom TTS endpoint not configured");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.apiKey) {
    headers["Authorization"] = `Bearer ${opts.apiKey}`;
  }

  const body = JSON.stringify({
    text,
    voice: opts.voice,
    rate: opts.rate,
    volume: opts.volume,
    pitch: opts.pitch,
  });

  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          ...headers,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let errData = "";
          res.on("data", (d) => (errData += d));
          res.on("end", () =>
            reject(
              new Error(
                `Custom TTS error ${res.statusCode}: ${errData.slice(0, 200)}`
              )
            )
          );
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Main entry: route to the correct provider ──────────────────────────────

/**
 * Synthesize a text segment using the configured TTS provider.
 */
export async function synthesizeSegment(
  text: string,
  opts: TtsOptions
): Promise<Buffer> {
  switch (opts.provider) {
    case "edge-tts":
      return synthesizeEdgeTts(text, opts);
    case "openai":
      return synthesizeOpenAI(text, opts);
    case "google":
      return synthesizeGoogle(text, opts);
    case "custom":
      return synthesizeCustom(text, opts);
    default:
      throw new Error(`Unknown TTS provider: ${opts.provider}`);
  }
}

/**
 * Synthesize all segments sequentially.
 */
export async function synthesizeAll(
  texts: string[],
  opts: TtsOptions,
  onProgress: (index: number, total: number) => void
): Promise<Buffer[]> {
  const results: Buffer[] = new Array(texts.length);
  for (let i = 0; i < texts.length; i++) {
    onProgress(i, texts.length);
    results[i] = await synthesizeSegment(texts[i], opts);
  }
  return results;
}
