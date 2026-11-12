// Command-line interface over the same data/ folder the web app uses.
// Built for both people and AI agents: every read command supports --json,
// tweet and image numbers are 1-based, and multi-line text can come from
// stdin ("-") or a file (--file). See docs/AGENT_GUIDE.md.

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { basename, extname, join, resolve } from 'node:path';
import { FsStore, IMAGE_TYPES } from './fsStore.js';
import {
  ACCOUNT_TYPES,
  MAX_ALT_TEXT,
  MAX_MEDIA_PER_TWEET,
  charLimit,
  createProfile,
  createThread,
  createTweet,
  toTyperJson,
  touch,
  uid,
} from '../public/js/model.js';
import { tweetLength } from '../public/js/counter.js';

export const SEPARATOR = '---';

export const HELP = `tweetmgr: view and edit tweetMgr threads from the command line.

Threads live in the data folder (default: the app's data/ folder; override with
TWEETMGR_DATA or --data). <thread> is a thread id, a unique id prefix, an exact
title (case-insensitive), or "latest" for the most recently edited thread.
Tweet numbers <n> and image numbers <m> start at 1.

Reading
  list                               List threads, newest first
  show <thread>                      Show a thread with counts, images, and alt text
  show <thread> --text               Print tweets as plain text separated by "---"
  check <thread>                     Check limits, alt text, and image counts
                                     (exit code 1 if there are problems)
  export <thread> [--format typer|text|json] [-o file]
                                     Export for the typing macro (default: typer)
  profiles                           List profiles and their character limits
  where                              Print the data folder path

Writing
  create <title> [--from file|-] [--profile id]
                                     New thread; tweets come from text split on "---"
  rename <thread> <title>            Change a thread's title
  edit <thread> <n> <text|->         Replace tweet n's text (images are kept)
  add <thread> <text|-> [--at n]     Insert a tweet (default: at the end)
  remove <thread> <n>                Delete tweet n
  move <thread> <n> <to>             Move tweet n to position <to>
  replace <thread> --from file|-     Replace all tweet text from "---"-separated
                                     text; images stay with the tweet at the same
                                     position
  image add <thread> <n> <path|url> --alt <text>
                                     Attach a local image (copied into data/images)
                                     or a remote image URL
  image alt <thread> <n> <m> <text|->
                                     Set alt text for image m of tweet n
  image remove <thread> <n> <m>      Detach image m from tweet n
  delete <thread> --yes              Delete a thread

Options
  --json          Machine-readable output (list, show, check, profiles, and
                  every write command, which prints the updated thread)
  --file <path>   Read text from a file instead of an argument
  --data <dir>    Use a different data folder
  -h, --help      Show this help
`;

class CliError extends Error {}
const fail = (msg) => {
  throw new CliError(msg);
};

const OPTIONS = {
  json: { type: 'boolean' },
  text: { type: 'boolean' },
  yes: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  alt: { type: 'string' },
  at: { type: 'string' },
  file: { type: 'string' },
  from: { type: 'string' },
  format: { type: 'string' },
  output: { type: 'string', short: 'o' },
  profile: { type: 'string' },
  data: { type: 'string' },
};

