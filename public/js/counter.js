// Character counting that approximates Twitter/X's weighted rules
// (twitter-text v3 config):
//   - Most Latin/Western characters weigh 1.
//   - CJK and most other scripts weigh 2.
//   - Each emoji (a full grapheme, including skin tones/ZWJ sequences) weighs 2.
//   - Every URL counts as 23, regardless of its real length.
// Text is NFC-normalized first, as Twitter does.

export const URL_LENGTH = 23;

// Code point ranges that weigh 1. Everything else weighs 2.
const LIGHT_RANGES = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];

// Deliberately simple URL matcher: explicit http(s) links, www. links,
// and bare domains with common TLDs (e.g. "example.com/path").
const URL_RE =
  /\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|co|ai|dev|app|edu|gov|me|ly|gg|tv|us|uk|ca|de|fr|xyz|info)\b(?:\/[^\s]*)?/gi;

const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

const segmenter =
  typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

function graphemes(text) {
  if (segmenter) return Array.from(segmenter.segment(text), (s) => s.segment);
  return Array.from(text);
}

function codePointWeight(cp) {
  for (const [lo, hi] of LIGHT_RANGES) if (cp >= lo && cp <= hi) return 1;
  return 2;
}

function plainWeight(text) {
  let total = 0;
  for (const g of graphemes(text)) {
    if (EMOJI_RE.test(g)) {
      total += 2;
      continue;
    }
    for (const ch of g) total += codePointWeight(ch.codePointAt(0));
  }
  return total;
}

/** Find URLs in text. Returns [{start, end, url}] using string indices. */
export function findUrls(text) {
  const out = [];
  for (const m of text.matchAll(URL_RE)) {
    // Trailing punctuation is usually not part of the link.
    const url = m[0].replace(/[.,!?;:)\]'"]+$/, '');
    out.push({ start: m.index, end: m.index + url.length, url });
  }
  return out;
}

/** Weighted length of a tweet, as Twitter/X would count it. */
export function tweetLength(text) {
  const t = (text || '').normalize('NFC');
  let total = 0;
  let cursor = 0;
  for (const { start, end } of findUrls(t)) {
    total += plainWeight(t.slice(cursor, start)) + URL_LENGTH;
    cursor = end;
  }
  return total + plainWeight(t.slice(cursor));
}

/** Characters left before hitting the limit (negative when over). */
export function remaining(text, limit) {
  return limit - tweetLength(text);
}
