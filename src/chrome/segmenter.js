/**
 * segmenter.js — Long-text segmentation engine for Edge TTS (browser version).
 *
 * Ported from the VSCode extension's segmenter.ts. No Node.js dependencies.
 *
 * Multi-layer strategy:
 *   1. Pre-normalization: collapse whitespace, normalize quotes/dashes,
 *      strip non-speakable artifacts (markdown, code fences, URLs).
 *   2. Sentence splitting: break on terminal punctuation (。！？.!?；;… —)
 *      while respecting abbreviations and decimal numbers.
 *   3. Length-aware grouping: merge short sentences and split long ones so
 *      each segment falls in [minChars, maxChars].
 *   4. Paragraph mode: split on blank lines first, then sentence-split inside.
 */

const CJK_TERMINALS = new Set(["。", "！", "？", "；", "…"]);
const LATIN_TERMINALS = new Set([".", "!", "?", ";", ":"]);

const ABBREVIATIONS = new Set([
  "e.g", "i.e", "vs", "mr", "mrs", "ms", "dr", "prof", "etc",
  "inc", "ltd", "co", "corp", "st", "ave", "dept", "est", "fig", "no",
]);

function isAbbreviation(text, end) {
  const start = Math.max(0, end - 7);
  const before = text.slice(start, end - 1).toLowerCase();
  const m = before.match(/([a-zA-Z.]+)$/);
  if (!m) return false;
  const token = m[1];
  const stem = token.replace(/\.$/, "");
  if (stem.length > 4) return false;
  return ABBREVIATIONS.has(stem);
}

function shouldSplitLatin(text, pos) {
  const ch = text[pos];
  if (!LATIN_TERMINALS.has(ch)) return false;
  const next = text[pos + 1];
  if (next !== undefined && !/\s/.test(next)) return false;
  const prev = text[pos - 1];
  if (prev && /\d/.test(prev) && next && /\d/.test(next)) return false;
  if (isAbbreviation(text, pos + 1)) return false;
  return true;
}

function findSplitPoints(line) {
  const points = [];
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (CJK_TERMINALS.has(ch)) {
      points.push(i + 1);
    } else if (LATIN_TERMINALS.has(ch)) {
      if (shouldSplitLatin(line, i)) {
        points.push(i + 1);
      }
    }
  }
  return points;
}

function splitSentences(text) {
  if (!text) return [];
  const sentences = [];
  const paraBlocks = text.split(/\n{2,}/);
  let globalOffset = 0;

  for (const block of paraBlocks) {
    const blockStart = globalOffset;
    const lines = block.split("\n");
    let lineOffsetInBlock = 0;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        lineOffsetInBlock += rawLine.length + 1;
        continue;
      }
      const lineStart = blockStart + lineOffsetInBlock;
      const leadWs = rawLine.length - rawLine.trimStart().length;
      const effectiveStart = lineStart + leadWs;
      const splitPoints = findSplitPoints(line);

      let prev = 0;
      for (const sp of splitPoints) {
        if (sp > prev) {
          const s = line.slice(prev, sp);
          if (s.trim()) {
            sentences.push({ text: s, start: effectiveStart + prev, end: effectiveStart + sp });
          }
        }
        prev = sp;
      }
      if (prev < line.length) {
        const s = line.slice(prev);
        if (s.trim()) {
          sentences.push({ text: s, start: effectiveStart + prev, end: effectiveStart + line.length });
        }
      }
      lineOffsetInBlock += rawLine.length + 1;
    }
    globalOffset += block.length + 2;
  }
  return sentences;
}

