import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStore } from '../lib/fsStore.js';
import { createApp } from '../server.js';

let dir, server, base;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tweetmgr-'));
  const store = await new FsStore(dir).init();
  server = createApp(store);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('threads round-trip through the API and land as JSON files', async () => {
  const thread = { id: 'th_1', profileId: 'p_1', title: 'Hello', tweets: [{ id: 't1', text: 'hi', media: [] }], updatedAt: '2026-01-01T00:00:00Z' };
  let res = await fetch(`${base}/api/threads/th_1`, { method: 'PUT', body: JSON.stringify(thread) });
  assert.equal(res.status, 200);
  const onDisk = JSON.parse(await readFile(join(dir, 'threads', 'th_1.json'), 'utf8'));
  assert.equal(onDisk.title, 'Hello');
  res = await fetch(`${base}/api/threads?profileId=p_1`);
  assert.equal((await res.json()).length, 1);
  res = await fetch(`${base}/api/threads/th_1`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  res = await fetch(`${base}/api/threads/th_1`);
  assert.equal(res.status, 404);
});

test('images upload to data/images and are served back', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  let res = await fetch(`${base}/api/images?name=fig.png`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
  assert.equal(res.status, 201);
  const { id } = await res.json();
  assert.match(id, /^img_[0-9a-f]+\.png$/);
  res = await fetch(`${base}/api/images/${id}`);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
});

test('rejects path traversal ids', async () => {
  const res = await fetch(`${base}/api/threads/..%2Fsettings`);
  assert.equal(res.status, 400);
});

test('settings persist', async () => {
  await fetch(`${base}/api/settings/activeThreadId`, { method: 'PUT', body: JSON.stringify({ value: 'th_9' }) });
  const res = await fetch(`${base}/api/settings/activeThreadId`);
  assert.deepEqual(await res.json(), { value: 'th_9' });
});

test('profiles can be deleted', async () => {
  await fetch(`${base}/api/profiles/p_gone`, { method: 'PUT', body: JSON.stringify({ name: 'Gone' }) });
  let res = await fetch(`${base}/api/profiles/p_gone`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  res = await fetch(`${base}/api/profiles/p_gone`);
  assert.equal(res.status, 404);
});
