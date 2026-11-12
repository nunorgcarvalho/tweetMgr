// Pure logic for the continuous draft: one long text with images anchored
// in it, cut into tweets. No DOM here, so it is unit-tested in Node
// (test/draft.test.js).
//
// Doc { text, media, pins }
//   text   the whole draft. Each image is one OBJ character at the point
//          where it was inserted.
//   media  media ids, in the order their OBJ characters appear in text.
//   pins   offsets in text where the writer placed a cut. Every other cut
//          is automatic: it appears where a tweet would pass the limit and
//          moves as the text changes.
import { tweetLength } from './counter.js';
import { BREAK_RE, findCut, maxFittingIndex } from './split.js';

/** Stands for an image in the draft text (U+FFFC, object replacement). */
export const OBJ = '￼';

const isWs = (ch) => ch !== undefined && ch !== OBJ && /\s/.test(ch);

/** First index at or after `i` (below `end`) that is not whitespace. */
export function skipWs(text, i, end = text.length) {
  while (i < end && isWs(text[i])) i++;
  return i;
}

/**
 * Removes image placeholders from a piece of draft text. An image that sat
 * on its own line, or between two spaces, takes that one separator with it
 * so no stray gap is left behind. `map[k]` is the index in `src` of
 * `out[k]`, and `map[out.length]` is `src.length`.
 */
export function stripObjects(src) {
  let out = '';
  const map = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== OBJ) {
      map.push(i);
      out += src[i];
      continue;
    }
    let j = i;
    while (src[j] === OBJ) j++;
    const before = out[out.length - 1];
    const after = src[j];
    const dropSpace = after === ' ' && (before === undefined || isWs(before));
    const dropLine = after === '\n' && (before === undefined || before === '\n');
    i = dropSpace || dropLine ? j : j - 1;
  }
  map.push(src.length);
  return { out, map };
}

