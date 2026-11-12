// Browser-side storage. The UI only talks to the Store interface below, so
// the backend can change without touching the UI:
//
//   HttpStore      (default) talks to the local server, which keeps plain
//                  files in data/ that the CLI and other agents can also
//                  read and edit. See lib/fsStore.js.
//   IndexedDbStore keeps everything inside the browser. Meant for a future
//                  hosted/public version where there is no local server.
//
// Interface (all methods async unless noted):
//   kind                         'files' | 'browser'
//   listProfiles()               getProfile(id)          saveProfile(profile)
//   listThreads(profileId)       getThread(id)           saveThread(thread)
//   deleteThread(id)
//   putImage(blob, name) -> id   imageUrl(id) -> string  deleteImage(id)
//   getSetting(key)              setSetting(key, value)

import { uid } from './model.js';

const DB_NAME = 'tweetmgr';
const DB_VERSION = 1;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class HttpStore {
  constructor(base = '/api') {
    this.kind = 'files';
    this.base = base;
  }

  async _fetch(path, opts = {}) {
    const res = await fetch(this.base + path, opts);
    if (res.status === 404 && (!opts.method || opts.method === 'GET')) return undefined;
    if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} failed: ${res.status}`);
    return res.status === 204 ? undefined : res.json();
  }
  _put(path, body) {
    return this._fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  _id(id) {
    return encodeURIComponent(id);
  }

  listProfiles() {
    return this._fetch('/profiles');
  }
  getProfile(id) {
    return this._fetch(`/profiles/${this._id(id)}`);
  }
  saveProfile(p) {
    return this._put(`/profiles/${this._id(p.id)}`, p);
  }
  listThreads(profileId) {
    return this._fetch(`/threads${profileId ? `?profileId=${encodeURIComponent(profileId)}` : ''}`);
  }
  getThread(id) {
    return this._fetch(`/threads/${this._id(id)}`);
  }
  saveThread(t) {
    return this._put(`/threads/${this._id(t.id)}`, t);
  }
  deleteThread(id) {
    return this._fetch(`/threads/${this._id(id)}`, { method: 'DELETE' });
  }
  async putImage(blob, name = '') {
    const res = await this._fetch(`/images?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    });
    return res.id;
  }
  imageUrl(id) {
    return `${this.base}/images/${this._id(id)}`;
  }
  deleteImage(id) {
    return this._fetch(`/images/${this._id(id)}`, { method: 'DELETE' });
  }
  async getSetting(key) {
    const r = await this._fetch(`/settings/${this._id(key)}`);
    return r ? r.value ?? undefined : undefined;
  }
  setSetting(key, value) {
    return this._put(`/settings/${this._id(key)}`, { value });
  }
}

export class IndexedDbStore {
  constructor(dbName = DB_NAME) {
    this.kind = 'browser';
    this.dbName = dbName;
    this._db = null;
    this._urls = new Map();
  }

  async open() {
    if (this._db) return this._db;
    const r = indexedDB.open(this.dbName, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('profiles')) db.createObjectStore('profiles', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('threads')) {
        const s = db.createObjectStore('threads', { keyPath: 'id' });
        s.createIndex('profileId', 'profileId');
      }
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    this._db = await req(r);
    return this._db;
  }

  async _tx(store, mode, fn) {
    const db = await this.open();
    const tx = db.transaction(store, mode);
    const result = await fn(tx.objectStore(store));
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return result;
  }

  // Profiles
  listProfiles() {
    return this._tx('profiles', 'readonly', (s) => req(s.getAll()));
  }
  getProfile(id) {
    return this._tx('profiles', 'readonly', (s) => req(s.get(id)));
  }
  saveProfile(profile) {
    return this._tx('profiles', 'readwrite', (s) => req(s.put(profile))).then(() => profile);
  }

  // Threads (newest first)
  async listThreads(profileId) {
    const all = await this._tx('threads', 'readonly', (s) =>
      req(profileId ? s.index('profileId').getAll(profileId) : s.getAll()),
    );
    return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  getThread(id) {
    return this._tx('threads', 'readonly', (s) => req(s.get(id)));
  }
  saveThread(thread) {
    return this._tx('threads', 'readwrite', (s) => req(s.put(thread))).then(() => thread);
  }
  deleteThread(id) {
    return this._tx('threads', 'readwrite', (s) => req(s.delete(id)));
  }

  // Images (uploaded files are copied in as Blobs)
  async putImage(blob, name = '') {
    const id = uid('img_');
    await this._tx('images', 'readwrite', (s) =>
      req(s.put({ id, blob, name, type: blob.type, createdAt: new Date().toISOString() })),
    );
    this._urls.set(id, URL.createObjectURL(blob));
    return id;
  }
  // Object URLs must be created up front; call loadImages(ids) before render.
  async loadImages(ids) {
    for (const id of ids) {
      if (this._urls.has(id)) continue;
      const rec = await this._tx('images', 'readonly', (s) => req(s.get(id)));
      if (rec) this._urls.set(id, URL.createObjectURL(rec.blob));
    }
  }
  imageUrl(id) {
    return this._urls.get(id) || '';
  }
  deleteImage(id) {
    return this._tx('images', 'readwrite', (s) => req(s.delete(id)));
  }

  // Settings (small key/value pairs, e.g. the active profile and thread)
  async getSetting(key) {
    const rec = await this._tx('settings', 'readonly', (s) => req(s.get(key)));
    return rec ? rec.value : undefined;
  }
  setSetting(key, value) {
    return this._tx('settings', 'readwrite', (s) => req(s.put({ key, value })));
  }
}

/** Use the local server's file storage when available, else the browser. */
export async function openStore() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (res.ok) return new HttpStore();
  } catch {
    /* no local server: fall through */
  }
  return new IndexedDbStore();
}
