# Using tweetMgr from another agent

This guide is for an AI agent (or a script) that helps write and review threads, for example a research assistant that drafts tweets and adds figures. Everything below works without the web app running; the app picks up your changes when its browser tab regains focus.

## Setup

From the tweetMgr folder, once:

```sh
npm link            # puts a `tweetmgr` command on your PATH
```

Or call it directly: `node /path/to/tweetMgr/bin/tweetmgr.js ...`. Node.js 18+ is required and there is nothing to install.

The CLI always uses tweetMgr's own `data/` folder, no matter which directory you run it from, so it edits the same threads the app shows. Set `TWEETMGR_DATA` or pass `--data <dir>` to use another folder. `tweetmgr where` prints the folder in use.

## Conventions

- `<thread>` is a thread id, a unique id prefix, the exact title (case-insensitive), or `latest` (the most recently edited thread).
- Tweet numbers and image numbers start at 1.
- Add `--json` to get machine-readable output. Write commands with `--json` print the whole updated thread, so you can confirm the change without a second call.
- Multi-line text: pass `-` and pipe it on stdin, or use `--file <path>`. Separate tweets with a line containing only `---`.
- Exit codes: `0` success, `1` `check` found problems, `2` bad input (the message on stderr says what to fix).

## Typical workflow

```sh
tweetmgr list --json                         # find the thread
tweetmgr show "Why do cells age?" --json     # read it: text, length, remaining, images, problems
tweetmgr show latest --text > draft.txt      # or get plain text to revise as a whole
# ... revise draft.txt ...
tweetmgr replace latest --from draft.txt     # write it back; images stay with the tweet at the same position
tweetmgr check latest                        # limits, missing alt text, image counts
```

Small edits:

```sh
tweetmgr edit latest 3 "New text for tweet 3"
printf 'Line one\nLine two' | tweetmgr edit latest 3 -
tweetmgr add latest "A new closing tweet"
tweetmgr add latest "A new second tweet" --at 2
tweetmgr move latest 5 2
tweetmgr remove latest 4
tweetmgr rename latest "Better title"
```

Start a new thread from a draft:

```sh
tweetmgr create "Why do cells age?" --from draft.txt --json
```

## Figures and alt text

```sh
tweetmgr image add latest 2 ./figures/telomeres.png --alt "Line chart: telomere length falls with age"
tweetmgr image add latest 4 https://example.com/figure.png --alt "Hayflick's original figure"
tweetmgr image alt latest 2 1 "Better description of the chart"
tweetmgr image remove latest 2 1
```

- Local files are copied into `data/images/`, so the original can move or be deleted. PNG, JPEG, GIF, and WebP are supported.
- Up to 4 images per tweet. `--alt` is required; pass `--alt ""` only if you will fill it in later (`check` flags it). Alt text can be up to 1,000 characters.
- `show --json` gives each uploaded image's absolute `path`, so you can open the file to review the figure and write its alt text.

## Character limits

Each thread belongs to a profile whose account type sets the limit: Free 280, Premium 25,000, or custom. `tweetmgr profiles` lists them. Lengths follow X's counting rules: every link counts as 23, and emoji and CJK characters count as 2. Use the `length` and `remaining` fields from `show --json` rather than counting characters yourself.

## Exporting for the typer

```sh
tweetmgr export latest                   # typer JSON on stdout
tweetmgr export latest -o thread.json    # or to a file
tweetmgr export latest --format text     # plain text, tweets separated by ---
```

The typer JSON is `{ "title", "tweets": [{ "text", "images": [{ "alt", "url"?, "path"? }] }] }`. `path` points to the local image file for uploaded images. See `typer/README.md` for typing a thread into X.

## Editing the files directly

The CLI is the safest route because it validates input and keeps ids and timestamps right, but threads are plain JSON in `data/threads/<id>.json` if you need to do something the CLI doesn't cover. See [DATA_FORMAT.md](DATA_FORMAT.md).

## Cautions

- Don't delete threads unless the user asked; `delete` requires `--yes`.
- If the user has the same thread open in the app and keeps typing, the app's next save can overwrite your change. Tell the user what you changed so they can refresh, or have them switch away from the tab while you edit.
- Nothing here posts to X. Posting is always done by the user.
