import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCut, splitOverflow, splitText, reflow, joinTexts } from '../public/js/split.js';
import { tweetLength } from '../public/js/counter.js';

const sentence = (n) => `Sentence number ${n} is here.`;

test('text that fits is not cut', () => {
  assert.equal(findCut('short', 280), 5);
  assert.deepEqual(splitOverflow('short', 280), ['short', '']);
});

test('prefers sentence boundaries', () => {
  const text = `${sentence(1)} ${sentence(2)} ${sentence(3)}`;
  const [head, tail] = splitOverflow(text, 60);
  assert.equal(head, `${sentence(1)} ${sentence(2)}`);
  assert.equal(tail, sentence(3));
});

test('prefers paragraph breaks over sentences when they fill enough', () => {
  const text = `${sentence(1)} ${sentence(2)}\n\n${sentence(3)} ${sentence(4)}`;
  const [head] = splitOverflow(text, 80);
  assert.equal(head, `${sentence(1)} ${sentence(2)}`);
});

test('falls back to word boundaries', () => {
  const [head, tail] = splitOverflow('aaa bbb ccc ddd eee', 10);
  assert.equal(head, 'aaa bbb');
  assert.equal(tail, 'ccc ddd eee');
});

test('hard-cuts a single long word without breaking emoji', () => {
  const text = '🎉'.repeat(10);
  const [head, tail] = splitOverflow(text, 7);
  assert.equal(head, '🎉🎉🎉');
  assert.equal(tail, '🎉'.repeat(7));
});

test('does not cut inside a URL', () => {
  const text = 'Read this: https://example.com/some/really/long/path then reply';
  const [head] = splitOverflow(text, 40);
  assert.ok(!head.includes('example') || head.includes('https://example.com/some/really/long/path'));
});

test('splitText keeps every tweet within the limit and preserves words', () => {
  const words = Array.from({ length: 300 }, (_, i) => `word${i}`);
  const text = words.join(' ');
  const parts = splitText(text, 100);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(tweetLength(p) <= 100, p);
  assert.equal(parts.join(' '), text);
});

test('splitText honors --- breaks', () => {
  assert.deepEqual(splitText('one\n---\ntwo\n\n---\n\nthree', 280), ['one', 'two', 'three']);
});

test('splitText numbering reserves space and numbers every tweet', () => {
  const text = Array.from({ length: 40 }, (_, i) => sentence(i)).join(' ');
  const parts = splitText(text, 100, { numbering: true });
  assert.ok(parts.length >= 10, 'expected two-digit total');
  parts.forEach((p, i) => {
    assert.ok(p.endsWith(` ${i + 1}/${parts.length}`), p);
    assert.ok(tweetLength(p) <= 100, p);
  });
});

test('reflow pushes overflow forward and appends tweets', () => {
  const out = reflow(['aaa bbb ccc', 'ddd'], 7);
  assert.deepEqual(out, ['aaa bbb', 'ccc ddd']);
  const grown = reflow(['aaa bbb ccc ddd'], 7);
  assert.deepEqual(grown, ['aaa bbb', 'ccc ddd']);
});

test('joinTexts', () => {
  assert.equal(joinTexts('a ', ' b'), 'a b');
  assert.equal(joinTexts('', 'b'), 'b');
});
