// The Draft view: the whole thread as one continuous piece of writing on the
// left, and the tweets it turns into on the right.
//
//   - Cut lines show exactly where one tweet ends and the next begins. They
//     appear by themselves wherever a tweet fills up, and move as you type.
//   - Drag a cut's knob (or use its ▲ ▼ buttons) to send a sentence to the
//     tweet before or after. A cut you place stays where you put it.
//   - Images are chips inside the text. An image belongs to whichever tweet
//     its chip falls in, so it follows the text around.
//
// The browser edits the text natively; after each change the DOM is read
// back into a small model (draft-core.js), which decides the cuts. Cut lines
// are drawn on an overlay, so typing never shuffles the DOM under the caret.
import { commitThread, getState, onThreadRender, toast } from './app.js';
import { charLimit, MAX_ALT_TEXT, MAX_MEDIA_PER_TWEET, uid } from './model.js';
import { clampAlt, createUploadMedia, createUrlMedia, imageUrlFromTransfer, isAcceptedImageType, parseImageUrl } from './mediaUtils.js';
import { linkify } from './preview.js';
import {
  OBJ,
  breakRange,
  derive,
  docFromThread,
  insertMedia,
  insertText,
  mapPins,
  matchesTweets,
  moveBreak,
  moveMedia,
  nearest,
  removeMedia,
  skipWs,
  stepBreak,
  tweetEnd,
  wordStarts,
} from './draft-core.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#draft-view');
const sheet = $('#draft-sheet');
const editor = $('#draft-editor');
const overlay = $('#draft-overlay');
const previewCol = $('#draft-preview-col');
const previewList = $('#draft-preview');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---------- State ----------

let doc = { text: '', media: [], pins: [] };
let limit = 280;
let derived = derive(doc, limit);
let threadId = null;
let current = 0; // index of the tweet the caret is in
let lastCaret = null;
const registry = new Map(); // media id -> media object

const visible = () => !view.hidden && sheet.offsetParent !== null;

function srcFor(media) {
  if (!media) return '';
  if (media.source === 'url') return media.url;
  return getState().store.imageUrl(media.imageId);
}
function setSrc(img, media) {
  Promise.resolve(srcFor(media)).then((url) => url && (img.src = url));
}
function labelFor(media) {
  if (media?.name) return media.name;
  if (media?.source === 'url') {
    try {
      return new URL(media.url).pathname.split('/').pop() || new URL(media.url).hostname || 'image';
    } catch {
      return 'image';
    }
  }
  return 'image';
}

// ---------- Editor DOM <-> model ----------

function chip(id) {
  const media = registry.get(id);
  const span = el('span', 'draft-img');
  span.contentEditable = 'false';
  span.dataset.mediaId = id;
  const img = el('img');
  img.alt = '';
  img.draggable = false;
  setSrc(img, media);
  span.append(img);
  dressChip(span);
  return span;
}
function dressChip(span) {
  const media = registry.get(span.dataset.mediaId);
  const hasAlt = Boolean(media?.alt?.trim());
  // Labels are drawn by CSS from these attributes so that copying text out
  // of the draft does not pick them up.
  span.dataset.label = labelFor(media);
  span.dataset.alt = hasAlt ? 'Alt' : 'No alt';
  span.classList.toggle('has-alt', hasAlt);
  span.title = `${labelFor(media)}: click to edit, drag to move`;
}

function renderEditor(caret = null) {
  const nodes = [];
  let mi = 0;
  for (const part of doc.text.split(/(￼)/)) {
    if (part === OBJ) nodes.push(chip(doc.media[mi++]));
    else if (part) nodes.push(document.createTextNode(part));
  }
  // Without this the browser shows no last line after a newline or a chip.
  if (/[\n￼]$/.test(doc.text)) {
    const br = el('br');
    br.dataset.pad = '';
    nodes.push(br);
  }
  editor.replaceChildren(...nodes);
  if (caret != null) setCaret(caret);
}

/** The editor's content as a flat list of pieces, each `len` characters of the model text. */
function leaves() {
  const out = [];
  const walk = (parent) => {
    for (const n of parent.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) out.push({ node: n, kind: 'text', len: n.data.length });
      else if (n.nodeType !== Node.ELEMENT_NODE) continue;
      else if (n.classList.contains('draft-img')) out.push({ node: n, kind: 'obj', len: 1 });
      else if (n.tagName === 'BR') {
        const pad = 'pad' in n.dataset && !n.nextSibling && n.parentNode === editor;
        out.push({ node: n, kind: 'nl', len: pad ? 0 : 1 });
      } else {
        // Some browsers wrap new lines in <div>; read them as line breaks.
        if (out.some((l) => l.len)) out.push({ node: n, kind: 'block', len: 1 });
        walk(n);
      }
    }
  };
  walk(editor);
  return out;
}

function readDom() {
  let text = '';
  const media = [];
  for (const leaf of leaves()) {
    if (leaf.kind === 'text') text += leaf.node.data;
    else if (leaf.kind === 'obj') {
      text += OBJ;
      media.push(leaf.node.dataset.mediaId);
    } else if (leaf.len) text += '\n';
  }
  return { text: text.replace(/\r/g, ''), media };
}

