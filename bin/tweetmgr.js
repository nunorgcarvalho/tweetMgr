#!/usr/bin/env node
// tweetmgr CLI entry point. Run "tweetmgr --help" (or "node bin/tweetmgr.js --help").
// Defaults to the app's own data/ folder, wherever you run it from, so other
// projects and agents edit the same threads the web app shows.
import { fileURLToPath } from 'node:url';
import { run } from '../lib/cli.js';

const defaultDataDir = fileURLToPath(new URL('../data', import.meta.url));

run(process.argv.slice(2), { defaultDataDir }).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`tweetmgr: ${err.stack || err.message}\n`);
    process.exitCode = 2;
  },
);
