/**
 * segmenter.ts — Long-text segmentation engine for Edge TTS.
 *
 * Edge TTS REST API has practical limits on request size, and quality degrades
 * on very long single requests. This module splits arbitrary long text into
 * TTS-friendly segments using a multi-layer strategy:
 *
 *   1. Pre-normalization: collapse whitespace, normalize quotes/dashes,
 *      strip non-speakable artifacts (markdown, code fences, URLs).
 *   2. Sentence splitting: break on terminal punctuation (。！？.!?；;… —)
 *      while respecting abbreviations and decimal numbers.
 *   3. Length-aware grouping: merge short sentences and split long ones so
 *      each segment falls in [minChars, maxChars].
 *   4. Paragraph mode: split on blank lines first, then sentence-split inside.
 *
 * The result is an ordered array of `Segment` objects, each carrying the
 * original text span so the UI can highlight the currently-playing region.
 */

export type SegmentMode = "smart" | "sentence" | "paragraph";

export interface Segment {
  /** The text to send to TTS for this segment. */
  text: string;
  /** Start offset (0-based) into the normalized text. */
  start: number;
  /** End offset (exclusive) into the normalized text. */
  end: number;
  /**
   * 1-based line number where this segment begins in the text that was
   * passed to segmentText(). For a full-file read this is the document
   * line. For a partial read (e.g. readFromCursor) this is relative to the
   * substring; add `lineOffset` to get the absolute document line.
   */
  originalLine: number;
  /**
   * 0-based line offset to add to `originalLine` to get the absolute
   * document line. Set when segmenting a substring that starts at a
   * non-zero line (e.g. readFromCursor). Default 0.
   */
  lineOffset: number;
}

export interface SegmentOptions {
  mode: SegmentMode;
  maxChars: number;
  minChars: number;
}

/**
 * CJK terminal characters — split AFTER these.
 */
const CJK_TERMINALS = new Set(["。", "！", "？", "；", "…"]);

/**
 * Latin terminal characters — split AFTER these only when followed by
 * whitespace or end-of-string (to avoid splitting decimals like 3.14).
 */
const LATIN_TERMINALS = new Set([".", "!", "?", ";", ":"]);

/**
 * Abbreviations that should NOT trigger a sentence split.
 * We check the few characters before a candidate split point.
 */
const ABBREVIATIONS = new Set([
  "e.g", "i.e", "vs", "mr", "mrs", "ms", "dr", "prof", "etc",
  "inc", "ltd", "co", "corp", "st", "ave", "dept", "est", "fig", "no",
]);

/**
 * Check whether the text ending at position `end` (exclusive) is an
 * abbreviation (e.g. "e.g." or "Mr."). Returns true if the terminal
 * punctuation at `end-1` belongs to an abbreviation.
 */
function isAbbreviation(text: string, end: number): boolean {
  // Look back up to 6 chars before the terminal punctuation.
  const start = Math.max(0, end - 7);
  const before = text.slice(start, end - 1).toLowerCase();
  // Get the last word-like token
  const m = before.match(/([a-zA-Z.]+)$/);
  if (!m) return false;
  const token = m[1];
  // Strip trailing dot (the terminal we're checking)
  const stem = token.replace(/\.$/, "");
  if (stem.length > 4) return false; // too long to be an abbreviation
  return ABBREVIATIONS.has(stem);
}

/**
 * Check if a Latin terminal at position `pos` (0-based, the char itself)
 * should trigger a split. Rules:
 *  - Must be followed by whitespace or end-of-string.
 *  - Must not be part of a decimal number (digit before AND after).
 *  - Must not be an abbreviation.
 */
function shouldSplitLatin(text: string, pos: number): boolean {
  const ch = text[pos];
  if (!LATIN_TERMINALS.has(ch)) return false;

  // Next char must be whitespace or end
  const next = text[pos + 1];
  if (next !== undefined && !/\s/.test(next)) return false;

  // Decimal check: digit immediately before and after (e.g. "3.14")
  const prev = text[pos - 1];
  if (prev && /\d/.test(prev) && next && /\d/.test(next)) return false;

  // Abbreviation check
  if (isAbbreviation(text, pos + 1)) return false;

  return true;
}

/**
 * Find all split points in a line of text. A split point is the index
 * immediately AFTER a terminal character (i.e. the start of the next
 * sentence).
 */