const childIndex = (node) => Array.prototype.indexOf.call(node.parentNode.childNodes, node);

/** DOM position for a model offset. */
function locate(offset) {
  let acc = 0;
  for (const leaf of leaves()) {
    if (leaf.kind === 'text') {
      if (offset <= acc + leaf.len) return [leaf.node, offset - acc];
    } else if (offset <= acc && leaf.kind !== 'block') {
      return [leaf.node.parentNode, childIndex(leaf.node)];
    } else if (offset <= acc) {
      return [leaf.node, 0];
    }
    acc += leaf.len;
  }
  const pad = editor.lastChild?.nodeName === 'BR' && 'pad' in editor.lastChild.dataset;
  return [editor, editor.childNodes.length - (pad ? 1 : 0)];
}

/** Model offset for a DOM position. */
function pointToOffset(node, off) {
  let total = 0;
  const range = document.createRange();
  for (const leaf of leaves()) {
    if (leaf.kind === 'text' && leaf.node === node) return total + Math.min(off, leaf.len);
    if (leaf.kind === 'block') {
      if (leaf.node === node && off === 0) return total + leaf.len;
      range.setStart(leaf.node, 0);
      range.collapse(true);
    } else {
      range.selectNode(leaf.node);
    }
    let cmp;
    try {
      cmp = range.comparePoint(node, off);
    } catch {
      return total;
    }
    if (cmp > 0 || (leaf.kind === 'block' && cmp === 0)) total += leaf.len;
    else return total;
  }
  return total;
}

function getSelectionOffsets() {
  const sel = document.getSelection();
  if (!sel || !sel.rangeCount || !editor.contains(sel.anchorNode) || !editor.contains(sel.focusNode)) return null;
  const a = pointToOffset(sel.anchorNode, sel.anchorOffset);
  const b = pointToOffset(sel.focusNode, sel.focusOffset);
  return { from: Math.min(a, b), to: Math.max(a, b), focus: b };
}

function setCaret(offset) {
  const [node, off] = locate(Math.max(0, Math.min(offset, doc.text.length)));
  const sel = document.getSelection();
  const range = document.createRange();
  range.setStart(node, off);
  range.collapse(true);
  editor.focus({ preventScroll: true });
  sel.removeAllRanges();
  sel.addRange(range);
  lastCaret = offset;
}

// ---------- Undo ----------

let history = [];
let historyAt = -1;
function snapshot(kind) {
  return { text: doc.text, media: [...doc.media], pins: [...doc.pins], caret: getSelectionOffsets()?.focus ?? lastCaret, kind, time: Date.now() };
}
function resetHistory() {
  history = [snapshot('load')];
  historyAt = 0;
}
function record(kind) {
  const snap = snapshot(kind);
  const top = history[historyAt];
  // A burst of typing is one undo step.
  if (kind === 'type' && top?.kind === 'type' && snap.time - top.time < 1200) {
    history[historyAt] = snap;
    return;
  }
  history.splice(historyAt + 1);
  history.push(snap);
  if (history.length > 200) history.shift();
  historyAt = history.length - 1;
}
function travel(delta) {
  const target = history[historyAt + delta];
  if (!target) return;
  historyAt += delta;
  doc = { text: target.text, media: [...target.media], pins: [...target.pins] };
  renderEditor(target.caret ?? doc.text.length);
  refresh();
  save();
}

// ---------- Applying changes ----------

/** Re-cut the draft and redraw everything that depends on the cuts. */
function refresh() {
  derived = derive(doc, limit);
  doc.pins = derived.breaks.filter((b) => b.pinned).map((b) => b.offset);
  editor.classList.toggle('is-empty', doc.text.length === 0);
  draw();
  renderPreview();
  trackCaret();
}

/** Write the tweets (and the draft itself) into the open thread. */
function writeThread() {
  const { thread } = getState();
  const old = thread.tweets || [];
  let made = derived.tweets.filter((t) => t.text || t.media.length);
  if (!made.length) made = [derived.tweets[0]];
  thread.tweets = made.map((t, i) => ({
    ...(old[i] || {}),
    id: old[i]?.id || uid('t_'),
    text: t.text,
    media: t.media.map((id) => registry.get(id)).filter(Boolean),
  }));
  thread.draft = { text: doc.text, media: [...doc.media], pins: [...doc.pins], limit };
  syncedSig = signature(thread.tweets);
}
function save() {
  writeThread();
  commitThread();
}

/** A change made by a button, a drag, or a paste (not by native typing). */
function apply(next, { caret = null, render = true, kind = 'edit' } = {}) {
  doc = next;
  if (render) renderEditor(caret);
  refresh();
  record(kind);
  save();
}

function onInput() {
  const read = readDom();
  doc = { text: read.text, media: read.media, pins: mapPins(doc.pins, doc.text, read.text) };
  refresh();
  record('type');
  save();
}

/** What the open thread's tweets looked like when the draft last read or wrote them. */
let syncedSig = '';
const signature = (tweets) => JSON.stringify((tweets || []).map((t) => [t.text, (t.media || []).map((m) => m.id)]));

