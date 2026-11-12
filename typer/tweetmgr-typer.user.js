// ==UserScript==
// @name         tweetMgr Typer
// @namespace    https://github.com/nunorgcarvalho/tweetMgr
// @version      0.1.0
// @description  Types out pre-written tweets from tweetMgr into X's composer, one character at a time, instead of pasting them.
// @author       tweetMgr
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * How it works
 * ------------
 * 1. Load a thread into the panel (paste the JSON exported by tweetMgr, plain
 *    text with tweets separated by a line containing only "---"). The easiest
 *    path: press "Copy for typer" in tweetMgr, then "Load from clipboard" here.
 * 2. Click into X's compose box, then click "Type" next to a tweet (or press
 *    Alt+Shift+T to type the next one). The text is entered character by
 *    character with small, slightly random pauses, the same way the browser
 *    handles keyboard input, so X never sees a paste event.
 *
 * Nothing is posted automatically. You always review and press "Post" yourself.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Storage (Tampermonkey/Violentmonkey storage, with a fallback for testing)
  // ---------------------------------------------------------------------------
  const store = {
    get(key, fallback) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
      } catch (_) { /* ignore */ }
      return fallback;
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(key, value);
      } catch (_) { /* ignore */ }
    },
  };

  const DEFAULTS = {
    minDelay: 35, // ms between characters
    maxDelay: 110,
    collapsed: false,
  };
  const settings = Object.assign({}, DEFAULTS, store.get('settings', {}));
  const saveSettings = () => store.set('settings', settings);

  // ---------------------------------------------------------------------------
  // Thread parsing
  // ---------------------------------------------------------------------------
  /**
   * Accepts any of:
   *   - {"title": "...", "tweets": [{"text": "...", "images": [{"alt": "..."}]}]}
   *   - [{"text": "..."}, ...]  or  ["tweet one", "tweet two"]
   *   - plain text, tweets separated by a line containing only ---
   * Returns {title, tweets: [{text, alts: [string]}]}.
   */
  function parseThread(raw) {
    const input = (raw || '').trim();
    if (!input) throw new Error('Nothing to load.');
    let data = null;
    if (input[0] === '{' || input[0] === '[') {
      try { data = JSON.parse(input); } catch (e) { throw new Error('That looks like JSON but could not be parsed: ' + e.message); }
    }
    if (data === null) {
      const parts = input.split(/\r?\n[ \t]*---[ \t]*\r?\n/).map((s) => s.trim()).filter(Boolean);
      return { title: 'Pasted thread', tweets: parts.map((text) => ({ text, alts: [] })) };
    }
    const list = Array.isArray(data) ? data : (data.tweets || data.posts || []);
    if (!Array.isArray(list) || list.length === 0) throw new Error('No tweets found in that JSON.');
    const tweets = list.map((t) => {
      if (typeof t === 'string') return { text: t, alts: [] };
      const media = t.images || t.media || [];
      const alts = media.map((m) => (m && (m.alt || m.altText || m.alt_text)) || '').filter(Boolean);
      return { text: String(t.text || t.body || ''), alts };
    });
    return { title: (!Array.isArray(data) && (data.title || data.name)) || 'Untitled thread', tweets };
  }

  // ---------------------------------------------------------------------------
  // Typing engine
  // ---------------------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Split into user-perceived characters so emoji and accents stay intact. */
  function graphemes(text) {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment);
    }
    return Array.from(text);
  }

  function delayFor(ch) {
    const base = settings.minDelay + Math.random() * (settings.maxDelay - settings.minDelay);
    if (/[.!?]/.test(ch)) return base + 120 + Math.random() * 180;
    if (/[,;:]/.test(ch)) return base + 60 + Math.random() * 90;
    if (ch === ' ' && Math.random() < 0.06) return base + 150 + Math.random() * 250; // occasional "thinking" pause
    return base;
  }

  const isTextarea = (el) => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|)$/i.test(el.type || '')));
  const isEditable = (el) => el && (isTextarea(el) || el.isContentEditable);

  function editorText(el) {
    return isTextarea(el) ? el.value : el.innerText;
  }

  function typeChar(el, ch) {
    // 1) A "textInput" event is what React turns into onBeforeInput, which is
    //    how Draft.js (X's editor) receives every typed character. If the
    //    editor handles it, it cancels the event and updates its own state.
    if (!isTextarea(el) && typeof TextEvent !== 'undefined') {
      const ev = document.createEvent('TextEvent');
      ev.initTextEvent('textInput', true, true, window, ch);
      if (!(document.activeElement || el).dispatchEvent(ev)) return;
    }
    // 2) Otherwise insert it the way the browser does for a keystroke: this
    //    fires beforeinput/input with inputType "insertText" (never a paste).
    if (document.execCommand('insertText', false, ch)) return;
    // Fallback for plain inputs where execCommand is unavailable.
    if (isTextarea(el)) {
      const start = el.selectionStart, end = el.selectionEnd;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      setter.call(el, el.value.slice(0, start) + ch + el.value.slice(end));
      el.selectionStart = el.selectionEnd = start + ch.length;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
    }
  }

  function typeNewline(el) {
    if (isTextarea(el)) { typeChar(el, '\n'); return; }
    // Rich editors (X uses Draft.js) treat Enter as "split block".
    const before = editorText(el);
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const notHandled = el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    if (notHandled && editorText(el) === before) {
      if (!document.execCommand('insertParagraph')) document.execCommand('insertLineBreak');
    }
  }

  /**
   * Moves the caret to the end of the editor, unless the user already put it
   * somewhere inside. For rich editors the caret goes into the last text node,
   * because editors like Draft.js break if the selection sits on the root.
   */
  function placeCaretAtEnd(el) {
    if (isTextarea(el)) {
      if (document.activeElement !== el) el.selectionStart = el.selectionEnd = el.value.length;
      return;
    }
    const sel = window.getSelection();
    if (sel.rangeCount && el.contains(sel.anchorNode)) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let last = null;
    while (walker.nextNode()) last = walker.currentNode;
    if (!last) return; // empty editor: focus() already put the caret in the only spot
    const range = document.createRange();
    range.setStart(last, last.length);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  let typing = null; // {cancel: bool}

  async function typeInto(el, text, onProgress) {
    if (typing) throw new Error('Already typing. Press Stop first.');
    const job = { cancel: false };
    typing = job;
    try {
      el.focus();
      placeCaretAtEnd(el);
      const chars = graphemes(text.replace(/\r\n?/g, '\n'));
      for (let i = 0; i < chars.length; i++) {
        if (job.cancel) return false;
        if (document.activeElement !== el && !el.contains(document.activeElement)) el.focus();
        const ch = chars[i];
        if (ch === '\n') typeNewline(el); else typeChar(el, ch);
        if (onProgress) onProgress(i + 1, chars.length);
        await sleep(delayFor(ch));
      }
      return true;
    } finally {
      typing = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Finding X's compose boxes
  // ---------------------------------------------------------------------------
  let lastEditor = null;
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest && e.target.closest('[contenteditable="true"], textarea, input');
    if (el && isEditable(el) && !el.closest('#tmgr-typer')) lastEditor = el;
  }, true);

  /** The compose box for tweet `index` (0-based) in X's thread composer. */
  function composerFor(index) {
    const box = document.querySelector(`[data-testid="tweetTextarea_${index}"]`);
    if (!box) return null;
    return box.isContentEditable ? box : box.querySelector('[contenteditable="true"]') || box;
  }

  function pickTarget(index) {
    if (lastEditor && document.contains(lastEditor)) return lastEditor;
    return composerFor(index) || composerFor(0);
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  const CSS = `
  #tmgr-typer { position: fixed; right: 16px; bottom: 16px; width: 340px; max-height: 78vh; z-index: 2147483000;
    font: 13px/1.4 "Helvetica Neue", Helvetica, Arial, sans-serif; color: #333; background: #fff;
    border: 1px solid #c0deed; border-radius: 6px; box-shadow: 0 3px 12px rgba(0,0,0,.25); display: flex; flex-direction: column; overflow: hidden; }
  #tmgr-typer * { box-sizing: border-box; }
  #tmgr-typer .hd { background: linear-gradient(#33ccff, #0099dd); color: #fff; padding: 7px 10px; font-weight: bold;
    text-shadow: 0 -1px 0 rgba(0,0,0,.25); display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
  #tmgr-typer .hd .t { flex: 1; }
  #tmgr-typer .hd .bird { font-size: 15px; }
  #tmgr-typer .bd { padding: 10px; overflow: auto; background: #f5fafd; }
  #tmgr-typer.collapsed .bd { display: none; }
  #tmgr-typer textarea.src { width: 100%; height: 70px; font: 12px/1.35 Menlo, Consolas, monospace; border: 1px solid #ccc;
    border-radius: 4px; padding: 6px; resize: vertical; background: #fff; color: #333; }
  #tmgr-typer .row { display: flex; gap: 6px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
  #tmgr-typer button { font: bold 12px "Helvetica Neue", Helvetica, Arial, sans-serif; color: #333; cursor: pointer;
    background: linear-gradient(#fff, #e6e6e6); border: 1px solid #ccc; border-radius: 4px; padding: 4px 9px; text-shadow: 0 1px 0 #fff; }
  #tmgr-typer button:hover { background: linear-gradient(#fff, #d9d9d9); border-color: #bbb; }
  #tmgr-typer button.blue { color: #fff; text-shadow: 0 -1px 0 rgba(0,0,0,.25); background: linear-gradient(#33bbee, #2289c9); border-color: #1d7ab5; }
  #tmgr-typer button.blue:hover { background: linear-gradient(#2eb0e3, #1a76b3); }
  #tmgr-typer button.stop { color: #fff; background: linear-gradient(#e86a6a, #c33); border-color: #a22; text-shadow: none; }
  #tmgr-typer button:disabled { opacity: .5; cursor: default; }
  #tmgr-typer .title { font-weight: bold; color: #0084b4; margin: 10px 0 4px; }
  #tmgr-typer .msg { font-size: 12px; margin-top: 6px; color: #666; }
  #tmgr-typer .msg.err { color: #c33; }
  #tmgr-typer ol { list-style: none; margin: 0; padding: 0; }
  #tmgr-typer li { background: #fff; border: 1px solid #e1e8ed; border-radius: 4px; padding: 7px 8px; margin-top: 6px; }
  #tmgr-typer li.done { background: #eef8ee; border-color: #bfe0bf; }
  #tmgr-typer li.active { border-color: #33bbee; box-shadow: 0 0 0 2px rgba(51,187,238,.25); }
  #tmgr-typer li .n { color: #999; font-weight: bold; margin-right: 4px; }
  #tmgr-typer li .tx { white-space: pre-wrap; word-wrap: break-word; color: #333; max-height: 5.6em; overflow: hidden; }
  #tmgr-typer li .meta { color: #999; font-size: 11px; margin-top: 4px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  #tmgr-typer li .meta .sp { flex: 1; }
  #tmgr-typer li .alt { font-size: 11px; color: #555; background: #f5f8fa; border-left: 3px solid #c0deed; padding: 3px 6px; margin-top: 4px; display: flex; gap: 6px; align-items: flex-start; }
  #tmgr-typer li .alt span { flex: 1; }
  #tmgr-typer li .alt button { padding: 1px 6px; font-size: 11px; }
  #tmgr-typer .bar { height: 3px; background: #e1e8ed; border-radius: 2px; margin-top: 5px; overflow: hidden; display: none; }
  #tmgr-typer li.active .bar { display: block; }
  #tmgr-typer .bar i { display: block; height: 100%; width: 0; background: #33bbee; }
  #tmgr-typer details { margin-top: 8px; font-size: 12px; }
  #tmgr-typer details input { width: 100%; font-size: 12px; padding: 3px 5px; border: 1px solid #ccc; border-radius: 3px; }
  #tmgr-typer details label { display: block; margin-top: 5px; color: #666; }
  #tmgr-typer .hint { font-size: 11px; color: #999; margin-top: 8px; }
  #tmgr-typer kbd { font: 11px Menlo, monospace; background: #fff; border: 1px solid #ccc; border-radius: 3px; padding: 0 3px; }
  `;

  const state = { thread: store.get('thread', null), done: store.get('done', []), next: 0 };

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : String(kid));
    return el;
  }

  let root, listEl, msgEl, srcEl;

  function say(text, isErr) {
    msgEl.textContent = text || '';
    msgEl.className = 'msg' + (isErr ? ' err' : '');
  }

  function load(raw) {
    try {
      state.thread = parseThread(raw);
      state.done = [];
      store.set('thread', state.thread);
      store.set('done', state.done);
      render();
      say(`Loaded ${state.thread.tweets.length} tweet(s). Click into X's compose box, then press Type.`);
    } catch (e) {
      say(e.message, true);
    }
  }

  async function loadFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      srcEl.value = text;
      load(text);
    } catch (_) {
      say('The browser blocked clipboard access. Paste into the box above and press Load instead.', true);
    }
  }

  async function typeTweet(i, target, text, opts) {
    const el = target || pickTarget(i);
    if (!el) { say('Click into a compose box on X first.', true); return; }
    const li = listEl.children[i];
    if (li && !opts?.alt) li.classList.add('active');
    const fill = li && li.querySelector('.bar i');
    setBusy(true);
    say(opts?.alt ? 'Typing alt text...' : `Typing tweet ${i + 1}...`);
    try {
      const finished = await typeInto(el, text, (n, total) => { if (fill && !opts?.alt) fill.style.width = (100 * n / total) + '%'; });
      if (finished && !opts?.alt) {
        if (!state.done.includes(i)) state.done.push(i);
        store.set('done', state.done);
        state.next = i + 1;
      }
      say(finished ? (opts?.alt ? 'Alt text typed.' : `Tweet ${i + 1} typed. Review it, then post or add the next one.`) : 'Stopped.');
    } catch (e) {
      say(e.message, true);
    } finally {
      setBusy(false);
      render();
    }
  }

  function setBusy(busy) {
    root.querySelectorAll('button[data-type]').forEach((b) => { b.disabled = busy; });
    root.querySelector('.stop').style.display = busy ? '' : 'none';
  }

  function render() {
    listEl.textContent = '';
    const titleEl = root.querySelector('.title');
    if (!state.thread) { titleEl.textContent = ''; return; }
    titleEl.textContent = state.thread.title + ` (${state.thread.tweets.length})`;
    state.thread.tweets.forEach((t, i) => {
      const alts = t.alts.map((alt, j) => h('div', { class: 'alt' },
        h('span', null, `🖼 Image ${j + 1} alt: ${alt}`),
        h('button', { 'data-type': '1', title: 'Click into the image description box on X first', onclick: () => typeTweet(i, lastEditor, alt, { alt: true }) }, 'Type')));
      listEl.append(h('li', { class: state.done.includes(i) ? 'done' : '' },
        h('div', { class: 'tx' }, h('span', { class: 'n' }, `${i + 1}/${state.thread.tweets.length}`), t.text),
        h('div', { class: 'meta' },
          h('span', null, `${graphemes(t.text).length} chars`),
          t.alts.length ? h('span', null, `· ${t.alts.length} image(s)`) : null,
          state.done.includes(i) ? h('span', null, '· ✓ typed') : null,
          h('span', { class: 'sp' }),
          h('button', { class: 'blue', 'data-type': '1', onclick: () => typeTweet(i, null, t.text) }, 'Type')),
        alts,
        h('div', { class: 'bar' }, h('i'))));
    });
  }

  function build() {
    const style = h('style', null, CSS);
    srcEl = h('textarea', { class: 'src', placeholder: 'Paste the thread JSON from tweetMgr, or plain text with tweets separated by a line with ---' });
    listEl = h('ol');
    msgEl = h('div', { class: 'msg' });
    const minD = h('input', { type: 'number', value: settings.minDelay, min: 0 });
    const maxD = h('input', { type: 'number', value: settings.maxDelay, min: 0 });
    const upd = () => { settings.minDelay = Math.max(0, +minD.value || 0); settings.maxDelay = Math.max(settings.minDelay, +maxD.value || 0); saveSettings(); };
    minD.addEventListener('change', upd); maxD.addEventListener('change', upd);

    root = h('div', { id: 'tmgr-typer', class: settings.collapsed ? 'collapsed' : '' },
      h('div', { class: 'hd', onclick: () => { root.classList.toggle('collapsed'); settings.collapsed = root.classList.contains('collapsed'); saveSettings(); } },
        h('span', { class: 'bird' }, '🐦'), h('span', { class: 't' }, 'tweetMgr Typer'), h('span', null, '▾')),
      h('div', { class: 'bd' },
        srcEl,
        h('div', { class: 'row' },
          h('button', { class: 'blue', onclick: () => load(srcEl.value) }, 'Load'),
          h('button', { onclick: loadFromClipboard }, 'Load from clipboard'),
          h('button', { class: 'stop', style: 'display:none', onclick: () => { if (typing) typing.cancel = true; } }, 'Stop')),
        msgEl,
        h('div', { class: 'title' }),
        listEl,
        h('div', { class: 'hint' }, 'Tip: click into X\'s compose box and press ', h('kbd', null, 'Alt'), '+', h('kbd', null, 'Shift'), '+', h('kbd', null, 'T'),
          ' to type the next tweet without leaving the keyboard. Nothing is ever posted for you.'),
        h('details', null, h('summary', null, 'Settings'),
          h('label', null, 'Min delay per character (ms)', minD),
          h('label', null, 'Max delay per character (ms)', maxD))));
    // Keep X's global keyboard shortcuts from firing while typing in the panel.
    ['keydown', 'keypress', 'keyup'].forEach((t) => root.addEventListener(t, (e) => e.stopPropagation()));
    document.head.append(style);
    document.body.append(root);
    render();
  }

  // Alt+Shift+T types the next untyped tweet into the focused compose box.
  document.addEventListener('keydown', (e) => {
    if (!(e.altKey && e.shiftKey && (e.code === 'KeyT' || e.key.toLowerCase() === 't'))) return;
    if (!state.thread || typing) return;
    const el = document.activeElement;
    if (!isEditable(el) || el.closest('#tmgr-typer')) return;
    e.preventDefault();
    e.stopPropagation();
    let i = state.thread.tweets.findIndex((_, k) => k >= state.next && !state.done.includes(k));
    if (i < 0) i = state.thread.tweets.findIndex((_, k) => !state.done.includes(k));
    if (i < 0) { say('All tweets have been typed. Load a new thread to start over.'); return; }
    typeTweet(i, el, state.thread.tweets[i].text);
  }, true);

  // Exposed for tests and for power users in the console.
  window.tweetMgrTyper = { parseThread, load, typeInto, state };

  if (document.body) build(); else document.addEventListener('DOMContentLoaded', build);
})();
