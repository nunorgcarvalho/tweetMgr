// Local server: serves the web app from public/ and a small JSON API over
// the data/ folder (see lib/fsStore.js). Zero dependencies.
//
//   npm start            -> http://localhost:4321
//   PORT, HOST, TWEETMGR_DATA environment variables override the defaults.
//
// API (JSON unless noted):
//   GET    /api/health
//   GET    /api/profiles                PUT /api/profiles/:id
//   GET    /api/threads[?profileId=]    GET/PUT/DELETE /api/threads/:id
//   POST   /api/images  (raw image body; ?name=file.png)  -> { id }
//   GET    /api/images/:id  (image bytes)     DELETE /api/images/:id
//   GET    /api/settings/:key           PUT /api/settings/:key  { value }
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsStore, defaultDataDir } from './lib/fsStore.js';

const ROOT = resolve(fileURLToPath(new URL('./public', import.meta.url)));
const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 25 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function createApp(store) {
  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  const readBody = (req) =>
    new Promise((resolveBody, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error('Body too large'), { status: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolveBody(Buffer.concat(chunks)));
      req.on('error', reject);
    });

  const readJsonBody = async (req) => {
    try {
      return JSON.parse((await readBody(req)).toString('utf8'));
    } catch (err) {
      throw Object.assign(new Error('Invalid JSON body'), { status: err.status || 400 });
    }
  };

  async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent); // drop "api"
    const [resource, id] = parts;
    const m = req.method;

    if (resource === 'health') return send(res, 200, { ok: true, dataDir: store.dir });

    if (resource === 'profiles') {
      if (!id && m === 'GET') return send(res, 200, await store.listProfiles());
      if (id && m === 'GET') {
        const p = await store.getProfile(id);
        return p ? send(res, 200, p) : send(res, 404, { error: 'Not found' });
      }
      if (id && m === 'PUT') return send(res, 200, await store.saveProfile({ ...(await readJsonBody(req)), id }));
    }

    if (resource === 'threads') {
      if (!id && m === 'GET') return send(res, 200, await store.listThreads(url.searchParams.get('profileId')));
      if (id && m === 'GET') {
        const t = await store.getThread(id);
        return t ? send(res, 200, t) : send(res, 404, { error: 'Not found' });
      }
      if (id && m === 'PUT') return send(res, 200, await store.saveThread({ ...(await readJsonBody(req)), id }));
      if (id && m === 'DELETE') {
        await store.deleteThread(id);
        return send(res, 204);
      }
    }

    if (resource === 'images') {
      if (!id && m === 'POST') {
        const body = await readBody(req);
        const newId = await store.putImage(body, {
          type: (req.headers['content-type'] || '').split(';')[0],
          name: url.searchParams.get('name') || undefined,
        });
        return send(res, 201, { id: newId });
      }
      if (id && m === 'GET') {
        const img = await store.getImage(id);
        if (!img) return send(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': img.type, 'Cache-Control': 'private, max-age=31536000, immutable' });
        return res.end(img.data);
      }
      if (id && m === 'DELETE') {
        await store.deleteImage(id);
        return send(res, 204);
      }
    }

    if (resource === 'settings' && id) {
      if (m === 'GET') return send(res, 200, { value: (await store.getSetting(id)) ?? null });
      if (m === 'PUT') {
        const { value } = await readJsonBody(req);
        await store.setSetting(id, value);
        return send(res, 200, { value });
      }
    }

    return send(res, 404, { error: 'Unknown API route' });
  }

  async function staticFile(req, res, url) {
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) return res.writeHead(403).end('Forbidden');
    try {
      if (!(await stat(file)).isFile()) throw new Error('not a file');
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else await staticFile(req, res, url);
    } catch (err) {
      if (!res.headersSent) send(res, err.status || 500, { error: err.message });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.js')) {
  const store = await new FsStore(defaultDataDir()).init();
  createApp(store).listen(PORT, HOST, () => {
    console.log(`tweetMgr running at http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`);
    console.log(`Data folder: ${store.dir}`);
  });
}
