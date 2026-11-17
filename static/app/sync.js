import { idb } from '../offline.js';
import { $, CLIENT, VAULT, api, debounce, dirname, enc, setOnline, state, stem, vstore } from './core.js';
import { backlinksSoon } from './panels.js';
import { loadWords, scheduleLint, spell } from './spellui.js';
import { patchTreeNote, refreshTree } from './tree.js';
import { dialog, toast } from './ui.js';
import { setEditorValue, updateStatus } from './writing.js';

// ------------------------------------------------------------------ pending (offline) store
export const pending = {
  all: () => vstore.get('pending', {}),
  put(path, content, base) { const p = pending.all(); p[path] = { content, base, at: Date.now() }; vstore.set('pending', p); },
  drop(path) { const p = pending.all(); if (p[path]) { delete p[path]; vstore.set('pending', p); } },
  clear() { vstore.set('pending', {}); },
  move(from, to) {
    const p = pending.all();
    for (const k of Object.keys(p)) if (k === from || k.startsWith(from + '/')) { p[to + k.slice(from.length)] = p[k]; delete p[k]; }
    vstore.set('pending', p);
  },
};

// ------------------------------------------------------------------ sync status
export const SYNC_LABEL = { synced: 'Synced', pending: 'Edited', saving: 'Saving…', offline: 'Offline · saved here', conflict: 'Conflict · resolve', error: 'Not saved', local: 'Saved here · sync' };
export const SYNC_TITLE = {
  offline: 'The server is unreachable. Changes are kept on this device and sync when it is back.',
  local: 'Manual sync: changes are kept on this device. Click to sync now.',
  conflict: 'This note changed somewhere else. Click to choose a version.',
};
export function setSync(s) {
  state.sync = s;
  const b = $('#stSync');
  b.dataset.state = s;
  const waiting = Object.keys(pending.all()).length;
  b.querySelector('span').textContent = s === 'local' && waiting > 1 ? `${waiting} notes saved here · sync` : SYNC_LABEL[s];
  b.title = SYNC_TITLE[s] || 'Sync status. Click to sync now.';
  $('#tabs .tab.active')?.classList.toggle('dirty', s !== 'synced' && !!state.cur);
}

// ------------------------------------------------------------------ saving
export let saveTimer = null;
export let savingP = null;
export let retryTimer = null;

export const manual = () => state.settings.syncMode === 'manual';

export function scheduleSave(ms = state.settings.saveDelay) {
  clearTimeout(saveTimer);
  if (state.cur?.conflict) return;
  if (manual()) { saveTimer = setTimeout(saveLocal, 250); return; }
  saveTimer = setTimeout(() => save(), ms);
}

/** Keep the open note on this device: the queue of unsent edits plus the offline copy. */
export function saveLocal() {
  const cur = state.cur;
  if (!cur || !cur.dirty) return;
  pending.put(cur.path, cur.content, cur.version);
  cacheNote(cur);
  if (state.sync !== 'conflict') setSync(manual() ? 'local' : 'offline');
}

export function cacheNote(n) {
  idb.set(`${VAULT}|note|${n.path}`, { content: n.content, version: n.version, modified: n.modified, created: n.created });
}

/** Send everything now: the open note and anything queued on this device. */
export async function syncNow() {
  if (state.cur?.dirty && !state.cur.conflict) { clearTimeout(saveTimer); await save(); }
  await flushPending();
  if (!state.cur?.dirty && state.sync !== 'conflict' && state.online) setSync('synced');
}

export async function save(force = false) {
  clearTimeout(saveTimer);
  while (savingP) await savingP;
  const cur = state.cur;
  if (!cur || !cur.dirty || (cur.conflict && !force)) return;
  savingP = doSave(cur, force);
  try { await savingP; } finally { savingP = null; }
}

