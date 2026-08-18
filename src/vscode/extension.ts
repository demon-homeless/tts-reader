/**
 * extension.ts — VSCode extension entry point for TTS Reader.
 *
 * Registers commands, status bar item, and wires the segmentation + TTS +
 * playback pipeline together.
 */

import * as vscode from "vscode";
import { segmentText, SegmentMode } from "../shared/segmenter";
import { TtsOptions, TtsProvider } from "./ttsEngine";
import { PlaybackEngine, PlayerState } from "./player";
import { t } from "./l10n";

// ─── Configuration helpers ──────────────────────────────────────────────────

function getConfig(): {
  provider: TtsProvider;
  voice: string;
  rate: string;
  volume: string;
  pitch: string;
  maxChars: number;
  minChars: number;
  mode: SegmentMode;
  preload: number;
  playbackRate: number;
  proxyUrl: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  trustedClientToken: string;
} {
  const cfg = vscode.workspace.getConfiguration("ttsReader");
  return {
    provider: cfg.get<TtsProvider>("provider", "edge-tts"),
    voice: cfg.get<string>("voice", "en-US-AvaMultilingualNeural"),
    rate: cfg.get<string>("rate", "+0%"),
    volume: cfg.get<string>("volume", "+0%"),
    pitch: cfg.get<string>("pitch", "+0Hz"),
    maxChars: cfg.get<number>("maxSegmentChars", 180),
    minChars: cfg.get<number>("minSegmentChars", 20),
    mode: cfg.get<SegmentMode>("segmentMode", "smart"),
    preload: cfg.get<number>("preloadSegments", 2),
    playbackRate: cfg.get<number>("playbackRate", 1.0),
    proxyUrl: cfg.get<string>("proxyUrl", ""),
    apiUrl: cfg.get<string>("apiUrl", ""),
    apiKey: cfg.get<string>("apiKey", ""),
    model: cfg.get<string>("model", ""),
    trustedClientToken: cfg.get<string>("trustedClientToken", ""),
  };
}

function buildTtsOptions(): TtsOptions {
  const c = getConfig();
  return {
    provider: c.provider,
    voice: c.voice,
    rate: c.rate,
    volume: c.volume,
    pitch: c.pitch,
    apiUrl: c.apiUrl || undefined,
    apiKey: c.apiKey || undefined,
    model: c.model || undefined,
    trustedClientToken: c.trustedClientToken || undefined,
    proxyUrl: c.proxyUrl || undefined,
  };
}

// ─── Status bar ─────────────────────────────────────────────────────────────

// Four independent status bar items — only the relevant one(s) are shown
// based on the current player state.
const sbMain = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
const sbPlay = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
const sbPause = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
const sbStop = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);

sbPlay.command = "ttsReader.resume";
sbPause.command = "ttsReader.pause";
sbStop.command = "ttsReader.stop";

function showStatusItems(state: PlayerState) {
  sbMain.show();
  sbPlay.hide();
  sbPause.hide();
  sbStop.hide();
  switch (state) {
    case "playing":
      sbPause.show();
      sbStop.show();
      break;
    case "paused":
      sbPlay.show();
      sbStop.show();
      break;
    // idle / stopped: only sbMain
  }
}

function updateStatusBar(state: PlayerState, current: number, total: number) {
  // Update context keys for dynamic menu visibility
  void vscode.commands.executeCommand("setContext", "ttsReader.isPlaying", state === "playing");
  void vscode.commands.executeCommand("setContext", "ttsReader.isPaused", state === "paused");

  switch (state) {
    case "idle":
      sbMain.text = `$(volume-up) ${t("status.ready")}`;
      sbMain.tooltip = t("status.tooltip.ready");
      break;
    case "playing":
      sbMain.text = `$(play) ${t("status.playing", { current, total })}`;
      sbMain.tooltip = t("status.tooltip.playing");
      sbPause.text = "$(pause)";
      sbPause.tooltip = t("status.tooltip.pause");
      sbStop.text = "$(stop)";
      sbStop.tooltip = t("status.tooltip.stop");
      break;
    case "paused":
      sbMain.text = `$(pause) ${t("status.paused", { current, total })}`;
      sbMain.tooltip = t("status.tooltip.paused");
      sbPlay.text = "$(play)";
      sbPlay.tooltip = t("status.tooltip.resume");
      sbStop.text = "$(stop)";
      sbStop.tooltip = t("status.tooltip.stop");
      break;
    case "stopped":
      sbMain.text = `$(stop) ${t("status.stopped")}`;
      sbMain.tooltip = t("status.tooltip.stopped");
      break;
  }
  showStatusItems(state);
}

