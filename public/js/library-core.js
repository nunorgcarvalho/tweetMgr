// Thread library logic with no DOM: duplicating threads, finding images that
// are safe to delete, and the single-file export bundle. Runs in the browser
// and in Node (tests, a future CLI), so it never touches fetch or files
// itself; callers pass in small functions that read or write images.
//
// Export bundle (`*.tweetmgr.json`), see docs/DATA_FORMAT.md:
//   {
//     "format": "tweetmgr.thread",
//     "version": 1,
//     "exportedAt": "2026-11-12T02:00:00.000Z",
//     "thread": { ...a normal thread file... },
//     "images": { "<imageId>": { "type": "image/png", "data": "data:image/png;base64,..." } }
//   }
// Uploaded images are embedded as data URLs so one file carries everything.
// URL images stay as URLs.

import { SCHEMA_VERSION, uid } from './model.js';

export const BUNDLE_FORMAT = 'tweetmgr.thread';
export const BUNDLE_VERSION = 1;

const now = () => new Date().toISOString();

/** Image ids (files in data/images) that a thread's uploaded media point to. */
export function uploadedImageIds(thread) {
  const ids = new Set();
  for (const tweet of thread?.tweets || []) {
    for (const m of tweet.media || []) if (m.source === 'upload' && m.imageId) ids.add(m.imageId);
  }
  return [...ids];
}

/**
 * Images used by `removed` threads that no thread in `remaining` still uses,
 * so they can be deleted without breaking a duplicate.
 */
export function orphanedImageIds(removed, remaining) {
  const kept = new Set(remaining.flatMap(uploadedImageIds));
  return [...new Set(removed.flatMap(uploadedImageIds))].filter((id) => !kept.has(id));
}

/**
 * Deep copy of a thread with fresh ids for the thread, tweets, and media.
 * `imageMap` renames image ids (used on import); duplicates share image files.
 */
export function cloneThread(thread, fields = {}, imageMap = {}) {
  const copy = structuredClone(thread);
  copy.id = uid('th_');
  copy.createdAt = now();
  copy.updatedAt = copy.createdAt;
  copy.schemaVersion = copy.schemaVersion || SCHEMA_VERSION;
  copy.tweets = (copy.tweets || []).map((t) => ({
    ...t,
    id: uid('t_'),
    text: typeof t.text === 'string' ? t.text : '',
    media: (t.media || []).map((m) => ({
      ...m,
      id: uid('m_'),
      ...(m.imageId && imageMap[m.imageId] ? { imageId: imageMap[m.imageId] } : {}),
    })),
  }));
  return Object.assign(copy, fields);
}

/** "Copy of X", "Copy of X (2)", ... avoiding titles already in the list. */
export function copyTitle(title, existingTitles = []) {
  const base = `Copy of ${title || 'Untitled thread'}`;
  const taken = new Set(existingTitles);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}

/**
 * Build an export bundle. `readImage(id)` resolves to { type, data } where
 * data is a data URL, or to undefined if the file is gone. Missing images are
 * listed in `missingImages` so the UI can warn instead of failing.
 */
export async function buildBundle(thread, { readImage }) {
  const images = {};
  const missingImages = [];
  for (const id of uploadedImageIds(thread)) {
    const img = await readImage(id);
    if (img && img.data) images[id] = { type: img.type, data: img.data };
    else missingImages.push(id);
  }
  return {
    bundle: { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt: now(), thread, images },
    missingImages,
  };
}

/** File name for an export: "why-do-cells-age.tweetmgr.json". */
export function bundleFileName(thread) {
  const slug = String(thread?.title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 60);
  return `${slug || 'thread'}.tweetmgr.json`;
}

const fail = (msg) => {
  throw new Error(msg);
};

/**
 * Accept an export bundle, or a bare thread file copied out of data/threads.
 * Returns { thread, images } or throws an Error with a readable message.
 */
export function parseBundle(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch {
      fail('That file is not valid JSON.');
    }
  }
  if (!data || typeof data !== 'object') fail('That file does not contain a thread.');
  let thread;
  let images = {};
  if (data.format === BUNDLE_FORMAT) {
    if (Number(data.version) > BUNDLE_VERSION) fail('That file was made by a newer version of tweetMgr.');
    thread = data.thread;
    images = data.images && typeof data.images === 'object' ? data.images : {};
  } else if (Array.isArray(data.tweets)) {
    thread = data;
  } else {
    fail('That file is not a tweetMgr thread.');
  }
  if (!thread || !Array.isArray(thread.tweets)) fail('That file does not contain a thread.');
  for (const t of thread.tweets) {
    if (!t || typeof t !== 'object') fail('A tweet in that file is malformed.');
    if (t.media !== undefined && !Array.isArray(t.media)) fail('A tweet in that file has malformed media.');
  }
  for (const [id, img] of Object.entries(images)) {
    if (!img || typeof img.data !== 'string' || !img.data.startsWith('data:image/')) {
      fail(`Image ${id} in that file is not an embedded image.`);
    }
  }
  return { thread, images };
}

/**
 * Turn a parsed bundle into a new thread owned by `profileId`. Embedded
 * images are stored with `putImage({ id, type, data })` -> newId, and the
 * thread is re-pointed at the new ids. Never overwrites an existing thread.
 */
export async function materializeBundle({ thread, images }, { profileId, putImage }) {
  const imageMap = {};
  for (const [id, img] of Object.entries(images || {})) {
    imageMap[id] = await putImage({ id, type: img.type, data: img.data });
  }
  return cloneThread(thread, { profileId, title: thread.title || 'Imported thread' }, imageMap);
}
