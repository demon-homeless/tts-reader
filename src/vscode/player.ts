/**
 * player.ts — Playback queue and audio playback for Edge TTS segments.
 *
 * Strategy:
 *   - Segments are synthesized lazily (on demand) with a small preload
 *     window to keep latency low while still hiding network jitter.
 *   - Audio is played via a native audio backend. VSCode's extension host
 *     has no audio API, so we shell out to a system player:
 *       - Windows: PowerShell System.Media.SoundPlayer (WAV only) — but we
 *         have MP3, so we use `ffplay`/`mpv` if available, falling back to
 *         PowerShell with a WASAPI COM object, or `play` (sox).
 *       - macOS: `afplay`
 *       - Linux: `paplay` / `aplay` / `ffplay`
 *   - We detect the best available player at startup and cache it.
 *   - Playback rate is applied client-side via the player's speed flag.
 *
 * The player writes each segment's MP3 to a temp file, plays it, and waits
 * for completion before advancing to the next segment.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChildProcess, spawn } from "child_process";
import { Segment } from "../shared/segmenter";
import { TtsOptions, synthesizeSegment } from "./ttsEngine";
import { t } from "./l10n";

export type PlayerState = "idle" | "playing" | "paused" | "stopped";

export interface PlaybackCallbacks {
  onStateChange: (state: PlayerState) => void;
  onSegmentStart: (index: number, total: number, segment: Segment) => void;
  onSegmentEnd: (index: number, total: number) => void;
  onProgress: (current: number, total: number) => void;
  onError: (message: string) => void;
  onFinished: () => void;
}

/**
 * Detect the best available audio player on this platform.
 * Returns the command + args template, or null if none found.
 */
function detectPlayer(): { cmd: string; args: string[]; rateFlag: string } | null {
  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";

  const candidates: { cmd: string; args: string[]; rateFlag: string }[] = [];

  if (isMac) {
    // afplay supports -q (quiet) but not speed. We'll apply speed via
    // a different approach (none). afplay is reliable for MP3.
    candidates.push({ cmd: "afplay", args: ["{file}"], rateFlag: "" });
  }

  if (isWin) {
    // Prefer mpv (supports --speed), then ffplay, then PowerShell fallback.
    candidates.push({
      cmd: "mpv",
      args: ["--no-video", "--really-quiet", "--volume=100", "{rate}", "{file}"],
      rateFlag: "--speed={rate}",
    });
    candidates.push({
      cmd: "ffplay",
      args: ["-nodisp", "-autoexit", "-loglevel", "quiet", "-i", "{file}"],
      rateFlag: "",
    });
    // PowerShell fallback using WASAPI via a small script (no speed control)
    candidates.push({
      cmd: "powershell",
      args: ["-NoProfile", "-Command", "{ps}"],
      rateFlag: "",
    });
  } else {
    // Linux
    candidates.push({
      cmd: "mpv",
      args: ["--no-video", "--really-quiet", "--volume=100", "{rate}", "{file}"],
      rateFlag: "--speed={rate}",
    });
    candidates.push({
      cmd: "ffplay",
      args: ["-nodisp", "-autoexit", "-loglevel", "quiet", "-i", "{file}"],
      rateFlag: "",
    });
    candidates.push({
      cmd: "paplay",
      args: ["{file}"],
      rateFlag: "",
    });
  }

  // Try each candidate; return the first that exists on PATH.
  for (const c of candidates) {
    if (c.cmd === "powershell") continue; // always available on Windows
    if (commandExists(c.cmd)) {
      return c;
    }
  }
  // Fallback: on Windows, PowerShell is always there.
  if (isWin) {
    return candidates.find((c) => c.cmd === "powershell") || null;
  }
  return null;
}

