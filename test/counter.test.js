import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tweetLength, findUrls, remaining } from '../public/js/counter.js';

test('plain ASCII counts one per character', () => {
  assert.equal(tweetLength('hello world'), 11);
  assert.equal(tweetLength(''), 0);
});

test('URLs always count as 23', () => {
  assert.equal(tweetLength('https://example.com/a/very/long/path/that/goes/on'), 23);
  assert.equal(tweetLength('see example.com'), 4 + 23);
  assert.equal(tweetLength('read https://a.co.'), 5 + 23 + 1);
});

test('emoji count as 2, including ZWJ sequences', () => {
  assert.equal(tweetLength('🎉'), 2);
  assert.equal(tweetLength('👩‍🔬'), 2);
  assert.equal(tweetLength('hi 👋🏽'), 5);
});

test('CJK characters count as 2', () => {
  assert.equal(tweetLength('日本'), 4);
});

test('accented Latin counts as 1 after NFC normalization', () => {
  assert.equal(tweetLength('café'), 4);
});

test('remaining goes negative when over', () => {
  assert.equal(remaining('a'.repeat(281), 280), -1);
});

test('findUrls trims trailing punctuation', () => {
  assert.deepEqual(findUrls('go to https://x.com/foo).').map((u) => u.url), ['https://x.com/foo']);
});
