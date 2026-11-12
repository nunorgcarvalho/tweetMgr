// Theme extras that sit on top of the app shell without changing it:
//   - the Compose / Preview tabs, where Preview shows the thread as a
//     read-only timeline, the way it will look once posted;
//   - the summary card in the sidebar (who you are, how big the thread is).
// Both read the shared state from app.js and refresh whenever the composer
// re-renders or the text changes.
import { getState, renderThread } from './app.js';
import { tweetLength } from './counter.js';
import { charLimit } from './model.js';

const $ = (sel, root = document) => root.querySelector(sel);

// Links, @mentions, and #hashtags are shown in link color, as on a timeline.
const ENTITY_RE = /(https?:\/\/[^\s]+|www\.[^\s]+)|(^|[^\w@])(@\w{1,15})|(^|[^\w#&])(#[\p{L}\p{N}_]+)/gu;

export function linkify(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(ENTITY_RE)) {
    const lead = m[2] ?? m[4] ?? '';
    const entity = m[1] ?? m[3] ?? m[5];
    const start = m.index + lead.length;
    frag.append(text.slice(last, start));
    const a = document.createElement('a');
    a.textContent = entity;
    if (m[1]) {
      a.href = entity.startsWith('www.') ? `https://${entity}` : entity;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    frag.append(a);
    last = start + entity.length;
  }
  frag.append(text.slice(last));
  return frag;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function initial(profile) {
  return (profile.name || '?').trim().charAt(0).toUpperCase();
}

function mediaSrc(media, store) {
  if (media.source === 'url') return media.url;
  if (media.imageId && store.imageUrl) return store.imageUrl(media.imageId);
  return null;
}

function renderPreview() {
  const { thread, profile, store } = getState();
  if (!thread || !profile) return;
  const limit = charLimit(profile);
  const total = thread.tweets.length;
  $('#preview-tweets').replaceChildren(
    ...thread.tweets.map((tweet, i) => {
      const li = el('li', 'tweet');
      li.append(el('div', 'avatar', initial(profile)));
      const body = el('div', 'tweet-body');
      const head = el('div', 'tweet-head');
      head.append(el('strong', 'tweet-name', profile.name), el('span', 'tweet-handle', `@${profile.handle}`));
      const text = el('p', 'tweet-preview-text');
      text.append(linkify(tweet.text));
      body.append(head, text);

      const images = (tweet.media || []).map((m) => ({ m, src: mediaSrc(m, store) })).filter((x) => x.src);
      if (images.length) {
        const media = el('div', 'tweet-media');
        for (const { m, src } of images) {
          const fig = el('figure', 'media-item');
          const img = el('img');
          Promise.resolve(src).then((url) => (img.src = url));
          img.alt = m.alt || '';
          fig.append(img);
          fig.append(el('span', m.alt ? 'badge badge-alt' : 'badge badge-alt-missing', m.alt ? 'Alt' : 'No alt'));
          media.append(fig);
        }
        body.append(media);
      }

      const stamp = el('div', 'tweet-stamp');
      const length = tweetLength(tweet.text);
      stamp.append(`${i + 1} of ${total} · `);
      stamp.append(
        length > limit
          ? el('span', 'is-over', `${(length - limit).toLocaleString()} over the limit`)
          : `${length.toLocaleString()} characters`,
      );
      body.append(stamp);
      li.append(body);
      return li;
    }),
  );
}

function renderSummary() {
  const { thread, profile } = getState();
  if (!thread || !profile) return;
  const limit = charLimit(profile);
  const lengths = thread.tweets.map((t) => tweetLength(t.text));
  const over = lengths.filter((n) => n > limit).length;
  $('#summary-avatar').textContent = initial(profile);
  $('#summary-name').textContent = profile.name;
  $('#summary-handle').textContent = `@${profile.handle}`;
  $('#stat-tweets').textContent = thread.tweets.length.toLocaleString();
  $('#stat-chars').textContent = lengths.reduce((a, b) => a + b, 0).toLocaleString();
  $('#stat-over').textContent = over.toLocaleString();
  $('#stat-over-item').classList.toggle('is-over', over > 0);
}

// Three views share the content column: the continuous draft (default, with
// its own live preview beside it), the per-tweet cards, and the full preview.
let view = 'draft';
function setView(next) {
  view = next;
  const preview = view === 'preview';
  const cards = view === 'compose';
  if (preview) renderPreview();
  $('#draft-view').hidden = view !== 'draft';
  $('#tweets').hidden = !cards;
  $('#compose-footer').hidden = !cards;
  $('#preview').hidden = !preview;
  document.body.dataset.view = view;
  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.view === view;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  // The cards measure their text boxes, which only works once visible.
  if (cards) renderThread();
  document.dispatchEvent(new CustomEvent('tweetmgr:view', { detail: view }));
}

function refresh() {
  renderSummary();
  if (view === 'preview') renderPreview();
}

$('.tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) setView(tab.dataset.view);
});
// The composer replaces the tweet list on every structural change (and on
// load), and fires input events while typing; both are our cue to refresh.
new MutationObserver(refresh).observe($('#tweets'), { childList: true });
document.addEventListener('input', refresh);
document.addEventListener('tweetmgr:edit', refresh);
setView(view);
refresh();