function findSplitPoints(line: string): number[] {
  const points: number[] = [];
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (CJK_TERMINALS.has(ch)) {
      // Always split after CJK terminals
      points.push(i + 1);
    } else if (LATIN_TERMINALS.has(ch)) {
      if (shouldSplitLatin(line, i)) {
        points.push(i + 1);
      }
    }
  }
  return points;
}

/**
 * Split a normalized text into sentences.
 * Returns array of { text, start, end } where start/end are offsets into the
 * normalized string.
 */
function splitSentences(text: string): { text: string; start: number; end: number }[] {
  if (!text) return [];

  const sentences: { text: string; start: number; end: number }[] = [];

  // Split into paragraph blocks first (double newlines).
  const paraBlocks = text.split(/\n{2,}/);
  let globalOffset = 0;

  for (const block of paraBlocks) {
    const blockStart = globalOffset;
    // Within a block, split by single newlines into lines.
    const lines = block.split("\n");
    let lineOffsetInBlock = 0;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        lineOffsetInBlock += rawLine.length + 1;
        continue;
      }
      const lineStart = blockStart + lineOffsetInBlock;
      // Account for leading whitespace that was trimmed
      const leadWs = rawLine.length - rawLine.trimStart().length;
      const effectiveStart = lineStart + leadWs;

      const splitPoints = findSplitPoints(line);

      // Build sentences from split points.
      let prev = 0;
      for (const sp of splitPoints) {
        if (sp > prev) {
          const s = line.slice(prev, sp);
          if (s.trim()) {
            sentences.push({
              text: s,
              start: effectiveStart + prev,
              end: effectiveStart + sp,
            });
          }
        }
        prev = sp;
      }
      // Remainder after last split point
      if (prev < line.length) {
        const s = line.slice(prev);
        if (s.trim()) {
          sentences.push({
            text: s,
            start: effectiveStart + prev,
            end: effectiveStart + line.length,
          });
        }
      }

      lineOffsetInBlock += rawLine.length + 1;
    }

    globalOffset += block.length + 2; // +2 for the \n\n separator
  }

  return sentences;
}