function normalizeForSpeech(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__|[*_])/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " link ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\u200B-\u200F\u2028-\u202F\u2060\uFEFF]/g, "")
    .replace(/[\uE000-\uF8FF]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function groupSentences(sentences, maxChars, minChars) {
  const segments = [];
  let buf = "";
  let bufStart = -1;
  let bufEnd = -1;

  const flush = () => {
    if (buf.trim()) {
      segments.push({
        text: buf.trim(),
        start: bufStart,
        end: bufEnd,
        originalLine: 0,
        lineOffset: 0,
      });
    }
    buf = "";
    bufStart = -1;
    bufEnd = -1;
  };

  for (const s of sentences) {
    if (s.text.length > maxChars) {
      const hard = hardSplit(s.text, maxChars, minChars);
      const totalLen = hard.reduce((sum, h) => sum + h.length, 0);
      let cursor = s.start;
      for (const h of hard) {
        const partLen = totalLen > 0 ? Math.round((h.length / totalLen) * (s.end - s.start)) : 0;
        segments.push({ text: h, start: cursor, end: cursor + partLen, originalLine: 0, lineOffset: 0 });
        cursor += partLen;
      }
      continue;
    }
    let candidate = buf ? buf + " " + s.text : s.text;
    if (buf && candidate.length > maxChars) {
      flush();
      candidate = s.text;
    }
    if (bufStart === -1) bufStart = s.start;
    buf = candidate;
    bufEnd = s.end;
  }
  flush();
  mergeTinySegments(segments, minChars);
  return segments;
}

function hardSplit(text, maxChars, _minChars) {
  const parts = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    const lo = Math.floor(maxChars * 0.6);
    const window = remaining.slice(0, maxChars);
    let cut = -1;
    for (const ch of ["，", "、", "：", ",", "：", ";", "；"]) {
      const idx = window.lastIndexOf(ch);
      if (idx >= lo) {
        cut = idx + 1;
        break;
      }
    }
    if (cut === -1) {
      const spaceIdx = window.lastIndexOf(" ");
      cut = spaceIdx >= lo ? spaceIdx + 1 : maxChars;
    }
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) parts.push(remaining);
  return parts.filter((p) => p.length > 0);
}

function mergeTinySegments(segments, minChars) {
  if (segments.length === 0) return;
  let i = 0;
  while (i < segments.length - 1) {
    if (segments[i].text.length < minChars) {
      segments[i + 1].text = segments[i].text + " " + segments[i + 1].text;
      segments[i + 1].start = segments[i].start;
      segments.splice(i, 1);
    } else if (segments[i + 1].text.length < minChars) {
      segments[i].text = segments[i].text + " " + segments[i + 1].text;
      segments[i].end = segments[i + 1].end;
      segments.splice(i + 1, 1);
    } else {
      i++;
    }
  }
  if (segments.length > 1 && segments[segments.length - 1].text.length < minChars) {
    const last = segments.pop();
    segments[segments.length - 1].text += " " + last.text;
    segments[segments.length - 1].end = last.end;
  }
  // After all merges, segments may be out of order. Sort by start offset
  // to guarantee playback order matches text order.
  segments.sort((a, b) => a.start - b.start);
}

function splitParagraphs(text) {
  const paras = [];
  const blocks = text.split(/\n{2,}/);
  let cursor = 0;
  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed) {
      paras.push({ text: trimmed, start: cursor, end: cursor + trimmed.length });
    }
    cursor += block.length + 2;
  }
  return paras;
}

/**
 * Main entry: segment long text into TTS-friendly chunks.
 */
function segmentText(rawText, options, lineOffset = 0) {
  const normalized = normalizeForSpeech(rawText);
  if (!normalized.trim()) return [];

  const { mode, maxChars, minChars } = options;
  let segments;

  switch (mode) {
    case "paragraph": {
      const paras = splitParagraphs(normalized);
      segments = [];
      for (const p of paras) {
        if (p.text.length <= maxChars) {
          segments.push({ text: p.text, start: p.start, end: p.end, originalLine: 0, lineOffset });
        } else {
          const inner = splitSentences(p.text);
          const grouped = groupSentences(inner, maxChars, minChars);
          for (const g of grouped) {
            const absStart = g.start === 0 && g.end === 0 ? p.start : p.start + g.start;
            const absEnd = g.end === 0 ? p.end : p.start + g.end;
            segments.push({
              text: g.text,
              start: absStart,
              end: absEnd,
              originalLine: 0,
              lineOffset,
            });
          }
        }
      }
      break;
    }
    case "sentence": {
      const sentences = splitSentences(normalized);
      segments = groupSentences(sentences, maxChars, minChars);
      break;
    }
    case "smart":
    default: {
      const sentences = splitSentences(normalized);
      segments = groupSentences(sentences, maxChars, minChars);
      break;
    }
  }

  for (const seg of segments) {
    seg.lineOffset = lineOffset;
  }

  return segments;
}

// Export for use in other scripts
if (typeof module !== "undefined") module.exports = { segmentText };
if (typeof self !== "undefined") self.segmentText = segmentText;
