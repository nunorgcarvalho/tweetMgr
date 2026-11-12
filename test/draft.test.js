import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OBJ,
  derive,
  docFromThread,
  docFromTweets,
  insertMedia,
  insertText,
  mapPins,
  matchesTweets,
  moveBreak,
  moveMedia,
  removeMedia,
  stepBreak,
  stripObjects,
  tweetEnd,
} from '../public/js/draft-core.js';
import { tweetLength } from '../public/js/counter.js';

const doc = (text, pins = [], media = []) => ({ text, pins, media });
const texts = (d, limit) => derive(d, limit).tweets.map((t) => t.text);

test('a short draft is one tweet with no cuts', () => {
  const d = derive(doc('Hello there.'), 280);
  assert.deepEqual(d.tweets.map((t) => t.text), ['Hello there.']);
  assert.deepEqual(d.breaks, []);
  assert.equal(d.tweets[0].hard, null);
});

test('an empty draft still gives one empty tweet', () => {
  assert.deepEqual(texts(doc(''), 280), ['']);
  assert.deepEqual(texts(doc('  \n '), 280), ['']);
});

test('cuts appear automatically where a tweet fills up, and every tweet fits', () => {
  const sentence = 'The quick brown fox jumps over the lazy dog. ';
  const d = derive(doc(sentence.repeat(20)), 100);
  assert.ok(d.tweets.length > 5);
  for (const t of d.tweets) assert.ok(t.length <= 100, `${t.length} fits`);
  assert.ok(d.breaks.every((b) => !b.pinned));
  assert.equal(d.tweets.map((t) => t.text).join(' '), sentence.repeat(20).trim());
  // Sentences are kept whole when they fit.
  assert.ok(d.tweets.every((t) => t.text.endsWith('.')));
});

test('the hard limit is reported to the character', () => {
  const d = derive(doc('aaaa bbbb cccc dddd'), 11);
  assert.deepEqual(d.tweets.map((t) => t.text), ['aaaa bbbb', 'cccc dddd']);
  assert.equal(d.tweets[0].hard, 11);
  assert.equal(d.breaks[0].offset, 10);
});

test('a pinned cut is honored and automatic cuts fill in around it', () => {
  const text = 'One. Two. Three. Four.';
  const d = derive(doc(text, [5]), 280);
  assert.deepEqual(d.tweets.map((t) => t.text), ['One.', 'Two. Three. Four.']);
  assert.deepEqual(d.breaks, [{ offset: 5, pinned: true }]);
  const tight = derive(doc(text, [5]), 11);
  assert.deepEqual(tight.tweets.map((t) => t.text), ['One.', 'Two. Three.', 'Four.']);
  assert.deepEqual(tight.breaks.map((b) => b.pinned), [true, false]);
});

test('a cut at the very end starts an empty tweet', () => {
  assert.deepEqual(texts(doc('One.', [4]), 280), ['One.', '']);
});

test('a word longer than the limit is cut hard', () => {
  const d = derive(doc('abcdefghij'), 4);
  assert.deepEqual(d.tweets.map((t) => t.text), ['abcd', 'efgh', 'ij']);
});

test('images belong to the tweet their anchor falls in', () => {
  const text = `One.${OBJ} Two.\n${OBJ}`;
  const d = derive(doc(text, [6], ['a', 'b']), 280);
  assert.deepEqual(d.tweets.map((t) => [t.text, t.media]), [['One.', ['a']], ['Two.', ['b']]]);
  const moved = derive(doc(text, [], ['a', 'b']), 280);
  assert.deepEqual(moved.tweets.map((t) => t.media), [['a', 'b']]);
});

test('placeholders do not count toward the limit or leave gaps', () => {
  assert.equal(stripObjects(`P1\n${OBJ}\nP2`).out, 'P1\nP2');
  assert.equal(stripObjects(`a ${OBJ} b`).out, 'a b');
  assert.equal(stripObjects(`a.${OBJ} b`).out, 'a. b');
  const d = derive(doc(`abcd${OBJ} efgh`, [], ['a']), 9);
  assert.deepEqual(d.tweets.map((t) => t.text), ['abcd efgh']);
});

