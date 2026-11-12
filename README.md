# tweetMgr

A small, locally run app for drafting Twitter/X threads: write tweets with a live character counter for your account type, save drafts, and reload them later. Threads are stored as plain JSON files, so scripts and AI agents can read and edit them too.

![Composer](docs/screenshots/composer.png)

## Run it

Requires Node.js 18 or newer. There are no dependencies to install.

```sh
npm start          # http://localhost:4321
npm test
```

Set `PORT`, `HOST`, or `TWEETMGR_DATA` (the data folder) to override the defaults.

## Where your data lives

Everything is saved to the `data/` folder next to the app, which is gitignored so your drafts never end up in the repo:

```
data/
  profiles/<profileId>.json   your name, handle, and account type
  threads/<threadId>.json     one file per thread
  images/<imageId>            uploaded images (e.g. img_3f9a1c2b7d4e.png)
  settings.json               which profile and thread are open
```

The app picks up changes made to these files by other tools when you switch back to its browser tab. See [docs/DATA_FORMAT.md](docs/DATA_FORMAT.md) for the thread format.

If the app is opened without the local server (for example from a future hosted version), it falls back to storing everything in the browser's IndexedDB.

## Command line and AI agents

`bin/tweetmgr.js` lets scripts and AI agents list, read, edit, and check threads, attach figures with alt text, and export for the typer:

```sh
npm link                                   # optional: adds a `tweetmgr` command
tweetmgr list
tweetmgr show latest
tweetmgr edit latest 2 "Revised second tweet"
tweetmgr image add latest 3 ./fig.png --alt "Bar chart of results"
tweetmgr check latest
```

Run `tweetmgr --help` for every command, and see [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) for a guide aimed at agents.

## Character limits

Choose your account type in the sidebar: Free (280), Premium (25,000), or a custom limit. Counting follows Twitter/X's rules: links count as 23, emoji and CJK characters count as 2.

## Typing macro

[`typer/`](typer/) types each tweet into X for you instead of pasting it. "Copy for typer" in the app copies the thread as JSON for it. See [typer/README.md](typer/README.md).
