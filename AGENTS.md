# AGENTS.md

Guidance for AI agents (and humans) working in this repository.

## What this project is

**TTS Reader** — a long-text text-to-speech reader shipped as **two products from one repo**:

1. **VSCode extension** (`src/vscode/`, TypeScript) — reads editor text, clipboard, or files aloud.
2. **Chrome extension** (`src/chrome/`, plain JavaScript, Manifest V3) — reads web pages aloud.

Both share the same architecture: **segment → synthesize → play**, with a provider-agnostic TTS engine supporting four backends: `edge-tts` (default, free), `openai`, `google`, and `custom` HTTP endpoints.

## Repository layout

```
src/
  shared/
    segmenter.ts        # Text segmentation (shared logic, TS, compiled for VSCode)
  vscode/
    extension.ts        # VSCode entry point: commands, status bar, config wiring
    ttsEngine.ts        # TTS providers (Node/TS): edge-tts, openai, google, custom
    player.ts           # PlaybackEngine: queue, preload, native audio player shell-out
    l10n.ts             # Runtime i18n for VSCode (loads package.nls*.json)
  chrome/
    manifest.json       # MV3 manifest (icons live in icons/, not committed here)
    background.js       # Service worker: session state, synthesis, tab messaging
    content.js          # Content script: text extraction + in-page <audio> playback
    popup.html/js       # Popup UI: status + settings only (no audio)
    options.html/js     # Full options page
    ttsEngine.js        # TTS providers (browser JS)
    segmenter.js        # Segmenter ported for the browser (plain JS)
    i18n.js             # Runtime i18n, 8 locales (en, zh_CN, ja, ko, fr, de, es, ru)
    _locales/           # Chrome manifest-level i18n (per-locale messages.json)
package.json            # VSCode extension manifest + npm scripts
package.nls.json        # VSCode i18n (default English)
package.nls.zh-cn.json  # VSCode i18n (Chinese)
tsconfig.json           # TS config (strict, ES2022, commonjs, outDir: out/)
out/                    # Build output (gitignored; compiled VSCode + copied Chrome assets)
```

## Build & dev commands

```bash
npm install          # install deps (typescript, @types/vscode, ws)
npm run compile      # tsc -p ./ && copy src/chrome → out/chrome
npm run watch        # tsc in watch mode
npm run lint         # eslint src --ext ts (note: eslint is NOT in devDependencies)
```

**Important:** `npm run compile` does two things:
1. Compiles TypeScript (`src/` → `out/`).
2. Copies `src/chrome/` → `out/chrome/` via an inline node script.

The Chrome extension is loaded from `out/chrome/` (after compile), NOT `src/chrome/`.

There is **no test suite** in the repo. `.vscodeignore` references `test-*` files that are not committed.

## Key invariants (do not break)

### 1. The two TTS engines are parallel implementations, not shared code
- `src/vscode/ttsEngine.ts` (TypeScript, Node APIs: `https`, `http`, `child_process`, `crypto`)
- `src/chrome/ttsEngine.js` (plain JS, browser APIs: `fetch`, `WebSocket`, `crypto.subtle`)

They implement the same `synthesizeSegment(text, opts) → audio` contract but use different transports. **If you change one, check whether the other needs the same change** (e.g. a new provider, a protocol fix, a voice-mapping update).

### 2. The segmenter exists in two forms
- `src/shared/segmenter.ts` — TypeScript, used by the VSCode extension.
- `src/chrome/segmenter.js` — plain-JS port, used by the Chrome extension.

**If you change segmentation logic, update both** and keep the behavior identical.

### 3. Chrome playback lives in the content script (in-page <audio>)
Audio playback happens in a hidden `<audio>` element created by the content script in the user's active tab. The popup is a pure status/settings panel.
- The background sends base64-encoded MP3 segments to the content script via `chrome.tabs.sendMessage(tabId, ...)`. The content script decodes them into a Blob, creates an object URL, and plays via `<audio>`.
- A heartbeat (3s `ttsPing`) detects if the tab was closed or navigated; on failure the session is stopped.
- The `<audio>` element is created lazily on first play and torn down on stop. `pagehide` also triggers teardown.
- All `chrome.tabs.sendMessage` calls are wrapped with a 5s timeout to prevent the service worker from hanging.
- Do NOT move playback to an offscreen document (`chrome.offscreen` API can block the SW event loop) or to a background tab (intrusive, may be throttled).

