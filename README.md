# TTS Reader

Long-text text-to-speech reader, shipped as **two products from one repo**:

- **VSCode extension** — read editor text, files, or clipboard aloud.
- **Chrome extension** — read web pages aloud (right-click any page).

Both use the same architecture — **segment → synthesize → play** — and support four TTS providers:

| Provider | API key | Notes |
|---|---|---|
| `edge-tts` *(default)* | No | Microsoft neural voices, free, WebSocket |
| `openai` | Yes | `tts-1` / `tts-1-hd`, high quality |
| `google` | Yes | Google Cloud TTS, wide voice selection |
| `custom` | Optional | Any HTTP endpoint: `POST {text, voice, rate, volume, pitch}` → audio |

## Features

- **Smart segmentation** — splits long text at sentence/paragraph boundaries, CJK-aware (。！？；…) and Latin-aware (respects decimals, abbreviations). Strips markdown, code fences, URLs, HTML.
- **Sequential playback with preloading** — synthesizes the next N segments ahead of the current one to hide network latency.
- **Full playback controls** — play, pause, resume, skip, stop.
- **Two speed knobs** — TTS `rate` (server-side, e.g. `+25%`) and client-side `playbackRate` (0.5×–3×).
- **Bilingual / multilingual UI** — VSCode: English + Chinese. Chrome: 8 locales (en, zh, ja, ko, fr, de, es, ru).

---

## VSCode Extension

### Install

