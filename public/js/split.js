// Pure text-splitting logic for breaking long text into tweets.
// No DOM here, so it can be shared with the CLI and unit-tested in Node.
import { tweetLength } from './counter.js';

/** A line containing only "---" forces a tweet break in a long draft. */
export const BREAK_RE = /\n[ \t]*-{3,}[ \t]*\n/;

const isLowSurrogate = (c) => c >= 0xdc00 && c <= 0xdfff;

/** Longest prefix length (in string indices) whose weighted length fits. */
function maxFittingIndex(text, limit) {
  if (tweetLength(text) <= limit) return text.length;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (tweetLength(text.slice(0, mid)) <= limit) lo = mid;
    else hi = mid - 1;
  }
  // Never cut a surrogate pair in half.
  while (lo > 0 && isLowSurrogate(text.charCodeAt(lo))) lo--;
  return lo;
}

/**
 * Where to cut `text` so the first part fits within `limit`.
 * Prefers, in order: a paragraph break, the end of a sentence, a space.
 * A boundary is only used if it keeps at least `minFill` of the space
 * that could fit, so we don't leave a tweet nearly empty.
 * Returns the index to cut at (text.length if it already fits).
 */
export function findCut(text, limit, { minFill = 0.4 } = {}) {
  const max = maxFittingIndex(text, limit);
  if (max >= text.length) return text.length;
  if (max === 0) return 0;
  const window = text.slice(0, max + 1); // +1 so a boundary right at the edge counts
  const floor = Math.floor(max * minFill);

  const lastMatchEnd = (re) => {
    let best = -1;
    for (const m of window.matchAll(re)) {
      const end = m.index + m[0].length;
      if (end <= max + 1) best = end;
    }
    return best;
  };

  const candidates = [
    lastMatchEnd(/\n\s*\n/g), // paragraph
    lastMatchEnd(/[.!?…]["')\]]*(?=\s)/g), // sentence end, before whitespace
    lastMatchEnd(/[;:,—–](?=\s)/g), // clause
    lastMatchEnd(/\s+/g), // word
  ];
  for (const c of candidates) {
    if (c > 0 && c >= floor) return Math.min(c, max);
  }
  return max; // a single very long word: hard cut
}

/**
 * Split one tweet's text into a part that fits and the overflow.
 * Both parts are trimmed at the cut.
 */
export function splitOverflow(text, limit) {
  const cut = findCut(text, limit);
  if (cut >= text.length) return [text, ''];
  return [text.slice(0, cut).trimEnd(), text.slice(cut).trimStart()];
}

function splitSegment(text, limit) {
  const out = [];
  let rest = text.trim();
  while (rest) {
    const [head, tail] = splitOverflow(rest, limit);
    if (!head) {
      // Limit too small to fit anything; avoid an infinite loop.
      out.push(rest);
      break;
    }
    out.push(head);
    rest = tail;
  }
  return out;
}

export function numberSuffix(i, n) {
  return ` ${i}/${n}`;
}

/**
 * Split a long draft into tweets that each fit within `limit`.
 * Options:
 *   numbering: append " 1/n", " 2/n", ... to each tweet (space is reserved).
 * Lines that are just "---" force a break.
 */
export function splitText(text, limit, { numbering = false } = {}) {
  const segments = (text || '')
    .replace(/\r\n?/g, '\n')
    .split(BREAK_RE)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segments.length) return [];
  if (!numbering) return segments.flatMap((s) => splitSegment(s, limit));

  // Reserve room for the suffix. Its width depends on the total count,
  // so repeat until the count stops changing.
  let n = 1;
  for (let attempt = 0; attempt < 5; attempt++) {
    const reserve = tweetLength(numberSuffix(n, n));
    const parts = segments.flatMap((s) => splitSegment(s, limit - reserve));
    if (String(parts.length).length === String(n).length) {
      return parts.map((p, i) => p + numberSuffix(i + 1, parts.length));
    }
    n = parts.length;
  }
  const reserve = tweetLength(numberSuffix(n, n));
  const parts = segments.flatMap((s) => splitSegment(s, limit - reserve));
  return parts.map((p, i) => p + numberSuffix(i + 1, parts.length));
}

/**
 * Re-flow a list of tweets so none is over the limit: overflow from each
 * tweet is pushed to the start of the next one (creating new tweets at the
 * end as needed). Returns new text values; does not touch media.
 */
export function reflow(texts, limit) {
  const out = [...texts];
  for (let i = 0; i < out.length; i++) {
    const [head, tail] = splitOverflow(out[i], limit);
    if (!tail || !head) continue;
    out[i] = head;
    if (i + 1 < out.length) out[i + 1] = out[i + 1] ? `${tail} ${out[i + 1]}` : tail;
    else out.push(tail);
  }
  return out;
}

/** Join two tweets' text with a sensible separator. */
export function joinTexts(a, b) {
  if (!a.trim()) return b;
  if (!b.trim()) return a;
  return `${a.trimEnd()} ${b.trimStart()}`;
}
