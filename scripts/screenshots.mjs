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
import { OBJ, derive } from '../public/js/draft-core.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const outDir = resolve(process.argv[2] || 'docs/screenshots');
await mkdir(outDir, { recursive: true });

const dir = await mkdtemp(join(tmpdir(), 'tweetmgr-shots-'));
const store = await new FsStore(dir).init();
const profile = { id: 'p_demo', name: 'Ada Researcher', handle: 'ada_studies', accountType: 'free', customLimit: 280, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };
await store.saveProfile(profile);
await store.saveProfile({ ...profile, id: 'p_lab', name: 'Ada (lab account)', handle: 'ada_lab', accountType: 'premium' });
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
// A tiny inline picture so the preview can show an attached image.
const demoImage = "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 132 92'><rect width='132' height='92' fill='#f4f4f4'/><path d='M14 78V20M14 78h108' stroke='#999' stroke-width='2'/><path d='M18 30l22 10 20 6 24 14 30 8' fill='none' stroke='#0084b4' stroke-width='3'/></svg>");
const demo = await store.getThread('th_demo');
demo.tweets[1].media.push({ id: 'm_demo', source: 'url', url: demoImage, alt: 'A line chart of telomere length falling with each cell division.' });
await store.saveThread(demo);

// A thread written in the Draft view: one continuous text, an image anchored
// in it, and one cut placed by hand (after the opening line).
const hook = 'Why do our cells age? I spent a month reading the telomere literature, and here is what surprised me most. 🧵';
const draftText =
  `${hook}\n\n` +
  'Telomeres are protective caps on the ends of chromosomes. Every time a cell divides, they get a little shorter, until the cell stops dividing altogether. ' +
  `That limit has a name: the Hayflick limit, first described in 1961. ${OBJ}\n\n` +
  'Why does that matter? Because the same mechanism that protects us from runaway cell growth may also be part of why tissues wear out. ' +
  'Researchers have spent decades trying to untangle which comes first. The honest answer so far is that it depends on the tissue, the species, and how you measure.\n\n' +
  'If you want to go deeper, the full reading list is here: https://example.com/reading-list';
const draftDoc = { text: draftText, media: ['m_chart'], pins: [hook.length + 2] };
const chart = { id: 'm_chart', source: 'url', url: demoImage, alt: 'A line chart of telomere length falling with each cell division.', name: 'telomere-length.png' };
await store.saveThread({
  id: 'th_draft', profileId: profile.id, title: 'How cells keep time', schemaVersion: 1,
  createdAt: '2026-11-12T02:00:00Z', updatedAt: '2026-11-12T02:00:00Z',
  tweets: derive(draftDoc, 280).tweets.map((t, i) => ({ id: `th_draft_t${i}`, text: t.text, media: t.media.map(() => chart) })),
  draft: { ...draftDoc, limit: 280 },
});

const server = createApp(store);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
  // The Draft view: continuous text on the left, live tweets on the right.
  const wide = await browser.newPage({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2 });
  await wide.goto(url);
  await wide.waitForSelector('#draft-preview .tweet');
  await wide.click('.lib-item[data-id="th_draft"] a');
  await wide.waitForSelector('.cut-knob');
  await wide.click('#draft-editor', { position: { x: 300, y: 150 } });
  await wide.screenshot({ path: join(outDir, 'draft.png') });

  // Dragging a cut: the limit marker shows how far it can go.
  const knob = await wide.locator('.cut-knob').nth(1).boundingBox();
  await wide.mouse.move(knob.x + 7, knob.y + 7);
  await wide.mouse.down();
  await wide.mouse.move(knob.x + 330, knob.y - 100, { steps: 6 }); // up to "That limit has a name"

  await wide.screenshot({ path: join(outDir, 'draft-cut.png'), clip: { x: 0, y: 0, width: 1360, height: 620 } });
  await wide.mouse.up();
  await wide.keyboard.press('Control+z');

  await wide.click('.draft-img');
  await wide.waitForSelector('.draft-dialog:not([hidden])');
  await wide.screenshot({ path: join(outDir, 'draft-image.png') });
  await wide.keyboard.press('Escape');
  await wide.close();

  await page.goto(url);
  await page.click('.lib-item[data-id="th_demo"] a');
  await page.click('.tab[data-view="compose"]');
  await page.waitForSelector('#tweets .tweet');
  await page.screenshot({ path: join(outDir, 'composer.png') });

  if (await page.$('#open-draft')) {
    await page.click('#open-draft');
    await page.fill(
      '#draft-text',
      'Telomeres shorten every time a cell divides. Eventually the cell stops dividing, a limit first described in 1961.\n\n' +
        'Why does that matter? Because the same mechanism that protects us from runaway cell growth may also be part of why tissues age. ' +
        'Researchers have spent decades trying to untangle which comes first.\n---\nNext up: what this means for regenerative medicine.',
    );
    await page.check('#draft-numbering');
    await page.screenshot({ path: join(outDir, 'split-draft.png'), clip: { x: 0, y: 0, width: 1100, height: 560 } });
    await page.click('#draft-cancel');
  }

  // Thread library: the action row on one thread, then a delete confirmation.
  const sidebar = page.locator('.dashboard');
  await page.click('.lib-item[data-id="th_b"] .lib-toggle');
  await sidebar.screenshot({ path: join(outDir, 'library-actions.png') });
  await page.click('.lib-item[data-id="th_b"] [data-act="delete"]');
  await page.click('#profile-delete');
  await sidebar.screenshot({ path: join(outDir, 'library-confirm.png') });

  await page.click('.tab[data-view="preview"]');
  await page.waitForSelector('#preview-tweets .tweet');
  await page.screenshot({ path: join(outDir, 'preview.png') });

  const guide = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
  await guide.goto(`${url}styleguide.html`);
  await guide.screenshot({ path: join(outDir, 'styleguide.png'), fullPage: true });

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await phone.goto(url);
  await phone.click('.lib-item[data-id="th_demo"] a');
  await phone.click('.tab[data-view="compose"]');
  await phone.waitForSelector('#tweets .tweet');
  await phone.screenshot({ path: join(outDir, 'composer-phone.png') });
  await phone.click('.tab[data-view="draft"]');
  await phone.click('.lib-item[data-id="th_draft"] a');
  await phone.waitForSelector('.cut-knob');
  await phone.evaluate(() => window.scrollTo(0, 0));
  await phone.screenshot({ path: join(outDir, 'draft-phone.png') });
  console.log(`Screenshots written to ${outDir}`);
} finally {
  await browser.close();
  server.close();
  await rm(dir, { recursive: true, force: true });
}