// ─── Active player ──────────────────────────────────────────────────────────

let engine: PlaybackEngine | null = null;

function getEngine(): PlaybackEngine {
  if (!engine) {
    const c = getConfig();
    engine = new PlaybackEngine(
      {
        onStateChange: (state) => {
          updateStatusBar(state, 0, 0);
        },
        onSegmentStart: (index, total) => {
          updateStatusBar("playing", index + 1, total);
        },
        onSegmentEnd: (index, total) => {
          updateStatusBar("playing", index + 1, total);
        },
        onProgress: (current, total) => {
          updateStatusBar("playing", current, total);
        },
        onError: (msg) => {
          vscode.window.showErrorMessage(msg);
        },
        onFinished: () => {
          vscode.window.showInformationMessage(t("msg.finished"));
        },
      },
      c.preload
    );
    engine.setPlaybackRate(c.playbackRate);
    engine.setProxy(c.proxyUrl);
  }
  return engine;
}

// ─── Read a text source ─────────────────────────────────────────────────────

async function startReading(text: string, sourceLabel: string) {
  if (!text || !text.trim()) {
    vscode.window.showWarningMessage(t("msg.noText"));
    return;
  }

  const c = getConfig();
  const ttsOpts = buildTtsOptions();

  // Show a progress notification while segmenting
  const segments = segmentText(text, {
    mode: c.mode,
    maxChars: c.maxChars,
    minChars: c.minChars,
  });

  if (segments.length === 0) {
    vscode.window.showWarningMessage(t("msg.noReadableText"));
    return;
  }

  const eng = getEngine();

  // Start playback without awaiting — the play loop runs in the
  // background. We show the notification immediately after kicking
  // off playback (before the first segment finishes) so the editor
  // view is not disturbed by a focus change from the notification.
  void eng.start(segments, ttsOpts);

  vscode.window.showInformationMessage(
    t("msg.reading", { source: sourceLabel, count: segments.length, voice: c.voice })
  );
}

// ─── Command registration ───────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  console.log("TTS Reader activated");

  // Read selection (or whole file if no selection)
  context.subscriptions.push(
    vscode.commands.registerCommand("ttsReader.readSelection", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(t("msg.noActiveEditor"));
        return;
      }
      const sel = editor.selection;
      if (!sel.isEmpty) {
        const text = editor.document.getText(sel);
        startReading(text, t("msg.selection"));
      } else {
        const text = editor.document.getText();
        startReading(text, `file: ${editor.document.fileName}`);
      }
    })
  );

  // Read entire current file
  context.subscriptions.push(
    vscode.commands.registerCommand("ttsReader.readFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(t("msg.noActiveEditor"));
        return;
      }
      const text = editor.document.getText();
      startReading(text, `file: ${editor.document.fileName}`);
    })
  );

  // Read clipboard
  context.subscriptions.push(
    vscode.commands.registerCommand("ttsReader.readClipboard", async () => {
      const text = await vscode.env.clipboard.readText();
      startReading(text, "clipboard");
    })
  );

  // Stop
  context.subscriptions.push(
    vscode.commands.registerCommand("ttsReader.stop", () => {
      if (engine) engine.stop();
    })
  );

  // Pause / resume
  context.subscriptions.push(
    vscode.commands.registerCommand("ttsReader.pause", () => {
      if (engine) engine.pause();
    })
  );

  // Resume (explicit, for right-click menu)
  context.subscriptions.push(
    vscode.commands.registerCommand("ttsReader.resume", () => {
      if (engine && engine.getState() === "paused") {
        engine.pause(); // pause() toggles: paused -> playing
      }
    })
  );

  // Read from the cursor's current line to end of file
  context.subscriptions.push(
    vscode.commands.registerCommand("ttsReader.readFromCursor", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(t("msg.noActiveEditor"));
        return;
      }
      const cursorLine = editor.selection.active.line; // 0-based
      const doc = editor.document;
      const startRange = new vscode.Range(cursorLine, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length);
      const text = doc.getText(startRange);
      if (!text.trim()) {
        vscode.window.showWarningMessage(t("msg.noTextFromCursor"));
        return;
      }
      startReading(text, t("msg.fromLine", { line: cursorLine + 1 }));
    })
  );

  // Skip to next segment
  context.subscriptions.push(
    vscode.commands.registerCommand("ttsReader.skipNext", () => {
      if (engine) engine.skip();
    })
  );

  // List voices (fetch from Edge TTS or show a curated list)
  context.subscriptions.push(
    vscode.commands.registerCommand("ttsReader.listVoices", () => {
      showVoiceList();
    })
  );

  // Clean up temp audio files
  context.subscriptions.push(
    vscode.commands.registerCommand("ttsReader.cleanupTemp", () => {
      if (engine) {
        const removed = engine.cleanupTempFiles();
        vscode.window.showInformationMessage(
          t("msg.cleaned", { count: removed })
        );
      } else {
        vscode.window.showInformationMessage(t("msg.noTempFiles"));
      }
    })
  );

  // Update status bar on config change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ttsReader")) {
        const c = getConfig();
        if (engine) {
          engine.setPlaybackRate(c.playbackRate);
          engine.setProxy(c.proxyUrl);
        }
      }
    })
  );

  updateStatusBar("idle", 0, 0);
}