/** Bring the draft in line with the open thread (after a load, a reload from disk, or edits in another view). */
function syncFromThread() {
  const { thread, profile } = getState();
  if (!thread || !profile) return;
  for (const t of thread.tweets || []) for (const m of t.media || []) registry.set(m.id, m);
  const newLimit = charLimit(profile);
  const sameThread = thread.id === threadId;
  const inSync = sameThread && signature(thread.tweets) === syncedSig;
  const limitChanged = sameThread && newLimit !== limit;
  threadId = thread.id;
  limit = newLimit;
  if (!inSync) {
    doc = docFromThread(thread);
    renderEditor();
    lastCaret = null;
  } else {
    editor.querySelectorAll('.draft-img').forEach(dressChip);
  }
  previewCache = new Map();
  refresh();
  syncedSig = signature(thread.tweets);
  if (!inSync) resetHistory();
  if (!sameThread && visible() && !doc.text && document.activeElement === document.body) editor.focus();
  // A new limit moves the automatic cuts; that is a change worth saving.
  // Anything else that differs (say, a stored tweet that is too long) is
  // only shown here, and saved once the draft is edited.
  if (limitChanged && inSync && !matchesTweets(derived, thread.tweets)) save();
}

// ---------- Geometry ----------

let metrics = null;
function measure() {
  const cs = getComputedStyle(editor);
  const sheetRect = sheet.getBoundingClientRect();
  const rect = editor.getBoundingClientRect();
  metrics = {
    sheet: sheetRect,
    lineHeight: parseFloat(cs.lineHeight) || 28,
    left: rect.left - sheetRect.left + parseFloat(cs.paddingLeft),
    right: rect.right - sheetRect.left - parseFloat(cs.paddingRight),
    top: rect.top - sheetRect.top + parseFloat(cs.paddingTop),
    width: sheetRect.width,
  };
}

function chipAt(offset) {
  let index = 0;
  for (let i = 0; i < offset; i++) if (doc.text[i] === OBJ) index++;
  return editor.querySelectorAll('.draft-img')[index];
}

function charRect(offset) {
  if (doc.text[offset] === OBJ) return chipAt(offset)?.getBoundingClientRect() || null;
  const range = document.createRange();
  range.setStart(...locate(offset));
  range.setEnd(...locate(offset + 1));
  const rects = [...range.getClientRects()];
  return rects.find((r) => r.width > 0.5) || null;
}

/** Where the caret would sit before the character at `offset`: { x, top, bottom } inside the sheet. */
function caretBox(offset) {
  const { text } = doc;
  const m = metrics;
  const line = (rect, x, down = 0) => {
    const mid = rect.top + rect.height / 2 - m.sheet.top + down * m.lineHeight;
    return { x, top: mid - m.lineHeight / 2, bottom: mid + m.lineHeight / 2 };
  };
  if (offset < text.length && text[offset] !== '\n') {
    const rect = charRect(offset);
    if (rect) return line(rect, rect.left - m.sheet.left);
  }
  // The end of the text, or a line break: work from the last visible character before it.
  let k = offset - 1;
  let newlines = 0;
  while (k >= 0 && /\s/.test(text[k]) && text[k] !== OBJ) {
    if (text[k] === '\n') newlines++;
    k--;
  }
  const rect = k >= 0 ? charRect(k) : null;
  if (!rect) return { x: m.left, top: m.top + newlines * m.lineHeight, bottom: m.top + (newlines + 1) * m.lineHeight };
  return line(rect, newlines ? m.left : rect.right - m.sheet.left, newlines);
}

/** The model offset under a point on screen, or null when it is outside the text. */
function offsetFromPoint(clientX, clientY) {
  const rect = editor.getBoundingClientRect();
  const x = Math.max(metrics.sheet.left + metrics.left + 1, Math.min(clientX, metrics.sheet.left + metrics.right - 1));
  const y = Math.max(rect.top + 2, Math.min(clientY, rect.bottom - 2));
  let node;
  let off;
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (!pos) return null;
    [node, off] = [pos.offsetNode, pos.offset];
  } else if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    if (!range) return null;
    [node, off] = [range.startContainer, range.startOffset];
  }
  if (!node || !editor.contains(node)) return null;
  const chipEl = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement).closest('.draft-img');
  if (chipEl) {
    const r = chipEl.getBoundingClientRect();
    return pointToOffset(chipEl.parentNode, childIndex(chipEl) + (clientX > r.left + r.width / 2 ? 1 : 0));
  }
  return pointToOffset(node, off);
}

// ---------- Overlay: cut lines, knobs, tweet numbers ----------

