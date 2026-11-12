import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStore } from '../lib/fsStore.js';
import { run, splitTweets } from '../lib/cli.js';

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'tweetmgr-cli-'));
  const store = new FsStore(join(dir, 'data'));
  const cli = async (args, stdin = '') => {
    let out = '';
    let err = '';
    const code = await run(args, {
      store,
      stdout: { write: (s) => (out += s) },
      stderr: { write: (s) => (err += s) },
      readStdin: async () => stdin,
    });
    return { code, out, err, json: () => JSON.parse(out) };
  };
  return { dir, store, cli };
}

test('splitTweets splits on --- lines only', () => {
  assert.deepEqual(splitTweets('one\n---\ntwo -- not a split\n\n  ---  \nthree\n---\n'), ['one', 'two -- not a split', 'three']);
});

test('create from stdin, then show and list as JSON', async () => {
  const { cli } = await setup();
  const c = await cli(['create', 'Cell aging', '--from', '-', '--json'], 'Why do cells age?\n---\nTelomeres.\n');
  assert.equal(c.code, 0);
  const created = c.json();
  assert.deepEqual(created.tweets.map((t) => t.text), ['Why do cells age?', 'Telomeres.']);
  assert.equal(created.limit, 280);

  const list = (await cli(['list', '--json'])).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].tweets, 2);

  // Resolve by title (case-insensitive), id prefix, and "latest".
  for (const ref of ['cell AGING', created.id.slice(0, 8), 'latest']) {
    assert.equal((await cli(['show', ref, '--json'])).json().id, created.id);
  }
  assert.equal((await cli(['show', 'latest', '--text'])).out, 'Why do cells age?\n\n---\n\nTelomeres.\n');
});

test('edit, add, move, remove tweets', async () => {
  const { cli } = await setup();
  await cli(['create', 'T', '--from', '-'], 'a\n---\nb');
  await cli(['edit', 'latest', '1', 'A']);
  await cli(['add', 'latest', '-'], 'multi\nline');
  await cli(['add', 'latest', 'first', '--at', '1']);
  await cli(['move', 'latest', '1', '4']);
  let t = (await cli(['show', 'latest', '--json'])).json();
  assert.deepEqual(t.tweets.map((x) => x.text), ['A', 'b', 'multi\nline', 'first']);
  await cli(['remove', 'latest', '2']);
  t = (await cli(['show', 'latest', '--json'])).json();
  assert.deepEqual(t.tweets.map((x) => x.text), ['A', 'multi\nline', 'first']);

  const bad = await cli(['edit', 'latest', '9', 'x']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /between 1 and 3/);
});

test('images: add local file and URL, set alt, remove', async () => {
  const { dir, store, cli } = await setup();
  await cli(['create', 'T', '--from', '-'], 'one\n---\ntwo');
  const fig = join(dir, 'fig.png');
  await writeFile(fig, Buffer.from('fake png bytes'));

  const missingAlt = await cli(['image', 'add', 'latest', '2', fig]);
  assert.equal(missingAlt.code, 2);

  let t = (await cli(['image', 'add', 'latest', '2', fig, '--alt', 'A chart', '--json'])).json();
  const img = t.tweets[1].images[0];
  assert.equal(img.source, 'upload');
  assert.equal(img.alt, 'A chart');
  assert.ok(existsSync(img.path));
  assert.equal(await readFile(img.path, 'utf8'), 'fake png bytes');
  assert.ok(img.path.startsWith(store.paths.images));

  await cli(['image', 'add', 'latest', '2', 'https://example.com/x.png', '--alt', '']);
  await cli(['image', 'alt', 'latest', '2', '2', 'Remote figure']);
  t = (await cli(['show', 'latest', '--json'])).json();
  assert.deepEqual(t.tweets[1].images.map((m) => m.alt), ['A chart', 'Remote figure']);

  await cli(['image', 'remove', 'latest', '2', '1']);
  t = (await cli(['show', 'latest', '--json'])).json();
  assert.equal(t.tweets[1].images.length, 1);
  assert.equal(t.tweets[1].images[0].url, 'https://example.com/x.png');
});

test('check reports problems with exit code 1', async () => {
  const { cli } = await setup();
  await cli(['create', 'T', '--from', '-'], 'ok\n---\n' + 'x'.repeat(281));
  await cli(['image', 'add', 'latest', '1', 'https://example.com/x.png', '--alt', '']);
  const r = await cli(['check', 'latest', '--json']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json().problems, [
    { tweet: 1, image: 1, problem: 'missing alt text' },
    { tweet: 2, problem: 'over the 280 character limit by 1' },
  ]);
  await cli(['edit', 'latest', '2', 'short']);
  await cli(['image', 'alt', 'latest', '1', '1', 'Alt']);
  assert.equal((await cli(['check', 'latest'])).code, 0);
});

test('replace keeps images by position; export typer format', async () => {
  const { cli } = await setup();
  await cli(['create', 'T', '--from', '-'], 'a\n---\nb');
  await cli(['image', 'add', 'latest', '2', 'https://example.com/x.png', '--alt', 'X']);
  await cli(['replace', 'latest', '--from', '-'], 'A\n---\nB\n---\nC');
  const exp = (await cli(['export', 'latest'])).json();
  assert.deepEqual(exp, {
    title: 'T',
    tweets: [
      { text: 'A', images: [] },
      { text: 'B', images: [{ alt: 'X', url: 'https://example.com/x.png' }] },
      { text: 'C', images: [] },
    ],
  });
  assert.equal((await cli(['export', 'latest', '--format', 'text'])).out, 'A\n\n---\n\nB\n\n---\n\nC\n');
});

test('delete requires --yes', async () => {
  const { cli } = await setup();
  await cli(['create', 'T']);
  assert.equal((await cli(['delete', 'latest'])).code, 2);
  assert.equal((await cli(['delete', 'latest', '--yes'])).code, 0);
  assert.equal((await cli(['list', '--json'])).json().length, 0);
});
