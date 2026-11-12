// Thread library: the "Your threads" sidebar list (open, rename, duplicate,
// export, delete), importing exported files, and the account switcher.
// Pure logic lives in library-core.js; this file is the DOM side.
import {
  cancelPendingSave,
  getState,
  loadThread,
  newThread,
  onProfileChange,
  refreshThreadList,
  saveNow,
  setThreadListRenderer,
  switchProfile,
  toast,
} from './app.js';
import { createProfile, createThread, touch } from './model.js';
import {
  buildBundle,
  bundleFileName,
  cloneThread,
  copyTitle,
  materializeBundle,
  orphanedImageIds,
  parseBundle,
} from './library-core.js';

const $ = (sel, root = document) => root.querySelector(sel);
const store = () => getState().store;

// Which list item has its action row open, and which one is being renamed
// or confirming a delete. Kept here so a list refresh does not lose them.
const ui = { openId: null, renamingId: null, confirmingId: null };

// ---------- Helpers ----------

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

function shortDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The freshest copy of a thread, saving pending edits if it is open. */
async function readThread(id) {
  const state = getState();
  if (state.thread?.id === id) {
    if (state.dirty) await saveNow();
    return structuredClone(state.thread);
  }
  return store().getThread(id);
}

// ---------- Thread actions ----------

async function renameThread(id, title) {
  const state = getState();
  title = title.trim() || 'Untitled thread';
  if (state.thread?.id === id) {
    state.thread.title = title;
    $('#thread-title').value = title;
    await saveNow();
    return;
  }
  const thread = await store().getThread(id);
  if (!thread) return;
  thread.title = title;
  await store().saveThread(touch(thread));
  await refreshThreadList();
}

async function duplicateThread(id) {
  const source = await readThread(id);
  if (!source) return;
  const copy = cloneThread(source, { title: copyTitle(source.title, getState().threads.map((t) => t.title)) });
  await store().saveThread(copy);
  ui.openId = copy.id;
  await loadThread(copy.id);
  toast('Thread duplicated');
}

async function exportThread(id) {
  const thread = await readThread(id);
  if (!thread) return;
  const { bundle, missingImages } = await buildBundle(thread, {
    readImage: async (imageId) => {
      const url = store().imageUrl(imageId);
      if (!url) return undefined;
      const res = await fetch(url);
      if (!res.ok) return undefined;
      const blob = await res.blob();
      return { type: blob.type, data: await blobToDataUrl(blob) };
    },
  });
  download(bundleFileName(thread), JSON.stringify(bundle, null, 2));
  toast(missingImages.length ? `Exported, but ${missingImages.length} image file(s) were missing` : 'Thread exported');
}

async function deleteThread(id) {
  const state = getState();
  const doomed = await store().getThread(id);
  // Drop pending edits so a queued save cannot bring the file back.
  if (state.thread?.id === id) cancelPendingSave();
  await store().deleteThread(id);

  // Remove uploaded images no other thread (in any account) still uses.
  if (doomed) {
    const remaining = await store().listThreads();
    for (const imageId of orphanedImageIds([doomed], remaining)) {
      await store().deleteImage(imageId).catch(() => {});
    }
  }

  if (state.thread?.id === id) {
    const next = (await store().listThreads(state.profile.id))[0];
    if (next) await loadThread(next.id);
    else await newThread();
  } else {
    await refreshThreadList();
  }
  toast(`Deleted “${doomed?.title || 'thread'}”`);
}

async function importFiles(files) {
  const state = getState();
  let imported = 0;
  let lastId = null;
  for (const file of files) {
    try {
      const parsed = parseBundle(await file.text());
      const thread = await materializeBundle(parsed, {
        profileId: state.profile.id,
        putImage: async ({ id, data }) => store().putImage(await (await fetch(data)).blob(), id),
      });
      await store().saveThread(thread);
      lastId = thread.id;
      imported++;
    } catch (err) {
      console.error(err);
      toast(`${file.name}: ${err.message}`);
    }
  }
  if (lastId) {
    await loadThread(lastId);
    toast(imported === 1 ? 'Thread imported' : `${imported} threads imported`);
  }
}

// ---------- Thread list ----------

function renderItem(t, activeId) {
  const li = el('li', { className: 'lib-item' });
  li.dataset.id = t.id;
  li.classList.toggle('is-active', t.id === activeId);
  li.classList.toggle('is-open', t.id === ui.openId);

  const count = t.tweets?.length || 0;
  const meta = `${count} tweet${count === 1 ? '' : 's'} · ${shortDate(t.updatedAt)}`;

  if (ui.renamingId === t.id) {
    const input = el('input', { type: 'text', className: 'lib-rename', value: t.title || '' });
    input.setAttribute('aria-label', 'New thread title');
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      ui.renamingId = null;
      if (commit && input.value.trim() !== (t.title || '')) await renameThread(t.id, input.value);
      else await refreshThreadList();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    li.append(input);
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    return li;
  }

  const open = el(
    'a',
    { href: `#${t.id}`, className: 'lib-open', title: t.title || 'Untitled thread' },
    el('span', { className: 'lib-title', textContent: t.title || 'Untitled thread' }),
    el('small', { className: 'lib-meta', textContent: meta }),
  );
  open.dataset.act = 'open';
  const toggle = el('button', { type: 'button', className: 'lib-toggle', textContent: '▾' });
  toggle.dataset.act = 'toggle';
  toggle.setAttribute('aria-label', `Actions for ${t.title || 'Untitled thread'}`);
  toggle.setAttribute('aria-expanded', String(t.id === ui.openId));
  li.append(el('div', { className: 'lib-row' }, open, toggle));

  if (ui.confirmingId === t.id) {
    const yes = el('button', { type: 'button', className: 'btn btn-small btn-danger', textContent: 'Delete' });
    yes.dataset.act = 'delete-yes';
    const no = el('button', { type: 'button', className: 'btn btn-small', textContent: 'Cancel' });
    no.dataset.act = 'delete-no';
    li.append(el('div', { className: 'lib-confirm' }, el('span', { textContent: 'Delete this thread for good?' }), yes, no));
  } else if (t.id === ui.openId) {
    const actions = el('div', { className: 'lib-actions' });
    for (const [act, label] of [
      ['rename', 'Rename'],
      ['duplicate', 'Duplicate'],
      ['export', 'Export'],
      ['delete', 'Delete'],
    ]) {
      const b = el('button', { type: 'button', className: `lib-action${act === 'delete' ? ' is-danger' : ''}`, textContent: label });
      b.dataset.act = act;
      actions.append(b);
    }
    li.append(actions);
  }
  return li;
}