/** Split "---"-separated text into tweet texts. */
export function splitTweets(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split(/^\s*---\s*$/m)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export function joinTweets(thread) {
  return thread.tweets.map((t) => t.text).join(`\n\n${SEPARATOR}\n\n`) + '\n';
}

/** Problems that would stop a thread from posting cleanly. */
export function checkThread(thread, profile) {
  const limit = charLimit(profile);
  const problems = [];
  const tweets = thread.tweets.map((t, i) => {
    const n = i + 1;
    const length = tweetLength(t.text);
    const media = t.media || [];
    if (!t.text.trim() && media.length === 0) problems.push({ tweet: n, problem: 'empty tweet' });
    if (length > limit) problems.push({ tweet: n, problem: `over the ${limit} character limit by ${length - limit}` });
    if (media.length > MAX_MEDIA_PER_TWEET) problems.push({ tweet: n, problem: `has ${media.length} images (max ${MAX_MEDIA_PER_TWEET})` });
    media.forEach((m, j) => {
      if (!(m.alt || '').trim()) problems.push({ tweet: n, image: j + 1, problem: 'missing alt text' });
      else if (m.alt.length > MAX_ALT_TEXT) problems.push({ tweet: n, image: j + 1, problem: `alt text over ${MAX_ALT_TEXT} characters` });
    });
    return { n, length, remaining: limit - length };
  });
  return { ok: problems.length === 0, limit, tweets, problems };
}

export async function run(argv, io = {}) {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const print = (s = '') => out.write(s + '\n');
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    } catch (e) {
      fail(e.message);
    }
    const { values: opts, positionals: pos } = parsed;
    const [cmd, ...args] = pos;
    if (!cmd || opts.help || cmd === 'help') {
      out.write(HELP);
      return 0;
    }

    const store = io.store || new FsStore(resolve(opts.data || process.env.TWEETMGR_DATA || io.defaultDataDir || join(process.cwd(), 'data')));
    const readStdin = io.readStdin || (() => readStream(process.stdin));

    // Text from an argument, "-" (stdin), or --file.
    const textArg = async (value, what = 'text') => {
      if (opts.file) return (await readFile(opts.file, 'utf8')).replace(/\r?\n$/, '');
      if (value === '-') return (await readStdin()).replace(/\r?\n$/, '');
      if (value === undefined) fail(`Missing ${what}. Pass it as an argument, "-" for stdin, or --file <path>.`);
      return value;
    };
    const sourceText = async () => {
      const src = opts.from ?? opts.file;
      if (src === undefined) return undefined;
      return src === '-' ? readStdin() : readFile(src, 'utf8');
    };

    const findThread = async (ref) => {
      if (!ref) fail('Missing <thread>. Run "tweetmgr list" to see threads.');
      const all = await store.listThreads();
      if (ref === 'latest') return all[0] || fail('There are no threads yet.');
      const exact = all.find((t) => t.id === ref);
      if (exact) return exact;
      const byPrefix = all.filter((t) => t.id.startsWith(ref));
      const byTitle = all.filter((t) => (t.title || '').toLowerCase() === ref.toLowerCase());
      const matches = byTitle.length ? byTitle : byPrefix;
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) fail(`"${ref}" matches ${matches.length} threads: ${matches.map((t) => t.id).join(', ')}`);
      fail(`No thread matches "${ref}". Run "tweetmgr list" to see threads.`);
    };
    const profileFor = async (thread) => (thread.profileId && (await store.getProfile(thread.profileId))) || undefined;
    const tweetIndex = (thread, n, { allowEnd = false } = {}) => {
      const i = Number(n) - 1;
      const max = thread.tweets.length + (allowEnd ? 1 : 0);
      if (!Number.isInteger(i) || i < 0 || i >= max) fail(`Tweet number must be between 1 and ${max} (got ${n}).`);
      return i;
    };
    const mediaIndex = (tweet, m) => {
      const i = Number(m) - 1;
      if (!Number.isInteger(i) || i < 0 || i >= tweet.media.length) {
        fail(tweet.media.length ? `Image number must be between 1 and ${tweet.media.length} (got ${m}).` : 'That tweet has no images.');
      }
      return i;
    };
    const imagePath = (m) => (m.source === 'upload' && m.imageId ? join(store.paths.images, m.imageId) : undefined);

    const describe = async (thread) => {
      const profile = await profileFor(thread);
      const report = checkThread(thread, profile);
      return {
        id: thread.id,
        title: thread.title,
        profileId: thread.profileId,
        limit: report.limit,
        updatedAt: thread.updatedAt,
        file: join(store.paths.threads, `${thread.id}.json`),
        tweets: thread.tweets.map((t, i) => ({
          n: i + 1,
          id: t.id,
          text: t.text,
          length: report.tweets[i].length,
          remaining: report.tweets[i].remaining,
          images: (t.media || []).map((m, j) => ({
            m: j + 1,
            id: m.id,
            source: m.source,
            alt: m.alt || '',
            ...(m.source === 'url' ? { url: m.url } : { imageId: m.imageId, path: imagePath(m) }),
          })),
        })),
        problems: report.problems,
      };
    };
    const printThread = async (thread) => {
      const d = await describe(thread);
      if (opts.json) return print(JSON.stringify(d, null, 2));
      print(`${d.title}  (${d.id})`);
      print(`${d.tweets.length} tweet${d.tweets.length === 1 ? '' : 's'}, limit ${d.limit}, updated ${d.updatedAt}`);
      for (const t of d.tweets) {
        print('');
        print(`[${t.n}/${d.tweets.length}] ${t.length}/${d.limit}${t.remaining < 0 ? '  OVER LIMIT' : ''}`);
        print(t.text || '(empty)');
        for (const m of t.images) {
          print(`  image ${m.m}: ${m.url || m.path}`);
          print(`    alt: ${m.alt || '(missing)'}`);
        }
      }
      if (d.problems.length) {
        print('');
        print('Problems:');
        for (const p of d.problems) print(`  ${formatProblem(p)}`);
      }
    };
    // Every write prints the updated thread so agents can confirm the result.
    const save = async (thread, message) => {
      await store.saveThread(touch(thread));
      if (opts.json) return printThread(thread);
      print(message);
      const { problems } = checkThread(thread, await profileFor(thread));
      for (const p of problems) print(`  warning: ${formatProblem(p)}`);
    };

    switch (cmd) {
      case 'where':
        print(store.dir);
        return 0;

      case 'profiles': {
        const profiles = await store.listProfiles();
        const active = await store.getSetting('activeProfileId');
        const rows = profiles.map((p) => ({ id: p.id, name: p.name, handle: p.handle, accountType: p.accountType, limit: charLimit(p), active: p.id === active }));
        if (opts.json) print(JSON.stringify(rows, null, 2));
        else if (!rows.length) print('No profiles yet. One is created with your first thread.');
        else for (const r of rows) print(`${r.active ? '*' : ' '} ${r.id}  @${r.handle}  ${ACCOUNT_TYPES[r.accountType]?.label || r.accountType} (${r.limit})`);
        return 0;
      }

      case 'list': {
        const threads = await store.listThreads(opts.profile);
        const rows = threads.map((t) => ({
          id: t.id,
          title: t.title,
          tweets: t.tweets.length,
          images: t.tweets.reduce((s, tw) => s + (tw.media || []).length, 0),
          updatedAt: t.updatedAt,
        }));
        if (opts.json) print(JSON.stringify(rows, null, 2));
        else if (!rows.length) print('No threads yet. Create one with: tweetmgr create "My title"');
        else for (const r of rows) print(`${r.id}  ${r.updatedAt}  ${r.tweets} tweets, ${r.images} images  ${r.title}`);
        return 0;
      }

      case 'show': {
        const thread = await findThread(args[0]);
        if (opts.text) out.write(joinTweets(thread));
        else await printThread(thread);
        return 0;
      }

      case 'check': {
        const thread = await findThread(args[0]);
        const report = checkThread(thread, await profileFor(thread));
        if (opts.json) print(JSON.stringify(report, null, 2));
        else if (report.ok) print(`OK: ${thread.tweets.length} tweets, all within ${report.limit} characters.`);
        else for (const p of report.problems) print(formatProblem(p));
        return report.ok ? 0 : 1;
      }

      case 'export': {
        const thread = await findThread(args[0]);
        const format = opts.format || 'typer';
        let body;
        if (format === 'typer') {
          // Typer shape, plus a local "path" for uploaded images so tools that
          // run on this machine can find the files. The typer ignores it.
          const typer = toTyperJson(thread);
          thread.tweets.forEach((t, i) =>
            t.media.forEach((m, j) => {
              const p = imagePath(m);
              if (p) typer.tweets[i].images[j].path = p;
            }),
          );
          body = JSON.stringify(typer, null, 2) + '\n';
        } else if (format === 'text') body = joinTweets(thread);
        else if (format === 'json') body = JSON.stringify(thread, null, 2) + '\n';
        else fail(`Unknown format "${format}". Use typer, text, or json.`);
        if (opts.output) {
          await writeFile(opts.output, body, 'utf8');
          err.write(`Wrote ${opts.output}\n`);
        } else out.write(body);
        return 0;
      }

      case 'create': {
        const title = args[0];
        if (!title) fail('Missing <title>.');
        let profileId = opts.profile;
        if (profileId) {
          if (!(await store.getProfile(profileId))) fail(`No profile "${profileId}". Run "tweetmgr profiles".`);
        } else {
          const profiles = await store.listProfiles();
          const active = await store.getSetting('activeProfileId');
          let profile = profiles.find((p) => p.id === active) || profiles[0];
          if (!profile) {
            profile = await store.saveProfile(createProfile());
            await store.setSetting('activeProfileId', profile.id);
          }
          profileId = profile.id;
        }
        const thread = createThread(profileId, { title });
        const text = await sourceText();
        if (text !== undefined) {
          const texts = splitTweets(text);
          if (texts.length) thread.tweets = texts.map((t) => createTweet(t));
        }
        await save(thread, `Created ${thread.id} with ${thread.tweets.length} tweet(s).`);
        return 0;
      }

      case 'rename': {
        const thread = await findThread(args[0]);
        thread.title = await textArg(args[1], 'title');
        await save(thread, `Renamed ${thread.id} to "${thread.title}".`);
        return 0;
      }

      case 'edit': {
        const thread = await findThread(args[0]);
        const i = tweetIndex(thread, args[1]);
        thread.tweets[i].text = await textArg(args[2]);
        await save(thread, `Updated tweet ${i + 1}.`);
        return 0;
      }

      case 'add': {
        const thread = await findThread(args[0]);
        const i = opts.at ? tweetIndex(thread, opts.at, { allowEnd: true }) : thread.tweets.length;
        thread.tweets.splice(i, 0, createTweet(await textArg(args[1])));
        await save(thread, `Added tweet ${i + 1} of ${thread.tweets.length}.`);
        return 0;
      }

      case 'remove': {
        const thread = await findThread(args[0]);
        const i = tweetIndex(thread, args[1]);
        thread.tweets.splice(i, 1);
        if (!thread.tweets.length) thread.tweets.push(createTweet());
        await save(thread, `Removed tweet ${i + 1}.`);
        return 0;
      }

      case 'move': {
        const thread = await findThread(args[0]);
        const from = tweetIndex(thread, args[1]);
        const to = tweetIndex(thread, args[2]);
        const [tweet] = thread.tweets.splice(from, 1);
        thread.tweets.splice(to, 0, tweet);
        await save(thread, `Moved tweet ${from + 1} to position ${to + 1}.`);
        return 0;
      }

      case 'replace': {
        const thread = await findThread(args[0]);
        const text = await sourceText();
        if (text === undefined) fail('Pass the new text with --from <file> or --from - (stdin).');
        const texts = splitTweets(text);
        if (!texts.length) fail('The new text has no tweets.');
        const old = thread.tweets;
        thread.tweets = texts.map((t, i) => (old[i] ? { ...old[i], text: t } : createTweet(t)));
        const dropped = old.slice(texts.length).reduce((s, t) => s + (t.media || []).length, 0);
        await save(thread, `Replaced text: ${texts.length} tweet(s).${dropped ? ` ${dropped} image(s) on removed tweets were detached.` : ''}`);
        return 0;
      }

      case 'image': {
        const [sub, ref, n, m, ...rest] = args;
        if (!['add', 'alt', 'remove'].includes(sub)) fail('Use "image add", "image alt", or "image remove".');
        const thread = await findThread(ref);
        const tweet = thread.tweets[tweetIndex(thread, n)];
        tweet.media = tweet.media || [];
        if (sub === 'add') {
          const src = m;
          if (!src) fail('Missing image path or URL.');
          if (opts.alt === undefined) fail('Pass alt text with --alt "..." (use --alt "" to add it later).');
          if (tweet.media.length >= MAX_MEDIA_PER_TWEET) fail(`Tweet ${n} already has ${MAX_MEDIA_PER_TWEET} images.`);
          let media;
          if (/^https?:\/\//i.test(src)) {
            media = { id: uid('m_'), source: 'url', url: src, alt: opts.alt };
          } else {
            if (!IMAGE_TYPES[extname(src).toLowerCase()]) fail(`Unsupported image type "${extname(src)}". Use ${Object.keys(IMAGE_TYPES).join(', ')}.`);
            const imageId = await store.putImage(await readFile(src), { name: basename(src) });
            media = { id: uid('m_'), source: 'upload', imageId, alt: opts.alt, name: basename(src) };
          }
          tweet.media.push(media);
          await save(thread, `Attached image ${tweet.media.length} to tweet ${n}${media.imageId ? ` (saved as ${media.imageId})` : ''}.`);
          return 0;
        }
        const j = mediaIndex(tweet, m);
        if (sub === 'alt') {
          tweet.media[j].alt = await textArg(rest[0], 'alt text');
          await save(thread, `Updated alt text for image ${j + 1} of tweet ${n}.`);
        } else {
          // The image file stays in data/images; it may be used elsewhere.
          tweet.media.splice(j, 1);
          await save(thread, `Removed image ${j + 1} from tweet ${n}.`);
        }
        return 0;
      }

      case 'delete': {
        const thread = await findThread(args[0]);
        if (!opts.yes) fail(`This deletes "${thread.title}" (${thread.id}). Add --yes to confirm.`);
        await store.deleteThread(thread.id);
        print(opts.json ? JSON.stringify({ deleted: thread.id }) : `Deleted ${thread.id}.`);
        return 0;
      }

      default:
        fail(`Unknown command "${cmd}". Run "tweetmgr --help".`);
    }
  } catch (e) {
    if (!(e instanceof CliError) && !e.status) throw e;
    err.write(`tweetmgr: ${e.message}\n`);
    return 2;
  }
}

function formatProblem(p) {
  return `tweet ${p.tweet}${p.image ? `, image ${p.image}` : ''}: ${p.problem}`;
}

async function readStream(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
