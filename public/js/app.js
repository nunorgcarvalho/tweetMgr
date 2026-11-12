// App shell: wires the Store, the data model, and the DOM together.
// Feature modules (images, splitting tools, thread library, preview) should
// hook in through the functions exported at the bottom of this file rather
// than reaching into each other.
import { openStore } from './storage.js';
import { tweetLength } from './counter.js';
import {
  ACCOUNT_TYPES,
  charLimit,
  createProfile,
  createThread,
  createTweet,
  toTyperJson,
  touch,
} from './model.js';

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  store: null,
  profile: null,
  thread: null,
  threads: [],
  dirty: false,
};

// ---------- Persistence ----------

let saveTimer = null;
function scheduleSave() {
  state.dirty = true;
  setStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (!state.thread) return;
  touch(state.thread);
  await state.store.saveThread(state.thread);
  state.dirty = false;
  setStatus('All changes saved');
  await refreshThreadList();
}

async function saveProfile() {
  touch(state.profile);
  await state.store.saveProfile(state.profile);
}

async function loadThread(id) {
  if (state.dirty) await saveNow();
  const thread = await state.store.getThread(id);
  if (!thread) return;
  state.thread = thread;
  await state.store.setSetting('activeThreadId', id);
  renderThread();
  await refreshThreadList();
}

async function newThread() {
  if (state.dirty) await saveNow();
  state.thread = createThread(state.profile.id);
  await state.store.saveThread(state.thread);
  await state.store.setSetting('activeThreadId', state.thread.id);
  renderThread();
  await refreshThreadList();
  $('.tweet-text')?.focus();
}

// Files on disk may be edited by the CLI or another agent. When the window
// regains focus, pick up those edits if there are no unsaved local changes.
async function syncFromStore() {
  if (!state.thread || state.dirty) return;
  const fresh = await state.store.getThread(state.thread.id);
  if (fresh && fresh.updatedAt !== state.thread.updatedAt) {
    state.thread = fresh;
    renderThread();
    setStatus('Reloaded changes from disk');
  }
  await refreshThreadList();
}

// ---------- Rendering ----------

function setStatus(text) {
  $('#save-status').textContent = text;
}

let toastTimer = null;
export function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 1800);
}

function limit() {
  return charLimit(state.profile);
}

function updateCounter(li, tweet) {
  const left = limit() - tweetLength(tweet.text);
  const counter = $('.counter', li);
  counter.textContent = left;
  counter.classList.toggle('is-warn', left >= 0 && left < 20);
  counter.classList.toggle('is-over', left < 0);
  li.classList.toggle('is-over', left < 0);
}

function updateMeta() {
  const n = state.thread.tweets.length;
  const over = state.thread.tweets.filter((t) => tweetLength(t.text) > limit()).length;
  $('#thread-meta').textContent = `${n} tweet${n === 1 ? '' : 's'}${over ? ` · ${over} over the limit` : ''}`;
}

function renderTweet(tweet, index, total) {
  const li = $('#tweet-template').content.firstElementChild.cloneNode(true);
  li.dataset.id = tweet.id;
  $('.avatar', li).textContent = (state.profile.name || '?').trim().charAt(0).toUpperCase();
  $('.tweet-name', li).textContent = state.profile.name;
  $('.tweet-handle', li).textContent = `@${state.profile.handle}`;
  $('.tweet-index', li).textContent = `${index + 1}/${total}`;
  const ta = $('.tweet-text', li);
  ta.value = tweet.text;
  updateCounter(li, tweet);
  for (const hook of tweetRenderHooks) hook(li, tweet, index);
  return li;
}

export function renderThread() {
  const { thread } = state;
  $('#thread-title').value = thread.title;
  const list = $('#tweets');
  list.replaceChildren(...thread.tweets.map((t, i) => renderTweet(t, i, thread.tweets.length)));
  list.querySelectorAll('.tweet-text').forEach(autosize); // needs to be in the DOM to measure
  updateMeta();
}

function renderProfile() {
  const p = state.profile;
  $('#profile-name').value = p.name;
  $('#profile-handle').value = p.handle;
  $('#profile-type').value = p.accountType;
  $('#profile-limit').value = p.customLimit;
  $('#custom-limit-row').hidden = p.accountType !== 'custom';
  $('#limit-hint').textContent = `Each tweet can be up to ${limit().toLocaleString()} characters. Links count as 23; emoji and CJK characters count as 2.`;
}