function draw() {
  if (!visible()) return;
  measure();
  const m = metrics;
  const focused = document.activeElement?.closest?.('.cut-knob');
  const focusIndex = focused ? focused.dataset.i : null;
  const nodes = [];
  const box = (className, style) => {
    const node = el('div', className);
    Object.assign(node.style, style);
    nodes.push(node);
    return node;
  };
  const px = (n) => `${Math.round(n)}px`;

  let lastBadge = -Infinity;
  const badge = (i, y) => {
    const top = Math.max(y, lastBadge + m.lineHeight);
    lastBadge = top;
    const node = box('cut-badge', { top: px(top + (m.lineHeight - 18) / 2) });
    node.textContent = String(i + 1);
    node.dataset.i = i;
    node.title = `Tweet ${i + 1}: ${derived.tweets[i].length.toLocaleString()} of ${limit.toLocaleString()} characters`;
    node.classList.toggle('is-current', i === current);
  };
  badge(0, caretBox(derived.tweets[0].start).top);

  derived.breaks.forEach((b, i) => {
    const at = caretBox(b.offset);
    const kind = b.pinned ? 'is-pinned' : 'is-auto';
    const lineStart = at.x <= m.left + 1;
    if (lineStart) {
      box(`cut-line ${kind}`, { left: '0', width: px(m.width), top: px(at.top) });
    } else {
      // A stepped line: under the words that stay, then up and over the words that move on.
      box(`cut-line ${kind}`, { left: px(at.x), width: px(m.width - at.x), top: px(at.top) });
      box(`cut-tick ${kind}`, { left: px(at.x), top: px(at.top), height: px(at.bottom - at.top + 2) });
      box(`cut-line ${kind}`, { left: '0', width: px(at.x + 2), top: px(at.bottom) });
    }
    const knob = el('button', `cut-knob ${kind}`);
    knob.type = 'button';
    knob.dataset.i = i;
    knob.setAttribute('aria-label', `Cut between tweets ${i + 1} and ${i + 2}. Arrow keys move it${b.pinned ? '; Delete removes it' : ''}.`);
    knob.title = b.pinned
      ? 'Your cut. Drag to move it (hold Alt for any character); double-click to remove it.'
      : 'Automatic cut. Drag to move it (hold Alt for any character).';
    Object.assign(knob.style, { left: px(lineStart ? m.left : at.x), top: px(at.top) });
    nodes.push(knob);

    const tools = box(`cut-tools ${kind}`, { top: px(at.top - 9) });
    const tool = (act, label, title) => {
      const btn = el('button', 'cut-tool', label);
      btn.type = 'button';
      btn.dataset.act = act;
      btn.dataset.i = i;
      btn.title = title;
      btn.setAttribute('aria-label', title);
      tools.append(btn);
    };
    tool('up', '▲', `Move the cut up: the sentence before it joins tweet ${i + 2}`);
    tool('down', '▼', `Move the cut down: the sentence after it joins tweet ${i + 1}`);
    if (b.pinned) tool('unpin', '×', 'Remove this cut');

    badge(i + 1, lineStart ? at.top : at.bottom);
  });

  // Where each tweet would hit the limit, to the character.
  derived.tweets.forEach((t, i) => {
    if (t.hard === null || t.hard >= doc.text.length) return;
    const next = derived.breaks[i];
    if (next && skipWs(doc.text, t.hard) === next.offset) return; // the cut is already drawn there
    if (doc.text[t.hard] === '\n' && doc.text[t.hard - 1] === '\n') return;
    const at = caretBox(t.hard);
    const tick = box('cut-limit', { left: px(at.x), top: px(at.top + 3), height: px(at.bottom - at.top - 6) });
    tick.dataset.limit = limit.toLocaleString();
    tick.dataset.i = i;
  });

  overlay.replaceChildren(...nodes);
  if (focusIndex !== null) $(`.cut-knob[data-i="${focusIndex}"]`, overlay)?.focus();
}

// ---------- Live preview ----------

let previewCache = new Map();

function buildPreviewTweet(t, i, total, profile) {
  const li = el('li', 'tweet');
  li.append(el('div', 'avatar', (profile.name || '?').trim().charAt(0).toUpperCase()));
  const body = el('div', 'tweet-body');
  const head = el('div', 'tweet-head');
  head.append(el('strong', 'tweet-name', profile.name), el('span', 'tweet-handle', `@${profile.handle}`), el('span', 'tweet-index', `${i + 1}/${total}`));
  const text = el('p', 'tweet-preview-text');
  text.append(linkify(t.text));
  body.append(head, text);

  if (t.media.length) {
    const grid = el('div', 'tweet-media');
    grid.dataset.count = String(Math.min(t.media.length, MAX_MEDIA_PER_TWEET));
    for (const id of t.media) {
      const media = registry.get(id);
      const fig = el('figure', 'media-item');
      fig.dataset.mediaId = id;
      fig.title = 'Click to edit, drag to another tweet to move';
      const img = el('img');
      img.alt = media?.alt || '';
      img.draggable = false;
      setSrc(img, media);
      img.addEventListener('error', () => {
        fig.classList.add('is-broken');
        fig.append(el('span', 'media-broken', media?.source === 'url' ? "This link didn't load" : 'Image file is missing'));
      });
      fig.append(img, el('span', media?.alt?.trim() ? 'badge badge-alt' : 'badge badge-alt-missing', media?.alt?.trim() ? 'Alt' : 'No alt'));
      grid.append(fig);
    }
    body.append(grid);
    if (t.media.length > MAX_MEDIA_PER_TWEET) {
      body.append(el('div', 'overrun', `${t.media.length} images land in this tweet, and a tweet can hold ${MAX_MEDIA_PER_TWEET}. Drag one to another tweet.`));
    }
  }

  const stamp = el('div', 'tweet-stamp');
  const meter = el('span', 'meter');
  const fill = el('span', 'meter-fill');
  fill.style.width = `${Math.min(100, (t.length / limit) * 100)}%`;
  meter.append(fill);
  meter.classList.toggle('is-over', t.length > limit);
  const count = el('span', t.length > limit ? 'is-over' : '', `${t.length.toLocaleString()} / ${limit.toLocaleString()}`);
  const copy = el('button', 'btn btn-small btn-quiet', 'Copy');
  copy.type = 'button';
  copy.dataset.act = 'copy';
  copy.title = "Copy this tweet's text";
  stamp.append(meter, count, el('span', 'spacer'), copy);
  body.append(stamp);
  li.append(body);
  return li;
}