function commandExists(cmd: string): boolean {
  try {
    const check = process.platform === "win32" ? `where ${cmd}` : `which ${cmd}`;
    const { execSync } = require("child_process");
    execSync(check, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the PowerShell command to play an MP3 file.
 * Uses the Windows Media Player COM object (WMP) which handles MP3.
 */
function buildPowerShellPlayCommand(file: string): string {
  const escaped = file.replace(/'/g, "''");
  return (
    `$wmp = New-Object -ComObject WMPlayer.OCX; ` +
    `$wmp.URL = '${escaped}'; ` +
    `while ($wmp.playState -ne 2) { Start-Sleep -Milliseconds 200 }; ` +
    `$wmp.Close()`
  );
}

/**
 * The playback engine. Manages the queue of segments, synthesizes audio
 * with a preload buffer, and plays each segment sequentially.
 *
 * Preload strategy: while segment N is playing, segments N+1..N+preload
 * are synthesized in the background and cached. This hides network
 * latency and ensures uninterrupted playback.
 */
export class PlaybackEngine {
  private state: PlayerState = "idle";
  private queue: Segment[] = [];
  private currentIndex = 0;
  private callbacks: PlaybackCallbacks;
  private player: { cmd: string; args: string[]; rateFlag: string } | null = null;
  private tempDir: string;
  private playbackRate: number;
  private proxyUrl?: string;
  private stopRequested = false;
  private pauseRequested = false;
  private currentProc: ChildProcess | null = null;
  /** Preload buffer size (number of segments to synthesize ahead). */
  private preloadCount: number;
  /** Cache of pre-synthesized audio buffers, keyed by segment index. */
  private audioCache: Map<number, Buffer> = new Map();
  /** Track in-flight synthesis promises to avoid duplicate work. */
  private inFlight: Map<number, Promise<Buffer>> = new Map();

  constructor(callbacks: PlaybackCallbacks, preloadCount = 2) {
    this.callbacks = callbacks;
    this.tempDir = path.join(os.tmpdir(), "edge-tts-vscode");
    fs.mkdirSync(this.tempDir, { recursive: true });
    this.playbackRate = 1.0;
    this.preloadCount = preloadCount;
  }

  getState(): PlayerState {
    return this.state;
  }

  setPlaybackRate(rate: number) {
    this.playbackRate = rate;
  }

  setProxy(url: string) {
    this.proxyUrl = url || undefined;
  }

  /**
   * Start playing a list of segments.
   */
  async start(segments: Segment[], ttsOpts: TtsOptions) {
    this.stop(); // stop any previous playback
    this.queue = segments;
    this.currentIndex = 0;
    this.stopRequested = false;
    this.pauseRequested = false;
    this.audioCache.clear();
    this.inFlight.clear();

    this.player = detectPlayer();
    if (!this.player) {
      this.callbacks.onError(t("msg.noPlayer"));
      this.setState("idle");
      return;
    }

    this.setState("playing");
    this.callbacks.onProgress(0, this.queue.length);

    // Kick off preload for the first N segments (non-blocking).
    this.preloadAhead(0, ttsOpts);

    // Run the playback loop in the background (don't block the caller).
    this.playLoop(ttsOpts);
  }

  /**
   * Preload the next `preloadCount` segments starting from `fromIndex`.
   * Synthesis runs in the background; results are cached in audioCache.
   */
  private preloadAhead(fromIndex: number, ttsOpts: TtsOptions): void {
    for (let i = fromIndex; i < Math.min(fromIndex + this.preloadCount, this.queue.length); i++) {
      if (this.audioCache.has(i) || this.inFlight.has(i)) continue;
      const seg = this.queue[i];
      const promise = synthesizeSegment(seg.text, ttsOpts)
        .then((audio) => {
          this.audioCache.set(i, audio);
          this.inFlight.delete(i);
          return audio;
        })
        .catch((err) => {
          this.inFlight.delete(i);
          // Preload failure is non-fatal — we'll retry on demand.
          console.warn(`Preload failed for segment ${i}: ${err.message}`);
          throw err;
        });
      this.inFlight.set(i, promise);
    }
  }

  /**
   * Get audio for a segment: from cache if available, otherwise synthesize.
   */
  private async getAudio(index: number, ttsOpts: TtsOptions): Promise<Buffer> {
    // Check cache first
    if (this.audioCache.has(index)) {
      return this.audioCache.get(index)!;
    }
    // Check in-flight
    if (this.inFlight.has(index)) {
      try {
        return await this.inFlight.get(index)!;
      } catch {
        // fall through to fresh synthesis
      }
    }
    // Synthesize on demand
    const seg = this.queue[index];
    const audio = await synthesizeSegment(seg.text, ttsOpts);
    this.audioCache.set(index, audio);
    return audio;
  }

  private async playLoop(ttsOpts: TtsOptions) {
    for (let i = this.currentIndex; i < this.queue.length; i++) {
      if (this.stopRequested) break;

      // Handle pause
      while (this.pauseRequested && !this.stopRequested) {
        await sleep(200);
      }
      if (this.stopRequested) break;

      const seg = this.queue[i];
      this.currentIndex = i;

      // Show "synthesizing" progress (segment not yet playing — audio is
      // still being generated). The status bar shows the current index so
      // the user knows we're working on segment i+1.
      this.callbacks.onProgress(i + 1, this.queue.length);

      // Preload the next segments while we wait for current audio.
      this.preloadAhead(i + 1, ttsOpts);

      try {
        // Get audio (from cache or synthesize). This may take several
        // seconds if the segment isn't preloaded.
        const audio = await this.getAudio(i, ttsOpts);
        if (this.stopRequested) break;

        // NOW the audio is ready and about to play. This is the correct
        // moment to fire onSegmentStart — the editor highlight will be
        // in sync with the audio (no more "highlight jumps ahead" issue).
        this.callbacks.onSegmentStart(i, this.queue.length, seg);

        // Write to temp file
        const file = path.join(this.tempDir, `seg_${i}.mp3`);
        fs.writeFileSync(file, audio);

        // Play it (blocks until done)
        await this.playFile(file);
        if (this.stopRequested) break;

        this.callbacks.onSegmentEnd(i, this.queue.length);
      } catch (err: any) {
        if (!this.stopRequested) {
          this.callbacks.onError(
            t("msg.segmentFailed", {
              current: i + 1,
              total: this.queue.length,
              error: err.message,
            })
          );
        }
        // Skip to next segment on error
      }
    }

    if (!this.stopRequested) {
      this.setState("idle");
      this.callbacks.onFinished();
    }
    this.cleanupTemp();
  }

  private playFile(file: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.player) {
        reject(new Error("No player"));
        return;
      }

      let cmd = this.player.cmd;
      let args: string[] = [];

      if (cmd === "powershell") {
        const psCmd = buildPowerShellPlayCommand(file);
        args = ["-NoProfile", "-Command", psCmd];
      } else {
        const rateArg = this.player.rateFlag
          ? this.player.rateFlag.replace("{rate}", String(this.playbackRate))
          : "";
        args = this.player.args
          .map((a) => {
            if (a === "{file}") return file;
            if (a === "{rate}") return rateArg;
            return a;
          })
          .filter((a) => a !== "" && a !== "{rate}" && a !== "{file}");
        // If rateFlag is empty, remove the {rate} placeholder
        if (!this.player.rateFlag) {
          args = args.filter((a) => a !== "");
        }
      }

      const proc = spawn(cmd, args, {
        stdio: "ignore",
        windowsHide: true,
      });
      this.currentProc = proc;

      proc.on("error", (err) => {
        this.currentProc = null;
        if (!this.stopRequested) reject(err);
        else resolve();
      });

      proc.on("close", (code) => {
        this.currentProc = null;
        if (this.stopRequested) {
          resolve();
        } else if (code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`Player exited with code ${code}`));
        }
      });
    });
  }

  pause() {
    if (this.state === "playing") {
      this.pauseRequested = true;
      this.setState("paused");
      // Kill current audio process
      if (this.currentProc) {
        try {
          this.currentProc.kill();
        } catch {
          /* ignore */
        }
      }
    } else if (this.state === "paused") {
      this.pauseRequested = false;
      this.setState("playing");
    }
  }

  skip() {
    // Skip current segment: kill current proc and advance index.
    if (this.currentProc) {
      try {
        this.currentProc.kill();
      } catch {
        /* ignore */
      }
    }
    this.currentIndex++;
  }

  stop() {
    if (this.state === "idle") return;
    this.stopRequested = true;
    this.pauseRequested = false;
    if (this.currentProc) {
      try {
        this.currentProc.kill();
      } catch {
        /* ignore */
      }
    }
    this.setState("stopped");
    this.cleanupTemp();
    // Reset to idle after a tick
    setTimeout(() => {
      if (this.state === "stopped") this.setState("idle");
    }, 100);
  }

  /**
   * Manually clean up all temp audio files. Returns the number of files
   * removed.
   */
  cleanupTempFiles(): number {
    let removed = 0;
    try {
      if (fs.existsSync(this.tempDir)) {
        for (const f of fs.readdirSync(this.tempDir)) {
          if (f.startsWith("seg_") && f.endsWith(".mp3")) {
            fs.unlinkSync(path.join(this.tempDir, f));
            removed++;
          }
        }
      }
    } catch {
      /* ignore */
    }
    return removed;
  }

  private setState(s: PlayerState) {
    if (this.state !== s) {
      this.state = s;
      this.callbacks.onStateChange(s);
    }
  }

  private cleanupTemp() {
    try {
      if (fs.existsSync(this.tempDir)) {
        for (const f of fs.readdirSync(this.tempDir)) {
          if (f.startsWith("seg_") && f.endsWith(".mp3")) {
            fs.unlinkSync(path.join(this.tempDir, f));
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
