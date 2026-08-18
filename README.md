# TTS Reader

Long-text TTS reader for VSCode and Chrome. Supports multiple TTS providers:
Edge TTS (Microsoft neural voices), OpenAI, Google Cloud TTS, and custom HTTP endpoints.

## Features

- **Smart segmentation** — splits long text at sentence/paragraph boundaries
- **Multiple providers** — Edge TTS (free, no API key), OpenAI, Google Cloud TTS, custom
- **Sequential playback** — plays segments in order with preloading
- **Playback controls** — play, pause, resume, skip, stop
- **Adjustable speed** — TTS rate + client-side playback speed
- **Bilingual UI** — English and Chinese (VSCode), 8 languages (Chrome)

## VSCode Extension

Install from the `.vsix` file or from the VSCode marketplace.

Commands (right-click context menu or command palette):
- `TTS: Read Selection` — read selected text (or whole file)
- `TTS: Read File` — read the entire current file
- `TTS: Read from Cursor` — read from cursor to end of file
- `TTS: Read Clipboard` — read clipboard text
- `TTS: Pause` / `TTS: Resume` / `TTS: Skip Next` / `TTS: Stop`
- `TTS: List Voices` — browse available voices
- `TTS: Cleanup Temp` — remove cached audio files

Settings (prefix `edgeTts.`):
- `provider` — `edge-tts` | `openai` | `google` | `custom`
- `voice` — voice name (provider-specific)
- `rate` / `volume` / `pitch` — speech parameters
- `maxSegmentChars` / `minSegmentChars` — segmentation
- `segmentMode` — `smart` | `sentence` | `paragraph`
- `playbackRate` — client-side speed multiplier
- `proxyUrl` — optional HTTP proxy for Edge TTS
- `apiKey` / `apiUrl` / `model` — for OpenAI/Google/custom providers

## Chrome Extension

Load from `out/chrome/` in `chrome://extensions` (Developer Mode → Load unpacked).

Right-click any page → "Read This Page" or "Read Selection". Playback happens
in the popup (keep it open while playing). Controls via context menu.