function renderPreview() {
  const { profile } = getState();
  if (!profile) return;
  const total = derived.tweets.length;
  const next = new Map();
  const items = derived.tweets.map((t, i) => {
    const sig = JSON.stringify([i, total, t.text, t.media.map((id) => [id, registry.get(id)?.alt]), profile.name, profile.handle, limit]);
    const li = previewCache.get(sig) || buildPreviewTweet(t, i, total, profile);
    li.dataset.i = i;
    li.classList.toggle('is-current', i === current);
    next.set(sig, li);
    return li;
  });
  previewCache = next;
  // Reuse the nodes that did not change so images do not flicker and the column keeps its scroll position.
  let ref = previewList.firstChild;
  for (const li of items) {
    if (li === ref) ref = ref.nextSibling;
    else previewList.insertBefore(li, ref);
  }
  while (ref) {
    const gone = ref;
    ref = ref.nextSibling;
    gone.remove();
  }
}

function tweetIndexAt(offset) {
  let i = 0;
  derived.tweets.forEach((t, k) => {
    if (t.start <= offset) i = k;
  });
  return i;
}

function trackCaret() {
  const sel = getSelectionOffsets();
  if (sel) lastCaret = sel.focus;
  const next = sel ? tweetIndexAt(sel.focus) : Math.min(current, derived.tweets.length - 1);
  const moved = next !== current;
  current = next;
  for (const node of overlay.querySelectorAll('.cut-badge')) node.classList.toggle('is-current', Number(node.dataset.i) === current);
  for (const li of previewList.children) li.classList.toggle('is-current', Number(li.dataset.i) === current);
  if (!moved || !sel) return;
  // Keep the tweet being written in sight in the preview column.
  const li = previewList.children[current];
  if (!li || previewCol.scrollHeight <= previewCol.clientHeight) return;
  const top = li.offsetTop - previewCol.offsetTop;
  if (top < previewCol.scrollTop) previewCol.scrollTop = top - 8;
  else if (top + li.offsetHeight > previewCol.scrollTop + previewCol.clientHeight) previewCol.scrollTop = top + li.offsetHeight - previewCol.clientHeight + 8;
}

// Pointing at a tweet in the preview lights up its text in the draft.
const hoverHighlight = typeof Highlight !== 'undefined' && CSS.highlights ? new Highlight() : null;
if (hoverHighlight) CSS.highlights.set('draft-hover', hoverHighlight);
function highlightTweet(i) {
  if (!hoverHighlight) return;
  hoverHighlight.clear();
  const t = derived.tweets[i];
  if (!t || t.end <= t.start) return;
  const range = new Range();
  range.setStart(...locate(t.start));
  range.setEnd(...locate(tweetEnd(doc, t)));
  hoverHighlight.add(range);
}

// ---------- Cuts ----------

function setPins(pins, kind = 'cut') {
  if (!pins) return false;
  apply({ ...doc, pins }, { render: false, kind });
  return true;
}

function cutAtCaret() {
  const sel = getSelectionOffsets();
  const at = sel ? sel.focus : lastCaret;
  if (at == null) {
    toast('Click in the draft where the next tweet should start');
    return;
  }
  const target = skipWs(doc.text, at);
  if (target <= skipWs(doc.text, 0)) return;
  if (derived.breaks.some((b) => b.offset === target && b.pinned)) return;
  setPins([...doc.pins, target]);
}

function unpin(i) {
  const b = derived.breaks[i];
  if (!b?.pinned) return;
  setPins(doc.pins.filter((p) => p !== b.offset));
}

function step(i, direction, unit) {
  if (setPins(stepBreak(doc, derived, i, direction, unit))) return;
  if (direction > 0 && derived.tweets[i].hard !== null) toast(`Tweet ${i + 1} is full, so the cut can't move down`);
  else toast(direction > 0 ? "There's nothing after this cut to move" : `Tweet ${i + 1} has nothing more to give`);
}

// ---------- Images ----------

function insertionPoint() {
  const sel = getSelectionOffsets();
  if (sel) return sel.focus;
  return lastCaret ?? doc.text.length;
}

function addMedia(items, offset) {
  for (const m of items) registry.set(m.id, m);
  const at = Math.max(0, Math.min(offset ?? insertionPoint(), doc.text.length));
  apply(insertMedia(doc, at, items.map((m) => m.id)), { caret: at + items.length, kind: 'image' });
  const i = derived.tweets.findIndex((t) => t.media.includes(items[0].id));
  if (i >= 0 && derived.tweets[i].media.length > MAX_MEDIA_PER_TWEET) toast(`Tweet ${i + 1} now has more than ${MAX_MEDIA_PER_TWEET} images`);
}