test('mapPins follows typing, and typing at a cut joins the next tweet', () => {
  assert.deepEqual(mapPins([5], 'One. Two.', 'Zero. One. Two.'), [11]);
  assert.deepEqual(mapPins([5], 'One. Two.', 'One. XTwo.'), [5]);
  assert.deepEqual(mapPins([5], 'One. Two.', 'One. Two. Three.'), [5]);
  assert.deepEqual(mapPins([5], 'One. Two.', 'OTwo.'), [1]);
  assert.deepEqual(mapPins([5, 10], 'One. Two. Three.', 'One. ee.'), [5]);
});

test('moving a cut pins it, within the limit', () => {
  const d0 = doc('One. Two. Three. Four.');
  const derived = derive(d0, 11); // "One. Two." | "Three." | "Four."
  assert.deepEqual(derived.tweets.map((t) => t.text), ['One. Two.', 'Three.', 'Four.']);
  const pins = stepBreak(d0, derived, 0, -1);
  assert.deepEqual(pins, [5]);
  assert.deepEqual(texts({ ...d0, pins }, 11), ['One.', 'Two. Three.', 'Four.']);
  assert.equal(stepBreak(d0, derived, 0, 1), null, 'no room to take another sentence');
  assert.equal(moveBreak(d0, derived, 0, 0), null);
});

test('stepping a cut later pulls the next sentence up when it fits', () => {
  const d0 = doc('One. Two. Three. Four.', [5]);
  const derived = derive(d0, 280);
  const pins = stepBreak(d0, derived, 0, 1);
  assert.deepEqual(texts({ ...d0, pins }, 280), ['One. Two.', 'Three. Four.']);
});

test('stored tweets round-trip through a draft', () => {
  const tweets = [
    { id: 't1', text: 'First tweet.', media: [] },
    { id: 't2', text: 'Second.\nWith a line.', media: [{ id: 'm1' }, { id: 'm2' }] },
    { id: 't3', text: '', media: [{ id: 'm3' }] },
  ];
  const d = docFromTweets(tweets);
  assert.equal(d.pins.length, 2);
  assert.ok(matchesTweets(derive(d, 280), tweets));
});

test('a saved draft is reused only while it matches the tweets', () => {
  const d0 = doc('One. Two. Three. Four.');
  const made = derive(d0, 11).tweets.map((t, i) => ({ id: `t${i}`, text: t.text, media: [] }));
  const thread = { tweets: made, draft: { ...d0, limit: 11 } };
  assert.deepEqual(docFromThread(thread).pins, [], 'automatic cuts stay automatic');
  thread.tweets[1].text = 'Edited elsewhere.';
  assert.equal(docFromThread(thread).pins.length, 2, 'rebuilt from the tweets');
});

test('pasting with --- lines places cuts', () => {
  const { doc: d, caret } = insertText(doc('Start. End.'), 7, 7, 'A\n---\nB ');
  assert.equal(d.text, 'Start. A\n\nB End.');
  assert.deepEqual(d.pins, [10]);
  assert.equal(caret, 12);
  assert.deepEqual(texts(d, 280), ['Start. A', 'B End.']);
});

test('images can be inserted, moved, and removed', () => {
  let d = doc('One. Two.', [5]);
  d = insertMedia(d, 4, ['a']);
  assert.equal(d.text, `One.${OBJ} Two.`);
  assert.deepEqual(d.pins, [6]);
  let derived = derive(d, 280);
  assert.deepEqual(derived.tweets.map((t) => t.media), [['a'], []]);
  d = moveMedia(d, 'a', tweetEnd(d, derived.tweets[1]));
  derived = derive(d, 280);
  assert.deepEqual(derived.tweets.map((t) => [t.text, t.media]), [['One.', []], ['Two.', ['a']]]);
  d = removeMedia(d, 'a');
  assert.deepEqual(d, doc('One. Two.', [5]));
});

test('long links weigh 23, so more text than the limit can fit', () => {
  const url = `https://example.com/${'x'.repeat(400)}`;
  const d = derive(doc(`Read ${url} now. Then more words follow here.`), 40);
  assert.ok(d.tweets[0].text.includes(url));
  for (const t of d.tweets) assert.ok(tweetLength(t.text) <= 40);
});