export async function doSave(cur, force) {
  const content = cur.content;
  const path = cur.path;
  if (state.cur === cur) setSync('saving');
  try {
    const r = await api('PUT', `/api/note?path=${enc(path)}`, { content, base: cur.version, force });
    Object.assign(cur, { version: r.version, modified: r.modified, created: cur.created || r.created, conflict: null });
    if (cur.content === content) cur.dirty = false;
    pending.drop(path);
    cacheNote({ ...cur, content });
    state.lastSync = Date.now();
    patchTreeNote(r);
    if (state.cur === cur) { setSync(cur.dirty ? 'pending' : 'synced'); updateStatus(); }
    if (cur.dirty) scheduleSave(300);
  } catch (e) {
    pending.put(path, content, cur.version);
    if (e.status === 409) {
      cur.conflict = e.data;
      if (state.cur === cur) setSync('conflict');
    } else {
      if (state.cur === cur) setSync(e.offline || e.status >= 500 ? 'offline' : 'error');
      if (!e.offline && e.status < 500) toast(e.message, 'err');
      clearTimeout(retryTimer);
      if (!manual()) retryTimer = setTimeout(() => save(), 5000);
    }
  }
}

export async function flushSave() {
  clearTimeout(saveTimer);
  if (manual()) saveLocal();
  else if (state.cur?.dirty && !state.cur.conflict) await save();
  while (savingP) await savingP;
}

/** Push edits that were kept locally for notes other than the open one. */
export let flushing = null;
export function flushPending() {
  flushing ||= doFlushPending().finally(() => { flushing = null; });
  return flushing;
}
export async function doFlushPending() {
  const all = pending.all();
  for (const [path, p] of Object.entries(all)) {
    if (state.cur?.path === path) continue;
    try {
      const r = await api('PUT', `/api/note?path=${enc(path)}`, { content: p.content, base: p.base });
      pending.drop(path);
      cacheNote({ ...r, content: p.content });
    } catch (e) {
      if (e.status === 409) {
        await api('POST', '/api/note', { folder: dirname(path), name: `${stem(path)} (conflict ${new Date(p.at).toISOString().slice(0, 10)})`, content: p.content }).catch(() => {});
        pending.drop(path);
        toast(`“${stem(path)}” changed elsewhere, so your offline copy was saved beside it`);
      } else if (e.offline) return;
    }
  }
  if (state.cur?.dirty) await save();
  await refreshTree();
}

export async function resolveConflict() {
  const cur = state.cur;
  if (!cur?.conflict) return;
  const choice = await dialog({
    title: 'This note changed somewhere else',
    text: 'Another device saved a different version while you were editing. Choose which one to keep.',
    buttons: [
      { label: 'Keep both', value: 'both' },
      { label: 'Use theirs', value: 'theirs' },
      { label: 'Keep mine', value: 'mine', primary: true },
    ],
  });
  if (choice === 'mine') { await save(true); }
  else if (choice === 'theirs' || choice === 'both') {
    if (choice === 'both') {
      await api('POST', '/api/note', { folder: dirname(cur.path), name: `${stem(cur.path)} (my copy)`, content: cur.content }).catch((e) => toast(e.message, 'err'));
    }
    const theirs = cur.conflict;
    Object.assign(cur, { content: theirs.content, version: theirs.version, modified: theirs.modified, dirty: false, conflict: null });
    pending.drop(cur.path);
    setEditorValue(theirs.content);
    setSync('synced');
    refreshTree();
  }
}

// ------------------------------------------------------------------ live sync
export let live = null;
export const liveRefresh = debounce(() => { refreshTree(); backlinksSoon(); }, 250);
export function connectLive() {
  if (live) { live.close(); live = null; }
  if (state.settings.syncMode !== 'live' || !('EventSource' in window)) return;
  live = new EventSource(`/api/events?vault=${enc(VAULT)}`);
  live.onopen = () => setOnline(true);
  live.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.client === CLIENT) return;
    if (ev.type === 'dictionary') { loadWords().then((words) => spell.configure({ dialect: state.settings.dialect, rules: state.settings.harperRules, words })).then(() => scheduleLint(0)).catch(() => {}); return; }
    liveRefresh();
  };
  live.onerror = () => { if (live?.readyState === EventSource.CLOSED) setTimeout(connectLive, 5000); };
}
