/**
 * l10n.ts — Runtime localization for the Edge TTS Reader extension.
 *
 * VSCode's `package.nls*.json` files handle command titles and setting
 * descriptions (resolved by VSCode itself based on `vscode.locale`). For
 * runtime strings (status bar, notifications, messages), we load the same
 * language files at runtime and provide a `t(key, params)` function.
 *
 * The language files are bundled at the extension root (package.nls.json,
 * package.nls.zh-cn.json, etc.). We detect the active locale from
 * `vscode.env.language` (e.g. "zh-cn", "en") and pick the matching file.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

type Messages = Record<string, string>;

let messages: Messages = {};
let loaded = false;

/**
 * Load the language file matching the current VSCode locale.
 * Falls back to the default (package.nls.json) if no match is found.
 */
function loadMessages(): Messages {
  if (loaded) return messages;
  loaded = true;

  const extPath = vscode.extensions.getExtension("local.edge-tts-reader")?.extensionUri
    ? vscode.extensions.getExtension("local.edge-tts-reader")!.extensionUri.fsPath
    : path.join(__dirname, "..", "..");

  // vscode.env.language is like "zh-cn", "en", "de", etc.
  const locale = (vscode.env.language || "en").toLowerCase();

  // Try locale-specific file first, then default.
  const candidates = [
    path.join(extPath, `package.nls.${locale}.json`),
    path.join(extPath, "package.nls.json"),
  ];

  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, "utf8");
        messages = JSON.parse(raw);
        return messages;
      }
    } catch {
      // fall through to next candidate
    }
  }

  // Last resort: empty object (keys will return as-is).
  messages = {};
  return messages;
}

/**
 * Translate a key, substituting {param} placeholders.
 *
 * @param key     The message key (e.g. "status.playing").
 * @param params  Optional object of {name: value} substitutions.
 * @returns       The translated string, or the key itself if not found.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const msgs = loadMessages();
  let str = msgs[key];
  if (str === undefined) {
    // Key not found — return the key as a fallback so the user sees
    // something meaningful rather than an empty string.
    return key;
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return str;
}
