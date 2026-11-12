import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charLimit, createProfile, createThread, toTyperJson } from '../public/js/model.js';

test('char limit follows account type', () => {
  assert.equal(charLimit(createProfile()), 280);
  assert.equal(charLimit(createProfile({ accountType: 'premium' })), 25000);
  assert.equal(charLimit(createProfile({ accountType: 'custom', customLimit: 500 })), 500);
});

test('toTyperJson emits the macro shape', () => {
  const th = createThread('p1', { title: 'T' });
  th.tweets[0].text = 'hello';
  th.tweets[0].media = [
    { id: 'm1', source: 'upload', imageId: 'img_1.png', alt: 'a chart' },
    { id: 'm2', source: 'url', url: 'https://example.com/x.png', alt: '' },
  ];
  assert.deepEqual(toTyperJson(th), {
    title: 'T',
    tweets: [{ text: 'hello', images: [{ alt: 'a chart' }, { alt: '', url: 'https://example.com/x.png' }] }],
  });
});
