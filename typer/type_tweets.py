#!/usr/bin/env python3
"""tweetMgr desktop typer: types tweets with real OS-level keystrokes.

This is the fallback for when the browser userscript can't be used (for
example, a different browser or the X desktop app). It sends genuine key
presses to whatever window has focus, so make sure X's compose box is focused
when the countdown ends.

Usage:
    pip install pynput
    python type_tweets.py thread.json            # step through every tweet
    python type_tweets.py thread.json --tweet 3  # type only tweet 3
    python type_tweets.py thread.txt             # plain text, tweets split by a line of ---

macOS: grant your terminal Accessibility permission (System Settings >
Privacy & Security > Accessibility) or no keystrokes will be sent.
Nothing is posted for you; you always press Post yourself.
"""
from __future__ import annotations

import argparse
import json
import random
import re
import sys
import time
from pathlib import Path


def parse_thread(raw: str) -> list[str]:
    """Same input formats as the userscript: tweetMgr JSON, a JSON list, or --- separated text."""
    raw = raw.strip()
    if raw[:1] in "{[":
        data = json.loads(raw)
        items = data if isinstance(data, list) else (data.get("tweets") or data.get("posts") or [])
        return [t if isinstance(t, str) else str(t.get("text") or t.get("body") or "") for t in items]
    return [p.strip() for p in re.split(r"\r?\n[ \t]*---[ \t]*\r?\n", raw) if p.strip()]


def delay_for(ch: str, lo: float, hi: float) -> float:
    base = random.uniform(lo, hi)
    if ch in ".!?":
        return base + random.uniform(0.12, 0.30)
    if ch in ",;:":
        return base + random.uniform(0.06, 0.15)
    if ch == " " and random.random() < 0.06:
        return base + random.uniform(0.15, 0.40)
    return base


def type_text(text: str, lo: float, hi: float) -> None:
    from pynput.keyboard import Controller, Key  # imported lazily so --help works without it

    kb = Controller()
    for ch in text.replace("\r\n", "\n"):
        if ch == "\n":
            kb.press(Key.enter)
            kb.release(Key.enter)
        else:
            kb.type(ch)  # handles unicode and emoji
        time.sleep(delay_for(ch, lo, hi))


def countdown(seconds: int) -> None:
    for s in range(seconds, 0, -1):
        print(f"  typing in {s}... (focus the X compose box)", end="\r", flush=True)
        time.sleep(1)
    print(" " * 50, end="\r")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", type=Path, help="thread file (tweetMgr JSON or --- separated text)")
    ap.add_argument("--tweet", type=int, help="type only this tweet (1-based)")
    ap.add_argument("--countdown", type=int, default=4, help="seconds to switch windows (default 4)")
    ap.add_argument("--min-delay", type=float, default=0.035, help="min seconds per character")
    ap.add_argument("--max-delay", type=float, default=0.110, help="max seconds per character")
    args = ap.parse_args()

    tweets = parse_thread(args.file.read_text(encoding="utf-8"))
    if not tweets:
        print("No tweets found.", file=sys.stderr)
        return 1
    indices = [args.tweet - 1] if args.tweet else range(len(tweets))
    for i in indices:
        if not 0 <= i < len(tweets):
            print(f"There is no tweet {i + 1}; the thread has {len(tweets)}.", file=sys.stderr)
            return 1
        preview = tweets[i].replace("\n", " ")
        print(f"\nTweet {i + 1}/{len(tweets)}: {preview[:70]}{'...' if len(preview) > 70 else ''}")
        if not args.tweet:
            answer = input("  Enter to type it, s to skip, q to quit: ").strip().lower()
            if answer == "q":
                break
            if answer == "s":
                continue
        countdown(args.countdown)
        type_text(tweets[i], args.min_delay, max(args.min_delay, args.max_delay))
        print("  done. Review it in X before posting.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
