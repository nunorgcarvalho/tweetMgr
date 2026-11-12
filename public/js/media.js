// Images on tweets: add by file picker, paste, drag and drop, or URL; up to
// four per tweet, each with alt text. Hooks into the app through
// onRenderTweet / mutateThread (see app.js) and stores files through the
// Store's putImage / imageUrl (see storage.js).
//
// Where images live:
//   - Files from your computer (picker, paste of a screenshot, drop of a
//     file) are copied into the store, i.e. data/images/ with the local
//     server. Browsers never reveal a file's original path.
//   - Images dragged or pasted from a web page, or added with "Image URL",
//     are kept as links. Nothing is downloaded.
import { findTweet, getState, mutateThread, onRenderTweet, renderThread, toast } from './app.js';
import { MAX_ALT_TEXT, MAX_MEDIA_PER_TWEET } from './model.js';
import {
  ACCEPTED_TYPES,
  clampAlt,
  createUploadMedia,
  createUrlMedia,
  imageUrlFromTransfer,
  isAcceptedImageType,
  moveMedia,
  parseImageUrl,
  slotsLeft,
} from './mediaUtils.js';

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

function srcFor(media) {
  if (media.source === 'url') return media.url;
  return getState().store.imageUrl(media.imageId);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ---------- Adding images ----------

/** Copies image files into the store and attaches them to a tweet. */
async function addFiles(tweetId, files) {
  const images = [...files].filter((f) => isAcceptedImageType(f.type));
  if (files.length && !images.length) {
    toast('Only PNG, JPEG, GIF, and WebP images can be attached');
    return;
  }
  const tweet = findTweet(tweetId);
  if (!tweet) return;
  const room = slotsLeft(tweet);
  if (!room) return toast(`A tweet can have up to ${MAX_MEDIA_PER_TWEET} images`);
  const take = images.slice(0, room);
  const { store } = getState();
  const added = [];
  for (const file of take) {
    try {
      const imageId = await store.putImage(file, file.name || '');
      added.push(createUploadMedia(imageId, file.name || ''));
    } catch (err) {
      console.error(err);
      toast(`Couldn't save ${file.name || 'that image'}`);
    }
  }
  if (!added.length) return;
  mutateThread(() => {
    const t = findTweet(tweetId);
    if (t) t.media.push(...added.slice(0, slotsLeft(t)));
  });
  if (images.length > take.length) toast(`Only ${plural(take.length, 'image')} fit; a tweet can have up to ${MAX_MEDIA_PER_TWEET}`);
}

function addUrl(tweetId, url) {
  const tweet = findTweet(tweetId);
  if (!tweet) return false;
  if (!slotsLeft(tweet)) {
    toast(`A tweet can have up to ${MAX_MEDIA_PER_TWEET} images`);
    return false;
  }
  mutateThread(() => findTweet(tweetId)?.media.push(createUrlMedia(url)));
  return true;
}

/**
 * Handles a DataTransfer from paste or drop. Images from a web page become
 * links; files from the computer (or a pasted screenshot) are copied in.
 * Returns a promise if it found an image to add, otherwise null.
 */
function addFromTransfer(tweetId, dt) {
  const files = [...(dt.files || [])].filter((f) => f.type.startsWith('image/'));
  const webUrl = imageUrlFromTransfer({ html: dt.getData('text/html'), uriList: dt.getData('text/uri-list') });
  if (webUrl) return Promise.resolve(addUrl(tweetId, webUrl));
  if (files.length) return addFiles(tweetId, files);
  return null;
}

/** Re-rendering replaces the textarea, so put the cursor back after a paste. */
function refocus(tweetId) {
  const ta = $(`.tweet[data-id="${tweetId}"] .tweet-text`);
  if (ta) {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
}

// ---------- Rendering ----------

function renderMediaItem(media, tweet, index) {
  const img = el('img', { src: srcFor(media), alt: media.alt || '', loading: 'lazy', draggable: false });
  const fig = el('figure', { className: 'media-item', dataset: { mediaId: media.id } }, img);
  img.addEventListener('error', () => {
    fig.classList.add('is-broken');
    fig.append(
      el('span', { className: 'media-broken' }, media.source === 'url' ? "This link didn't load" : 'Image file is missing'),
    );
  });

  const hasAlt = Boolean(media.alt?.trim());
  const altBtn = el(
    'button',
    {
      type: 'button',
      className: `media-alt-badge${hasAlt ? ' has-alt' : ''}`,
      dataset: { mediaAction: 'alt' },
      title: hasAlt ? `Alt text: ${media.alt}` : 'Add a description (alt text) for people who use screen readers',
    },
    hasAlt ? 'ALT' : '+ ALT',
  );
  const tools = el(
    'div',
    { className: 'media-tools' },
    tweet.media.length > 1 && index > 0
      ? el('button', { type: 'button', className: 'media-tool', dataset: { mediaAction: 'left' }, title: 'Move earlier', ariaLabel: 'Move image earlier' }, '‹')
      : null,
    tweet.media.length > 1 && index < tweet.media.length - 1
      ? el('button', { type: 'button', className: 'media-tool', dataset: { mediaAction: 'right' }, title: 'Move later', ariaLabel: 'Move image later' }, '›')
      : null,
    el('button', { type: 'button', className: 'media-tool media-remove', dataset: { mediaAction: 'remove' }, title: 'Remove image', ariaLabel: 'Remove image' }, '×'),
  );
  fig.append(altBtn, tools);
  if (media.source === 'url') {
    fig.append(el('a', { className: 'media-source', href: media.url, target: '_blank', rel: 'noopener noreferrer', title: media.url }, 'link'));
  }
  return fig;
}

function decorateTweet(li, tweet) {
  const slot = $('.tweet-media', li);
  const count = tweet.media.length;
  slot.hidden = count === 0;
  slot.dataset.count = String(count);
  slot.replaceChildren(...tweet.media.map((m, i) => renderMediaItem(m, tweet, i)));

  // Media buttons go at the start of the action bar, next to the counter.
  const actions = $('.tweet-actions', li);
  const full = count >= MAX_MEDIA_PER_TWEET;
  const fileInput = el('input', { type: 'file', accept: ACCEPTED_TYPES.join(','), multiple: true, hidden: true, className: 'media-file-input' });
  const photoBtn = el(
    'button',
    {
      type: 'button',
      className: 'btn btn-small media-add',
      dataset: { mediaAction: 'pick' },
      disabled: full,
      title: full ? `Up to ${MAX_MEDIA_PER_TWEET} images per tweet` : 'Add photos from your computer (or paste / drop them on the tweet)',
    },
    el('span', { className: 'media-add-icon', ariaHidden: 'true' }),
    'Photo',
  );
  const urlBtn = el(
    'button',
    { type: 'button', className: 'btn btn-small', dataset: { mediaAction: 'url-open' }, disabled: full, title: 'Attach an image by its web address (stored as a link)' },
    'Image URL',
  );
  const countLabel = count ? el('span', { className: 'media-count' }, `${count}/${MAX_MEDIA_PER_TWEET}`) : null;
  const group = el('span', { className: 'media-buttons' }, photoBtn, urlBtn, countLabel, fileInput);
  actions.querySelector('.spacer')?.before(group);

  // Inline "Image URL" form, shown on demand.
  const form = el(
    'form',
    { className: 'media-url-form', hidden: true },
    el('input', { type: 'url', className: 'media-url-input', placeholder: 'https://example.com/figure.png', ariaLabel: 'Image URL', required: true }),
    el('button', { type: 'submit', className: 'btn btn-small btn-primary' }, 'Add'),
    el('button', { type: 'button', className: 'btn btn-small', dataset: { mediaAction: 'url-cancel' } }, 'Cancel'),
  );
  actions.before(form);
}

// ---------- Alt text editor ----------

let altDialog = null;

function buildAltDialog() {
  const preview = el('img', { className: 'alt-preview', alt: '' });
  const textarea = el('textarea', { className: 'alt-text', rows: 5, placeholder: 'Describe this image for people who are blind or have low vision.' });
  const counter = el('span', { className: 'alt-counter', ariaLive: 'polite' });
  const form = el(
    'form',
    { method: 'dialog', className: 'alt-form' },
    el('div', { className: 'alt-head' }, el('h2', {}, 'Edit image description'), el('button', { type: 'button', className: 'alt-close', value: 'cancel', ariaLabel: 'Close', dataset: { altClose: '' } }, '×')),
    el('div', { className: 'alt-preview-wrap' }, preview),
    el('label', { className: 'alt-label' }, 'Description (alt text)', textarea),
    el(
      'div',
      { className: 'alt-foot' },
      el('a', { href: 'https://help.x.com/en/using-x/write-image-descriptions', target: '_blank', rel: 'noopener noreferrer' }, 'What is alt text?'),
      el('span', { className: 'spacer' }),
      counter,
      el('button', { type: 'button', className: 'btn', dataset: { altClose: '' } }, 'Cancel'),
      el('button', { type: 'submit', className: 'btn btn-primary', value: 'save' }, 'Save'),
    ),
  );
  const dialog = el('dialog', { className: 'alt-dialog', ariaLabel: 'Edit image description' }, form);

  const updateCounter = () => {
    const n = Array.from(textarea.value).length;
    counter.textContent = `${n.toLocaleString()} / ${MAX_ALT_TEXT.toLocaleString()}`;
    counter.classList.toggle('is-over', n > MAX_ALT_TEXT);
  };
  textarea.addEventListener('input', updateCounter);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('[data-alt-close]')) dialog.close('cancel');
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (Array.from(textarea.value).length > MAX_ALT_TEXT) {
      toast(`Alt text can be up to ${MAX_ALT_TEXT.toLocaleString()} characters`);
      return;
    }
    dialog.close('save');
  });
  dialog.addEventListener('close', () => {
    const { tweetId, mediaId } = dialog.dataset;
    if (dialog.returnValue === 'save') {
      const alt = clampAlt(textarea.value.trim());
      mutateThread(() => {
        const m = findTweet(tweetId)?.media.find((x) => x.id === mediaId);
        if (m) m.alt = alt;
      });
    }
    // Return focus to the badge that opened the dialog.
    $(`.tweet[data-id="${tweetId}"] [data-media-id="${mediaId}"] .media-alt-badge`)?.focus();
  });

  document.body.append(dialog);
  return { dialog, preview, textarea, updateCounter };
}