function cleanPins(doc) {
  const { text } = doc;
  const first = skipWs(text, 0);
  const seen = new Set();
  for (const p of doc.pins || []) {
    if (!Number.isInteger(p)) continue;
    const q = skipWs(text, Math.max(0, Math.min(p, text.length)));
    if (q > first) seen.add(q);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Where the tweet starting at `pos` would hit the limit, or null if the rest of the draft fits. */
function hardLimit(text, pos, limit) {
  const rest = text.length - pos;
  let width = Math.min(rest, limit * 2 + 64);
  for (;;) {
    const { out, map } = stripObjects(text.slice(pos, pos + width));
    const whole = width >= rest;
    if (tweetLength(whole ? out.trimEnd() : out) <= limit) {
      if (whole) return null;
      width = Math.min(rest, width * 2); // long links weigh little; look further
      continue;
    }
    return pos + map[Math.max(1, maxFittingIndex(out, limit))];
  }
}

/**
 * Cuts the draft into tweets.
 * Returns { tweets, breaks }:
 *   tweets[i] { start, end, text, media, length, hard }
 *     `media` is the ids of the images anchored inside [start, end);
 *     `hard` is the offset where this tweet would pass the limit if the
 *     text simply ran on (null when everything after `start` fits).
 *   breaks[i] { offset, pinned } is the cut between tweets[i] and tweets[i+1].
 */
export function derive(doc, limit) {
  const { text } = doc;
  const len = text.length;
  const media = doc.media || [];
  const tweets = [];
  const breaks = [];
  let mediaSeen = 0;

  const push = (start, end, hard) => {
    const slice = text.slice(start, end);
    const body = stripObjects(slice).out.replace(/[ \t]+\n/g, '\n').trim();
    const ids = [];
    for (const ch of slice) if (ch === OBJ) ids.push(media[mediaSeen++]);
    tweets.push({ start, end, text: body, media: ids.filter((id) => id != null), length: tweetLength(body), hard });
  };

  let pos = skipWs(text, 0);
  for (const ch of text.slice(0, pos)) if (ch === OBJ) mediaSeen++; // none: OBJ is not whitespace
  const bounds = [...cleanPins(doc), len];
  bounds.forEach((bound, bi) => {
    for (;;) {
      const hard = hardLimit(text, pos, limit);
      let end = bound;
      while (end > pos && isWs(text[end - 1])) end--;
      if (hard === null || end <= hard) {
        push(pos, bound, hard);
        break;
      }
      const { out, map } = stripObjects(text.slice(pos, Math.min(bound, hard + 1)));
      const cut = pos + map[Math.max(1, Math.min(findCut(out, limit), out.length))];
      const next = skipWs(text, Math.max(cut, pos + 1), bound);
      if (next >= bound) {
        push(pos, bound, hard);
        break;
      }
      push(pos, next, hard);
      breaks.push({ offset: next, pinned: false });
      pos = next;
    }
    if (bi < bounds.length - 1) {
      breaks.push({ offset: bound, pinned: true });
      pos = bound;
    }
  });
  return { tweets, breaks };
}

/**
 * Carries pinned cuts across an edit. The edit is found by comparing the
 * text before and after: text typed exactly at a cut joins the tweet that
 * starts there, and a cut inside deleted text is dropped.
 */
export function mapPins(pins, oldText, newText) {
  if (oldText === newText) return [...pins];
  const max = Math.min(oldText.length, newText.length);
  let p = 0;
  while (p < max && oldText[p] === newText[p]) p++;
  let s = 0;
  while (s < max - p && oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]) s++;
  const removedEnd = oldText.length - s;
  const delta = newText.length - oldText.length;
  const out = [];
  for (const pin of pins) {
    if (pin <= p) out.push(pin);
    else if (pin >= removedEnd) out.push(pin + delta);
  }
  return out;
}

/** Offsets where a word starts. */
export function wordStarts(text) {
  const out = [];
  for (let i = 1; i < text.length; i++) if (isWs(text[i - 1]) && !isWs(text[i])) out.push(i);
  return out;
}

/** Offsets where a sentence or a line starts. */
export function sentenceStarts(text) {
  const out = [];
  for (const m of text.matchAll(/(?:[.!?…]["')\]]*[ \t]+|\n\s*)(?=\S)/g)) out.push(m.index + m[0].length);
  return out;
}

/**
 * How far the cut after tweet `i` may move: it has to leave tweet `i` at
 * least one character and may not push it past the limit or past the next
 * cut the writer placed.
 */
export function breakRange(doc, derived, i) {
  const tweet = derived.tweets[i];
  const nextPin = derived.breaks.slice(i + 1).find((b) => b.pinned);
  let max = nextPin ? nextPin.offset - 1 : doc.text.length;
  if (tweet.hard !== null) max = Math.min(max, tweet.hard);
  return { min: tweet.start + 1, max };
}

/** The candidate nearest to `offset` within [min, max], or null. */
export function nearest(candidates, offset, { min, max }) {
  let best = null;
  for (const c of candidates) {
    if (c < min || c > max) continue;
    if (best === null || Math.abs(c - offset) < Math.abs(best - offset)) best = c;
  }
  return best;
}

/** Pins the cut after tweet `i` at `offset`. Returns the new pins, or null if it cannot go there. */
export function moveBreak(doc, derived, i, offset) {
  const { min, max } = breakRange(doc, derived, i);
  const target = skipWs(doc.text, offset);
  if (target < min || target > max) return null;
  const old = derived.breaks[i];
  const pins = derived.breaks.filter((b) => b.pinned && b !== old).map((b) => b.offset);
  pins.push(target);
  return pins.sort((a, b) => a - b);
}

/** Moves the cut after tweet `i` one sentence (or word) earlier or later. */
export function stepBreak(doc, derived, i, direction, unit = 'sentence') {
  const { min, max } = breakRange(doc, derived, i);
  const from = derived.breaks[i].offset;
  const stops = (unit === 'word' ? wordStarts : sentenceStarts)(doc.text).filter((c) => c >= min && c <= max);
  const target = direction < 0 ? stops.filter((c) => c < from).pop() : stops.find((c) => c > from);
  return target === undefined ? null : moveBreak(doc, derived, i, target);
}

/** Builds a draft from stored tweets: one paragraph each, images after the text, every cut pinned. */
export function docFromTweets(tweets) {
  let text = '';
  const media = [];
  const pins = [];
  for (const t of tweets || []) {
    const ids = (t.media || []).map((m) => m.id);
    const words = (t.text || '').trim();
    const body = words + (ids.length ? (words ? '\n' : '') + OBJ.repeat(ids.length) : '');
    if (!body) continue;
    if (text) {
      text += '\n\n';
      pins.push(text.length);
    }
    text += body;
    media.push(...ids);
  }
  return { text, media, pins };
}

/** True when cutting the draft gives exactly these stored tweets. */
export function matchesTweets(derived, tweets) {
  const stored = (tweets || []).filter((t) => (t.text || '').trim() || (t.media || []).length);
  const made = derived.tweets.filter((t) => t.text || t.media.length);
  if (stored.length !== made.length) return false;
  return made.every((t, i) => {
    const ids = (stored[i].media || []).map((m) => m.id);
    return t.text === stored[i].text && t.media.length === ids.length && t.media.every((id, j) => id === ids[j]);
  });
}

/** A stored `thread.draft` is usable when it is well formed and still describes the stored tweets. */
export function docFromThread(thread) {
  const d = thread.draft;
  const ids = new Set((thread.tweets || []).flatMap((t) => (t.media || []).map((m) => m.id)));
  if (d && typeof d.text === 'string' && Array.isArray(d.media) && Array.isArray(d.pins) && Number(d.limit) > 0) {
    const count = [...d.text].filter((ch) => ch === OBJ).length;
    const doc = { text: d.text, media: [...d.media], pins: d.pins.filter(Number.isInteger) };
    if (count === d.media.length && d.media.every((id) => ids.has(id)) && matchesTweets(derive(doc, Number(d.limit)), thread.tweets)) {
      return doc;
    }
  }
  return docFromTweets(thread.tweets);
}

/** Replaces [from, to) with pasted text. Lines that are just "---" become pinned cuts. */
export function insertText(doc, from, to, pasted) {
  const parts = pasted.replace(/\r\n?/g, '\n').split(BREAK_RE);
  const insert = parts.join('\n\n');
  const text = doc.text.slice(0, from) + insert + doc.text.slice(to);
  const pins = mapPins(doc.pins, doc.text, text);
  let at = from;
  parts.slice(0, -1).forEach((part) => {
    at += part.length + 2;
    pins.push(at);
  });
  return { doc: { ...doc, text, pins }, caret: from + insert.length };
}

/** Inserts image placeholders for `ids` at `offset`. */
export function insertMedia(doc, offset, ids) {
  const before = doc.text.slice(0, offset);
  const index = [...before].filter((ch) => ch === OBJ).length;
  const text = before + OBJ.repeat(ids.length) + doc.text.slice(offset);
  const media = [...doc.media];
  media.splice(index, 0, ...ids);
  // Like typed text, an image inserted exactly at a cut joins the tweet that starts there.
  const pins = doc.pins.map((p) => (p > offset ? p + ids.length : p));
  return { text, media, pins };
}

/** Removes one image from the draft. */
export function removeMedia(doc, id) {
  const index = doc.media.indexOf(id);
  if (index < 0) return doc;
  const offset = mediaOffset(doc, index);
  const text = doc.text.slice(0, offset) + doc.text.slice(offset + 1);
  return { text, media: doc.media.filter((_, i) => i !== index), pins: doc.pins.map((p) => (p > offset ? p - 1 : p)) };
}

/** Offset of the `index`-th image placeholder. */
export function mediaOffset(doc, index) {
  let seen = -1;
  for (let i = 0; i < doc.text.length; i++) if (doc.text[i] === OBJ && ++seen === index) return i;
  return -1;
}

/** Moves an image so it sits at `offset` (an offset in the text before the move). */
export function moveMedia(doc, id, offset) {
  const from = mediaOffset(doc, doc.media.indexOf(id));
  if (from < 0) return doc;
  const without = removeMedia(doc, id);
  return insertMedia(without, offset > from ? offset - 1 : offset, [id]);
}

/** Where an image goes to join tweet `i`: right after its last character. */
export function tweetEnd(doc, tweet) {
  let end = tweet.end;
  while (end > tweet.start && isWs(doc.text[end - 1])) end--;
  return end;
}