async function addFiles(files, offset) {
  const images = [...files].filter((f) => isAcceptedImageType(f.type));
  if (!images.length) {
    if (files.length) toast('Only PNG, JPEG, GIF, and WebP images can be added');
    return;
  }
  const at = offset ?? insertionPoint();
  const { store } = getState();
  const added = [];
  for (const file of images) {
    try {
      added.push(createUploadMedia(await store.putImage(file, file.name || ''), file.name || ''));
    } catch (err) {
      console.error(err);
      toast(`Couldn't save ${file.name || 'that image'}`);
    }
  }
  if (added.length) addMedia(added, at);
}

/** Images from a web page become links; files and screenshots are copied in. Returns false if there was no image. */
function addFromTransfer(dt, offset) {
  const webUrl = imageUrlFromTransfer({ html: dt.getData('text/html'), uriList: dt.getData('text/uri-list') });
  if (webUrl) {
    addMedia([createUrlMedia(webUrl)], offset);
    return true;
  }
  const files = [...(dt.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return false;
  addFiles(files, offset);
  return true;
}

function moveImageToTweet(id, i) {
  const t = derived.tweets[i];
  if (!t || t.media.includes(id)) return;
  apply(moveMedia(doc, id, tweetEnd(doc, t)), { kind: 'image' });
}

// ---------- Image details dialog ----------

let dialog = null;
function buildDialog() {
  const root = el('div', 'modal-overlay draft-dialog');
  root.hidden = true;
  root.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="draft-dialog-title">
      <form class="modal-inner">
        <div class="modal-head"><h2 id="draft-dialog-title">Image</h2><button type="button" class="modal-close" data-close aria-label="Close">×</button></div>
        <div class="modal-body">
          <div class="draft-dialog-picture"><img alt=""></div>
          <p class="draft-dialog-info"></p>
          <div class="draft-dialog-move">
            <span class="draft-dialog-where"></span>
            <button type="button" class="btn btn-small" data-move="-1">◀ Move to previous tweet</button>
            <button type="button" class="btn btn-small" data-move="1">Move to next tweet ▶</button>
          </div>
          <label class="draft-dialog-label" for="draft-dialog-alt">Description (alt text)</label>
          <textarea id="draft-dialog-alt" rows="4" placeholder="Describe this image for people who are blind or have low vision."></textarea>
        </div>
        <div class="modal-foot">
          <span class="draft-dialog-count"></span>
          <button type="button" class="btn btn-danger" data-remove>Remove image</button>
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn btn-primary">Save</button>
        </div>
      </form>
    </div>`;
  document.body.append(root);
  const textarea = $('textarea', root);
  const count = $('.draft-dialog-count', root);
  const updateCount = () => {
    const n = Array.from(textarea.value).length;
    count.textContent = `${n.toLocaleString()} / ${MAX_ALT_TEXT.toLocaleString()}`;
    count.classList.toggle('is-over', n > MAX_ALT_TEXT);
  };
  const close = () => {
    root.hidden = true;
  };
  textarea.addEventListener('input', updateCount);
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) close();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('form', root).requestSubmit();
  });
  root.addEventListener('click', (e) => {
    const id = root.dataset.mediaId;
    if (e.target.closest('[data-close]')) close();
    else if (e.target.closest('[data-remove]')) {
      apply(removeMedia(doc, id), { kind: 'image' });
      close();
      toast('Image removed. Ctrl/⌘+Z brings it back.');
    } else if (e.target.closest('[data-move]')) {
      const i = derived.tweets.findIndex((t) => t.media.includes(id));
      moveImageToTweet(id, i + Number(e.target.closest('[data-move]').dataset.move));
      describe();
    }
  });
  $('form', root).addEventListener('submit', (e) => {
    e.preventDefault();
    if (Array.from(textarea.value).length > MAX_ALT_TEXT) {
      toast(`Alt text can be up to ${MAX_ALT_TEXT.toLocaleString()} characters`);
      return;
    }
    const media = registry.get(root.dataset.mediaId);
    if (media) media.alt = clampAlt(textarea.value.trim());
    editor.querySelectorAll('.draft-img').forEach(dressChip);
    renderPreview();
    save();
    close();
  });
  const describe = () => {
    const id = root.dataset.mediaId;
    const i = derived.tweets.findIndex((t) => t.media.includes(id));
    $('.draft-dialog-where', root).textContent = `In tweet ${i + 1} of ${derived.tweets.length}`;
    $('[data-move="-1"]', root).disabled = i <= 0;
    $('[data-move="1"]', root).disabled = i < 0 || i >= derived.tweets.length - 1;
  };
  return { root, textarea, updateCount, describe };
}

function openImage(id) {
  const media = registry.get(id);
  if (!media) return;
  dialog ||= buildDialog();
  const { root, textarea, updateCount, describe } = dialog;
  root.dataset.mediaId = id;
  setSrc($('.draft-dialog-picture img', root), media);
  const info = $('.draft-dialog-info', root);
  info.replaceChildren();
  if (media.source === 'url') {
    const a = el('a', '', media.url.startsWith('data:') ? 'Embedded image' : media.url);
    if (!media.url.startsWith('data:')) {
      a.href = media.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    info.append('Linked from ', a, '. Nothing is downloaded.');
  } else {
    info.append(`${media.name || 'Uploaded image'}, saved as `, el('code', '', media.imageId), ' in the images folder.');
  }
  textarea.value = media.alt || '';
  updateCount();
  describe();
  root.hidden = false;
  textarea.focus();
}

// ---------- Dragging: cut knobs and images ----------

function dragCut(e, i) {
  e.preventDefault();
  measure();
  const stops = wordStarts(doc.text);
  let moved = false;
  sheet.classList.add('is-cutting');
  sheet.dataset.cutting = i;
  const onMove = (ev) => {
    const raw = offsetFromPoint(ev.clientX, ev.clientY);
    if (raw === null) return;
    const range = breakRange(doc, derived, i);
    const target = ev.altKey ? Math.max(range.min, Math.min(raw, range.max)) : nearest(stops, raw, range);
    if (target === null || skipWs(doc.text, target) === derived.breaks[i]?.offset) return;
    const pins = moveBreak(doc, derived, i, target);
    if (!pins) return;
    doc = { ...doc, pins };
    moved = true;
    refresh();
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    sheet.classList.remove('is-cutting');
    delete sheet.dataset.cutting;
    if (moved) {
      record('cut');
      save();
    }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

function dragImage(e, id) {
  if (e.button) return;
  e.preventDefault();
  const start = { x: e.clientX, y: e.clientY };
  let ghost = null;
  let caretMark = null;
  let target = null;
  const clear = () => {
    caretMark?.remove();
    caretMark = null;
    previewList.querySelectorAll('.is-drop-target').forEach((n) => n.classList.remove('is-drop-target'));
  };
  const onMove = (ev) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
      ghost = el('div', 'draft-ghost');
      const img = el('img');
      setSrc(img, registry.get(id));
      ghost.append(img);
      document.body.append(ghost);
      document.body.classList.add('is-dragging-image');
      measure();
    }
    ghost.style.transform = `translate(${ev.clientX + 10}px, ${ev.clientY + 10}px)`;
    clear();
    target = null;
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const li = under?.closest?.('#draft-preview > .tweet');
    if (li) {
      li.classList.add('is-drop-target');
      target = { tweet: Number(li.dataset.i) };
    } else if (under && sheet.contains(under)) {
      const offset = offsetFromPoint(ev.clientX, ev.clientY);
      if (offset === null) return;
      const at = caretBox(offset);
      caretMark = el('div', 'draft-drop-caret');
      Object.assign(caretMark.style, { left: `${at.x}px`, top: `${at.top + 2}px`, height: `${at.bottom - at.top - 4}px` });
      overlay.append(caretMark);
      target = { offset };
    }
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('is-dragging-image');
    clear();
    if (!ghost) return openImage(id); // a plain click
    ghost.remove();
    if (!target) return;
    if ('tweet' in target) moveImageToTweet(id, target.tweet);
    else apply(moveMedia(doc, id, target.offset), { kind: 'image' });
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

// ---------- Events ----------

function bind() {
  try {
    editor.contentEditable = 'plaintext-only';
  } catch {
    /* older browsers */
  }
  if (editor.contentEditable !== 'plaintext-only') editor.contentEditable = 'true';

  editor.addEventListener('input', onInput);
  editor.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
      e.preventDefault();
      travel(e.inputType === 'historyUndo' ? -1 : 1);
    } else if (e.inputType.startsWith('format')) {
      e.preventDefault();
    }
  });
  editor.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      cutAtCaret();
    } else if (mod && !e.altKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      travel(e.shiftKey ? 1 : -1);
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      travel(1);
    } else if (e.key === 'Backspace' && !mod) {
      // Backspace right after a cut you placed removes the cut, not a letter.
      const sel = getSelectionOffsets();
      if (!sel || sel.from !== sel.to) return;
      const i = derived.breaks.findIndex((b) => b.pinned && b.offset === sel.focus);
      if (i >= 0) {
        e.preventDefault();
        unpin(i);
      }
    }
  });
  editor.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    e.preventDefault();
    const hasImage = [...dt.items].some((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (hasImage && addFromTransfer(dt)) return;
    const pasted = dt.getData('text/plain');
    if (!pasted) return;
    const sel = getSelectionOffsets() || { from: doc.text.length, to: doc.text.length };
    // Pasting over a selection that holds images removes those images too.
    let base = doc;
    const inside = [...doc.text.slice(sel.from, sel.to)].filter((ch) => ch === OBJ).length;
    if (inside) {
      const firstIndex = [...doc.text.slice(0, sel.from)].filter((ch) => ch === OBJ).length;
      base = { ...doc, media: doc.media.filter((_, k) => k < firstIndex || k >= firstIndex + inside) };
    }
    const { doc: next, caret } = insertText(base, sel.from, sel.to, pasted);
    apply(next, { caret, kind: 'paste' });
  });

  // Images dropped from the computer or from a web page land where they are dropped.
  const isImageDrag = (dt) => [...dt.types].some((t) => t === 'Files' || t === 'text/uri-list');
  for (const zone of [sheet, previewList]) {
    zone.addEventListener('dragover', (e) => {
      if (!isImageDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
  }
  sheet.addEventListener('drop', (e) => {
    if (!isImageDrag(e.dataTransfer)) return;
    measure();
    const offset = offsetFromPoint(e.clientX, e.clientY);
    if (addFromTransfer(e.dataTransfer, offset ?? doc.text.length)) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  previewList.addEventListener('drop', (e) => {
    const li = e.target.closest?.('.tweet');
    if (!li || !isImageDrag(e.dataTransfer)) return;
    const t = derived.tweets[Number(li.dataset.i)];
    if (t && addFromTransfer(e.dataTransfer, tweetEnd(doc, t))) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  editor.addEventListener('pointerdown', (e) => {
    const chipEl = e.target.closest?.('.draft-img');
    if (chipEl) dragImage(e, chipEl.dataset.mediaId);
  });

  overlay.addEventListener('pointerdown', (e) => {
    const knob = e.target.closest('.cut-knob');
    if (knob && !e.button) dragCut(e, Number(knob.dataset.i));
  });
  overlay.addEventListener('dblclick', (e) => {
    const knob = e.target.closest('.cut-knob');
    if (knob) unpin(Number(knob.dataset.i));
  });
  overlay.addEventListener('click', (e) => {
    const tool = e.target.closest('.cut-tool');
    if (tool) {
      const i = Number(tool.dataset.i);
      if (tool.dataset.act === 'unpin') unpin(i);
      else step(i, tool.dataset.act === 'up' ? -1 : 1, 'sentence');
      return;
    }
    const badge = e.target.closest('.cut-badge');
    if (badge) setCaret(derived.tweets[Number(badge.dataset.i)].start);
  });
  overlay.addEventListener('keydown', (e) => {
    const knob = e.target.closest('.cut-knob');
    if (!knob) return;
    const i = Number(knob.dataset.i);
    const keys = { ArrowUp: [-1, 'sentence'], ArrowDown: [1, 'sentence'], ArrowLeft: [-1, 'word'], ArrowRight: [1, 'word'] };
    if (keys[e.key]) {
      e.preventDefault();
      step(i, ...keys[e.key]);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      unpin(i);
    }
  });

  previewList.addEventListener('pointerdown', (e) => {
    const fig = e.target.closest('.media-item');
    if (fig) dragImage(e, fig.dataset.mediaId);
  });
  previewList.addEventListener('click', async (e) => {
    const li = e.target.closest('.tweet');
    if (!li || e.target.closest('.media-item') || e.target.closest('a')) return;
    const t = derived.tweets[Number(li.dataset.i)];
    if (e.target.closest('[data-act="copy"]')) {
      await navigator.clipboard.writeText(t.text);
      toast('Tweet copied');
      return;
    }
    if (String(document.getSelection()) !== '') return; // selecting text in the preview
    setCaret(t.start);
    const at = caretBox(t.start);
    const y = metrics.sheet.top + at.top;
    if (y < 60 || y > window.innerHeight - 80) window.scrollBy({ top: y - 140, behavior: 'smooth' });
  });
  previewList.addEventListener('mouseover', (e) => {
    const li = e.target.closest('.tweet');
    if (li) highlightTweet(Number(li.dataset.i));
  });
  previewList.addEventListener('mouseleave', () => hoverHighlight?.clear());

  $('#draft-cut').addEventListener('mousedown', (e) => e.preventDefault()); // keep the caret in the draft
  $('#draft-cut').addEventListener('click', cutAtCaret);
  $('#draft-reflow').addEventListener('click', () => {
    if (!doc.pins.length) return toast('Every cut is already automatic');
    setPins([]);
    toast('Cuts reset. Ctrl/⌘+Z brings them back.');
  });
  $('#draft-photo').addEventListener('click', () => $('#draft-file').click());
  $('#draft-file').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    addFiles(files);
  });
  const urlForm = $('#draft-url-form');
  $('#draft-url-open').addEventListener('click', () => {
    urlForm.hidden = !urlForm.hidden;
    if (!urlForm.hidden) $('#draft-url-input').focus();
    draw();
  });
  $('#draft-url-cancel').addEventListener('click', () => {
    urlForm.hidden = true;
    draw();
  });
  urlForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = parseImageUrl($('#draft-url-input').value);
    if (!url) return toast('Enter a web address that starts with http:// or https://');
    $('#draft-url-input').value = '';
    urlForm.hidden = true;
    addMedia([createUrlMedia(url)]);
  });

  document.addEventListener('selectionchange', () => {
    if (visible() && editor.contains(document.getSelection()?.anchorNode)) trackCaret();
  });
  document.addEventListener('tweetmgr:view', (e) => {
    if (e.detail === 'draft') syncFromThread();
  });
  new ResizeObserver(() => draw()).observe(editor);
  document.fonts?.ready.then(() => draw());
}

bind();
onThreadRender(syncFromThread);