async function refreshThreadList() {
  state.threads = await state.store.listThreads(state.profile.id);
  const ul = $('#thread-list');
  if (!state.threads.length) {
    ul.innerHTML = '<li class="empty">No saved threads yet.</li>';
    return;
  }
  ul.replaceChildren(
    ...state.threads.map((t) => {
      const li = document.createElement('li');
      li.classList.toggle('is-active', t.id === state.thread?.id);
      const a = document.createElement('a');
      a.href = `#${t.id}`;
      a.textContent = t.title || 'Untitled thread';
      const small = document.createElement('small');
      small.textContent = `${t.tweets.length}`;
      small.title = `${t.tweets.length} tweets`;
      a.append(small);
      a.addEventListener('click', (e) => {
        e.preventDefault();
        loadThread(t.id);
      });
      li.append(a);
      return li;
    }),
  );
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.max(64, ta.scrollHeight + 2)}px`;
}

// ---------- Thread editing API (used by feature modules too) ----------

export function getState() {
  return state;
}

export function findTweet(id) {
  return state.thread.tweets.find((t) => t.id === id);
}

/** Apply a structural change to the thread, then re-render and save. */
export function mutateThread(fn) {
  fn(state.thread);
  if (!state.thread.tweets.length) state.thread.tweets.push(createTweet());
  renderThread();
  scheduleSave();
}

const tweetRenderHooks = [];
/** Feature modules can decorate each rendered tweet card. */
export function onRenderTweet(hook) {
  tweetRenderHooks.push(hook);
  if (state.thread) renderThread(); // registered after the first render
}

// ---------- Events ----------

function bindEvents() {
  $('#thread-title').addEventListener('input', (e) => {
    state.thread.title = e.target.value;
    scheduleSave();
  });

  const list = $('#tweets');
  list.addEventListener('input', (e) => {
    if (!e.target.classList.contains('tweet-text')) return;
    const li = e.target.closest('.tweet');
    const tweet = findTweet(li.dataset.id);
    tweet.text = e.target.value;
    autosize(e.target);
    updateCounter(li, tweet);
    updateMeta();
    scheduleSave();
  });

  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.closest('.tweet').dataset.id;
    const i = state.thread.tweets.findIndex((t) => t.id === id);
    switch (btn.dataset.action) {
      case 'copy':
        await navigator.clipboard.writeText(state.thread.tweets[i].text);
        toast('Tweet copied');
        break;
      case 'add-below': {
        const tweet = createTweet();
        mutateThread((th) => th.tweets.splice(i + 1, 0, tweet));
        $(`.tweet[data-id="${tweet.id}"] .tweet-text`)?.focus();
        break;
      }
      case 'delete':
        mutateThread((th) => th.tweets.splice(i, 1));
        break;
    }
  });

  $('#add-tweet').addEventListener('click', () => {
    const tweet = createTweet();
    mutateThread((th) => th.tweets.push(tweet));
    $(`.tweet[data-id="${tweet.id}"] .tweet-text`)?.focus();
  });

  $('#new-thread').addEventListener('click', newThread);

  $('#copy-typer').addEventListener('click', async () => {
    await navigator.clipboard.writeText(JSON.stringify(toTyperJson(state.thread), null, 2));
    toast('Thread copied as JSON for the typer');
  });

  const onProfileChange = async () => {
    const p = state.profile;
    p.name = $('#profile-name').value;
    p.handle = $('#profile-handle').value.replace(/^@/, '');
    p.accountType = $('#profile-type').value;
    p.customLimit = Number($('#profile-limit').value) || 280;
    renderProfile();
    renderThread();
    await saveProfile();
  };
  for (const id of ['#profile-name', '#profile-handle', '#profile-limit']) $(id).addEventListener('input', onProfileChange);
  $('#profile-type').addEventListener('change', onProfileChange);

  window.addEventListener('focus', syncFromStore);
  window.addEventListener('beforeunload', () => {
    if (state.dirty) saveNow();
  });
}

// ---------- Boot ----------

async function boot() {
  state.store = await openStore();
  $('#storage-note').textContent =
    state.store.kind === 'files' ? 'Saving to the data/ folder' : 'Saving in this browser';

  const typeSelect = $('#profile-type');
  for (const [value, { label }] of Object.entries(ACCOUNT_TYPES)) {
    typeSelect.add(new Option(label, value));
  }

  const profiles = await state.store.listProfiles();
  const activeProfileId = await state.store.getSetting('activeProfileId');
  state.profile = profiles.find((p) => p.id === activeProfileId) || profiles[0];
  if (!state.profile) {
    state.profile = createProfile();
    await state.store.saveProfile(state.profile);
  }
  await state.store.setSetting('activeProfileId', state.profile.id);

  const threads = await state.store.listThreads(state.profile.id);
  const activeThreadId = await state.store.getSetting('activeThreadId');
  state.thread = threads.find((t) => t.id === activeThreadId) || threads[0];
  if (!state.thread) {
    state.thread = createThread(state.profile.id);
    await state.store.saveThread(state.thread);
  }
  if (state.store.loadImages) {
    await state.store.loadImages(threads.flatMap((t) => t.tweets.flatMap((tw) => tw.media.map((m) => m.imageId).filter(Boolean))));
  }

  renderProfile();
  renderThread();
  await refreshThreadList();
  bindEvents();
  setStatus('All changes saved');

  // Hook for scripts and the typing macro (e.g. from the dev console).
  window.tweetMgr = { getThread: () => structuredClone(state.thread), toTyperJson: () => toTyperJson(state.thread) };
}

boot().catch((err) => {
  console.error(err);
  setStatus(`Error: ${err.message}`);
});