function renderList(threads) {
  const ul = $('#thread-list');
  const activeId = getState().thread?.id;
  if (!threads.length) {
    ul.replaceChildren(el('li', { className: 'empty', textContent: 'No saved threads yet.' }));
  } else {
    ul.replaceChildren(...threads.map((t) => renderItem(t, activeId)));
  }
  const n = threads.length;
  $('#library-note').textContent = `${n} thread${n === 1 ? '' : 's'}`;
}

async function onListClick(e) {
  const target = e.target.closest('[data-act]');
  if (!target) return;
  e.preventDefault();
  const id = target.closest('.lib-item').dataset.id;
  const act = target.dataset.act;
  try {
    switch (act) {
      case 'open':
        ui.confirmingId = null;
        await loadThread(id);
        return;
      case 'toggle':
        ui.openId = ui.openId === id ? null : id;
        ui.confirmingId = null;
        break;
      case 'rename':
        ui.renamingId = id;
        break;
      case 'duplicate':
        await duplicateThread(id);
        return;
      case 'export':
        await exportThread(id);
        return;
      case 'delete':
        ui.confirmingId = id;
        break;
      case 'delete-no':
        ui.confirmingId = null;
        break;
      case 'delete-yes':
        ui.confirmingId = null;
        ui.openId = null;
        await deleteThread(id);
        return;
    }
  } catch (err) {
    console.error(err);
    toast(err.message);
  }
  renderList(getState().threads);
}

// ---------- Accounts ----------

let profiles = [];

async function renderProfiles(active) {
  profiles = await store().listProfiles();
  // The active profile may have unsaved keystrokes; prefer the live copy.
  profiles = profiles.map((p) => (p.id === active.id ? active : p));
  if (!profiles.some((p) => p.id === active.id)) profiles.push(active);
  profiles.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const select = $('#profile-switch');
  select.replaceChildren(
    ...profiles.map((p) => new Option(`${p.name || 'Unnamed'} (@${p.handle || ''})`, p.id, false, p.id === active.id)),
  );
  $('#profile-delete').disabled = profiles.length < 2;
  $('#profile-delete').title = profiles.length < 2 ? 'Add another account before removing this one' : 'Remove this account and its threads';
}

async function addProfile() {
  const profile = createProfile({ name: 'New account', handle: 'newaccount' });
  await store().saveProfile(profile);
  await store().saveThread(createThread(profile.id));
  await switchProfile(profile.id);
  $('#profile-name').focus();
  $('#profile-name').select();
  toast('Account added');
}

function confirmDeleteProfile() {
  const { profile, threads } = getState();
  const box = $('#profile-delete-confirm');
  const n = threads.length;
  const yes = el('button', { type: 'button', className: 'btn btn-small btn-danger', textContent: 'Remove' });
  const no = el('button', { type: 'button', className: 'btn btn-small', textContent: 'Cancel' });
  box.replaceChildren(
    el('span', { textContent: `Remove @${profile.handle} and its ${n} thread${n === 1 ? '' : 's'}?` }),
    yes,
    no,
  );
  box.hidden = false;
  no.addEventListener('click', () => (box.hidden = true));
  yes.addEventListener('click', async () => {
    box.hidden = true;
    await deleteProfile(profile.id);
  });
}

async function deleteProfile(id) {
  const next = profiles.find((p) => p.id !== id);
  if (!next) return;
  cancelPendingSave();
  const doomed = await store().listThreads(id);
  for (const t of doomed) await store().deleteThread(t.id);
  const remaining = await store().listThreads();
  for (const imageId of orphanedImageIds(doomed, remaining)) await store().deleteImage(imageId).catch(() => {});
  await store().deleteProfile(id);
  await switchProfile(next.id);
  toast('Account removed');
}

// ---------- Boot ----------

function init() {
  $('#thread-list').addEventListener('click', onListClick);

  $('#import-thread').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) await importFiles(files);
  });

  $('#profile-switch').addEventListener('change', async (e) => {
    $('#profile-delete-confirm').hidden = true;
    ui.openId = null;
    await switchProfile(e.target.value);
  });
  $('#profile-add').addEventListener('click', addProfile);
  $('#profile-delete').addEventListener('click', confirmDeleteProfile);

  setThreadListRenderer(renderList);
  onProfileChange((p) => renderProfiles(p));

  // Agents and scripts can drive the library from the dev console too.
  window.tweetMgrLibrary = { exportThread, duplicateThread, renameThread, deleteThread, importFiles, switchProfile };
}

init();