export function deactivate() {
  if (engine) engine.stop();
}

// ─── Voice list ─────────────────────────────────────────────────────────────

/**
 * A curated list of common Edge TTS voices. The full list (100+) can be
 * fetched from the Edge TTS API, but this covers the most-used ones.
 */
const VOICES: { name: string; desc: string }[] = [
  { name: "zh-CN-XiaoxiaoNeural", desc: "Chinese (Mandarin, China) — Female, warm" },
  { name: "zh-CN-YunxiNeural", desc: "Chinese (Mandarin, China) — Male, youthful" },
  { name: "zh-CN-YunjianNeural", desc: "Chinese (Mandarin, China) — Male, sports" },
  { name: "zh-CN-XiaoyiNeural", desc: "Chinese (Mandarin, China) — Female, cute" },
  { name: "zh-CN-YunyangNeural", desc: "Chinese (Mandarin, China) — Male, news" },
  { name: "zh-HK-HiuhaaNeural", desc: "Chinese (Cantonese, HK) — Female" },
  { name: "zh-TW-HsiaoChenNeural", desc: "Chinese (Taiwan) — Female" },
  { name: "en-US-AriaNeural", desc: "English (US) — Female, friendly" },
  { name: "en-US-GuyNeural", desc: "English (US) — Male, friendly" },
  { name: "en-US-JennyNeural", desc: "English (US) — Female, professional" },
  { name: "en-GB-SoniaNeural", desc: "English (UK) — Female, professional" },
  { name: "en-AU-NatashaNeural", desc: "English (Australia) — Female" },
  { name: "ja-JP-NanamiNeural", desc: "Japanese — Female, friendly" },
  { name: "ja-JP-KeitaNeural", desc: "Japanese — Male" },
  { name: "ko-KR-SunHiNeural", desc: "Korean — Female, friendly" },
  { name: "fr-FR-DeniseNeural", desc: "French (France) — Female" },
  { name: "de-DE-KatjaNeural", desc: "German — Female" },
  { name: "es-ES-ElviraNeural", desc: "Spanish (Spain) — Female" },
  { name: "ru-RU-SvetlanaNeural", desc: "Russian — Female" },
  { name: "pt-BR-FranciscaNeural", desc: "Portuguese (Brazil) — Female" },
];

async function showVoiceList() {
  const items = VOICES.map((v) => ({
    label: v.name,
    description: v.desc,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    title: t("voiceList.title"),
    placeHolder: t("voiceList.placeholder"),
    ignoreFocusOut: true,
  });

  if (selected) {
    const voiceName =
      typeof selected === "string" ? selected : (selected as any).label;
    await vscode.workspace
      .getConfiguration("ttsReader")
      .update("voice", voiceName, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(t("msg.voiceSet", { voice: voiceName }));
  }
}