### 4. Session generation counter
Both the Chrome background and the content script use a **monotonically increasing generation counter** to drop stale messages. Every `stop`/`skip`/`start` bumps it. The content script drops `play` messages whose generation is **older** than the current one (newer generations are accepted as new sessions). **Preserve this mechanism** when touching session lifecycle.

### 5. Edge TTS specifics (fragile, protocol-dependent)
- **VSCode (Node):** tries Python `edge-tts` package first, falls back to a hand-rolled WebSocket client (`MiniWebSocket` in `ttsEngine.ts`). The WS handshake needs `TrustedClientToken`, `Sec-MS-GEC` (SHA-256 of a 5-min-window tick + token), and a Chromium `User-Agent`.
- **Chrome (browser):** browsers can't set custom WS headers, so it routes through an **HTTP proxy**:
  1. `https://tts.webextools.com/tts` (POST JSON) — remote default
  2. `http://127.0.0.1:8787/tts` (GET query) — local proxy (`tools/edge-tts-proxy.js`, not committed)
  3. Direct WebSocket fallback (works in Node, not in Chrome)
- The Chrome `generateSecMsGec()` **waits 8s** after computing the token because the server only accepts the token a few seconds after the 5-minute window boundary. This is an empirical workaround — don't "clean it up."
- The `TrustedClientToken` default `6A5AA1D4EAFF4E9FB37E23D68491D6F4` is a public constant from the Edge read-aloud extension. It can change on Microsoft's side; it's overridable via `ttsReader.trustedClientToken` / options page.

### 6. VSCode audio playback shells out to a native player
VSCode's extension host has no audio API. `player.ts` detects and uses (in order): `mpv` → `ffplay` → `paplay`/`afplay` → PowerShell WMP COM (Windows fallback). Each segment's MP3 is written to a temp file (`%TEMP%/edge-tts-vscode/`), played, then cleaned up. **Don't assume an in-process audio API exists.**

### 7. i18n is layered and locale-specific
- **VSCode:** `package.nls.json` (en) + `package.nls.zh-cn.json` (zh). VSCode resolves command titles/setting descriptions from these. Runtime strings (status bar, notifications) are loaded by `l10n.ts` via `t(key, params)`.
- **Chrome:** `i18n.js` holds all UI strings for 8 locales inline. `_locales/*/messages.json` covers only manifest-level strings.
- **When adding a user-facing string:** add it to the right layer for each product. For VSCode, add to BOTH `package.nls.json` and `package.nls.zh-cn.json`. For Chrome, add to the relevant locale(s) in `i18n.js`.

### 8. Settings are namespaced `ttsReader.*` (VSCode) / `chrome.storage.sync` (Chrome)
Setting keys were renamed from `edgeTts.*` to `ttsReader.*` in v0.1.0. **Do not reintroduce `edgeTts.*` keys.** The Chrome extension stores settings in `chrome.storage.sync` with the same key names (camelCase, no prefix).

## Code style conventions

- **TypeScript** (`src/vscode/`, `src/shared/`): strict mode, ES2022, commonjs. 2-space indent. Use `import * as x from "..."`.
- **Plain JavaScript** (`src/chrome/`): no modules (service worker uses `importScripts`), 2-space indent, `const`/`let` (no `var`), template literals.
- **Comments:** section headers use `// ─── Title ───────────────` box-drawing style. Keep this style for new sections.
- **Error handling:** TTS synthesis failures are non-fatal per-segment — the player skips the bad segment and continues. Don't make a single segment failure abort the whole session.
- **No external runtime deps** beyond `ws` (VSCode) and browser built-ins. Keep it that way.

## What NOT to do

- Don't add a test framework or CI — none exists and isn't requested.
- Don't refactor the Chrome extension to use ES modules — MV3 service workers here use `importScripts`.
- Don't remove the 8-second Edge TTS token delay or the generation counter.
- Don't commit `out/`, `node_modules/`, `*.vsix`, or `package-lock.json` (all gitignored).
- Don't change the `publisher` field in `package.json` (currently `local`) without being asked.
- Don't add secrets, API keys, or tokens to the repo. The `TrustedClientToken` is a public constant, not a secret.

## Release process

1. Bump `version` in `package.json` (and `src/chrome/manifest.json` — keep them in sync).
2. `npm run compile` (regenerates `out/` including Chrome assets).
3. Package the `.vsix`: `npx @vscode/vsce package` (not currently scripted).
4. Commit. The `.vsix` is gitignored — it's a build artifact, not source.

## Git

- Branch: `master`.
- Two remotes: `github` (`github:demon-homeless/tts-reader`) and `gitlan` (`git:demon-homeless/tts-reader`). Keep both in sync when pushing.
