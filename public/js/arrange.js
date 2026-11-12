// Splitting and arranging tools: split at cursor, push overflow to the next
// tweet, merge, move, drag to reorder, and turn a long draft into a thread.
// Hooks into the app shell only through its exported API.
import { getState, mutateThread, onRenderTweet, toast } from './app.js';
import { charLimit, createTweet, MAX_MEDIA_PER_TWEET } from './model.js';
import { tweetLength } from './counter.js';
import { joinTexts, reflow, splitOverflow, splitText } from './split.js';

const $ = (sel, root = document) => root.querySelector(sel);
const limit = () => charLimit(getState().profile);
const tweets = () => getState().thread.tweets;
const indexOf = (id) => tweets().findIndex((t) => t.id === id);

function focusTweet(id, caret = 0) {
  const ta = $(`.tweet[data-id="${id}"] .tweet-text`);
  if (!ta) return;
  ta.focus();
  ta.setSelectionRange(caret, caret);
}

// ---------- Operations ----------

export function splitAtCursor(id, at) {
  const i = indexOf(id);
  const t = tweets()[i];
  const before = t.text.slice(0, at).trimEnd();
  const after = t.text.slice(at).trimStart();
  const next = createTweet(after);
  mutateThread((th) => {
    th.tweets[i].text = before;
    th.tweets.splice(i + 1, 0, next);
  });
  focusTweet(next.id);
}

export function pushOverflow(id) {
  const i = indexOf(id);
  const [head, tail] = splitOverflow(tweets()[i].text, limit());
  if (!tail) return;
  let nextId;
  mutateThread((th) => {
    th.tweets[i].text = head;
    const next = th.tweets[i + 1];
    if (next) next.text = joinTexts(tail, next.text);
    else th.tweets.splice(i + 1, 0, createTweet(tail));
    nextId = th.tweets[i + 1].id;
  });
  focusTweet(nextId);
}

export function mergeWithNext(id) {
  const i = indexOf(id);
  const [a, b] = [tweets()[i], tweets()[i + 1]];
  if (!b) return;
  if (a.media.length + b.media.length > MAX_MEDIA_PER_TWEET) {
    toast(`Can't merge: a tweet can hold at most ${MAX_MEDIA_PER_TWEET} images`);
    return;
  }
  const caret = a.text.trimEnd().length + (a.text.trim() && b.text.trim() ? 1 : 0);
  mutateThread((th) => {
    th.tweets[i].text = joinTexts(a.text, b.text);
    th.tweets[i].media = [...a.media, ...b.media];
    th.tweets.splice(i + 1, 1);
  });
  focusTweet(id, caret);
  if (tweetLength(tweets()[i].text) > limit()) toast('Merged tweet is over the limit');
}

export function move(id, delta) {
  const i = indexOf(id);
  const j = i + delta;
  if (j < 0 || j >= tweets().length) return;
  mutateThread((th) => {
    const [t] = th.tweets.splice(i, 1);
    th.tweets.splice(j, 0, t);
  });
  $(`.tweet[data-id="${id}"] .tweet-text`)?.focus();
}

export function moveTo(id, targetIndex) {
  const i = indexOf(id);
  if (i < 0 || i === targetIndex) return;
  mutateThread((th) => {
    const [t] = th.tweets.splice(i, 1);
    th.tweets.splice(targetIndex > i ? targetIndex - 1 : targetIndex, 0, t);
  });
}

export function fitAll() {
  const before = tweets().length;
  const texts = reflow(tweets().map((t) => t.text), limit());
  mutateThread((th) => {
    texts.forEach((text, i) => {
      if (th.tweets[i]) th.tweets[i].text = text;
      else th.tweets.push(createTweet(text));
    });
  });
  const added = tweets().length - before;
  toast(added ? `Fitted thread; added ${added} tweet${added === 1 ? '' : 's'}` : 'Fitted thread');
}

