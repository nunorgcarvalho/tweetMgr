import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUNDLE_FORMAT,
  buildBundle,
  bundleFileName,
  cloneThread,
  copyTitle,
  materializeBundle,
  orphanedImageIds,
  parseBundle,
  uploadedImageIds,
} from '../public/js/library-core.js';

const thread = {
  id: 'th_a',
  profileId: 'p_1',
  title: 'Why do cells age?',
  schemaVersion: 1,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  tweets: [
    {
      id: 't_1',
      text: 'One',
      media: [
        { id: 'm_1', source: 'upload', imageId: 'img_1.png', alt: 'Figure 1' },
        { id: 'm_2', source: 'url', url: 'https://example.com/a.png', alt: 'Remote' },
      ],
    },
    { id: 't_2', text: 'Two', media: [{ id: 'm_3', source: 'upload', imageId: 'img_2.png', alt: '' }] },
  ],
};

test('uploadedImageIds lists only uploaded files', () => {
  assert.deepEqual(uploadedImageIds(thread), ['img_1.png', 'img_2.png']);
});

test('cloneThread gives fresh ids but shares image files', () => {
  const copy = cloneThread(thread, { title: 'Copy' });
  assert.notEqual(copy.id, thread.id);
  assert.equal(copy.title, 'Copy');
  assert.notEqual(copy.tweets[0].id, 't_1');
  assert.notEqual(copy.tweets[0].media[0].id, 'm_1');
  assert.equal(copy.tweets[0].media[0].imageId, 'img_1.png');
  assert.equal(copy.tweets[0].media[0].alt, 'Figure 1');
  assert.equal(thread.tweets[0].id, 't_1', 'original untouched');
});

test('copyTitle avoids existing titles', () => {
  assert.equal(copyTitle('X', []), 'Copy of X');
  assert.equal(copyTitle('X', ['Copy of X', 'Copy of X (2)']), 'Copy of X (3)');
});

test('orphanedImageIds keeps images still used by a duplicate', () => {
  const dup = cloneThread(thread);
  dup.tweets.pop(); // the duplicate no longer uses img_2
  assert.deepEqual(orphanedImageIds([thread], [dup]), ['img_2.png']);
  assert.deepEqual(orphanedImageIds([thread], []), ['img_1.png', 'img_2.png']);
});

test('export then import round-trips text, alt text, and images', async () => {
  const files = { 'img_1.png': 'data:image/png;base64,AAAA' };
  const { bundle, missingImages } = await buildBundle(thread, {
    readImage: async (id) => (files[id] ? { type: 'image/png', data: files[id] } : undefined),
  });
  assert.equal(bundle.format, BUNDLE_FORMAT);
  assert.deepEqual(missingImages, ['img_2.png']);
  assert.deepEqual(Object.keys(bundle.images), ['img_1.png']);

  const stored = [];
  const parsed = parseBundle(JSON.stringify(bundle));
  const imported = await materializeBundle(parsed, {
    profileId: 'p_2',
    putImage: async (img) => {
      stored.push(img);
      return 'img_new.png';
    },
  });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].data, files['img_1.png']);
  assert.equal(imported.profileId, 'p_2');
  assert.notEqual(imported.id, thread.id);
  assert.equal(imported.title, thread.title);
  assert.deepEqual(imported.tweets.map((t) => t.text), ['One', 'Two']);
  assert.equal(imported.tweets[0].media[0].imageId, 'img_new.png');
  assert.equal(imported.tweets[0].media[0].alt, 'Figure 1');
  assert.equal(imported.tweets[0].media[1].url, 'https://example.com/a.png');
});

test('parseBundle accepts a bare thread file and rejects junk', () => {
  assert.equal(parseBundle(JSON.stringify(thread)).thread.title, thread.title);
  assert.throws(() => parseBundle('not json'), /not valid JSON/);
  assert.throws(() => parseBundle('{"hello":1}'), /not a tweetMgr thread/);
  assert.throws(() => parseBundle({ format: BUNDLE_FORMAT, version: 99, thread }), /newer version/);
  assert.throws(
    () => parseBundle({ format: BUNDLE_FORMAT, version: 1, thread, images: { x: { data: 'javascript:alert(1)' } } }),
    /not an embedded image/,
  );
});

test('bundleFileName makes a safe slug', () => {
  assert.equal(bundleFileName(thread), 'why-do-cells-age.tweetmgr.json');
  assert.equal(bundleFileName({ title: '🧵' }), 'thread.tweetmgr.json');
});