From the `.vsix` file (see [Release](#release)), or after publishing, from the VSCode marketplace.

### Commands

Available via the command palette (`Ctrl/Cmd+Shift+P`) or the editor right-click context menu:

| Command | Description |
|---|---|
| `TTS: Read Selection` | Read selected text (whole file if nothing selected) |
| `TTS: Read from Cursor` | Read from the cursor's line to end of file |
| `TTS: Read File` | Read the entire current file |
| `TTS: Read Clipboard` | Read clipboard text |
| `TTS: Pause / Resume` | Toggle pause |
| `TTS: Skip Segment` | Jump to the next segment |
| `TTS: Stop` | Stop playback |
| `TTS: List Voices` | Browse and pick a voice (updates the setting) |
| `TTS: Clean Temp Files` | Remove cached audio files |

The status bar shows playback state (`Ready` / `n/total` / `Paused` / `Stopped`) and is clickable to stop.

### Settings

All settings are under the `ttsReader.` prefix.

| Setting | Default | Description |
|---|---|---|
| `ttsReader.provider` | `edge-tts` | `edge-tts` \| `openai` \| `google` \| `custom` |
| `ttsReader.voice` | `en-US-AvaMultilingualNeural` | Voice name (provider-specific) |
| `ttsReader.rate` | `+0%` | Speaking rate offset, e.g. `-20%`, `+25%` |
| `ttsReader.volume` | `+0%` | Volume offset |
| `ttsReader.pitch` | `+0Hz` | Pitch offset |
| `ttsReader.maxSegmentChars` | `180` | Max chars per segment (40–1000) |
| `ttsReader.minSegmentChars` | `20` | Min chars; shorter fragments merge with neighbors |
| `ttsReader.segmentMode` | `smart` | `smart` \| `sentence` \| `paragraph` |
| `ttsReader.preloadSegments` | `2` | Segments to synthesize ahead (0–10) |
| `ttsReader.playbackRate` | `1` | Client-side speed multiplier (0.5–3) |
| `ttsReader.proxyUrl` | *(empty)* | Optional HTTP(S) proxy for the TTS API |
| `ttsReader.apiUrl` | *(Edge default)* | Endpoint override (wss:// for Edge, https:// for others) |
| `ttsReader.apiKey` | *(empty)* | API key for `openai` / `google` / `custom` |
| `ttsReader.model` | *(empty)* | Model name (`openai` only, e.g. `tts-1`) |
| `ttsReader.trustedClientToken` | *(Edge default)* | Edge TTS `TrustedClientToken` override |

### Audio playback

VSCode's extension host has no audio API, so the extension shells out to a native player. It auto-detects the best available one:

- **macOS:** `afplay`
- **Windows / Linux:** `mpv` → `ffplay` → `paplay`/`afplay` → PowerShell WMP (Windows fallback)

If you get a "No audio player found" error, install [`mpv`](https://mpv.io/) or [`ffmpeg`](https://ffmpeg.org/) (for `ffplay`).

### Edge TTS (VSCode)

The `edge-tts` provider first tries the Python [`edge-tts`](https://pypi.org/project/edge-tts/) package if it's installed, then falls back to a built-in Node WebSocket client. No API key required.

---

## Chrome Extension

### Install

1. Run `npm run compile` (copies `src/chrome/` → `out/chrome/`).
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the `out/chrome/` directory.

### Usage

- **Right-click any page** → **Read This Page** or **Read Selection**.
- Playback happens in the **popup window** — keep it open while playing.
- Control playback via the right-click context menu: **Pause** / **Resume** / **Skip** / **Stop**.
- The popup shows live status (segment counter, progress bar) and quick settings (provider, voice, rate, API key). Click **Options** for the full settings page.

> **Why the popup?** Chrome aggressively throttles offscreen documents (timers clamped to 1 minute, `AudioContext` can't resume without a user gesture). The popup is a normal extension page with full audio capability, so playback stays reliable.

### Edge TTS (Chrome)

Browsers can't set custom WebSocket headers, which Edge TTS requires. The extension routes through an HTTP proxy:

1. **Remote proxy** (default): `https://tts.webextools.com/tts`
2. **Local proxy** (fallback): `http://127.0.0.1:8787/tts` — run `tools/edge-tts-proxy.js` (not committed)
3. **Direct WebSocket** (last resort) — works in Node, not in Chrome

You can override the proxy URL in the options page.

### Settings

Stored in `chrome.storage.sync` (syncs across devices). The options page (`options.html`) exposes all settings: provider, voice, rate, volume, pitch, segmentation (mode, max/min chars, preload), playback speed, API key, endpoint, model.

---

## Development

```bash
npm install        # install dev dependencies
npm run compile    # compile TS + copy Chrome assets to out/
npm run watch      # compile in watch mode
```

### Repository layout

```
src/
  shared/segmenter.ts     # Text segmentation (TypeScript, VSCode)
  vscode/                 # VSCode extension (TypeScript)
    extension.ts          #   entry point: commands, status bar
    ttsEngine.ts          #   TTS providers (Node)
    player.ts             #   playback queue + native player
    l10n.ts               #   runtime i18n
  chrome/                 # Chrome extension (plain JS, MV3)
    manifest.json         #   MV3 manifest
    background.js         #   service worker: sessions, synthesis
    content.js            #   page text extraction
    popup.html / .js      #   popup UI + settings
    popupPlayer.js        #   <audio> playback
    options.html / .js    #   options page
    ttsEngine.js          #   TTS providers (browser)
    segmenter.js          #   segmenter (browser port)
    i18n.js               #   runtime i18n (8 locales)
    _locales/             #   manifest-level i18n
package.json              # VSCode extension manifest + npm scripts
package.nls.json          # VSCode i18n (English)
package.nls.zh-cn.json    # VSCode i18n (Chinese)
out/                      # build output (gitignored)
```

> **Note:** the VSCode and Chrome extensions are **parallel implementations** — they share architecture but not code. The TTS engine and segmenter each exist in two forms (TypeScript for VSCode, plain JS for Chrome). If you change one, check whether the other needs the same change. See [`AGENTS.md`](AGENTS.md) for full invariants and conventions.

---

## Release

1. Bump `version` in both `package.json` and `src/chrome/manifest.json`.
2. `npm run compile` — regenerates `out/` (compiled VSCode + copied Chrome assets).
3. Package the VSIX: `npx @vscode/vsce package` → produces `sub-life-tts-reader-<version>.vsix`.
4. Commit source changes. The `.vsix` and `out/` are gitignored build artifacts.

---

## License

MIT