export function importDraft(text, { numbering, mode }) {
  const parts = splitText(text, limit(), { numbering });
  if (!parts.length) return;
  mutateThread((th) => {
    const fresh = parts.map((p) => createTweet(p));
    const onlyEmpty = th.tweets.length === 1 && !th.tweets[0].text.trim() && !th.tweets[0].media.length;
    if (mode === 'replace' || onlyEmpty) th.tweets = fresh;
    else th.tweets.push(...fresh);
  });
  toast(`Split into ${parts.length} tweet${parts.length === 1 ? '' : 's'}`);
}

// ---------- Per-tweet controls ----------

const CONTROLS = [
  ['split', '✂ Split', 'Split at the cursor (Ctrl/⌘+Enter)'],
  ['overflow', 'Fit ↓', 'Move the text over the limit into the next tweet'],
  ['merge', 'Merge ↓', 'Merge with the next tweet'],
  ['up', '▲', 'Move up (Alt+↑)'],
  ['down', '▼', 'Move down (Alt+↓)'],
];

onRenderTweet((li, tweet, index) => {
  const total = tweets().length;
  const over = tweetLength(tweet.text) > limit();
  const bar = document.createElement('span');
  bar.className = 'arrange-controls';
  for (const [action, label, title] of CONTROLS) {
    const b = document.createElement('button');
    b.type = 'button';
    // Quiet buttons show on hover, matching the theme's per-tweet actions;
    // Fit stays loud because it flags a problem.
    b.className = action === 'overflow' ? 'btn btn-small' : 'btn btn-small btn-quiet';
    b.dataset.arrange = action;
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    if ((action === 'up' && index === 0) || ((action === 'down' || action === 'merge') && index === total - 1)) b.disabled = true;
    if (action === 'overflow') b.hidden = !over;
    bar.append(b);
  }
  $('.tweet-actions .spacer', li).after(bar);

  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.title = 'Drag to reorder';
  handle.textContent = '⋮⋮';
  handle.setAttribute('aria-hidden', 'true');
  li.prepend(handle);
  li.draggable = false;
  handle.addEventListener('pointerdown', () => (li.draggable = true));
  li.addEventListener('dragend', () => (li.draggable = false));
});

function bind() {
  const list = $('#tweets');

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-arrange]');
    if (!btn) return;
    const li = btn.closest('.tweet');
    const id = li.dataset.id;
    switch (btn.dataset.arrange) {
      case 'split': {
        const ta = $('.tweet-text', li);
        const at = ta.selectionStart || 0;
        if (at === 0 || at >= ta.value.length) {
          toast('Click inside the text where you want to split');
          ta.focus();
          return;
        }
        splitAtCursor(id, at);
        break;
      }
      case 'overflow':
        pushOverflow(id);
        break;
      case 'merge':
        mergeWithNext(id);
        break;
      case 'up':
        move(id, -1);
        break;
      case 'down':
        move(id, 1);
        break;
    }
  });

  // Keep the "Fit" button in sync while typing.
  list.addEventListener('input', (e) => {
    if (!e.target.classList.contains('tweet-text')) return;
    const li = e.target.closest('.tweet');
    const btn = $('[data-arrange="overflow"]', li);
    if (btn) btn.hidden = tweetLength(e.target.value) <= limit();
    updateFitAll();
  });

  list.addEventListener('keydown', (e) => {
    if (!e.target.classList.contains('tweet-text')) return;
    const id = e.target.closest('.tweet').dataset.id;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      splitAtCursor(id, e.target.selectionStart);
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      move(id, e.key === 'ArrowUp' ? -1 : 1);
    } else if (e.key === 'Backspace' && e.target.selectionStart === 0 && e.target.selectionEnd === 0) {
      // Backspace at the very start merges into the previous tweet.
      const i = indexOf(id);
      if (i > 0) {
        e.preventDefault();
        mergeWithNext(tweets()[i - 1].id);
      }
    }
  });

  // Drag and drop reordering.
  let dragId = null;
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.tweet');
    if (!li) return;
    dragId = li.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
    li.classList.add('is-dragging');
  });
  list.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const li = e.target.closest('.tweet');
    list.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    if (!li || li.dataset.id === dragId) return;
    const after = e.clientY > li.getBoundingClientRect().top + li.offsetHeight / 2;
    li.classList.add(after ? 'drop-after' : 'drop-before');
  });
  list.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const target = list.querySelector('.drop-before, .drop-after');
    if (target) {
      let idx = indexOf(target.dataset.id);
      if (target.classList.contains('drop-after')) idx += 1;
      moveTo(dragId, idx);
    }
    dragId = null;
  });
  list.addEventListener('dragend', () => {
    dragId = null;
    list.querySelectorAll('.is-dragging, .drop-before, .drop-after').forEach((el) => el.classList.remove('is-dragging', 'drop-before', 'drop-after'));
  });
}

