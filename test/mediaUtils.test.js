import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampAlt,
  createUploadMedia,
  createUrlMedia,
  imageUrlFromTransfer,
  isAcceptedImageType,
  looksLikeImage,
  moveMedia,
  parseImageUrl,
  slotsLeft,
} from '../public/js/mediaUtils.js';

test('accepts only the image types the server can store', () => {
  for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'IMAGE/PNG']) assert.ok(isAcceptedImageType(t), t);
  for (const t of ['image/svg+xml', 'image/heic', 'text/plain', '', undefined]) assert.ok(!isAcceptedImageType(t), String(t));
});

test('parseImageUrl keeps http(s) URLs only', () => {
  assert.equal(parseImageUrl('  https://example.com/a.png '), 'https://example.com/a.png');
  assert.equal(parseImageUrl('http://example.com/x'), 'http://example.com/x');
  for (const bad of ['', 'example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAA', 'file:///tmp/a.png', 'https://a.com/a b.png']) {
    assert.equal(parseImageUrl(bad), null, bad);
  }
});

test('imageUrlFromTransfer prefers the <img src> from copied or dragged HTML', () => {
  const html = '<meta charset="utf-8"><img src="https://cdn.example.com/fig.png?w=1&amp;h=2" alt="x">';
  assert.equal(imageUrlFromTransfer({ html, uriList: 'https://example.com/page' }), 'https://cdn.example.com/fig.png?w=1&h=2');
  assert.equal(imageUrlFromTransfer({ html: "<img alt='y' src='https://x.org/y.jpg'>" }), 'https://x.org/y.jpg');
});

test('imageUrlFromTransfer ignores data URLs and plain page links', () => {
  assert.equal(imageUrlFromTransfer({ html: '<img src="data:image/png;base64,AAA">' }), null);
  assert.equal(imageUrlFromTransfer({ uriList: 'https://example.com/article' }), null);
  assert.equal(imageUrlFromTransfer({ uriList: '# comment\nhttps://example.com/photo.JPG' }), 'https://example.com/photo.JPG');
  assert.equal(imageUrlFromTransfer({ uriList: 'file:///Users/me/a.png' }), null);
  assert.equal(imageUrlFromTransfer({}), null);
});

test('looksLikeImage checks the path, not the query string', () => {
  assert.ok(looksLikeImage('https://a.com/b/c.webp?x=1'));
  assert.ok(!looksLikeImage('https://a.com/b?file=c.png'));
});

test('media constructors match docs/DATA_FORMAT.md', () => {
  const up = createUploadMedia('img_abc.png', 'figure.png');
  assert.match(up.id, /^m_/);
  assert.deepEqual({ ...up, id: 'm' }, { id: 'm', source: 'upload', imageId: 'img_abc.png', alt: '', name: 'figure.png' });
  const link = createUrlMedia('https://a.com/b.png');
  assert.deepEqual({ ...link, id: 'm' }, { id: 'm', source: 'url', url: 'https://a.com/b.png', alt: '' });
});

test('slotsLeft caps a tweet at four images', () => {
  assert.equal(slotsLeft({ media: [] }), 4);
  assert.equal(slotsLeft({ media: [1, 2, 3] }), 1);
  assert.equal(slotsLeft({ media: [1, 2, 3, 4, 5] }), 0);
});

test('clampAlt limits alt text to 1,000 characters, counting emoji once', () => {
  assert.equal(clampAlt('a'.repeat(1200)).length, 1000);
  assert.equal(Array.from(clampAlt('🧬'.repeat(1001))).length, 1000);
  assert.equal(clampAlt(undefined), '');
});

test('moveMedia reorders within bounds', () => {
  const t = { media: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  assert.ok(moveMedia(t, 'c', -1));
  assert.deepEqual(t.media.map((m) => m.id), ['a', 'c', 'b']);
  assert.ok(!moveMedia(t, 'a', -1));
  assert.ok(!moveMedia(t, 'zzz', 1));
});