/** Strip markdown / code artifacts and non-readable characters. */
function normalizeForSpeech(text: string): string {
  return (
    text
      // normalize line endings FIRST so CRLF/CR text segments correctly
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      // remove code fences (keep nothing — code is not speakable)
      .replace(/```[\s\S]*?```/g, " ")
      // inline code: keep inner text
      .replace(/`([^`]*)`/g, "$1")
      // remove markdown headers / emphasis markers
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/(\*\*|__|[*_])/g, "")
      // remove markdown links [text](url) -> text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // remove images
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      // replace URLs with "link"
      .replace(/https?:\/\/\S+/g, " link ")
      // remove HTML tags
      .replace(/<[^>]+>/g, " ")
      // remove non-readable / control characters (keep \n, \t, printable)
      // Strip: C0 controls (except \n \t), C1 controls, private-use area,
      // zero-width chars, BOM, emoji-modifier remnants, etc.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/[\u200B-\u200F\u2028-\u202F\u2060\uFEFF]/g, "")
      .replace(/[\uE000-\uF8FF]/g, "") // private-use area
      // collapse multiple spaces/tabs
      .replace(/[ \t]+/g, " ")
      // collapse multiple newlines to single newline (keep paragraph breaks)
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Group sentences into segments respecting [minChars, maxChars].
 */
function groupSentences(
  sentences: { text: string; start: number; end: number }[],
  maxChars: number,
  minChars: number
): Segment[] {
  const segments: Segment[] = [];
  let buf = "";
  let bufStart = -1;
  let bufEnd = -1;

  const flush = () => {
    if (buf.trim()) {
      segments.push({
        text: buf.trim(),
        start: bufStart,
        end: bufEnd,
        originalLine: 0, // filled in later
        lineOffset: 0,   // set in segmentText()
      });
    }
    buf = "";
    bufStart = -1;
    bufEnd = -1;
  };

  for (const s of sentences) {
    // If this single sentence exceeds maxChars, hard-split it regardless of
    // buffer state.
    if (s.text.length > maxChars) {
      const hard = hardSplit(s.text, maxChars, minChars);
      // Distribute the sentence's [start, end) range proportionally across
      // the hard-split parts so line mapping works.
      const totalLen = hard.reduce((sum, h) => sum + h.length, 0);
      let cursor = s.start;
      for (const h of hard) {
        const partLen = totalLen > 0 ? Math.round((h.length / totalLen) * (s.end - s.start)) : 0;
        segments.push({ text: h, start: cursor, end: cursor + partLen, originalLine: 0, lineOffset: 0 });
        cursor += partLen;
      }
      continue;
    }

    // Build candidate: current buffer + this sentence (or just the sentence
    // if buffer is empty).
    let candidate = buf ? buf + " " + s.text : s.text;

    if (buf && candidate.length > maxChars) {
      // Current buffer + this sentence exceeds max. Flush buffer and start
      // a new segment with just this sentence.
      flush();
      candidate = s.text;
    }

    if (bufStart === -1) bufStart = s.start;
    buf = candidate;
    bufEnd = s.end;
  }
  flush();

  // Merge trailing tiny segments into previous to avoid a 3-char final chunk.
  mergeTinySegments(segments, minChars);

  return segments;
}

/**
 * Hard-split a single over-long sentence at clause punctuation (，、,：) or
 * at a fixed character boundary as a last resort.
 */
function hardSplit(text: string, maxChars: number, _minChars: number): string[] {
  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    // Look for a clause boundary (，、,：) in the window [maxChars*0.6, maxChars]
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
      // No clause boundary in window — cut at last space, else hard cut.
      const spaceIdx = window.lastIndexOf(" ");
      cut = spaceIdx >= lo ? spaceIdx + 1 : maxChars;
    }
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) parts.push(remaining);
  return parts.filter((p) => p.length > 0);
}

/** Merge segments shorter than minChars into their neighbor. */
function mergeTinySegments(segments: Segment[], minChars: number): void {
  if (segments.length === 0) return;
  let i = 0;
  while (i < segments.length - 1) {
    if (segments[i].text.length < minChars) {
      // Merge current into next: the merged segment inherits the
      // current's start (earlier) and the next's end (later).
      segments[i + 1].text = segments[i].text + " " + segments[i + 1].text;
      segments[i + 1].start = segments[i].start;
      segments.splice(i, 1);
      // Do NOT increment i — the new segment at position i needs checking.
    } else if (segments[i + 1].text.length < minChars) {
      // Merge next into current: the merged segment inherits the
      // current's start and the next's end (later).
      segments[i].text = segments[i].text + " " + segments[i + 1].text;
      segments[i].end = segments[i + 1].end;
      segments.splice(i + 1, 1);
      // Do NOT increment i — the merged segment at position i may now
      // be too long and the next segment needs checking.
    } else {
      i++;
    }
  }
  // Final segment might be tiny — merge into the one before it.
  if (segments.length > 1 && segments[segments.length - 1].text.length < minChars) {
    const last = segments.pop()!;
    segments[segments.length - 1].text += " " + last.text;
    segments[segments.length - 1].end = last.end;
  }
  // After all merges, segments may be out of order (a merge can produce
  // a segment whose start is before its predecessor's start). Sort by
  // start offset to guarantee playback order matches text order.
  segments.sort((a, b) => a.start - b.start);
}

/**
 * Split text into paragraph blocks (by blank lines).
 */
function splitParagraphs(text: string): { text: string; start: number; end: number }[] {
  const paras: { text: string; start: number; end: number }[] = [];
  const blocks = text.split(/\n{2,}/);
  let cursor = 0;
  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed) {
      paras.push({ text: trimmed, start: cursor, end: cursor + trimmed.length });
    }
    cursor += block.length + 2; // +2 for the separator we split on
  }
  return paras;
}

/**
 * Main entry: segment long text into TTS-friendly chunks.
 *
 * @param rawText     The original (possibly markdown) text.
 * @param options     Segmentation options.
 * @param lineOffset  0-based line offset to add to each segment's
 *                    originalLine (for partial reads like readFromCursor).
 * @returns           Ordered segments with text + normalized offsets.
 */
export function segmentText(
  rawText: string,
  options: SegmentOptions,
  lineOffset = 0
): Segment[] {
  const normalized = normalizeForSpeech(rawText);
  if (!normalized.trim()) return [];

  const { mode, maxChars, minChars } = options;
  let segments: Segment[];

  switch (mode) {
    case "paragraph": {
      const paras = splitParagraphs(normalized);
      // Each paragraph may still be too long — sentence-split inside.
      segments = [];
      for (const p of paras) {
        if (p.text.length <= maxChars) {
          segments.push({ text: p.text, start: p.start, end: p.end, originalLine: 0, lineOffset });
        } else {
          const inner = splitSentences(p.text);
          const grouped = groupSentences(inner, maxChars, minChars);
          // g.start is an offset into p.text (the trimmed paragraph).
          // p.start is the offset of p.text within `normalized`.
          // So the absolute normalized offset is p.start + g.start.
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
      // Split on sentences, but still group to avoid tiny chunks.
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

  // Set lineOffset on all segments (groupSentences doesn't set it).
  for (const seg of segments) {
    seg.lineOffset = lineOffset;
  }

  // Map normalized offsets back to original line numbers.
  mapOriginalLines(rawText, normalized, segments);

  return segments;
}

/**
 * Build a character-level mapping from normalized-text offsets to original
 * line numbers.
 *
 * For each original line, we compute the length of its normalized form
 * (using the same rules as normalizeForSpeech, applied per-line). The
 * cumulative lengths give us the offset ranges for each line in the
 * normalized text. A segment's start offset falls into exactly one line's
 * range, giving us the original line number.
 *
 * This is stable: no fuzzy matching, no prefix collisions.
 */
function buildLineMap(rawText: string): { lineOf: (offset: number) => number } {
  const lines = rawText.split("\n");
  // For each line, compute the normalized length.
  const lineNormLens: number[] = lines.map((line) => {
    const norm = normalizeLineForMap(line);
    return norm.length;
  });

  // Build cumulative offset ranges.
  // lineRanges[i] = [startOffset, endOffset) in normalized text for line i.
  const lineRanges: [number, number][] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const len = lineNormLens[i];
    lineRanges.push([offset, offset + len]);
    offset += len;
    // Account for the newline separator: normalizeForSpeech collapses
    // multiple newlines but keeps single newlines as separators. In the
    // normalized text, lines are joined by single \n. We add 1 for the
    // separator (except after the last line).
    if (i < lines.length - 1) {
      offset += 1; // the \n separator
    }
  }

  return {
    lineOf: (normOffset: number): number => {
      // Find which line range contains normOffset.
      for (let i = 0; i < lineRanges.length; i++) {
        const [start, end] = lineRanges[i];
        if (normOffset >= start && normOffset < end) {
          return i;
        }
        // Also handle the case where normOffset falls in the newline
        // separator gap (between lines) — attribute to the next line.
        if (i < lineRanges.length - 1) {
          const nextStart = lineRanges[i + 1][0];
          if (normOffset >= end && normOffset < nextStart) {
            return i + 1;
          }
        }
      }
      // Fallback: return the last line.
      return lines.length - 1;
    },
  };
}

/**
 * Apply the same normalization as normalizeForSpeech to a single line.
 * (Used for alignment reference in buildLineMap.)
 */
function normalizeLineForMap(line: string): string {
  return (
    line
      .replace(/`([^`]*)`/g, "$1")
      .replace(/^#{1,6}\s+/, "")
      .replace(/(\*\*|__|[*_])/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, " link ")
      .replace(/<[^>]+>/g, " ")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/[\u200B-\u200F\u2028-\u202F\u2060\uFEFF]/g, "")
      .replace(/[\uE000-\uF8FF]/g, "")
      .replace(/[ \t]+/g, " ")
      .trim()
  );
}

/**
 * For each segment, find the 1-based line number in the ORIGINAL text where
 * its text begins, using the character-level line map. This is stable:
 * no fuzzy matching, no prefix collisions.
 */
function mapOriginalLines(
  rawText: string,
  normalized: string,
  segments: Segment[]
): void {
  const { lineOf } = buildLineMap(rawText);

  for (const seg of segments) {
    // seg.start is an offset into the normalized text.
    const lineIdx = lineOf(seg.start);
    seg.originalLine = lineIdx + 1; // 1-based
  }
}

/**
 * Estimate how many segments a text will produce (for progress UI).
 */
export function estimateSegmentCount(rawText: string, options: SegmentOptions): number {
  const segments = segmentText(rawText, options);
  return segments.length;
}