function openAltEditor(tweetId, mediaId) {
  const media = findTweet(tweetId)?.media.find((m) => m.id === mediaId);
  if (!media) return;
  altDialog ||= buildAltDialog();
  const { dialog, preview, textarea, updateCounter } = altDialog;
  dialog.dataset.tweetId = tweetId;
  dialog.dataset.mediaId = mediaId;
  dialog.returnValue = '';
  preview.src = srcFor(media);
  textarea.value = media.alt || '';
  updateCounter();
  dialog.showModal();
  textarea.focus();
}

// ---------- Events ----------

function bindEvents() {
  const list = $('#tweets');
  const tweetIdOf = (node) => node.closest('.tweet')?.dataset.id;

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-media-action]');
    if (!btn) return;
    const li = btn.closest('.tweet');
    const tweetId = li.dataset.id;
    const mediaId = btn.closest('[data-media-id]')?.dataset.mediaId;
    switch (btn.dataset.mediaAction) {
      case 'pick':
        $('.media-file-input', li).click();
        break;
      case 'url-open': {
        const form = $('.media-url-form', li);
        form.hidden = false;
        $('input', form).focus();
        break;
      }
      case 'url-cancel':
        $('.media-url-form', li).hidden = true;
        break;
      case 'alt':
        openAltEditor(tweetId, mediaId);
        break;
      case 'left':
      case 'right':
        mutateThread(() => moveMedia(findTweet(tweetId), mediaId, btn.dataset.mediaAction === 'left' ? -1 : 1));
        break;
      case 'remove':
        // The file stays in data/images/ so nothing is lost by a misclick.
        mutateThread(() => {
          const t = findTweet(tweetId);
          t.media = t.media.filter((m) => m.id !== mediaId);
        });
        break;
    }
  });

  list.addEventListener('change', (e) => {
    if (!e.target.classList.contains('media-file-input')) return;
    const files = [...e.target.files];
    e.target.value = '';
    addFiles(tweetIdOf(e.target), files);
  });

  list.addEventListener('submit', (e) => {
    if (!e.target.classList.contains('media-url-form')) return;
    e.preventDefault();
    const input = $('.media-url-input', e.target);
    const url = parseImageUrl(input.value);
    if (!url) {
      toast('Enter a web address that starts with http:// or https://');
      input.focus();
      return;
    }
    addUrl(tweetIdOf(e.target), url);
  });

  list.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target.classList.contains('media-url-input')) {
      e.target.closest('form').hidden = true;
    }
  });

  // Paste an image (a screenshot, or "Copy image" on a web page) while
  // typing in a tweet. Plain text pastes are left alone.
  list.addEventListener('paste', (e) => {
    const tweetId = tweetIdOf(e.target);
    if (!tweetId || e.target.classList.contains('media-url-input')) return;
    const dt = e.clipboardData;
    if (!dt) return;
    const hasImageFile = [...dt.items].some((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (!hasImageFile) return;
    e.preventDefault();
    addFromTransfer(tweetId, dt)?.then(() => refocus(tweetId));
  });

  // Drag and drop files from the computer or images from a web page.
  const isImageDrag = (dt) =>
    [...dt.types].some((t) => t === 'Files' || t === 'text/uri-list');
  let dragDepth = new WeakMap();
  list.addEventListener('dragenter', (e) => {
    const li = e.target.closest?.('.tweet');
    if (!li || !isImageDrag(e.dataTransfer)) return;
    dragDepth.set(li, (dragDepth.get(li) || 0) + 1);
    li.classList.add('is-drop-target');
  });
  list.addEventListener('dragover', (e) => {
    const li = e.target.closest?.('.tweet');
    if (!li || !isImageDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  list.addEventListener('dragleave', (e) => {
    const li = e.target.closest?.('.tweet');
    if (!li) return;
    const depth = (dragDepth.get(li) || 1) - 1;
    dragDepth.set(li, depth);
    if (depth <= 0) li.classList.remove('is-drop-target');
  });
  list.addEventListener('drop', (e) => {
    const li = e.target.closest?.('.tweet');
    if (!li) return;
    li.classList.remove('is-drop-target');
    dragDepth = new WeakMap();
    // Not an image: let a text drop into the textarea happen as usual.
    if (addFromTransfer(li.dataset.id, e.dataTransfer)) e.preventDefault();
  });
  // Dropping a file anywhere else would navigate away from the app.
  window.addEventListener('dragover', (e) => {
    if (!e.target.closest?.('.tweet') && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!e.target.closest?.('.tweet') && [...e.dataTransfer.types].includes('Files')) {
      e.preventDefault();
      toast('Drop images onto a tweet to attach them');
    }
  });
}

onRenderTweet(decorateTweet);
bindEvents();
// In case the app rendered before this module loaded.
if (getState().thread) renderThread();