// ---------- Thread-level tools ----------

function buildToolbar() {
  const bar = document.createElement('div');
  bar.className = 'arrange-toolbar';
  bar.innerHTML = `
    <button type="button" class="btn btn-small" id="open-draft">Split a long draft…</button>
    <button type="button" class="btn btn-small" id="fit-all" title="Push text over the limit into the following tweets">Fit all to limit</button>
    <span class="arrange-tip">Tip: Ctrl/⌘+Enter splits at the cursor, Alt+↑/↓ moves a tweet.</span>
    <form class="draft-panel" id="draft-panel" hidden>
      <label for="draft-text">Paste or write a long draft. It's split at paragraphs, then sentences, then words. A line with just <code>---</code> forces a break.</label>
      <textarea id="draft-text" rows="8" placeholder="Paste your whole thread here…"></textarea>
      <div class="draft-options">
        <label><input type="checkbox" id="draft-numbering"> Number tweets (1/n)</label>
        <label><input type="radio" name="draft-mode" value="append" checked> Add to the end</label>
        <label><input type="radio" name="draft-mode" value="replace"> Replace this thread</label>
        <span class="draft-count" id="draft-count"></span>
        <button type="button" class="btn btn-small draft-cancel" id="draft-cancel">Cancel</button>
        <button type="submit" class="btn btn-small btn-primary">Split into tweets</button>
      </div>
    </form>`;
  $('.content-header').after(bar);

  const panel = $('#draft-panel');
  const text = $('#draft-text');
  const numbering = $('#draft-numbering');
  const preview = () => {
    const n = splitText(text.value, limit(), { numbering: numbering.checked }).length;
    $('#draft-count').textContent = n ? `→ ${n} tweet${n === 1 ? '' : 's'}` : '';
  };
  $('#open-draft').addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) text.focus();
  });
  $('#draft-cancel').addEventListener('click', () => (panel.hidden = true));
  text.addEventListener('input', preview);
  numbering.addEventListener('change', preview);
  panel.addEventListener('submit', (e) => {
    e.preventDefault();
    const mode = panel.querySelector('input[name="draft-mode"]:checked').value;
    if (mode === 'replace' && tweets().some((t) => t.text.trim()) && !confirmReplace()) return;
    importDraft(text.value, { numbering: numbering.checked, mode });
    text.value = '';
    preview();
    panel.hidden = true;
  });
  $('#fit-all').addEventListener('click', fitAll);
}

// Two-step confirm without a blocking dialog: the first click arms the button.
let armed = false;
function confirmReplace() {
  if (armed) return true;
  armed = true;
  toast('This replaces the current tweets. Click again to confirm.');
  setTimeout(() => (armed = false), 4000);
  return false;
}

function updateFitAll() {
  const btn = $('#fit-all');
  if (btn) btn.disabled = !tweets().some((t) => tweetLength(t.text) > limit());
}

onRenderTweet(() => queueMicrotask(updateFitAll));

buildToolbar();
bind();
