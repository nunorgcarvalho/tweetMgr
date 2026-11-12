// Renders PR/README screenshots from a throwaway demo data folder, so no
// personal data ever ends up in an image. Requires Playwright with Chromium
// available (not a project dependency).
//   node scripts/screenshots.mjs [outDir]
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { FsStore } from '../lib/fsStore.js';
import { createApp } from '../server.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const outDir = resolve(process.argv[2] || 'docs/screenshots');
await mkdir(outDir, { recursive: true });

const dir = await mkdtemp(join(tmpdir(), 'tweetmgr-shots-'));
const store = await new FsStore(dir).init();
const profile = { id: 'p_demo', name: 'Ada Researcher', handle: 'ada_studies', accountType: 'free', customLimit: 280, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };
await store.saveProfile(profile);
await store.setSetting('activeProfileId', profile.id);
const mk = (id, title, texts, updatedAt) => ({
  id, profileId: profile.id, title, createdAt: updatedAt, updatedAt, schemaVersion: 1,
  tweets: texts.map((text, i) => ({ id: `${id}_t${i}`, text, media: [] })),
});
await store.saveThread(mk('th_old', 'Notes on sleep and memory', ['Draft…'], '2026-11-08T10:00:00Z'));
await store.saveThread(mk('th_b', 'Conference recap', ['Day one was great.', 'Day two too.'], '2026-11-10T10:00:00Z'));
await store.saveThread(mk('th_demo', 'Why do cells age? A short thread', [
  "Why do our cells age? I spent the last month reading the literature on telomeres, and here's what surprised me most. 🧵",
  'Telomeres are protective caps on the ends of chromosomes. Every time a cell divides, they get a little shorter, until the cell stops dividing altogether. That limit has a name: the Hayflick limit, first described in 1961 after years of careful work growing human fibroblasts in culture dishes and counting divisions.',
  'Full reading list here: https://example.com/reading-list',
], '2026-11-12T01:00:00Z'));
await store.setSetting('activeThreadId', 'th_demo');

const server = createApp(store);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
  await page.goto(url);
  await page.waitForSelector('.tweet');
  await page.screenshot({ path: join(outDir, 'composer.png') });

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await phone.goto(url);
  await phone.waitForSelector('.tweet');
  await phone.screenshot({ path: join(outDir, 'composer-phone.png') });
  console.log(`Screenshots written to ${outDir}`);
} finally {
  await browser.close();
  server.close();
  await rm(dir, { recursive: true, force: true });
}
