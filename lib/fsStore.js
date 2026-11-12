// File-system store: the source of truth for local use.
// Shared by the local web server (server.js) and the CLI, so the web app,
// scripts, and other agents all read and edit the same plain files.
//
// Layout (default ./data, override with TWEETMGR_DATA):
//   data/
//     profiles/<profileId>.json
//     threads/<threadId>.json      one pretty-printed JSON file per thread
//     images/<imageId>             uploaded images, e.g. img_ab12cd.png
//     settings.json                small key/value pairs (active profile, etc.)
//
// Everything under data/ is gitignored: it is personal user data.

import { mkdir, readFile, readdir, rm, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, extname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

const ID_RE = /^[A-Za-z0-9_.-]+$/;

export const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const EXT_FOR_TYPE = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

export function defaultDataDir() {
  return resolve(process.env.TWEETMGR_DATA || join(process.cwd(), 'data'));
}

function checkId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id) || id.startsWith('.')) {
    throw Object.assign(new Error(`Invalid id: ${id}`), { status: 400 });
  }
  return id;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
}

// Write to a temp file then rename, so a reader never sees half a file.
async function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

export class FsStore {
  constructor(dir = defaultDataDir()) {
    this.dir = dir;
    this.paths = {
      profiles: join(dir, 'profiles'),
      threads: join(dir, 'threads'),
      images: join(dir, 'images'),
      settings: join(dir, 'settings.json'),
    };
  }

  async init() {
    for (const p of [this.paths.profiles, this.paths.threads, this.paths.images]) {
      await mkdir(p, { recursive: true });
    }
    return this;
  }

  async _list(dir) {
    if (!existsSync(dir)) return [];
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    const items = await Promise.all(files.map((f) => readJson(join(dir, f))));
    return items.filter(Boolean);
  }

  // Profiles
  listProfiles() {
    return this._list(this.paths.profiles);
  }
  getProfile(id) {
    return readJson(join(this.paths.profiles, `${checkId(id)}.json`));
  }
  async saveProfile(profile) {
    await this.init();
    await writeJson(join(this.paths.profiles, `${checkId(profile.id)}.json`), profile);
    return profile;
  }

  // Threads (newest first)
  async listThreads(profileId) {
    const all = await this._list(this.paths.threads);
    return all
      .filter((t) => !profileId || t.profileId === profileId)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  getThread(id) {
    return readJson(join(this.paths.threads, `${checkId(id)}.json`));
  }
  async saveThread(thread) {
    await this.init();
    await writeJson(join(this.paths.threads, `${checkId(thread.id)}.json`), thread);
    return thread;
  }
  async deleteThread(id) {
    await rm(join(this.paths.threads, `${checkId(id)}.json`), { force: true });
  }

  // Images. The id is the file name (with extension) inside data/images.
  async putImage(buffer, { type, name } = {}) {
    await this.init();
    const ext = EXT_FOR_TYPE[type] || (name && IMAGE_TYPES[extname(name).toLowerCase()] ? extname(name).toLowerCase() : '');
    if (!ext) throw Object.assign(new Error('Unsupported image type'), { status: 415 });
    const id = `img_${randomBytes(6).toString('hex')}${ext}`;
    await writeFile(join(this.paths.images, id), buffer);
    return id;
  }
  async getImage(id) {
    checkId(id);
    try {
      const data = await readFile(join(this.paths.images, basename(id)));
      return { data, type: IMAGE_TYPES[extname(id).toLowerCase()] || 'application/octet-stream' };
    } catch (err) {
      if (err.code === 'ENOENT') return undefined;
      throw err;
    }
  }
  async deleteImage(id) {
    await rm(join(this.paths.images, basename(checkId(id))), { force: true });
  }

  // Settings
  async getSetting(key) {
    const all = (await readJson(this.paths.settings)) || {};
    return all[key];
  }
  async setSetting(key, value) {
    await mkdir(this.dir, { recursive: true });
    const all = (await readJson(this.paths.settings)) || {};
    all[key] = value;
    await writeJson(this.paths.settings, all);
  }
}
