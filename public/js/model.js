// Data model. Plain JSON-serializable objects so the same shapes can be
// stored in IndexedDB today and synced to a server in a future public version.
//
// Profile  { id, name, handle, accountType, customLimit, createdAt, updatedAt }
// Thread   { id, profileId, title, tweets: Tweet[], createdAt, updatedAt, schemaVersion }
// Tweet    { id, text, media: Media[] }
// Media    { id, source: 'upload' | 'url', imageId?, url?, alt, name? }
//   - 'upload': the image is a file in data/images/ named imageId
//     (e.g. "img_ab12cd34ef56.png"). Browsers never reveal where a picked
//     file lives on disk, so uploads are copied into data/images/. Agents and
//     scripts can add figures by dropping a file there and referencing it.
//   - 'url': only the remote URL is stored; nothing is downloaded.

export const SCHEMA_VERSION = 1;

export const ACCOUNT_TYPES = {
  free: { label: 'Free (not verified)', limit: 280 },
  premium: { label: 'Premium / verified', limit: 25000 },
  custom: { label: 'Custom limit', limit: null },
};

export const MAX_MEDIA_PER_TWEET = 4;
export const MAX_ALT_TEXT = 1000;

export function uid(prefix = '') {
  const rand =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return prefix + rand;
}

const now = () => new Date().toISOString();

export function createProfile(fields = {}) {
  return {
    id: uid('p_'),
    name: 'Your Name',
    handle: 'yourhandle',
    accountType: 'free',
    customLimit: 280,
    createdAt: now(),
    updatedAt: now(),
    ...fields,
  };
}

export function charLimit(profile) {
  if (!profile) return ACCOUNT_TYPES.free.limit;
  if (profile.accountType === 'custom') return Math.max(1, Number(profile.customLimit) || 280);
  return (ACCOUNT_TYPES[profile.accountType] || ACCOUNT_TYPES.free).limit;
}

export function createTweet(text = '') {
  return { id: uid('t_'), text, media: [] };
}

export function createThread(profileId, fields = {}) {
  return {
    id: uid('th_'),
    profileId,
    title: 'Untitled thread',
    tweets: [createTweet()],
    createdAt: now(),
    updatedAt: now(),
    schemaVersion: SCHEMA_VERSION,
    ...fields,
  };
}

export function touch(obj) {
  obj.updatedAt = now();
  return obj;
}

/**
 * Minimal JSON for the typing macro (see typer/). Shape:
 * { title, tweets: [{ text, images: [{ alt, url? }] }] }
 */
export function toTyperJson(thread) {
  return {
    title: thread.title,
    tweets: thread.tweets.map((t) => ({
      text: t.text,
      images: t.media.map((m) => (m.source === 'url' ? { alt: m.alt || '', url: m.url } : { alt: m.alt || '' })),
    })),
  };
}
