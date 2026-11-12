// Pure helpers for tweet media. No DOM access, so they can be unit tested
// in Node (see test/mediaUtils.test.js).
import { MAX_ALT_TEXT, MAX_MEDIA_PER_TWEET, uid } from './model.js';

export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export function isAcceptedImageType(type) {
  return ACCEPTED_TYPES.includes(String(type || '').toLowerCase());
}

/** Returns a normalized http(s) URL, or null if `text` is not one. */
export function parseImageUrl(text) {
  const s = String(text || '').trim();
  if (!s || /\s/.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Finds the image URL in data dragged or copied from a web page: the first
 * http(s) <img src> in text/html, else the first http(s) line in
 * text/uri-list that ends in an image extension (so dropping a plain link
 * isn't mistaken for an image). Returns null when there is none.
 */
export function imageUrlFromTransfer({ html = '', uriList = '' } = {}) {
  const m = /<img\b[^>]*?\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html);
  if (m) {
    const src = parseImageUrl(decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
    if (src) return src;
  }
  for (const line of String(uriList).split(/\r?\n/)) {
    if (line.startsWith('#')) continue;
    const u = parseImageUrl(line);
    if (u && looksLikeImage(u)) return u;
  }
  return null;
}

/** True when a URL's path ends in a common image extension. */
export function looksLikeImage(url) {
  try {
    return /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

export function createUploadMedia(imageId, name = '') {
  return { id: uid('m_'), source: 'upload', imageId, alt: '', ...(name ? { name } : {}) };
}

export function createUrlMedia(url) {
  return { id: uid('m_'), source: 'url', url, alt: '' };
}

/** How many more images a tweet can take. */
export function slotsLeft(tweet) {
  return Math.max(0, MAX_MEDIA_PER_TWEET - (tweet.media?.length || 0));
}

export function clampAlt(text) {
  return Array.from(String(text || '')).slice(0, MAX_ALT_TEXT).join('');
}

/** Moves a media item by `delta` positions; returns true if it moved. */
export function moveMedia(tweet, mediaId, delta) {
  const i = tweet.media.findIndex((m) => m.id === mediaId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= tweet.media.length) return false;
  const [item] = tweet.media.splice(i, 1);
  tweet.media.splice(j, 0, item);
  return true;
}
