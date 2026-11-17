import { render, esc, frontmatterEnd, slug } from './markdown.js';
import { highlight, caretRect, replace, commands, handleKey } from './editor.js';
import { icon, hydrateIcons } from './icons.js';
import { openSettings } from './settings.js';
import { idb } from './offline.js';
import { enhance } from './rich.js';
import { Spell, GROUPS } from './spell.js';
import { splitFront, mountProps } from './props.js';
import { printNote, htmlFile, EXPORT_DEFAULTS } from './export.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
hydrateIcons();

// ------------------------------------------------------------------ settings model
export const DEFAULTS = {
  // general
  startup: 'restore', startupNote: '', confirmDelete: true, deleteMode: 'trash',
  // appearance
  theme: 'auto', hue: 218, accentSat: 78, glow: 0.6, grain: 0.22, grainAnim: true,
  // interface
  mode: 'write', tabMode: 'replace', showToolbar: true, showArrows: true, showCrumbs: true,
  showFileIcons: true, sort: 'name', focusReveal: true, readingWpm: 230,
  status: { words: true, chars: true, read: true, width: true, created: true, modified: true },
  // editor
  font: 'sans', customFont: '', fontSize: 17, lineHeight: 1.72, width: 'medium',
  syntaxColors: true, spellcheck: true, smartLists: true, autoPair: false, typewriter: false, indent: 'tab',
  linkSuggest: true, tagSuggest: true, slashMenu: true, tableKeys: true, previewEdit: true,
  // writing checks (Harper)
  spellEngine: 'harper', dialect: 'American',
  spellGroups: { spelling: true, grammar: true, punctuation: true, style: true }, harperRules: {},
  // preview
  richCode: true, richMath: true, richDiagrams: true,
  // files and links
  newNoteLocation: 'current', newNoteFolder: '', newNoteName: 'untitled',
  imageLinks: 'markdown', pasteName: 'timestamp', updateLinks: true,
  dailyFolder: 'Daily', dailyFormat: 'YYYY-MM-DD', dailyTemplate: '', templatesFolder: 'Templates',
  // export
  ...EXPORT_DEFAULTS,
  // sync
  syncMode: 'live', saveDelay: 700, pollInterval: 20, offlineAll: true,
  // hotkeys: { commandId: 'Mod+Shift+F' }, '' means unbound
  hotkeys: {},
};
export const WIDTHS = { narrow: ['36rem', 'Narrow'], medium: ['44rem', 'Medium'], wide: ['58rem', 'Wide'], full: ['100%', 'Full'] };
export const ACCENTS = [[218, 78, 'Polar'], [192, 70, 'Glacier'], [162, 55, 'Aurora'], [262, 65, 'Dusk'], [328, 60, 'Rose'], [28, 80, 'Ember'], [80, 50, 'Lichen'], [0, 0, 'Silver']];
export const SORTS = [['name', 'Name (A to Z)'], ['name-desc', 'Name (Z to A)'], ['modified', 'Edited (newest first)'], ['modified-asc', 'Edited (oldest first)'], ['created', 'Created (newest first)'], ['created-asc', 'Created (oldest first)']];

const store = {
  get(k, d) { try { const v = localStorage.getItem('pb:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pb:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const clone = (o) => JSON.parse(JSON.stringify(o));
function mergeSettings(saved = {}) {
  return {
    ...clone(DEFAULTS), ...saved,
    status: { ...DEFAULTS.status, ...(saved.status || {}) },
    spellGroups: { ...DEFAULTS.spellGroups, ...(saved.spellGroups || {}) },
    harperRules: { ...(saved.harperRules || {}) },
    hotkeys: { ...(saved.hotkeys || {}) },
  };
}

// Everything about the open vault (tabs, folders, unsent edits) is stored per vault.
const VAULT = store.get('vault', 'main');
const vstore = {
  get: (k, d) => store.get(`${VAULT}:${k}`, d),
  set: (k, v) => store.set(`${VAULT}:${k}`, v),
};
// One id per browser tab, so live updates can skip the changes this tab made.
const CLIENT = Math.random().toString(36).slice(2, 12);

const state = {
  vault: VAULT,
  settings: mergeSettings(store.get('settings', {})),
  config: { history: { enabled: true, interval: 10, keep: 50, days: 0 }, trashDays: 30, attachmentFolder: 'attachments' },
  tree: { folders: [], notes: [], folderMeta: {} },
  cur: null, // { path, content, version, created, modified, dirty, conflict }
  panel: store.get('panel', 'files'),
  open: new Set(vstore.get('open', [])),
  folder: '',
  tag: null,
  sync: 'synced',
  lastSync: 0,
  online: true,
  tabs: [],
  active: 0,
};
{
  const saved = vstore.get('tabs', null);
  if (saved?.tabs?.length) {
    state.tabs = saved.tabs.map((path) => ({ path, scroll: 0 }));
    state.active = Math.min(saved.active || 0, state.tabs.length - 1);
  } else {
    state.tabs = [{ path: vstore.get('last', null), scroll: 0 }];
  }
}

const el = {
  app: $('#app'), main: $('#main'), ws: $('#workspace'), ta: $('#ta'), hl: $('#hl'), lints: $('#lints'), editor: $('#editor'),
  title: $('#titleInput'), titleView: $('#titleView'), preview: $('#preview'),
  editPane: $('#editPane'), previewPane: $('#previewPane'), tree: $('#tree'),
  crumbs: $('#crumbs'), layer: $('#layer'),
};
const mobile = matchMedia('(max-width: 760px)');
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// ------------------------------------------------------------------ utils
const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
const stem = (p) => basename(p).replace(/\.md$/i, '');
const join = (a, b) => (a ? `${a}/${b}` : b);
const enc = encodeURIComponent;
const fmtNum = (n) => n.toLocaleString();
const cleanName = (s) => s.replace(/[\\/:*?"<>|#^\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const noteByPath = (p) => state.tree.notes.find((n) => n.path === p);
const folderMeta = (p) => state.tree.folderMeta?.[p] || {};
const pad = (n) => String(n).padStart(2, '0');

function relTime(ms) {
  if (!ms) return '';
  const s = (Date.now() - ms) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 6) return `${Math.round(s / 86400)}d ago`;
  return fmtDate(ms);
}
function fmtDate(ms) {
  const d = new Date(ms);
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}
function fmtDateTime(ms) {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}
function copyText(text, msg = 'Copied') {
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => toast(msg), () => toast('Could not copy', 'err'));
  else toast('Clipboard needs HTTPS or localhost', 'err');
}

async function api(method, url, body) {
  const opt = { method, headers: { 'X-Vault': state.vault, 'X-Polarboard': '1', 'X-Client': CLIENT } };
  if (body !== undefined) {
    if (body instanceof Blob) { opt.body = body; opt.headers['Content-Type'] = body.type || 'application/octet-stream'; }
    else { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  }
  let res;
  try { res = await fetch(url, opt); } catch {
    setOnline(false);
    const err = new Error('You appear to be offline'); err.offline = true; throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.login) { showLanding({ account: data.account }); }
  else setOnline(res.status < 500 || res.status === 501);
  if (!res.ok) { const err = new Error(data.error || res.statusText); err.status = res.status; err.data = data; err.offline = res.status >= 502; throw err; }
  return data;
}

/** Track the connection; when it comes back, send queued edits (unless sync is manual). */
function setOnline(on) {
  if (on === state.online) return;
  state.online = on;
  document.documentElement.classList.toggle('offline', !on);
  if (on && state.settings.syncMode !== 'manual') setTimeout(() => flushPending(), 300);
}

// ------------------------------------------------------------------ settings
function resolvedTheme() {
  const t = state.settings.theme;
  return t === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t;
}

function applySettings() {
  const s = state.settings;
  const r = document.documentElement;
  r.dataset.theme = resolvedTheme();
  r.dataset.font = s.font;
  r.style.setProperty('--hue', s.hue);
  r.style.setProperty('--acc-s', `${s.accentSat}%`);
  r.style.setProperty('--grain', s.grain);
  r.style.setProperty('--glow', s.glow);
  r.style.setProperty('--editor-size', `${s.fontSize}px`);
  r.style.setProperty('--editor-lh', s.lineHeight);
  r.style.setProperty('--measure', WIDTHS[s.width]?.[0] || WIDTHS.medium[0]);
  const custom = String(s.customFont || '').replace(/["';{}<>\\]/g, '').trim();
  if (custom) r.style.setProperty('--editor-font', `"${custom}", var(--font-sans)`);
  else r.style.removeProperty('--editor-font');
  r.classList.toggle('grain-anim', !!s.grainAnim);
  el.ta.spellcheck = s.spellEngine === 'browser';
  el.editor.classList.toggle('plain', !s.syntaxColors);
  el.main.classList.toggle('no-toolbar', !s.showToolbar);
  el.main.classList.toggle('no-arrows', !s.showArrows);
  el.main.classList.toggle('no-crumbs', !s.showCrumbs);
  el.tree.classList.toggle('no-file-icons', !s.showFileIcons);
  const items = { words: '#stWords', chars: '#stChars', read: '#stRead', width: '#stWidth', created: '#stCreated', modified: '#stModified' };
  for (const [k, sel] of Object.entries(items)) $(sel).hidden = !s.status[k];
  $('#stWidth span').textContent = WIDTHS[s.width]?.[1] || '';
  $('#themeBtn').innerHTML = icon(resolvedTheme() === 'dark' ? 'moon' : 'sun');
  $('meta[name="theme-color"]').setAttribute('content', getComputedStyle($('.tabbar')).backgroundColor);
  paintFavicon();
  schedulePoll();
  store.set('settings', s);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys[keys.length - 1]] = value;
}

function setSetting(path, value) {
  setPath(state.settings, path, value);
  applySettings();
  if (path === 'sort') renderTree();
  if (path === 'mode') setMode(value, false);
  if (path === 'readingWpm') updateCounts();
  if (/^(spellEngine|dialect|harperRules)/.test(path)) startSpell();
  if (path.startsWith('spellGroups')) runLint();
  if (/^rich/.test(path) || path === 'previewEdit') renderPreview(true);
  if (path === 'previewEdit') $('#editPreviewBtn').classList.toggle('on', !!value);
  if (path === 'syncMode') { pollKey = ''; schedulePoll(); if (!manual()) flushPending(); else if (state.cur?.dirty) saveLocal(); }
  if (path === 'offlineAll' && value) { lastPrefetch = 0; prefetchNotes(); }
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applySettings);

let cfgTimer = 0;
function setConfig(path, value) {
  setPath(state.config, path, value);
  clearTimeout(cfgTimer);
  cfgTimer = setTimeout(async () => {
    try { state.config = await api('PUT', '/api/config', state.config); refreshTree(); }
    catch (e) { toast(e.message, 'err'); }
  }, 350);
}

/** The browser-tab icon is the snowflake in the current accent colour. */
function paintFavicon() {
  const probe = document.createElement('span');
  probe.style.color = 'var(--accent)';
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  const arm = '<path d="M12 2v20M9.5 3.5 12 6l2.5-2.5M9.5 20.5 12 18l2.5 2.5"/>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">`
    + [0, 60, 120].map((d) => `<g transform="rotate(${d} 12 12)">${arm}</g>`).join('') + '</svg>';
  $('#favicon').href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}

// ------------------------------------------------------------------ pending (offline) store
const pending = {
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
const SYNC_LABEL = { synced: 'Synced', pending: 'Edited', saving: 'Saving…', offline: 'Offline · saved here', conflict: 'Conflict · resolve', error: 'Not saved', local: 'Saved here · sync' };
const SYNC_TITLE = {
  offline: 'The server is unreachable. Changes are kept on this device and sync when it is back.',
  local: 'Manual sync: changes are kept on this device. Click to sync now.',
  conflict: 'This note changed somewhere else. Click to choose a version.',
};
function setSync(s) {
  state.sync = s;
  const b = $('#stSync');
  b.dataset.state = s;
  const waiting = Object.keys(pending.all()).length;
  b.querySelector('span').textContent = s === 'local' && waiting > 1 ? `${waiting} notes saved here · sync` : SYNC_LABEL[s];
  b.title = SYNC_TITLE[s] || 'Sync status. Click to sync now.';
  $('#tabs .tab.active')?.classList.toggle('dirty', s !== 'synced' && !!state.cur);
}

// ------------------------------------------------------------------ saving
let saveTimer = null;
let savingP = null;
let retryTimer = null;

const manual = () => state.settings.syncMode === 'manual';

function scheduleSave(ms = state.settings.saveDelay) {
  clearTimeout(saveTimer);
  if (state.cur?.conflict) return;
  if (manual()) { saveTimer = setTimeout(saveLocal, 250); return; }
  saveTimer = setTimeout(() => save(), ms);
}

/** Keep the open note on this device: the queue of unsent edits plus the offline copy. */
function saveLocal() {
  const cur = state.cur;
  if (!cur || !cur.dirty) return;
  pending.put(cur.path, cur.content, cur.version);
  cacheNote(cur);
  if (state.sync !== 'conflict') setSync(manual() ? 'local' : 'offline');
}

function cacheNote(n) {
  idb.set(`${VAULT}|note|${n.path}`, { content: n.content, version: n.version, modified: n.modified, created: n.created });
}

/** Send everything now: the open note and anything queued on this device. */
async function syncNow() {
  if (state.cur?.dirty && !state.cur.conflict) { clearTimeout(saveTimer); await save(); }
  await flushPending();
  if (!state.cur?.dirty && state.sync !== 'conflict' && state.online) setSync('synced');
}

async function save(force = false) {
  clearTimeout(saveTimer);
  while (savingP) await savingP;
  const cur = state.cur;
  if (!cur || !cur.dirty || (cur.conflict && !force)) return;
  savingP = doSave(cur, force);
  try { await savingP; } finally { savingP = null; }
}

async function doSave(cur, force) {
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

async function flushSave() {
  clearTimeout(saveTimer);
  if (manual()) saveLocal();
  else if (state.cur?.dirty && !state.cur.conflict) await save();
  while (savingP) await savingP;
}

/** Push edits that were kept locally for notes other than the open one. */
let flushing = null;
function flushPending() {
  flushing ||= doFlushPending().finally(() => { flushing = null; });
  return flushing;
}
async function doFlushPending() {
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

async function resolveConflict() {
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

// ------------------------------------------------------------------ tree
async function refreshTree() {
  try {
    state.tree = await api('GET', '/api/tree');
    state.tree.folderMeta ||= {};
    state.lastSync = Date.now();
    idb.set(`${VAULT}|tree`, state.tree);
    if (state.settings.offlineAll) prefetchNotes();
  } catch (e) {
    if (!e.offline) return;
    if (!state.tree.notes.length) {
      const cached = await idb.get(`${VAULT}|tree`);
      if (!cached) return;
      state.tree = cached;
    }
    if (state.cur?.dirty) setSync(manual() ? 'local' : 'offline');
  }
  mergeLocalNotes();
  renderTree();
  renderTags();
  renderRecent();
  if (state.cur) renderNoteTags();
  checkRemoteChange();
}

/** Notes created while offline exist only in the queue until they sync; show them anyway. */
function mergeLocalNotes() {
  for (const path of Object.keys(pending.all())) {
    if (noteByPath(path)) continue;
    state.tree.notes.push({ path, version: null, modified: Date.now(), created: Date.now(), tags: [], ownTags: [], inherited: [], local: true });
    for (let d = dirname(path); d; d = dirname(d)) if (!state.tree.folders.includes(d)) state.tree.folders.push(d);
  }
}

/** Keep an offline copy of every note, fetching only the ones that changed. */
let prefetching = false;
let lastPrefetch = 0;
async function prefetchNotes() {
  if (prefetching || Date.now() - lastPrefetch < 60_000) return;
  prefetching = true;
  lastPrefetch = Date.now();
  try {
    const known = new Set(state.tree.notes.map((n) => `${VAULT}|note|${n.path}`));
    for (const key of await idb.keys(`${VAULT}|note|`)) if (!known.has(key)) idb.del(key);
    let fetched = 0;
    for (const n of state.tree.notes) {
      if (n.local) continue;
      const c = await idb.get(`${VAULT}|note|${n.path}`);
      if (c?.version === n.version) continue;
      cacheNote(await api('GET', `/api/note?path=${enc(n.path)}`));
      if (++fetched >= 300) break;
      await new Promise((r) => setTimeout(r, 25));
    }
  } catch { /* try again next time */ } finally { prefetching = false; }
}

function patchTreeNote(info) {
  const i = state.tree.notes.findIndex((n) => n.path === info.path);
  const old = i >= 0 ? state.tree.notes[i] : null;
  if (old) state.tree.notes[i] = { ...old, ...info };
  else state.tree.notes.push(info);
  if ((old?.tags || []).join('\n') !== (info.tags || []).join('\n')) renderTags();
}

async function checkRemoteChange() {
  const cur = state.cur;
  if (!cur || cur.dirty || savingP || block.active) return;
  const n = noteByPath(cur.path);
  if (!n || n.version === cur.version) return;
  try {
    const fresh = await api('GET', `/api/note?path=${enc(cur.path)}`);
    if (state.cur !== cur || cur.dirty) return;
    Object.assign(cur, { content: fresh.content, version: fresh.version, modified: fresh.modified });
    if (el.ta.value !== fresh.content) setEditorValue(fresh.content, true);
    updateStatus();
  } catch { /* next poll */ }
}

function buildTree() {
  const root = { path: '', folders: new Map(), notes: [] };
  const ensure = (p) => {
    let node = root;
    if (!p) return root;
    let acc = '';
    for (const part of p.split('/')) {
      acc = join(acc, part);
      if (!node.folders.has(part)) node.folders.set(part, { name: part, path: acc, folders: new Map(), notes: [] });
      node = node.folders.get(part);
    }
    return node;
  };
  state.tree.folders.forEach(ensure);
  state.tree.notes.forEach((n) => ensure(dirname(n.path)).notes.push(n));
  return root;
}

const countNotes = (f) => f.notes.length + [...f.folders.values()].reduce((a, c) => a + countNotes(c), 0);
const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const SORTERS = {
  name: (a, b) => byName(stem(a.path), stem(b.path)),
  'name-desc': (a, b) => byName(stem(b.path), stem(a.path)),
  modified: (a, b) => b.modified - a.modified,
  'modified-asc': (a, b) => a.modified - b.modified,
  created: (a, b) => (b.created || 0) - (a.created || 0),
  'created-asc': (a, b) => (a.created || 0) - (b.created || 0),
};

function renderTree() {
  const curPath = state.cur?.path;
  const known = new Set(state.tree.notes.map((n) => n.path));
  const walk = (node, d) => {
    const order = folderMeta(node.path).sort || state.settings.sort;
    const sorter = SORTERS[order] || SORTERS.name;
    const ownNote = node.path ? folderMeta(node.path).note : null;
    let html = '';
    const folders = [...node.folders.values()].sort((a, b) => (order === 'name-desc' ? byName(b.name, a.name) : byName(a.name, b.name)));
    for (const f of folders) {
      const open = state.open.has(f.path);
      const fnote = folderMeta(f.path).note;
      const hasNote = fnote && known.has(fnote);
      html += `<div class="row folder${open ? ' open' : ''}${state.folder === f.path ? ' sel' : ''}${hasNote ? ' has-note' : ''}" data-folder="${esc(f.path)}"${hasNote ? ` data-fnote="${esc(fnote)}"` : ''} style="--d:${d}" draggable="true" role="treeitem" aria-expanded="${open}" title="${countNotes(f)} notes${hasNote ? ' · click opens its note' : ''}">
        ${icon(open ? 'folderOpen' : 'folder')}<span class="name">${esc(f.name)}</span>
        <button class="more" data-more title="More">${icon('more')}</button></div>`;
      if (open) html += walk(f, d + 1);
    }
    const notes = node.notes.filter((n) => n.path !== ownNote).sort((a, b) => (b.pinned - a.pinned) || sorter(a, b));
    for (const n of notes) {
      html += `<div class="row note${n.path === curPath ? ' active' : ''}" data-note="${esc(n.path)}" style="--d:${d}" draggable="true" role="treeitem">
        ${icon('file')}<span class="name">${esc(stem(n.path))}</span>${n.pinned ? icon('pin', 'pin') : ''}<button class="more" data-more title="More">${icon('more')}</button></div>`;
    }
    return html;
  };
  const html = walk(buildTree(), 0);
  el.tree.innerHTML = html || '<div class="tree-empty">No notes yet.<br>Create one with the buttons above.</div>';
  const label = SORTS.find(([v]) => v === state.settings.sort)?.[1] || '';
  $('#sortBtn').title = `Sort: ${label}`;
}

function setOpen(path, open) {
  if (open) state.open.add(path); else state.open.delete(path);
  vstore.set('open', [...state.open]);
}

el.tree.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  if (e.target.closest('[data-more]')) { e.stopPropagation(); return rowMenu(row, e.target.closest('[data-more]')); }
  const newTab = (e.ctrlKey || e.metaKey) !== (state.settings.tabMode === 'new');
  if (row.dataset.note) return openNote(row.dataset.note, { newTab });
  const p = row.dataset.folder;
  const fnote = row.dataset.fnote;
  state.folder = p;
  if (fnote && state.cur?.path !== fnote) {
    setOpen(p, true);
    openNote(fnote, { newTab });
  } else setOpen(p, !state.open.has(p));
  renderTree();
});
el.tree.addEventListener('auxclick', (e) => {
  const row = e.target.closest('.row.note');
  if (row && e.button === 1) { e.preventDefault(); openNote(row.dataset.note, { newTab: true }); }
});
el.tree.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  e.preventDefault();
  rowMenu(row, { x: e.clientX, y: e.clientY });
});

// drag & drop to move
let dragPath = null;
el.tree.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  dragPath = row.dataset.note || row.dataset.folder;
  row.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragPath);
});
el.tree.addEventListener('dragend', () => { dragPath = null; $$('.dragging, .drop', el.tree).forEach((r) => r.classList.remove('dragging', 'drop')); el.tree.classList.remove('drop-root'); });
el.tree.addEventListener('dragover', (e) => {
  if (!dragPath) return;
  e.preventDefault();
  $$('.drop', el.tree).forEach((r) => r.classList.remove('drop'));
  const row = e.target.closest('.row.folder');
  el.tree.classList.toggle('drop-root', !row);
  if (row) row.classList.add('drop');
});
el.tree.addEventListener('drop', async (e) => {
  if (!dragPath) return;
  e.preventDefault();
  const row = e.target.closest('.row.folder');
  const target = row ? row.dataset.folder : '';
  const from = dragPath;
  dragPath = null;
  el.tree.classList.remove('drop-root');
  if (dirname(from) === target || target === from || target.startsWith(from + '/')) return renderTree();
  await moveItem(from, join(target, basename(from)));
  if (target) setOpen(target, true);
});

/** A note made offline only exists in the queue, so renaming it is a local change. */
function moveLocalNote(from, to) {
  const target = to.toLowerCase().endsWith('.md') ? to : `${to}.md`;
  if (noteByPath(target)) { toast('Something with that name is already there', 'err'); return null; }
  pending.move(from, target);
  const n = noteByPath(from);
  if (n) n.path = target;
  for (const t of state.tabs) if (t.path === from) t.path = target;
  if (state.cur?.path === from) { state.cur.path = target; setHash(target, true); showMeta(); }
  persistTabs();
  renderTabs();
  renderTree();
  return target;
}

async function moveItem(from, to) {
  if (state.cur && (state.cur.path === from || state.cur.path.startsWith(from + '/'))) await flushSave();
  if (noteByPath(from)?.local) return moveLocalNote(from, to);
  const isNote = from.toLowerCase().endsWith('.md');
  try {
    const r = await api('POST', '/api/move', { from, to, relink: isNote && state.settings.updateLinks });
    pending.move(from, r.path);
    for (const t of state.tabs) {
      if (t.path === from) t.path = r.path;
      else if (t.path?.startsWith(from + '/')) t.path = r.path + t.path.slice(from.length);
    }
    persistTabs();
    renderTabs();
    if (state.cur) {
      if (state.cur.path === from) state.cur.path = r.path;
      else if (state.cur.path.startsWith(from + '/')) state.cur.path = r.path + state.cur.path.slice(from.length);
      setHash(state.cur.path, true);
      showMeta();
    }
    if (state.open.has(from)) { setOpen(from, false); setOpen(r.path, true); }
    if (state.folder === from) state.folder = r.path;
    if (r.relinked) toast(`Updated links in ${r.relinked} note${r.relinked === 1 ? '' : 's'}`);
    await refreshTree();
    return r.path;
  } catch (e) {
    toast(e.status === 409 ? 'Something with that name is already there' : e.message, 'err');
    return null;
  }
}

async function setMeta(path, set) {
  try {
    await api('POST', '/api/meta', { path, set });
    await refreshTree();
  } catch (e) { toast(e.message, 'err'); }
}

// ------------------------------------------------------------------ context menus
function rowMenu(row, anchor) {
  if (row.dataset.note) noteMenu(row.dataset.note, anchor);
  else folderMenu(row.dataset.folder, anchor);
}

function noteMenu(path, anchor) {
  const n = noteByPath(path) || {};
  const folder = dirname(path);
  const isFolderNote = folder && folderMeta(folder).note === path;
  menu(anchor, [
    { icon: 'plus', label: 'Open in new tab', run: () => openNote(path, { newTab: true }) },
    '-',
    { icon: 'edit', label: 'Rename', run: () => renameNote(path) },
    { icon: 'move', label: 'Move to…', run: () => moveNoteDialog(path) },
    { icon: 'copy', label: 'Duplicate', run: () => duplicateNote(path) },
    '-',
    { icon: 'tag', label: 'Tags…', run: () => tagsDialog(path) },
    { icon: 'pin', label: n.pinned ? 'Unpin' : 'Pin to top', run: () => setMeta(path, { pinned: !n.pinned }) },
    isFolderNote
      ? { icon: 'folder', label: `Detach from “${basename(folder)}”`, run: () => setMeta(folder, { note: null }) }
      : { icon: 'folder', label: 'Attach to folder…', run: () => attachToFolder(path) },
    '-',
    { icon: 'link', label: 'Copy link', run: () => copyText(`[[${stem(path)}]]`, 'Link copied') },
    { icon: 'file', label: 'Copy path', run: () => copyText(path, 'Path copied') },
    { icon: 'history', label: 'Version history', run: () => openHistory(path) },
    { icon: 'share', label: 'Share link…', run: () => shareDialog(path) },
    { icon: 'download', label: 'Export…', run: () => exportDialog(path) },
    '-',
    { icon: 'trash', label: 'Delete', danger: true, run: () => deleteNote(path) },
  ]);
}

function folderMenu(path, anchor) {
  const meta = folderMeta(path);
  const hasNote = meta.note && noteByPath(meta.note);
  menu(anchor, [
    { icon: 'filePlus', label: 'New note here', run: () => newNote(path) },
    { icon: 'folderPlus', label: 'New folder here', run: () => newFolder(path) },
    '-',
    { icon: 'sort', label: 'Sort this folder…', run: () => sortMenu(path, anchor) },
    ...(hasNote
      ? [{ icon: 'file', label: 'Open folder note', run: () => openNote(meta.note) },
         { icon: 'x', label: 'Detach folder note', run: () => setMeta(path, { note: null }) }]
      : [{ icon: 'paperclip', label: 'Attach a note…', run: () => attachNoteDialog(path) }]),
    { icon: 'tag', label: 'Tags for every note in here…', run: () => tagsDialog(path, true) },
    '-',
    { icon: 'edit', label: 'Rename', run: () => renameFolder(path) },
    { icon: 'trash', label: 'Delete folder', danger: true, run: () => deleteFolder(path) },
  ]);
}

function sortMenu(path, anchor) {
  const cur = folderMeta(path).sort;
  menu(anchor, [
    { header: `Sort “${basename(path)}”` },
    ...SORTS.map(([v, l]) => ({ icon: cur === v ? 'check' : 'blank', label: l, run: () => setMeta(path, { sort: v }) })),
    '-',
    { icon: !cur ? 'check' : 'blank', label: 'Use the default order', run: () => setMeta(path, { sort: null }) },
  ]);
}

// ------------------------------------------------------------------ note actions
function defaultFolder() {
  const s = state.settings;
  if (s.newNoteLocation === 'root') return '';
  if (s.newNoteLocation === 'folder') return state.tree.folders.includes(s.newNoteFolder) ? s.newNoteFolder : '';
  return state.folder;
}
function defaultName() {
  const d = new Date();
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (state.settings.newNoteName === 'date') return date;
  if (state.settings.newNoteName === 'datetime') return `${date} ${pad(d.getHours())}${pad(d.getMinutes())}`;
  return 'Untitled';
}

async function newNote(folder = defaultFolder(), name = defaultName(), { editTitle = true, content: raw = '', newTab = false } = {}) {
  await flushSave();
  const cursor = raw.indexOf('\u0001'); // where a template asked for the cursor
  const content = raw.replace('\u0001', '');
  let path;
  try {
    const r = await api('POST', '/api/note', { folder, name, content });
    state.tree.notes.push(r);
    path = r.path;
  } catch (e) {
    if (!e.offline) { toast(e.message, 'err'); return null; }
    // Offline: create it on this device; the queued save creates it on the server later.
    const base = join(folder, cleanName(name) || 'Untitled');
    path = `${base}.md`;
    for (let n = 2; noteByPath(path); n++) path = `${base} ${n}.md`;
    pending.put(path, content, null);
    mergeLocalNotes();
    toast('Created on this device. It syncs when the server is back.');
  }
  if (folder) setOpen(folder, true);
  await openNote(path, { newTab });
  refreshTree();
  if (cursor >= 0) {
    el.ta.focus();
    el.ta.setSelectionRange(cursor, cursor);
    requestAnimationFrame(keepCaretVisible);
  } else if (editTitle) { el.title.focus(); el.title.select(); } else el.ta.focus();
  return path;
}

async function newFolder(parent = state.folder) {
  const name = await dialog({ title: 'New folder', input: { placeholder: 'Folder name' }, buttons: [{ label: 'Cancel' }, { label: 'Create', primary: true, value: true }] });
  if (!name || !cleanName(name)) return;
  try {
    const r = await api('POST', '/api/folder', { path: join(parent, cleanName(name)) });
    if (parent) setOpen(parent, true);
    setOpen(r.path, true);
    state.folder = r.path;
    await refreshTree();
  } catch (e) { toast(e.message, 'err'); }
}

async function renameNote(path) {
  if (state.cur?.path === path) { el.title.focus(); el.title.select(); return; }
  const name = await dialog({ title: 'Rename note', input: { value: stem(path) }, buttons: [{ label: 'Cancel' }, { label: 'Rename', primary: true, value: true }] });
  if (name && cleanName(name) && cleanName(name) !== stem(path)) await moveItem(path, join(dirname(path), cleanName(name) + '.md'));
}

async function renameFolder(path) {
  const name = await dialog({ title: 'Rename folder', input: { value: basename(path) }, buttons: [{ label: 'Cancel' }, { label: 'Rename', primary: true, value: true }] });
  if (name && cleanName(name) && cleanName(name) !== basename(path)) await moveItem(path, join(dirname(path), cleanName(name)));
}

async function pickFolder(title, exclude = null) {
  const folders = ['', ...state.tree.folders].filter((f) => f !== exclude);
  const target = await dialog({
    title,
    pick: folders.map((f) => ({ label: f || 'Vault root', value: f, icon: 'folder' })),
    buttons: [{ label: 'Cancel' }],
  });
  return target == null || target === true ? null : target;
}

async function moveNoteDialog(path) {
  const target = await pickFolder(`Move “${stem(path)}”`, dirname(path));
  if (target == null) return;
  await moveItem(path, join(target, basename(path)));
  if (target) { setOpen(target, true); renderTree(); }
}

async function duplicateNote(path) {
  if (state.cur?.path === path) await flushSave();
  try {
    const r = await api('POST', '/api/duplicate', { path });
    await refreshTree();
    openNote(r.path);
  } catch (e) { toast(e.message, 'err'); }
}

/** Make a note the page that opens when its folder is clicked. */
async function attachToFolder(path) {
  const folders = state.tree.folders;
  if (!folders.length) return toast('Create a folder first');
  const folder = await dialog({
    title: `Attach “${stem(path)}” to a folder`,
    text: 'Clicking the folder will open this note. It moves into that folder if it is not there already.',
    pick: folders.map((f) => ({ label: f, value: f, icon: 'folder' })),
    buttons: [{ label: 'Cancel' }],
  });
  if (folder == null || folder === true) return;
  let p = path;
  if (dirname(path) !== folder) p = await moveItem(path, join(folder, basename(path)));
  if (p) { setOpen(folder, true); await setMeta(folder, { note: p }); toast(`Attached to “${basename(folder)}”`); }
}

async function attachNoteDialog(folder) {
  const inside = state.tree.notes.filter((n) => n.path.startsWith(folder + '/'));
  const choice = await dialog({
    title: `Attach a note to “${basename(folder)}”`,
    text: 'Clicking the folder will open the note you pick.',
    pick: [{ label: `New note called “${basename(folder)}”`, value: '\u0000new', icon: 'filePlus' },
      ...inside.map((n) => ({ label: n.path.slice(folder.length + 1).replace(/\.md$/i, ''), value: n.path, icon: 'file' }))],
    buttons: [{ label: 'Cancel' }],
  });
  if (choice == null || choice === true) return;
  let p = choice;
  if (choice === '\u0000new') {
    const r = await api('POST', '/api/note', { folder, name: basename(folder) }).catch((e) => { toast(e.message, 'err'); return null; });
    if (!r) return;
    p = r.path;
  }
  setOpen(folder, true);
  await setMeta(folder, { note: p });
  openNote(p);
}

/** Tags stored by Polarboard (not in the note text). Folder tags apply to every note inside. */
async function tagsDialog(path, isFolder = false) {
  const n = isFolder ? null : noteByPath(path);
  const own = [...(isFolder ? folderMeta(path).tags || [] : n?.ownTags || [])];
  const inherited = isFolder
    ? path.split('/').slice(0, -1).flatMap((_, i, parts) => {
      const f = parts.slice(0, i + 1).join('/');
      return (folderMeta(f).tags || []).map((tag) => ({ tag, folder: f }));
    })
    : n?.inherited || [];
  const all = [...new Set(state.tree.notes.flatMap((x) => x.tags || []))].sort(byName);
  const box = document.createElement('div');
  const paint = () => {
    box.innerHTML = `
      <div class="note-tags" style="margin:0 0 10px">${own.map((t, i) => `<span class="ntag own">#${esc(t)}<button data-rm="${i}" title="Remove">${icon('x')}</button></span>`).join('') || '<span class="ntag">No tags yet</span>'}</div>
      <input class="txt" list="tagSuggest" placeholder="Add a tag and press Enter" style="width:100%" spellcheck="false">
      <datalist id="tagSuggest">${all.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
      ${inherited.length ? `<p style="margin:14px 0 6px">Inherited from folders</p><div class="note-tags" style="margin:0">${inherited.map((x) => `<span class="ntag" title="From ${esc(x.folder)}">${icon('folder')}#${esc(x.tag)}</span>`).join('')}</div>` : ''}`;
    const input = box.querySelector('input');
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ',') return;
      e.preventDefault();
      e.stopPropagation();
      const t = input.value.trim().replace(/^#/, '').replace(/\s+/g, '-');
      if (t && !own.some((o) => o.toLowerCase() === t.toLowerCase())) own.push(t);
      paint();
      box.querySelector('input').focus();
    });
  };
  box.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { own.splice(+rm.dataset.rm, 1); paint(); }
  });
  paint();
  setTimeout(() => box.querySelector('input')?.focus(), 30);
  const ok = await dialog({
    title: isFolder ? `Tags for everything in “${basename(path)}”` : `Tags for “${stem(path)}”`,
    text: isFolder
      ? 'Every note in this folder gets these tags, including notes you add later. They are stored by Polarboard, so your files stay unchanged.'
      : 'These tags are stored by Polarboard alongside the note, so the text stays as you wrote it. Hashtags typed in the note still count too.',
    content: box,
    buttons: [{ label: 'Cancel' }, { label: 'Save', primary: true, value: true }],
  });
  if (!ok) return;
  const pendingText = box.querySelector('input')?.value.trim().replace(/^#/, '');
  if (pendingText && !own.includes(pendingText)) own.push(pendingText);
  await setMeta(path, { tags: own });
}

async function deleteNote(path) {
  const permanent = state.settings.deleteMode === 'permanent';
  if (state.settings.confirmDelete) {
    const ok = await dialog({
      title: `Delete “${stem(path)}”?`,
      text: permanent ? 'This deletes the note and its version history for good.' : 'It moves to the trash. You can restore it from Settings → Sync.',
      buttons: [{ label: 'Cancel' }, { label: 'Delete', danger: true, value: true }],
    });
    if (!ok) return;
  }
  try {
    await api('DELETE', `/api/note?path=${enc(path)}${permanent ? '&permanent=1' : ''}`);
    if (state.cur?.path === path) { clearTimeout(saveTimer); state.cur = null; }
    pending.drop(path);
    forgetTabs((p) => p === path);
    if (!state.cur) showEmpty();
    await refreshTree();
  } catch (e) { toast(e.message, 'err'); }
}

async function deleteFolder(path) {
  const permanent = state.settings.deleteMode === 'permanent';
  const n = state.tree.notes.filter((x) => x.path.startsWith(path + '/')).length;
  if (state.settings.confirmDelete || n) {
    const what = n ? `The folder and its ${n} note${n === 1 ? '' : 's'}` : 'The folder';
    const ok = await dialog({
      title: `Delete “${basename(path)}”?`,
      text: permanent ? `${what} will be deleted for good.` : `${what} move to the trash, where you can restore them.`,
      buttons: [{ label: 'Cancel' }, { label: 'Delete', danger: true, value: true }],
    });
    if (!ok) return;
  }
  try {
    await api('DELETE', `/api/folder?path=${enc(path)}${permanent ? '&permanent=1' : ''}`);
    if (state.cur?.path.startsWith(path + '/')) { clearTimeout(saveTimer); state.cur = null; }
    forgetTabs((p) => p.startsWith(path + '/'));
    if (!state.cur) showEmpty();
    if (state.folder === path || state.folder.startsWith(path + '/')) state.folder = '';
    await refreshTree();
  } catch (e) { toast(e.message, 'err'); }
}

async function download(path) {
  let content = state.cur?.path === path ? state.cur.content : null;
  if (content == null) {
    try { content = (await api('GET', `/api/note?path=${enc(path)}`)).content; } catch (e) { return toast(e.message, 'err'); }
  }
  saveFile(basename(path), new Blob([content], { type: 'text/markdown' }));
}

function saveFile(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function findNote(name) {
  const n = name.toLowerCase().replace(/\.md$/, '');
  return state.tree.notes.find((x) => x.path.toLowerCase() === n + '.md')
    || state.tree.notes.find((x) => stem(x.path).toLowerCase() === n.split('/').pop());
}

// ------------------------------------------------------------------ version history
async function openHistory(path = state.cur?.path) {
  if (!path) return;
  if (state.cur?.path === path) await flushSave();
  let versions;
  try { versions = (await api('GET', `/api/history?path=${enc(path)}`)).versions; }
  catch (e) { return toast(e.message, 'err'); }
  const box = document.createElement('div');
  box.className = 'history';
  const h = state.config.history;
  box.innerHTML = `
    <header class="history-head">
      <h3>${icon('history')} History · ${esc(stem(path))}</h3>
      <button class="btn sm" data-act="copy" disabled>Copy text</button>
      <button class="btn sm primary" data-act="restore" disabled>Restore this version</button>
      <button class="icon-btn sm" data-act="close" title="Close">${icon('x')}</button>
    </header>
    <nav class="history-list">${versions.length
      ? versions.map((v) => `<button data-id="${v.id}"><b>${fmtDateTime(v.time)}</b><small>${relTime(v.time)} · ${fmtBytes(v.size)}</small></button>`).join('')
      : `<div class="history-empty">No earlier versions yet.</div>`}</nav>
    <div class="history-view scroll"><div class="history-empty">${versions.length ? 'Pick a version on the left.'
      : h.enabled ? `Earlier versions are saved while you edit, at most once every ${h.interval} minute${h.interval === 1 ? '' : 's'}.` : 'Version history is turned off in Settings → Sync.'}</div></div>`;
  let selected = null;
  let text = '';
  const view = box.querySelector('.history-view');
  const pick = async (id) => {
    selected = id;
    $$('[data-id]', box).forEach((b) => b.classList.toggle('active', b.dataset.id === id));
    try { text = (await api('GET', `/api/history/version?path=${enc(path)}&id=${id}`)).content; }
    catch (e) { return toast(e.message, 'err'); }
    if (selected !== id) return;
    view.innerHTML = `<article class="md">${render(text, previewOpts)}</article>`;
    enhance(view, richOpts());
    view.scrollTop = 0;
    $$('[data-act="copy"], [data-act="restore"]', box).forEach((b) => { b.disabled = false; });
  };
  box.addEventListener('click', async (e) => {
    const v = e.target.closest('[data-id]');
    if (v) return pick(v.dataset.id);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') closeLayer();
    if (act === 'copy') copyText(text);
    if (act === 'restore' && selected) {
      try {
        const r = await api('POST', '/api/history/restore', { path, id: selected });
        closeLayer();
        if (state.cur?.path === path) {
          Object.assign(state.cur, { content: text, version: r.version, modified: r.modified, dirty: false });
          setEditorValue(text);
        }
        patchTreeNote(r);
        toast('Version restored. The one it replaced is in history too.');
      } catch (err) { toast(err.message, 'err'); }
    }
  });
  dialog({ content: box, cls: 'history-dialog' });
  if (versions.length) pick(versions[0].id);
}

// ------------------------------------------------------------------ opening & tabs
/**
 * Open a note the way Obsidian does: reuse its tab if it is already open,
 * otherwise show it in the current tab (or a new one with newTab).
 */
async function openNote(path, { fromHash = false, newTab = false } = {}) {
  const existing = state.tabs.findIndex((t) => t.path === path);
  if (existing >= 0 && existing !== state.active) return switchTab(existing, { history: fromHash ? 'none' : 'push' });
  if (state.cur?.path === path) { if (mobile.matches) closeDrawer(); return; }
  if (newTab && state.tabs[state.active].path) {
    rememberScroll();
    await flushSave();
    state.tabs.splice(state.active + 1, 0, { path: null, scroll: 0 });
    state.active++;
  }
  await loadNote(path, { history: fromHash ? 'none' : 'push' });
}

/** Load a note into the active tab. */
async function loadNote(path, { history: hist = 'push', scroll = 0, pscroll = 0 } = {}) {
  await flushSave();
  let note;
  try {
    note = await api('GET', `/api/note?path=${enc(path)}`);
    cacheNote(note);
  } catch (e) {
    const local = pending.all()[path];
    const cached = e.offline ? await idb.get(`${VAULT}|note|${path}`) : null;
    if (!local && !cached) {
      toast(e.status === 404 ? 'That note no longer exists' : e.offline ? 'That note isn’t saved on this device yet' : e.message, 'err');
      if (e.status === 404) refreshTree();
      if (!state.cur) showEmpty();
      return false;
    }
    note = { path, content: cached?.content ?? '', version: local?.base ?? cached?.version ?? null, modified: cached?.modified, created: cached?.created };
  }
  const local = pending.all()[path];
  const isNew = !!local && local.base == null && !note.version; // created offline, not on the server yet
  const dirty = !!local && (isNew || local.content !== note.content);
  state.cur = { ...note, content: local && dirty ? local.content : note.content, dirty, conflict: null };
  if (!dirty && local) pending.drop(path);
  state.tabs[state.active].path = path;
  state.folder = dirname(path);
  for (let d = dirname(path); d; d = dirname(d)) state.open.add(d);
  vstore.set('open', [...state.open]);
  vstore.set('last', path);
  if (hist !== 'none') setHash(path, hist === 'replace');
  showNote();
  el.editPane.scrollTop = scroll;
  el.previewPane.scrollTop = pscroll;
  persistTabs();
  renderTabs();
  if (dirty) { setSync('pending'); scheduleSave(200); } else setSync('synced');
  if (mobile.matches) closeDrawer();
  return true;
}

function persistTabs() { vstore.set('tabs', { tabs: state.tabs.map((t) => t.path), active: state.active }); }

function rememberScroll() {
  const t = state.tabs[state.active];
  if (t && state.cur) { t.scroll = el.editPane.scrollTop; t.pscroll = el.previewPane.scrollTop; }
}

function renderTabs() {
  const box = $('#tabs');
  box.innerHTML = state.tabs.map((t, i) => {
    const label = t.path ? stem(t.path) : 'New tab';
    const dirty = i === state.active && state.cur?.dirty ? ' dirty' : '';
    return `<div class="tab${i === state.active ? ' active' : ''}${dirty}" data-i="${i}" role="tab" aria-selected="${i === state.active}" title="${esc(t.path || 'New tab')}">
      <span class="label">${esc(label)}</span><button class="close" data-close title="Close tab" aria-label="Close tab">${icon('x')}</button></div>`;
  }).join('');
  box.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

async function switchTab(i, { history: hist = 'replace' } = {}) {
  if (i < 0 || i >= state.tabs.length) return;
  if (i === state.active && state.tabs[i].path === (state.cur?.path ?? null)) return;
  rememberScroll();
  await flushSave();
  state.active = i;
  const t = state.tabs[i];
  if (t.path) {
    state.cur = null;
    if (!(await loadNote(t.path, { history: hist, scroll: t.scroll, pscroll: t.pscroll }))) { t.path = null; showEmpty(); }
  } else showEmpty();
  persistTabs();
  renderTabs();
}

async function newTab() {
  rememberScroll();
  await flushSave();
  state.tabs.splice(state.active + 1, 0, { path: null, scroll: 0 });
  state.active++;
  showEmpty();
}

async function closeTab(i) {
  const wasActive = i === state.active;
  if (wasActive) { rememberScroll(); await flushSave(); }
  state.tabs.splice(i, 1);
  if (!state.tabs.length) state.tabs.push({ path: null, scroll: 0 });
  if (wasActive) {
    state.active = Math.min(i, state.tabs.length - 1);
    state.cur = null;
    const t = state.tabs[state.active];
    if (!t.path || !(await loadNote(t.path, { history: 'replace', scroll: t.scroll, pscroll: t.pscroll }))) showEmpty();
  } else if (i < state.active) state.active--;
  persistTabs();
  renderTabs();
}

/** Drop tabs whose note is gone; the active one becomes an empty tab. */
function forgetTabs(match) {
  const activeTab = state.tabs[state.active];
  state.tabs = state.tabs.filter((t) => t === activeTab || !(t.path && match(t.path)));
  state.active = state.tabs.indexOf(activeTab);
  if (activeTab.path && match(activeTab.path)) activeTab.path = null;
  persistTabs();
  renderTabs();
}

$('#tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  if (e.target.closest('[data-close]')) closeTab(+tab.dataset.i);
  else switchTab(+tab.dataset.i);
});
$('#tabs').addEventListener('auxclick', (e) => {
  const tab = e.target.closest('.tab');
  if (tab && e.button === 1) { e.preventDefault(); closeTab(+tab.dataset.i); }
});
$('#tabs').addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
$('#tabbar').addEventListener('dblclick', (e) => { if (!e.target.closest('.tab, button')) newTab(); });
$('#newTabBtn').addEventListener('click', newTab);
$('#backBtn').addEventListener('click', () => history.back());
$('#fwdBtn').addEventListener('click', () => history.forward());

function setHash(path, replaceState = false) {
  const h = '#/' + path.split('/').map(enc).join('/');
  if (location.hash === h) return;
  if (replaceState) history.replaceState(null, '', h); else history.pushState(null, '', h);
}

function pathFromHash() {
  if (!location.hash.startsWith('#/')) return null;
  try { return location.hash.slice(2).split('/').map(decodeURIComponent).join('/'); } catch { return null; }
}
window.addEventListener('popstate', () => {
  const p = pathFromHash();
  if (p) openNote(p, { fromHash: true });
});

function showNote() {
  el.main.classList.remove('no-note');
  setEditorValue(state.cur.content);
  showMeta();
  el.editPane.scrollTop = 0;
  el.previewPane.scrollTop = 0;
  renderTree();
  if (state.panel === 'search') markActiveHit();
  renderBacklinks();
}

function showMeta() {
  const cur = state.cur;
  el.title.value = stem(cur.path);
  el.titleView.textContent = stem(cur.path);
  document.title = `${stem(cur.path)} · Polarboard`;
  const parts = dirname(cur.path).split('/').filter(Boolean);
  el.crumbs.innerHTML = parts.map((p, i) => `<button data-crumb="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</button><span class="sep">/</span>`).join('')
    + `<span class="here">${esc(stem(cur.path))}</span>`;
  renderNoteTags();
  updateStatus();
}

/** Chips under the title for tags Polarboard stores (the note's own and its folders'). */
function renderNoteTags() {
  const n = state.cur && noteByPath(state.cur.path);
  const own = n?.ownTags || [];
  const inh = n?.inherited || [];
  const chips = (edit) => own.map((t) => `<span class="ntag own" data-tag="${esc(t.toLowerCase())}">#${esc(t)}${edit ? `<button data-untag="${esc(t)}" title="Remove">${icon('x')}</button>` : ''}</span>`).join('')
    + inh.map((x) => `<span class="ntag" data-tag="${esc(x.tag.toLowerCase())}" title="From folder ${esc(x.folder)}">${icon('folder')}#${esc(x.tag)}</span>`).join('')
    + (edit && (own.length || inh.length) ? `<button class="ntag add" data-addtag title="Edit tags">${icon('plus')}</button>` : '');
  $('#noteTags').innerHTML = chips(true);
  $('#noteTagsView').innerHTML = chips(false);
}
for (const id of ['#noteTags', '#noteTagsView']) {
  $(id).addEventListener('click', (e) => {
    const rm = e.target.closest('[data-untag]');
    if (rm && state.cur) {
      const n = noteByPath(state.cur.path);
      return setMeta(state.cur.path, { tags: (n?.ownTags || []).filter((t) => t !== rm.dataset.untag) });
    }
    if (e.target.closest('[data-addtag]') && state.cur) return tagsDialog(state.cur.path);
    const chip = e.target.closest('[data-tag]');
    if (chip) { state.tag = chip.dataset.tag; showPanel('tags', true); renderTags(); }
  });
}

function showEmpty() {
  state.cur = null;
  el.main.classList.add('no-note');
  el.crumbs.innerHTML = '';
  document.title = 'Polarboard';
  history.replaceState(null, '', location.pathname);
  if (state.tabs[state.active]) state.tabs[state.active].path = null;
  setSync('synced');
  persistTabs();
  renderTabs();
  renderTree();
  renderRecent();
}

el.crumbs.addEventListener('click', (e) => {
  const b = e.target.closest('[data-crumb]');
  if (!b) return;
  const p = b.dataset.crumb;
  for (let d = p; d; d = dirname(d)) setOpen(d, true);
  state.folder = p;
  showPanel('files', true);
  renderTree();
});

function renderRecent() {
  const recent = [...state.tree.notes].sort((a, b) => b.modified - a.modified).slice(0, 5);
  $('#recent').innerHTML = recent.length
    ? `<div class="list-label">Recent</div>` + recent.map((n) => `<button class="hit" data-open="${esc(n.path)}"><b>${esc(stem(n.path))}<span>${relTime(n.modified)}</span></b></button>`).join('')
    : '';
}
$('#recent').addEventListener('click', (e) => { const b = e.target.closest('[data-open]'); if (b) openNote(b.dataset.open); });

// ------------------------------------------------------------------ editor
/**
 * Put a note's text in the editor. Front matter (properties) is kept apart in
 * state.cur.front and shown in the properties panel; the editor holds the rest.
 */
function setEditorValue(text, keepSelection = false) {
  const { selectionStart: s, selectionEnd: e } = el.ta;
  const { front, body } = splitFront(text);
  if (state.cur) state.cur.front = front;
  text = body;
  el.ta.value = text;
  paintProps();
  if (keepSelection) el.ta.setSelectionRange(Math.min(s, text.length), Math.min(e, text.length));
  renderHL();
  renderPreview(true);
  updateStatus();
  prevText = text;
  if (!keepSelection) clearLints();
  scheduleLint(keepSelection ? 300 : 120);
  renderOutline();
}

let hlFrame = 0;
function renderHL() {
  cancelAnimationFrame(hlFrame);
  hlFrame = requestAnimationFrame(() => { el.hl.innerHTML = highlight(el.ta.value); });
}

const vaultUrl = (rel) => `/vault/${enc(VAULT)}/${rel.split('/').map(enc).join('/')}`;
const tryDecode = (s) => { try { return decodeURI(s); } catch { return s; } };
const previewOpts = {
  image: (src) => (/^(https?:|data:|blob:)/i.test(src) ? src : vaultUrl(resolveFile(src))),
  embed: (name) => (/^https?:/i.test(name) ? name : vaultUrl(resolveEmbed(name))),
  exists: (name) => !!findNote(name),
  get math() { return state.settings.richMath; },
  get diagrams() { return state.settings.richDiagrams; },
};
const richOpts = () => ({ code: state.settings.richCode, math: state.settings.richMath, diagrams: state.settings.richDiagrams });

let previewTimer = 0;
function renderPreview(now = false) {
  const mode = el.ws.dataset.mode;
  if (mode === 'write' || !state.cur) return;
  clearTimeout(previewTimer);
  if (block.active) return; // don't rebuild under a block that is being edited
  const go = () => {
    el.preview.innerHTML = render(el.ta.value, { ...previewOpts, lines: true });
    el.preview.classList.toggle('editable', previewEditable());
    expandEmbeds(el.preview).then(() => enhance(el.preview, richOpts()));
  };
  if (now) go(); else previewTimer = setTimeout(go, mode === 'split' ? 250 : 120);
}

function onInput() {
  const cur = state.cur;
  if (!cur) return;
  cur.content = (cur.front || '') + el.ta.value;
  cur.dirty = true;
  if (state.sync !== 'conflict') setSync(state.sync === 'offline' ? 'offline' : manual() ? 'local' : 'pending');
  renderHL();
  renderPreview();
  updateCounts();
  scheduleSave();
  shiftLints(el.ta.value);
  scheduleLint();
  outlineSoon();
  checkSuggest();
  requestAnimationFrame(keepCaretVisible);
}
el.ta.addEventListener('input', onInput);

function keepCaretVisible() {
  if (document.activeElement !== el.ta) return;
  const rect = caretRect(el.hl, el.ta.selectionEnd);
  if (!rect) return;
  const pane = el.editPane.getBoundingClientRect();
  if (state.settings.typewriter) {
    // Keep the line being written a little above the middle of the page.
    el.editPane.scrollTop += rect.top - (pane.top + pane.height * 0.42);
    return;
  }
  const pad = 90;
  if (rect.bottom > pane.bottom - pad) el.editPane.scrollTop += rect.bottom - pane.bottom + pad;
  else if (rect.top < pane.top + 30) el.editPane.scrollTop -= pane.top + 30 - rect.top;
}

const INDENTS = { tab: '\t', 2: '  ', 4: '    ' };
el.ta.addEventListener('keydown', (e) => {
  const s = state.settings;
  if (suggestKey(e)) return;
  if (handleKey(el.ta, e, { indent: INDENTS[s.indent] || '\t', smartLists: s.smartLists, autoPair: s.autoPair, tables: s.tableKeys })) return;
  if (e.key.startsWith('Arrow') || e.key === 'PageDown' || e.key === 'PageUp' || e.key === 'Enter') requestAnimationFrame(keepCaretVisible);
});
el.ta.addEventListener('click', () => { closeSuggest(); if (state.settings.typewriter) requestAnimationFrame(keepCaretVisible); });
el.ta.addEventListener('blur', () => setTimeout(closeSuggest, 120));
el.ta.addEventListener('scroll', () => { if (el.ta.scrollTop) el.ta.scrollTop = 0; });
el.ta.addEventListener('select', updateCounts);
document.addEventListener('selectionchange', () => { if (document.activeElement === el.ta) updateCounts(); });

// ------------------------------------------------------------------ focus mode
// Hides everything but the page. Pointing at the top or bottom edge brings
// the controls that live there back until the pointer leaves.
function setFocus(on) {
  el.app.classList.toggle('focus', on);
  el.app.classList.remove('reveal-top', 'reveal-bottom');
  const b = $('#focusBtn');
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', on);
  b.title = on ? 'Leave focus mode (Esc)' : `Focus mode (${comboLabel(keyFor('focusMode'))})`;
  b.innerHTML = icon(on ? 'unfocus' : 'focus');
  if (on) closeDrawer();
  if (on && state.cur && el.ws.dataset.mode !== 'read') requestAnimationFrame(() => el.ta.focus({ preventScroll: true }));
}
$('#focusBtn').addEventListener('click', () => setFocus(!el.app.classList.contains('focus')));

let revealTimer = 0;
function revealFor(x, y, touch) {
  if (!el.app.classList.contains('focus') || !state.settings.focusReveal) return;
  const topEdge = el.main.getBoundingClientRect().top + 44 + 10;
  const bottoms = [$('.statusbar')];
  if (mobile.matches) bottoms.push($('#toolbar'));
  const bottomEdge = Math.min(...bottoms.map((n) => n.getBoundingClientRect().top)) - 10;
  const keepOpen = !!el.layer.firstChild; // a menu opened from the bar
  el.app.classList.toggle('reveal-top', y <= topEdge || keepOpen);
  el.app.classList.toggle('reveal-bottom', y >= bottomEdge);
  clearTimeout(revealTimer);
  if (touch) revealTimer = setTimeout(() => el.app.classList.remove('reveal-top', 'reveal-bottom'), 3500);
}
window.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') revealFor(e.clientX, e.clientY, false); }, { passive: true });
window.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') revealFor(e.clientX, e.clientY, true); }, { passive: true });
document.documentElement.addEventListener('mouseleave', () => el.app.classList.remove('reveal-top', 'reveal-bottom'));

// toolbar
$('#toolbar').addEventListener('mousedown', (e) => e.preventDefault()); // keep the textarea focused
$('#toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cmd]');
  if (!b || !state.cur) return;
  if (b.dataset.cmd === 'image') return $('#fileInput').click();
  commands[b.dataset.cmd](el.ta);
});

// title: renames the file
el.title.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); el.ta.focus(); el.ta.setSelectionRange(0, 0); }
  if (e.key === 'Escape') { e.preventDefault(); el.title.value = stem(state.cur.path); el.ta.focus(); }
});
el.title.addEventListener('blur', commitTitle);
async function commitTitle() {
  const cur = state.cur;
  if (!cur) return;
  const name = cleanName(el.title.value);
  if (!name) { el.title.value = stem(cur.path); return; }
  if (name === stem(cur.path)) { el.title.value = name; return; }
  const moved = await moveItem(cur.path, join(dirname(cur.path), name + '.md'));
  if (!moved) el.title.value = stem(cur.path);
}

// preview interactions
el.preview.addEventListener('click', (e) => {
  const box = e.target.closest('input[type="checkbox"][data-line]');
  if (box && state.cur) {
    const lines = el.ta.value.split('\n');
    const n = +box.dataset.line;
    lines[n] = lines[n].replace(/\[([ xX])\]/, (_, c) => (c === ' ' ? '[x]' : '[ ]'));
    el.ta.value = lines.join('\n');
    onInput();
    renderPreview(true);
    return;
  }
  const wl = e.target.closest('a.wikilink');
  if (wl) {
    e.preventDefault();
    const target = findNote(wl.dataset.note);
    if (target) openNote(target.path, { newTab: e.ctrlKey || e.metaKey });
    else newNote('', cleanName(wl.dataset.note.split('/').pop()), { editTitle: false });
    return;
  }
  const tag = e.target.closest('a.tag');
  if (tag) { e.preventDefault(); state.tag = tag.dataset.tag.toLowerCase(); showPanel('tags', true); renderTags(); }
  const a = e.target.closest('a[href^="#"]');
  if (a && !a.classList.contains('tag')) {
    e.preventDefault();
    const id = a.getAttribute('href').slice(1);
    if (id) el.preview.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth' });
  }
});
el.preview.addEventListener('click', (e) => {
  if (!previewEditable() || e.defaultPrevented || e.target.closest('a, input, button, .block-editor')) return;
  const t = e.target.closest('[data-a]');
  if (t && el.preview.contains(t)) editBlock(t);
});
el.preview.addEventListener('dblclick', (e) => {
  if (el.ws.dataset.mode === 'read' && !previewEditable() && !e.target.closest('a, input')) setMode('write');
});

// split scroll sync (editor -> preview)
el.editPane.addEventListener('scroll', () => {
  if (el.ws.dataset.mode !== 'split') return;
  const a = el.editPane;
  const b = el.previewPane;
  const ratio = a.scrollTop / Math.max(1, a.scrollHeight - a.clientHeight);
  b.scrollTop = ratio * (b.scrollHeight - b.clientHeight);
}, { passive: true });

// ------------------------------------------------------------------ modes
function setMode(mode, remember = true) {
  if (block.active) commitBlock();
  if (mobile.matches && mode === 'split') mode = 'write';
  el.ws.dataset.mode = mode;
  el.main.classList.toggle('reading', mode === 'read');
  $$('#modeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#editPreviewBtn').classList.toggle('on', !!state.settings.previewEdit);
  if (remember) { state.settings.mode = mode; store.set('settings', state.settings); }
  renderPreview(true);
  if (mode !== 'read' && state.cur && !el.layer.firstChild) requestAnimationFrame(() => el.ta.focus({ preventScroll: true }));
}
$('#modeSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });
mobile.addEventListener('change', () => { closeDrawer(); setMode(state.settings.mode, false); });

// ------------------------------------------------------------------ status bar
function countWords(text) {
  const body = text.split('\n').slice(frontmatterEnd(text.split('\n'))).join('\n');
  return (body.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || []).length;
}

function updateCounts() {
  const text = el.ta.value;
  const words = countWords(text);
  const { selectionStart: s, selectionEnd: e } = el.ta;
  const selWords = s !== e && document.activeElement === el.ta ? countWords(text.slice(s, e)) : 0;
  $('#stWords').textContent = selWords ? `${fmtNum(selWords)} of ${fmtNum(words)} words` : `${fmtNum(words)} word${words === 1 ? '' : 's'}`;
  $('#stChars').textContent = `${fmtNum(text.length)} chars`;
  $('#stRead').textContent = `${Math.max(1, Math.round(words / (state.settings.readingWpm || 230)))} min read`;
}

function updateStatus() {
  const cur = state.cur;
  if (!cur) return;
  updateCounts();
  $('#stCreated').textContent = cur.created ? `Created ${fmtDate(cur.created)}` : '';
  $('#stCreated').title = cur.created ? new Date(cur.created).toLocaleString() : '';
  $('#stModified').textContent = cur.modified ? `Edited ${relTime(cur.modified)}` : '';
  $('#stModified').title = cur.modified ? new Date(cur.modified).toLocaleString() : '';
}
setInterval(updateStatus, 30000);

$('#stSync').addEventListener('click', () => {
  if (state.sync === 'conflict') return resolveConflict();
  syncNow();
});
$('#stWidth').addEventListener('click', () => {
  const keys = Object.keys(WIDTHS);
  setSetting('width', keys[(keys.indexOf(state.settings.width) + 1) % keys.length]);
});

// ------------------------------------------------------------------ panels
function showPanel(name, reveal = false) {
  state.panel = name;
  store.set('panel', name);
  $$('.panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  $$('.ptab[data-panel]').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
  if (reveal && el.app.classList.contains('sb-collapsed')) toggleSidebar(true);
  if (reveal && el.app.classList.contains('focus')) setFocus(false);
  if (mobile.matches && reveal) openDrawer();
  if (name === 'search') { renderSearch(); setTimeout(() => $('#searchInput').focus(), 30); }
  if (name === 'tags') renderTags();
  if (name === 'outline') renderOutline();
  if (name === 'links') renderBacklinks();
}
$$('.ptab[data-panel]').forEach((b) => b.addEventListener('click', () => showPanel(b.dataset.panel)));
$('#railSwitch').addEventListener('click', () => quickSwitcher());
$('#railDaily').addEventListener('click', () => openDaily());
$('#railPalette').addEventListener('click', () => commandPalette());
$('#railNew').addEventListener('click', () => newNote());
$('#collapseBtn').addEventListener('click', () => { state.open.clear(); vstore.set('open', []); renderTree(); });

function toggleSidebar(force) {
  if (mobile.matches) { el.app.classList.contains('drawer-open') ? closeDrawer() : openDrawer(); return; }
  const show = force ?? el.app.classList.contains('sb-collapsed');
  el.app.classList.toggle('sb-collapsed', !show);
  store.set('collapsed', !show);
}
function openDrawer() { el.app.classList.add('drawer-open'); }
function closeDrawer() { el.app.classList.remove('drawer-open'); }
$('#sidebarBtn').addEventListener('click', () => toggleSidebar());
$('#scrim').addEventListener('click', closeDrawer);

// search
let searchSeq = 0;
const runSearch = debounce(async (q) => {
  const seq = ++searchSeq;
  if (!q) return renderSearch();
  let results;
  try { results = (await api('GET', `/api/search?q=${enc(q)}`)).results; } catch {
    const ql = q.toLowerCase();
    results = state.tree.notes.filter((n) => n.path.toLowerCase().includes(ql)).map((n) => ({ path: n.path, title: stem(n.path), snippet: '' }));
  }
  if (seq !== searchSeq) return;
  const words = q.toLowerCase().replace(/(-?\w+:\S+|-\S+|")/g, ' ').split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = words.length ? new RegExp(`(${words.join('|')})`, 'gi') : null;
  const hl = (s) => (re ? esc(s).replace(re, '<mark>$1</mark>') : esc(s));
  // The server marks matches in snippets with \x02 … \x03.
  const snip = (s) => (s.includes('\x02') ? esc(s).replace(/\x02/g, '<mark>').replace(/\x03/g, '</mark>') : hl(s));
  $('#searchResults').innerHTML = results.length
    ? results.map((r) => `<button class="hit" data-open="${esc(r.path)}"><b>${hl(r.title)}</b>${r.snippet ? `<small>${snip(r.snippet)}</small>` : ''}<span class="hit-path">${esc(dirname(r.path))}</span></button>`).join('')
    : '<div class="tree-empty">Nothing matches that yet.</div>';
  markActiveHit();
}, 160);

function renderSearch() {
  const q = $('#searchInput').value.trim();
  if (q) return runSearch(q);
  const recent = [...state.tree.notes].sort((a, b) => b.modified - a.modified).slice(0, 12);
  $('#searchResults').innerHTML = `<div class="search-help"><code>tag:work</code> <code>path:Daily</code> <code>title:plan</code> <code>"exact words"</code> <code>-skip</code></div>` + '<div class="list-label">Recently edited</div>' +
    recent.map((n) => `<button class="hit" data-open="${esc(n.path)}"><b>${esc(stem(n.path))}</b><small>${esc(dirname(n.path) || 'Vault')} · ${relTime(n.modified)}</small></button>`).join('');
  markActiveHit();
}
function markActiveHit() { $$('#searchResults .hit').forEach((h) => h.classList.toggle('active', h.dataset.open === state.cur?.path)); }
$('#searchInput').addEventListener('input', (e) => runSearch(e.target.value.trim()));
$('#searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const first = $('#searchResults .hit'); if (first) openNote(first.dataset.open); }
  if (e.key === 'Escape') { e.preventDefault(); e.target.value = ''; renderSearch(); el.ta.focus(); }
});
$('#searchResults').addEventListener('click', (e) => { const b = e.target.closest('[data-open]'); if (b) openNote(b.dataset.open, { newTab: e.ctrlKey || e.metaKey }); });

// tags
function renderTags() {
  const counts = new Map();
  for (const n of state.tree.notes) for (const t of n.tags || []) {
    const k = t.toLowerCase();
    const c = counts.get(k) || { name: t, n: 0 };
    c.n++;
    counts.set(k, c);
  }
  const tags = [...counts.entries()].sort((a, b) => b[1].n - a[1].n || byName(a[0], b[0]));
  if (state.tag && !counts.has(state.tag)) state.tag = null;
  $('#tagCloud').innerHTML = tags.length
    ? tags.map(([k, t]) => `<button class="chip${state.tag === k ? ' active' : ''}" data-tag="${esc(k)}">#${esc(t.name)}<small>${t.n}</small></button>`).join('')
    : '<div class="tree-empty">Write a #tag in any note, or right-click a note or folder to tag it.</div>';
  const list = state.tag ? state.tree.notes.filter((n) => (n.tags || []).some((t) => t.toLowerCase() === state.tag)) : [];
  list.sort((a, b) => b.modified - a.modified);
  $('#tagNotes').innerHTML = state.tag
    ? `<div class="list-label">${list.length} note${list.length === 1 ? '' : 's'}</div>` + list.map((n) => `<button class="hit${n.path === state.cur?.path ? ' active' : ''}" data-open="${esc(n.path)}"><b>${esc(stem(n.path))}</b><small>${esc(dirname(n.path) || 'Vault')} · ${relTime(n.modified)}</small></button>`).join('')
    : '';
}
$('#tagCloud').addEventListener('click', (e) => {
  const c = e.target.closest('[data-tag]');
  if (!c) return;
  state.tag = state.tag === c.dataset.tag ? null : c.dataset.tag;
  renderTags();
});
$('#tagNotes').addEventListener('click', (e) => { const b = e.target.closest('[data-open]'); if (b) openNote(b.dataset.open, { newTab: e.ctrlKey || e.metaKey }); });

$('#newNoteBtn').addEventListener('click', () => newNote());
$('#emptyNew').addEventListener('click', () => newNote());
$('#newFolderBtn').addEventListener('click', () => newFolder());
$('#sortBtn').addEventListener('click', (e) => {
  menu(e.currentTarget, [
    { header: 'Default order' },
    ...SORTS.map(([v, l]) => ({ icon: state.settings.sort === v ? 'check' : 'blank', label: l, run: () => setSetting('sort', v) })),
  ]);
});
$('#noteMenuBtn').addEventListener('click', (e) => {
  const cur = state.cur;
  if (!cur) return;
  menu(e.currentTarget, [
    { icon: 'edit', label: 'Rename', run: () => { el.title.focus(); el.title.select(); } },
    { icon: 'move', label: 'Move to…', run: () => moveNoteDialog(cur.path) },
    { icon: 'copy', label: 'Duplicate', run: () => duplicateNote(cur.path) },
    { icon: 'tag', label: 'Tags…', run: () => tagsDialog(cur.path) },
    { icon: 'history', label: 'Version history', run: () => openHistory(cur.path) },
    { icon: 'share', label: 'Share link…', run: () => shareDialog(cur.path) },
    { icon: 'template', label: 'Insert template…', run: () => insertTemplate() },
    { icon: 'outline', label: cur.front ? 'Edit properties' : 'Add properties', run: () => addProperties() },
    '-',
    { icon: 'link', label: 'Copy link', run: () => copyText(`[[${stem(cur.path)}]]`, 'Link copied') },
    { icon: 'copy', label: 'Copy markdown', run: () => copyText(cur.content) },
    { icon: 'download', label: 'Export (PDF, HTML, Markdown)…', run: () => exportDialog(cur.path) },
    '-',
    { icon: 'trash', label: 'Delete', danger: true, run: () => deleteNote(cur.path) },
  ]);
});
$('#themeBtn').addEventListener('click', () => setSetting('theme', resolvedTheme() === 'dark' ? 'light' : 'dark'));
$('#settingsBtn').addEventListener('click', () => showSettings());

// ------------------------------------------------------------------ images
async function uploadImages(files) {
  if (!state.cur) return;
  for (const f of files) {
    if (!f.type.startsWith('image/')) { toast(`${f.name || 'That file'} is not an image`, 'err'); continue; }
    const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    const d = new Date();
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const pasted = !f.name || /^image\.\w+$/i.test(f.name);
    const name = !pasted ? f.name : state.settings.pasteName === 'note' ? `${stem(state.cur.path)}.${ext}` : `pasted-${stamp}.${ext}`;
    const token = `![Uploading ${name.replace(/[\[\]]/g, '')}…]()`;
    const s = el.ta.selectionStart;
    const before = el.ta.value.slice(0, s);
    const lead = before && !before.endsWith('\n') ? '\n' : '';
    replace(el.ta, s, el.ta.selectionEnd, `${lead}${token}\n`);
    try {
      const r = await api('POST', `/api/upload?name=${enc(name)}`, f);
      swapToken(token, state.settings.imageLinks === 'wiki' ? `![[${r.name}]]` : `![](${r.path})`);
    } catch (e) {
      swapToken(token, '');
      toast(e.offline ? 'Images need the server. Try again when you are back online.' : e.message, 'err');
    }
  }
}
function swapToken(token, text) {
  const i = el.ta.value.indexOf(token);
  if (i < 0) return;
  const { selectionStart: s, selectionEnd: e } = el.ta;
  const delta = text.length - token.length;
  const end = i + token.length + (text ? 0 : el.ta.value[i + token.length] === '\n' ? 1 : 0);
  replace(el.ta, i, end, text);
  const fix = (p) => (p > i ? Math.max(i, p + delta - (end - i - token.length)) : p);
  el.ta.setSelectionRange(fix(s), fix(e));
}
$('#fileInput').addEventListener('change', (e) => { uploadImages([...e.target.files]); e.target.value = ''; });
el.ta.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); uploadImages(files); }
});
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e) && state.cur) { dragDepth++; document.body.classList.add('dropping'); } });
window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  if (state.cur) { if (el.ws.dataset.mode === 'read') setMode('write'); uploadImages([...e.dataTransfer.files]); }
});

// ------------------------------------------------------------------ menu / dialog / toast
let layerCleanup = null;
function closeLayer() {
  const fn = layerCleanup;
  layerCleanup = null;
  fn?.();
  el.layer.innerHTML = '';
}

function menu(anchor, items) {
  closeLayer();
  const m = document.createElement('div');
  m.className = 'menu glass';
  m.setAttribute('role', 'menu');
  items.forEach((it) => {
    if (it === '-') { m.appendChild(document.createElement('hr')); return; }
    if (it.header || it.message) {
      const h = document.createElement('div');
      h.className = it.message ? `menu-msg g-${it.kind || ''}` : 'menu-label';
      h.textContent = it.header || it.message;
      m.appendChild(h);
      return;
    }
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitem');
    if (it.danger) b.className = 'danger';
    b.innerHTML = `${icon(it.icon, it.icon === 'blank' ? 'blank' : '')}<span>${esc(it.label)}</span>`;
    b.addEventListener('click', () => { closeLayer(); it.run(); });
    m.appendChild(b);
  });
  el.layer.appendChild(m);
  const isEl = typeof anchor.getBoundingClientRect === 'function' && anchor.isConnected;
  const r = isEl ? anchor.getBoundingClientRect() : { left: anchor.x ?? 100, right: anchor.x ?? 100, top: anchor.y ?? 100, bottom: anchor.y ?? 100 };
  const w = m.offsetWidth;
  const h = m.offsetHeight;
  let x = isEl ? r.right - w : r.left;
  let y = r.bottom + 6;
  x = Math.max(8, Math.min(x, innerWidth - w - 8));
  if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 6);
  if (y + h > innerHeight - 8) y = Math.max(8, innerHeight - h - 8);
  Object.assign(m.style, { left: `${x}px`, top: `${y}px` });
  m.querySelector('button')?.focus({ preventScroll: true });
  const away = (e) => { if (!m.contains(e.target)) closeLayer(); };
  const key = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeLayer(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const bs = $$('button', m);
      const i = bs.indexOf(document.activeElement);
      bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length].focus();
    }
  };
  let armed = false;
  const timer = setTimeout(() => { armed = true; document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', key, true); });
  layerCleanup = () => {
    clearTimeout(timer);
    if (armed) { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true); }
  };
}

/**
 * A modal dialog. With stack: true it opens on top of the current one
 * (used by confirmations inside Settings) instead of replacing it.
 */
function dialog({ title, text, input, pick, buttons = [], content, cls = '', stack = false }) {
  if (!stack) closeLayer();
  return new Promise((resolve) => {
    const bd = document.createElement('div');
    bd.className = 'backdrop';
    bd.innerHTML = `<div class="dialog glass ${cls}" role="dialog" aria-modal="true" aria-label="${esc(title || 'Dialog')}">
      ${title ? `<h3>${esc(title)}</h3>` : ''}${text ? `<p>${esc(text)}</p>` : ''}
      ${input ? `<input class="field" value="${esc(input.value || '')}" placeholder="${esc(input.placeholder || '')}" type="${input.type || 'text'}" spellcheck="false">` : ''}
      ${pick ? `<div class="pick">${pick.map((p, i) => `<button data-i="${i}">${icon(p.icon || 'folder')}<span>${esc(p.label)}</span></button>`).join('')}</div>` : ''}
      <div class="dialog-body"></div>
      ${buttons.length ? `<div class="actions">${buttons.map((b, i) => `<button class="btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}" data-b="${i}">${esc(b.label)}</button>`).join('')}</div>` : ''}
    </div>`;
    const box = bd.firstElementChild;
    if (content) box.querySelector('.dialog-body').appendChild(content);
    const field = box.querySelector('.field');
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      bd.remove();
      if (layerCleanup === cleanup) layerCleanup = null;
      resolve(v);
    };
    const cleanup = () => done(null);
    const valueOf = (b) => (b.value === true && field ? field.value : b.value ?? null);
    const onKey = (e) => {
      if (el.layer.lastElementChild !== bd) return; // only the top dialog listens
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      if (e.key === 'Enter' && field && document.activeElement === field) {
        e.preventDefault();
        const p = buttons.find((b) => b.primary);
        done(p ? valueOf(p) : field.value);
      }
    };
    document.addEventListener('keydown', onKey, true);
    bd.addEventListener('pointerdown', (e) => { if (e.target === bd) done(null); });
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-b]');
      if (b && b.closest('.dialog') === box && !b.closest('.dialog-body')) return done(valueOf(buttons[+b.dataset.b]));
      const p = e.target.closest('.pick [data-i]');
      if (p) done(pick[+p.dataset.i].value);
    });
    el.layer.appendChild(bd);
    if (!stack) layerCleanup = cleanup;
    if (field) { field.focus(); field.select(); }
    else if (!content) box.querySelector('.btn.primary, .btn.danger, .pick button, .btn')?.focus();
  });
}

let toastBox;
function toast(msg, kind = '') {
  if (!toastBox) { toastBox = document.createElement('div'); toastBox.className = 'toasts'; document.body.appendChild(toastBox); }
  const t = document.createElement('div');
  t.className = `toast glass ${kind}`;
  t.textContent = msg;
  toastBox.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'err' ? 4200 : 2400);
}

// ------------------------------------------------------------------ hotkeys
const CODE_KEYS = {
  Backslash: '\\', Slash: '/', Comma: ',', Period: '.', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
  Minus: '-', Equal: '=', Backquote: '`', Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End',
};
function keyName(e) {
  const c = e.code || '';
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^Numpad\d$/.test(c)) return c.slice(6);
  if (/^F\d{1,2}$/.test(c)) return c;
  if (CODE_KEYS[c]) return CODE_KEYS[c];
  return e.key && e.key.length === 1 ? e.key.toUpperCase() : null;
}
function comboFromEvent(e) {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) return null;
  const k = keyName(e);
  if (!k) return null;
  const parts = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (isMac && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(k);
  return parts.join('+');
}
const KEY_LABELS = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space' };
function comboLabel(combo) {
  if (!combo) return 'Not set';
  const mods = isMac ? { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' } : { Mod: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
  return combo.split('+').map((p) => mods[p] || KEY_LABELS[p] || p).join(isMac ? '' : ' ');
}

/** Editor commands act on the main editor, or on a block being edited in the preview. */
const activeEditor = () => (document.activeElement?.classList?.contains('block-ta') ? document.activeElement : el.ta);
const edit = (fn) => () => {
  const t = activeEditor();
  if (state.cur && (t !== el.ta || el.ws.dataset.mode !== 'read')) fn(t);
};
export const COMMANDS = [
  { id: 'quickOpen', group: 'General', label: 'Open a note', def: 'Mod+O', icon: 'search', run: () => quickSwitcher() },
  { id: 'palette', group: 'General', label: 'Command palette', def: 'Mod+Shift+P', icon: 'command', run: () => commandPalette() },
  { id: 'search', group: 'General', label: 'Search inside notes', def: 'Mod+P', icon: 'search', run: () => { showPanel('search', true); $('#searchInput').select(); } },
  { id: 'daily', group: 'General', label: 'Open today’s note', def: 'Alt+D', icon: 'calendar', run: () => openDaily() },
  { id: 'newNote', group: 'General', label: 'New note', def: 'Alt+N', run: () => newNote() },
  { id: 'newTab', group: 'General', label: 'New tab', def: 'Alt+T', run: () => newTab() },
  { id: 'closeTab', group: 'General', label: 'Close tab', def: 'Alt+W', run: () => closeTab(state.active) },
  { id: 'nextTab', group: 'General', label: 'Next tab', def: 'Alt+]', run: () => switchTab((state.active + 1) % state.tabs.length) },
  { id: 'prevTab', group: 'General', label: 'Previous tab', def: 'Alt+[', run: () => switchTab((state.active - 1 + state.tabs.length) % state.tabs.length) },
  { id: 'toggleRead', group: 'General', label: 'Switch between writing and reading', def: 'Mod+E', run: () => { if (state.cur) setMode(el.ws.dataset.mode === 'read' ? 'write' : 'read'); } },
  { id: 'toggleSidebar', group: 'General', label: 'Show or hide the sidebar', def: 'Mod+\\', run: () => toggleSidebar() },
  { id: 'focusMode', group: 'General', label: 'Focus mode', def: 'Mod+Shift+F', run: () => setFocus(!el.app.classList.contains('focus')) },
  { id: 'history', group: 'General', label: 'Version history of this note', def: 'Alt+H', run: () => openHistory() },
  { id: 'toggleTheme', group: 'General', label: 'Switch light and dark', def: 'Alt+L', run: () => setSetting('theme', resolvedTheme() === 'dark' ? 'light' : 'dark') },
  { id: 'save', group: 'General', label: 'Save and sync now', def: 'Mod+S', icon: 'refresh', run: () => syncNow() },
  { id: 'insertTemplate', group: 'General', label: 'Insert a template', def: 'Alt+Shift+T', icon: 'template', run: () => insertTemplate() },
  { id: 'outline', group: 'General', label: 'Show the outline', def: 'Alt+O', icon: 'outline', run: () => showPanel('outline', true) },
  { id: 'backlinks', group: 'General', label: 'Show backlinks', def: 'Alt+B', icon: 'link', run: () => showPanel('links', true) },
  { id: 'export', group: 'General', label: 'Export this note (PDF, HTML, Markdown)', def: '', icon: 'download', run: () => exportDialog() },
  { id: 'properties', group: 'Editor', label: 'Add properties', def: '', icon: 'outline', run: () => addProperties() },
  { id: 'formatTable', group: 'Editor', label: 'Tidy the table', def: 'Mod+Shift+L', scope: 'editor', icon: 'layout', run: edit(commands.formatTable) },
  { id: 'previewEdit', group: 'General', label: 'Edit in preview on or off', def: '', icon: 'edit', run: () => $('#editPreviewBtn').click() },
  { id: 'nextIssue', group: 'Editor', label: 'Next writing suggestion', def: 'F8', scope: 'editor', icon: 'check', run: () => nextIssue() },
  { id: 'settings', group: 'General', label: 'Open settings', def: 'Mod+,', run: () => showSettings() },
  { id: 'bold', group: 'Editor', label: 'Bold', def: 'Mod+B', scope: 'editor', run: edit(commands.bold) },
  { id: 'italic', group: 'Editor', label: 'Italic', def: 'Mod+I', scope: 'editor', run: edit(commands.italic) },
  { id: 'strike', group: 'Editor', label: 'Strikethrough', def: 'Mod+Shift+X', scope: 'editor', run: edit(commands.strike) },
  { id: 'highlight', group: 'Editor', label: 'Highlight', def: 'Mod+Shift+M', scope: 'editor', run: edit(commands.mark) },
  { id: 'code', group: 'Editor', label: 'Inline code', def: 'Mod+Shift+E', scope: 'editor', run: edit(commands.code) },
  { id: 'link', group: 'Editor', label: 'Link', def: 'Mod+K', scope: 'editor', run: edit(commands.link) },
  { id: 'heading', group: 'Editor', label: 'Cycle heading level', def: 'Mod+Shift+H', scope: 'editor', run: edit(commands.heading) },
  { id: 'list', group: 'Editor', label: 'Bulleted list', def: 'Mod+Shift+8', scope: 'editor', run: edit(commands.list) },
  { id: 'ordered', group: 'Editor', label: 'Numbered list', def: 'Mod+Shift+7', scope: 'editor', run: edit(commands.ordered) },
  { id: 'checkbox', group: 'Editor', label: 'Toggle checkbox', def: 'Mod+Enter', scope: 'editor', run: edit(commands.checkbox) },
  { id: 'quote', group: 'Editor', label: 'Quote', def: 'Mod+Shift+.', scope: 'editor', run: edit(commands.quote) },
];
/** Everything the command palette can run: hotkey commands plus a few one-offs. */
function allCommands() {
  const extra = [
    ['New note', 'filePlus', () => newNote()],
    ['New note from template', 'template', () => newFromTemplate()],
    ['New folder', 'folderPlus', () => newFolder()],
    ['Yesterday’s note', 'calendar', () => openDaily(-1)],
    ['Tomorrow’s note', 'calendar', () => openDaily(1)],
    ['Share this note', 'share', () => state.cur && shareDialog(state.cur.path)],
    ['Tags for this note', 'tag', () => state.cur && tagsDialog(state.cur.path)],
    ['Duplicate this note', 'copy', () => state.cur && duplicateNote(state.cur.path)],
    ['Move this note', 'move', () => state.cur && moveNoteDialog(state.cur.path)],
    ['Delete this note', 'trash', () => state.cur && deleteNote(state.cur.path)],
    ['Copy link to this note', 'link', () => state.cur && copyText(`[[${stem(state.cur.path)}]]`, 'Link copied')],
    ['Show tags', 'hash', () => showPanel('tags', true)],
    ['Import notes', 'download', () => showSettings('files')],
    ['Find unused attachments', 'image', () => showSettings('files')],
    ['Switch account', 'user', () => showLanding()],
    ['Add account', 'plus', () => showLanding({ create: true })],
    ...(currentAccount().locked ? [['Lock this account', 'logout', () => lockAccount()]] : []),
    ...[['general', 'General'], ['appearance', 'Appearance'], ['interface', 'Interface'], ['editor', 'Editor'], ['files', 'Files and links'], ['hotkeys', 'Hotkeys'], ['keychain', 'Keychain'], ['sync', 'Sync']]
      .map(([id, l]) => [`Settings: ${l}`, 'sliders', () => showSettings(id)]),
  ].map(([label, ic, run]) => ({ id: `x-${label}`, label, icon: ic, group: 'More', run }));
  return [...COMMANDS, ...extra];
}

const keyFor = (id) => {
  const c = COMMANDS.find((x) => x.id === id);
  return id in state.settings.hotkeys ? state.settings.hotkeys[id] : c?.def || '';
};

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (e.defaultPrevented || el.layer.firstChild) return;
    if (el.app.classList.contains('focus') && document.activeElement !== el.title) { setFocus(false); return; }
    if (el.app.classList.contains('drawer-open')) closeDrawer();
    return;
  }
  if (el.layer.firstChild) return; // menus and dialogs handle their own keys
  const combo = comboFromEvent(e);
  if (!combo) return;
  if (/^Alt\+[1-9]$/.test(combo)) { e.preventDefault(); switchTab(Math.min(+combo.slice(4), state.tabs.length) - 1); return; }
  const inEditor = document.activeElement === el.ta || !!document.activeElement?.classList?.contains('block-ta');
  for (const c of COMMANDS) {
    if (keyFor(c.id) !== combo || (c.scope === 'editor' && !inEditor)) continue;
    e.preventDefault();
    c.run();
    return;
  }
});

// ------------------------------------------------------------------ properties (front matter)
function setFront(text) {
  const cur = state.cur;
  if (!cur) return;
  cur.front = text;
  cur.content = text + el.ta.value;
  cur.dirty = true;
  if (state.sync !== 'conflict') setSync(manual() ? 'local' : 'pending');
  scheduleSave();
  paintProps();
}
const propTag = (t) => { state.tag = t.toLowerCase(); showPanel('tags', true); renderTags(); };
const propsEdit = mountProps($('#props'), () => state.cur?.front || '', setFront, { onTag: propTag });
const propsView = mountProps($('#propsView'), () => state.cur?.front || '', setFront, { onTag: propTag });
function paintProps() { propsEdit.paint(); propsView.paint(); }

/** Properties only exist once added on purpose. */
function addProperties() {
  if (!state.cur) return toast('Open a note first');
  if (!state.cur.front) setFront('---\n---\n');
  const box = el.ws.dataset.mode === 'read' ? $('#propsView') : $('#props');
  box.querySelector('[data-new]')?.click();
}

// ------------------------------------------------------------------ files & embeds
function normalizePath(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return out.join('/');
}
/** Image paths: relative to the note if that file exists (Obsidian's default), else from the vault root. */
function resolveFile(src) {
  const clean = tryDecode(src).replace(/^\.\//, '');
  const files = state.tree.files || [];
  const here = state.cur ? dirname(state.cur.path) : '';
  if (here && !clean.startsWith('/')) {
    const rel = normalizePath(join(here, clean));
    if (files.includes(rel)) return rel;
  }
  return normalizePath(clean);
}
/** ![[name.png]]: a bare name is found anywhere in the vault, preferring the attachment folder. */
function resolveEmbed(name) {
  const n = name.replace(/^\/+/, '');
  if (n.includes('/')) return normalizePath(n);
  const files = state.tree.files || [];
  const attach = state.config.attachmentFolder || 'attachments';
  const lower = n.toLowerCase();
  return files.find((f) => f.toLowerCase() === `${attach}/${lower}`.toLowerCase())
    || files.find((f) => basename(f).toLowerCase() === lower) || `${attach}/${n}`;
}

function sectionOf(text, heading) {
  const lines = text.split('\n');
  const want = heading.trim().toLowerCase();
  let start = -1;
  let level = 0;
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    if (fence) continue;
    const m = lines[i].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    if (start < 0) {
      if (m[2].trim().toLowerCase() === want || slug(m[2]) === slug(heading)) { start = i; level = m[1].length; }
    } else if (m[1].length <= level) return lines.slice(start, i).join('\n');
  }
  return start < 0 ? null : lines.slice(start).join('\n');
}

/** Fill in ![[Note]] and ![[Note#Heading]] blocks, up to three levels deep, never looping. */
async function expandEmbeds(root, chain = [state.cur?.path]) {
  const boxes = $$('.note-embed:not([data-done])', root);
  await Promise.all(boxes.map(async (box) => {
    box.dataset.done = '1';
    const name = box.dataset.note;
    const heading = box.dataset.heading;
    const target = findNote(name);
    const head = (label, cls = '') => `<div class="embed-head">${icon('file')}<a class="wikilink${cls}" href="#" data-note="${esc(label)}">${esc(label)}${heading ? ` › ${esc(heading)}` : ''}</a></div>`;
    if (!target) { box.innerHTML = head(name, ' missing') + '<div class="embed-missing">This note doesn’t exist yet. Click its name to create it.</div>'; return; }
    if (chain.includes(target.path) || chain.length > 3) { box.innerHTML = head(stem(target.path)) + '<div class="embed-missing">Not shown here, to avoid an endless loop.</div>'; return; }
    const text = splitFront(await noteText(target.path)).body;
    const section = heading ? sectionOf(text, heading) : text;
    box.innerHTML = head(stem(target.path)) + `<div class="md embed-body">${section == null ? '<div class="embed-missing">That heading isn’t in the note.</div>' : render(section, previewOpts)}</div>`;
    await expandEmbeds(box, [...chain, target.path]);
  }));
}

// ------------------------------------------------------------------ editing inside the preview
// Read mode with "edit in preview" on: click a block to edit its markdown in place.
const block = { active: null };
const previewEditable = () => !!state.settings.previewEdit && el.ws.dataset.mode === 'read' && !!state.cur;

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

function startBlockEdit(target, atEnd = false) {
  const lines = el.ta.value.split('\n');
  const a = atEnd ? lines.length : +target.dataset.a;
  const b = atEnd ? lines.length : +target.dataset.b;
  const src = lines.slice(a, b).join('\n');
  const wrap = document.createElement('div');
  wrap.className = 'block-editor';
  wrap.innerHTML = `<textarea class="block-ta" spellcheck="${state.settings.spellEngine === 'browser'}" aria-label="Edit this block"></textarea>
    <div class="block-hint"><span>Markdown</span><span><kbd>Ctrl Enter</kbd> or click outside to finish · <kbd>Esc</kbd> cancel</span></div>`;
  const ta = wrap.querySelector('textarea');
  ta.value = src;
  if (atEnd) el.preview.appendChild(wrap); else target.replaceWith(wrap);
  block.active = { a, b, ta, src, atEnd };
  autosize(ta);
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(src.length, src.length);
  const s = state.settings;
  ta.addEventListener('input', () => autosize(ta));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancelBlock(); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitBlock(); return; }
    if (handleKey(ta, e, { indent: INDENTS[s.indent] || '\t', smartLists: s.smartLists, autoPair: s.autoPair, tables: s.tableKeys })) autosize(ta);
  });
  ta.addEventListener('blur', () => setTimeout(() => { if (block.active?.ta === ta && document.activeElement !== ta) commitBlock(); }, 150));
}

/** Write the edited block back into the note. Returns how many lines it added or removed, and where. */
function commitBlock() {
  const b = block.active;
  if (!b) return null;
  block.active = null;
  const text = b.ta.value.replace(/\s+$/, '');
  let delta = 0;
  if (text !== b.src.replace(/\s+$/, '')) {
    const lines = el.ta.value.split('\n');
    if (b.atEnd) {
      if (text) {
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        lines.push(...(lines.length ? [''] : []), ...text.split('\n'));
      }
    } else {
      const next = text ? text.split('\n') : [];
      lines.splice(b.a, b.b - b.a, ...next);
      delta = next.length - (b.b - b.a);
    }
    el.ta.value = lines.join('\n');
    onInput();
  }
  renderPreview(true);
  return { at: b.a, delta };
}

function cancelBlock() {
  block.active = null;
  renderPreview(true);
}

function editBlock(target) {
  let a = +target.dataset.a;
  if (block.active) {
    const done = commitBlock(); // re-renders, so find the clicked block again
    if (done && done.at < a) a += done.delta;
    target = el.preview.querySelector(`[data-a="${a}"]`);
    if (!target) return;
  }
  startBlockEdit(target);
}

el.previewPane.addEventListener('click', (e) => {
  if (!previewEditable() || e.target.closest('.md > *, .title-view, .note-tags, .props, a, button, input')) return;
  const last = el.preview.lastElementChild;
  if (last && e.clientY < last.getBoundingClientRect().bottom) return;
  if (block.active) commitBlock();
  startBlockEdit(null, true); // clicking below the last block starts a new one
});

$('#editPreviewBtn').addEventListener('click', () => {
  const on = !state.settings.previewEdit;
  setSetting('previewEdit', on);
  toast(on ? 'Click any paragraph, list or table to edit it' : 'Editing in the preview is off');
});

// ------------------------------------------------------------------ export
async function exportDialog(path = state.cur?.path) {
  if (!path) return toast('Open a note first');
  if (state.cur?.path === path) await flushSave();
  const s = state.settings;
  const o = Object.fromEntries(Object.keys(EXPORT_DEFAULTS).map((k) => [k, s[k]]));
  let format = 'pdf';
  const box = document.createElement('div');
  box.className = 'export-box';
  const opt = (k, list) => `<select class="sel" data-o="${k}">${list.map(([v, l]) => `<option value="${v}"${String(o[k]) === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  const chk = (k, label) => `<label class="check"><input type="checkbox" data-o="${k}"${o[k] ? ' checked' : ''}> ${label}</label>`;
  const paint = () => {
    const doc = format !== 'md';
    box.innerHTML = `<div class="opts export-fmt" style="margin:4px 0 14px">${[['pdf', 'PDF'], ['html', 'HTML file'], ['md', 'Markdown']].map(([v, l]) => `<button data-fmt="${v}" class="${v === format ? 'active' : ''}">${l}</button>`).join('')}</div>
      ${!doc ? '<p class="export-note">The note exactly as written, as a .md file.</p>' : `
      <div class="export-grid">
        <span>Header</span><div class="export-pair">${opt('pdfHeader', [['none', 'None'], ['title', 'Note title'], ['custom', 'Custom text']])}${o.pdfHeader === 'custom' ? `<input class="txt" data-o="pdfHeaderText" value="${esc(o.pdfHeaderText)}" placeholder="{title} · {date}">` : ''}</div>
        <span>Footer</span><div class="export-pair">${opt('pdfFooter', [['none', 'None'], ['date', 'Today’s date'], ['title', 'Note title'], ['custom', 'Custom text']])}${o.pdfFooter === 'custom' ? `<input class="txt" data-o="pdfFooterText" value="${esc(o.pdfFooterText)}" placeholder="{title} · {date}">` : ''}</div>
        ${format === 'pdf' ? `<span>Paper</span><div class="export-pair">${opt('pdfPaper', [['A4', 'A4'], ['Letter', 'US Letter']])}${opt('pdfMargins', [['narrow', 'Narrow margins'], ['normal', 'Normal margins'], ['wide', 'Wide margins']])}</div>` : ''}
        <span>Font</span><div class="export-pair">${opt('pdfFont', [['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono']])}</div>
      </div>
      <div class="export-checks">${chk('pdfTitle', 'Title at the top')}${chk('pdfProps', 'Properties')}${chk('pdfTags', 'Tags')}${format === 'pdf' ? chk('pdfPageNumbers', 'Page numbers') : ''}</div>
      <p class="export-note">${format === 'pdf' ? 'Opens your browser’s print dialog: choose <b>Save as PDF</b>. Page numbers appear in Chrome, Edge and other Chromium browsers.' : 'One self-contained file with its images built in. It opens in any browser.'} Custom text can use {title} and {date}.</p>`}`;
  };
  const read = () => {
    for (const el2 of $$('[data-o]', box)) o[el2.dataset.o] = el2.type === 'checkbox' ? el2.checked : el2.value;
  };
  box.addEventListener('click', (e) => { const f = e.target.closest('[data-fmt]'); if (f) { read(); format = f.dataset.fmt; paint(); } });
  box.addEventListener('change', (e) => { if (e.target.matches('select[data-o]')) { read(); paint(); } });
  paint();
  const ok = await dialog({ title: `Export “${stem(path)}”`, content: box, cls: 'export-dialog', buttons: [{ label: 'Cancel' }, { label: 'Export', primary: true, value: true }] });
  if (!ok) return;
  read();
  for (const [k, v] of Object.entries(o)) state.settings[k] = v;
  store.set('settings', state.settings);
  if (format === 'md') return download(path);
  const content = state.cur?.path === path ? state.cur.content : await noteText(path);
  const ctx = { title: stem(path), path, content, previewOpts, richOpts: richOpts(), tags: noteByPath(path)?.tags || [], expandEmbeds: (root) => expandEmbeds(root, [path]) };
  try {
    if (format === 'pdf') await printNote(ctx, o);
    else saveFile(`${stem(path)}.html`, await htmlFile(ctx, o));
  } catch (e) { toast(`Export failed: ${e.message}`, 'err'); }
}

// ------------------------------------------------------------------ import
/** Send files to the server's importer: .md/.txt notes, images, or a .zip of a folder or vault. */
async function importFiles(files, folder = '') {
  const total = { notes: 0, files: 0, skipped: 0 };
  for (const f of files) {
    try {
      const r = await api('POST', `/api/import?folder=${enc(folder)}&name=${enc(f.name)}`, f);
      for (const k of Object.keys(total)) total[k] += r[k] || 0;
    } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
  }
  await refreshTree();
  if (folder) { setOpen(folder, true); renderTree(); }
  toast(`Imported ${total.notes} note${total.notes === 1 ? '' : 's'}${total.files ? ` and ${total.files} file${total.files === 1 ? '' : 's'}` : ''}${total.skipped ? ` · skipped ${total.skipped}` : ''}`);
  return total;
}

// ------------------------------------------------------------------ writing checks (Harper)
const spell = new Spell();
const lint = { items: [], timer: 0, ready: false, error: '' };
let prevText = '';
const spellOn = () => state.settings.spellEngine === 'harper';

async function startSpell() {
  const st = $('#stLint');
  if (!spellOn()) { clearLints(); st.hidden = true; return; }
  st.hidden = false;
  setLintStatus(spell.ready ? 'checking' : 'loading');
  try {
    const words = await loadWords();
    const s = state.settings;
    await spell.configure({ dialect: s.dialect, rules: s.harperRules, words });
    lint.ready = true;
    lint.error = '';
    scheduleLint(0);
  } catch (e) {
    lint.error = e.message || String(e);
    setLintStatus('error');
  }
}

async function loadWords() {
  try {
    const r = await api('GET', '/api/dictionary');
    vstore.set('words', r.words);
    return r.words;
  } catch { return vstore.get('words', []); }
}

function scheduleLint(ms = 450) {
  clearTimeout(lint.timer);
  if (!spellOn() || !state.cur || !lint.ready) return;
  lint.timer = setTimeout(runLint, ms);
}

async function runLint() {
  const text = el.ta.value;
  setLintStatus('checking');
  let items;
  try { items = await spell.check(text, state.settings.spellGroups); } catch (e) { lint.error = e.message; return setLintStatus('error'); }
  if (!items || el.ta.value !== text) return; // the text moved on; a newer check is coming
  lint.items = items;
  renderLints();
  setLintStatus();
}

function renderLints() {
  const text = el.ta.value;
  let html = '';
  let pos = 0;
  lint.items.forEach((l, i) => {
    if (l.start < pos || l.end > text.length) return;
    html += esc(text.slice(pos, l.start)) + `<span class="lint g-${l.group}" data-i="${i}">${esc(text.slice(l.start, l.end))}</span>`;
    pos = l.end;
  });
  el.lints.innerHTML = html + esc(text.slice(pos)) + '​';
}

function clearLints() { lint.items = []; el.lints.innerHTML = ''; }

/** Keep underlines in place while typing: shift the ones after the edit, drop the ones it touched. */
function shiftLints(next) {
  const prev = prevText;
  prevText = next;
  if (!lint.items.length || prev === next) return;
  const max = Math.min(prev.length, next.length);
  let a = 0;
  while (a < max && prev[a] === next[a]) a++;
  let b = 0;
  while (b < max - a && prev[prev.length - 1 - b] === next[next.length - 1 - b]) b++;
  const oldEnd = prev.length - b;
  const delta = next.length - prev.length;
  lint.items = lint.items
    .filter((l) => l.end < a || l.start > oldEnd)
    .map((l) => (l.start > oldEnd ? { ...l, start: l.start + delta, end: l.end + delta } : l));
  renderLints();
}

function setLintStatus(mode) {
  const b = $('#stLint');
  const n = lint.items.length;
  const label = mode === 'loading' ? 'Loading writing checks…'
    : mode === 'checking' && !n ? 'Checking…'
    : mode === 'error' ? 'Checks unavailable'
    : n ? `${n} suggestion${n === 1 ? '' : 's'}` : 'No issues';
  b.querySelector('span').textContent = label;
  b.dataset.state = mode === 'error' ? 'error' : n ? 'issues' : mode === 'loading' ? 'loading' : 'clean';
  b.title = mode === 'error' ? `Harper could not start: ${lint.error}` : 'Writing checks by Harper. Click to list them.';
}

function applySuggestion(l, s) {
  if (el.ta.value.slice(l.start, l.end) !== l.problem) return scheduleLint(0);
  if (s.kind === 1) replace(el.ta, l.start, l.end, '');
  else if (s.kind === 2) replace(el.ta, l.end, l.end, s.text);
  else replace(el.ta, l.start, l.end, s.text, l.start + s.text.length);
  scheduleLint(150);
}

async function addWord(word) {
  try {
    const r = await api('PUT', '/api/dictionary', { add: word });
    vstore.set('words', r.words);
  } catch {
    vstore.set('words', [...new Set([...vstore.get('words', []), word])]);
  }
  await spell.addWords([word]);
  lint.items = lint.items.filter((x) => !(x.group === 'spelling' && x.problem.toLowerCase() === word.toLowerCase()));
  renderLints();
  setLintStatus();
  toast(`Added “${word}” to the dictionary`);
}

function lintMenu(l, anchor) {
  const sugs = l.suggestions.map((s) => ({
    icon: 'check',
    label: s.kind === 1 ? 'Remove it' : s.kind === 2 ? `Add “${s.text}”` : s.text ? `Change to “${s.text}”` : 'Remove it',
    run: () => applySuggestion(l, s),
  }));
  menu(anchor, [
    { message: l.message, kind: l.group },
    ...sugs,
    ...(sugs.length ? ['-'] : []),
    ...(l.group === 'spelling' ? [{ icon: 'plus', label: `Add “${l.problem}” to dictionary`, run: () => addWord(l.problem) }] : []),
    { icon: 'x', label: 'Ignore', run: async () => { await spell.ignore(el.ta.value, l); lint.items = lint.items.filter((x) => x !== l); renderLints(); setLintStatus(); } },
  ]);
}

el.ta.addEventListener('contextmenu', (e) => {
  if (!lint.items.length) return;
  const hit = $$('.lint', el.lints).find((span) => [...span.getClientRects()].some((r) =>
    e.clientX >= r.left - 1 && e.clientX <= r.right + 1 && e.clientY >= r.top - 2 && e.clientY <= r.bottom + 2));
  if (!hit) return; // the browser's own menu
  e.preventDefault();
  lintMenu(lint.items[+hit.dataset.i], { x: e.clientX, y: e.clientY });
});

function selectRange(start, end) {
  if (el.ws.dataset.mode === 'read') setMode('write');
  el.ta.focus({ preventScroll: true });
  el.ta.setSelectionRange(start, end);
  const rect = caretRect(el.hl, start);
  if (rect) {
    const pane = el.editPane.getBoundingClientRect();
    el.editPane.scrollTop += rect.top - pane.top - pane.height * 0.35;
  }
}

function nextIssue() {
  if (!lint.items.length) return toast('No writing suggestions');
  const pos = el.ta.selectionEnd;
  const l = lint.items.find((x) => x.start > pos) || lint.items[0];
  selectRange(l.start, l.end);
  const span = el.lints.querySelector(`[data-i="${lint.items.indexOf(l)}"]`);
  if (span) { const r = span.getBoundingClientRect(); lintMenu(l, { x: r.left, y: r.bottom }); }
}

$('#stLint').addEventListener('click', (e) => {
  if (lint.error) return toast(`Writing checks could not start: ${lint.error}`, 'err');
  if (!lint.items.length) return;
  menu(e.currentTarget, [
    { header: `${lint.items.length} suggestion${lint.items.length === 1 ? '' : 's'}` },
    ...lint.items.slice(0, 30).map((l) => ({
      icon: l.group === 'spelling' ? 'type' : 'edit',
      label: `${l.problem.slice(0, 24) || '·'} · ${l.message.slice(0, 60)}`,
      run: () => selectRange(l.start, l.end),
    })),
  ]);
});

// ------------------------------------------------------------------ fuzzy matching
/** Score how well q matches s as a subsequence. Higher is better; null means no match. */
function fuzzy(q, s) {
  if (!q) return { score: 0, idx: [] };
  const ql = q.toLowerCase();
  const sl = s.toLowerCase();
  const direct = sl.indexOf(ql);
  if (direct >= 0) {
    const idx = [...Array(ql.length).keys()].map((k) => direct + k);
    return { score: 1000 - direct * 2 - s.length * 0.1 + (direct === 0 || /[\s/_-]/.test(s[direct - 1]) ? 200 : 0), idx };
  }
  let score = 0;
  let j = 0;
  let last = -2;
  const idx = [];
  for (let i = 0; i < sl.length && j < ql.length; i++) {
    if (sl[i] !== ql[j]) continue;
    score += i === last + 1 ? 12 : 1;
    if (i === 0 || /[\s/_-]/.test(s[i - 1])) score += 8;
    idx.push(i);
    last = i;
    j++;
  }
  return j === ql.length ? { score: score - s.length * 0.05, idx } : null;
}
function markMatch(s, idx) {
  if (!idx?.length) return esc(s);
  const set = new Set(idx);
  return [...s].map((ch, i) => (set.has(i) ? `<mark>${esc(ch)}</mark>` : esc(ch))).join('');
}

// ------------------------------------------------------------------ quick switcher & command palette
function picker({ placeholder, source }) {
  closeLayer();
  const bd = document.createElement('div');
  bd.className = 'backdrop picker-backdrop';
  bd.innerHTML = `<div class="picker glass" role="dialog" aria-label="${esc(placeholder)}">
    <input class="picker-input" placeholder="${esc(placeholder)}" spellcheck="false" autocomplete="off">
    <div class="picker-list scroll" role="listbox"></div>
    <div class="picker-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Ctrl Enter</kbd> new tab</span><span><kbd>Esc</kbd> close</span></div>
  </div>`;
  const input = bd.querySelector('input');
  const list = bd.querySelector('.picker-list');
  let items = [];
  let i = 0;
  const draw = () => {
    list.innerHTML = items.length ? items.map((it, k) => `<button class="pick-item${k === i ? ' active' : ''}" data-k="${k}" role="option">
      ${icon(it.icon || 'file')}<span class="pi-main"><span class="pi-label">${it.html || esc(it.label)}</span>${it.detail ? `<small>${esc(it.detail)}</small>` : ''}</span>
      ${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ''}</button>`).join('') : '<div class="tree-empty">Nothing matches.</div>';
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  const update = () => { items = source(input.value.trim()); i = 0; draw(); };
  const close = () => { document.removeEventListener('keydown', onKey, true); bd.remove(); if (layerCleanup === close) layerCleanup = null; };
  const choose = (it, e) => { if (!it) return; close(); it.run({ newTab: e.ctrlKey || e.metaKey, query: input.value.trim() }); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); i = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(items[i], e); }
  };
  input.addEventListener('input', update);
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) choose(items[+b.dataset.k], e); });
  list.addEventListener('mousemove', (e) => { const b = e.target.closest('[data-k]'); if (b && +b.dataset.k !== i) { i = +b.dataset.k; $$('.pick-item', list).forEach((x, k) => x.classList.toggle('active', k === i)); } });
  bd.addEventListener('pointerdown', (e) => { if (e.target === bd) close(); });
  document.addEventListener('keydown', onKey, true);
  el.layer.appendChild(bd);
  layerCleanup = close;
  update();
  input.focus();
}

function quickSwitcher() {
  picker({
    placeholder: 'Open a note…',
    source: (q) => {
      const notes = state.tree.notes;
      let out;
      if (!q) {
        out = [...notes].sort((a, b) => b.modified - a.modified).slice(0, 40).map((n) => ({ n }));
      } else {
        out = notes.map((n) => {
          const name = stem(n.path);
          const a = fuzzy(q, name);
          const b = fuzzy(q, n.path.replace(/\.md$/i, ''));
          const best = a && (!b || a.score + 50 >= b.score) ? { ...a, onName: true, score: a.score + 50 } : b;
          return best ? { n, ...best } : null;
        }).filter(Boolean).sort((x, y) => y.score - x.score).slice(0, 50);
      }
      const items = out.map(({ n, idx, onName }) => ({
        icon: 'file',
        label: stem(n.path),
        html: onName ? markMatch(stem(n.path), idx) : esc(stem(n.path)),
        detail: dirname(n.path) || '',
        run: ({ newTab }) => openNote(n.path, { newTab }),
      }));
      if (q && !notes.some((n) => stem(n.path).toLowerCase() === q.toLowerCase())) {
        items.push({ icon: 'filePlus', label: `Create “${q}”`, detail: defaultFolder() || 'Vault root', run: ({ newTab }) => newNote(defaultFolder(), cleanName(q), { editTitle: false, newTab }) });
      }
      return items;
    },
  });
}

function commandPalette() {
  picker({
    placeholder: 'Run a command…',
    source: (q) => allCommands()
      .map((c) => ({ c, m: fuzzy(q, c.label) }))
      .filter((x) => x.m)
      .sort((a, b) => b.m.score - a.m.score)
      .map(({ c, m }) => ({ icon: c.icon || 'command', label: c.label, html: markMatch(c.label, m.idx), detail: c.group, hint: c.def !== undefined ? comboLabel(keyFor(c.id)).replace('Not set', '') : '', run: () => c.run() })),
  });
}

// ------------------------------------------------------------------ [[ and # suggestions
const sug = { box: null, items: [], i: 0, kind: '', from: 0 };

function checkSuggest() {
  const ta = el.ta;
  if (document.activeElement !== ta || ta.selectionStart !== ta.selectionEnd) return closeSuggest();
  const pos = ta.selectionStart;
  const before = ta.value.slice(Math.max(0, pos - 160), pos);
  let m;
  if (state.settings.linkSuggest && (m = before.match(/\[\[([^\[\]\n|#]*)$/))) return openSuggest('link', pos - m[1].length, m[1]);
  const lineStart = ta.value.lastIndexOf('\n', pos - 1) + 1;
  if (state.settings.tagSuggest && (m = before.match(/(?:^|[\s(])#([\p{L}\p{N}_\/-]+)$/u)) && !/^#{1,6}\s/.test(ta.value.slice(lineStart, pos))) {
    return openSuggest('tag', pos - m[1].length, m[1]);
  }
  // "/" at the start of a line or after a space opens the slash menu
  if (state.settings.slashMenu && (m = ta.value.slice(lineStart, pos).match(/(?:^|\s)\/([\p{L}\d-]{0,24})$/u))) {
    return openSuggest('slash', pos - m[1].length - 1, m[1]);
  }
  closeSuggest();
}

function openSuggest(kind, from, q) {
  let items;
  if (kind === 'link') {
    items = state.tree.notes
      .map((n) => ({ n, m: fuzzy(q, stem(n.path)) || fuzzy(q, n.path) }))
      .filter((x) => x.m && x.n.path !== state.cur?.path)
      .sort((a, b) => b.m.score - a.m.score || b.n.modified - a.n.modified)
      .slice(0, 8)
      .map(({ n, m }) => ({ value: stem(n.path), html: markMatch(stem(n.path), q ? m.idx : []), detail: dirname(n.path), icon: 'file' }));
    if (q && !state.tree.notes.some((n) => stem(n.path).toLowerCase() === q.toLowerCase())) items.push({ value: q, html: `New note “${esc(q)}”`, icon: 'filePlus' });
  } else if (kind === 'slash') {
    items = SLASH
      .map((c) => ({ c, m: fuzzy(q, c.label) || fuzzy(q, c.keys || '') }))
      .filter((x) => x.m)
      .sort((a, b) => (q ? b.m.score - a.m.score : 0))
      .slice(0, q ? 8 : 40)
      .map(({ c, m }) => ({ value: c, html: q && fuzzy(q, c.label) ? markMatch(c.label, m.idx) : esc(c.label), detail: c.hint || '', icon: c.icon }));
  } else {
    const counts = new Map();
    for (const n of state.tree.notes) for (const t of n.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    items = [...counts.entries()]
      .map(([t, c]) => ({ t, c, m: fuzzy(q, t) }))
      .filter((x) => x.m && x.t.toLowerCase() !== q.toLowerCase())
      .sort((a, b) => b.m.score - a.m.score || b.c - a.c)
      .slice(0, 8)
      .map(({ t, c, m }) => ({ value: t, html: '#' + markMatch(t, m.idx), detail: `${c}`, icon: 'hash' }));
  }
  if (!items.length) return closeSuggest();
  Object.assign(sug, { items, i: 0, kind, from });
  if (!sug.box) {
    sug.box = document.createElement('div');
    sug.box.className = 'suggest glass';
    sug.box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const b = e.target.closest('[data-k]');
      if (b) { sug.i = +b.dataset.k; acceptSuggest(); }
    });
    document.body.appendChild(sug.box);
  }
  sug.box.innerHTML = items.map((it, k) => `<button class="pick-item${k === sug.i ? ' active' : ''}" data-k="${k}">${icon(it.icon)}<span class="pi-main"><span class="pi-label">${it.html}</span></span>${it.detail ? `<small>${esc(it.detail)}</small>` : ''}</button>`).join('');
  positionSuggest();
}

function positionSuggest() {
  if (!sug.box) return;
  const rect = caretRect(el.hl, el.ta.selectionStart);
  if (!rect) return;
  const w = sug.box.offsetWidth;
  const h = sug.box.offsetHeight;
  let x = Math.min(rect.left, innerWidth - w - 8);
  let y = rect.bottom + 6;
  if (y + h > innerHeight - 8) y = rect.top - h - 6;
  Object.assign(sug.box.style, { left: `${Math.max(8, x)}px`, top: `${Math.max(8, y)}px` });
}

function closeSuggest() { if (sug.box) { sug.box.remove(); sug.box = null; } sug.items = []; }

// ------------------------------------------------------------------ slash menu
// \u0001 marks where the cursor lands; text up to \u0002 is selected so typing replaces it.
// Block snippets start on their own line.
const SLASH = [
  { label: 'Heading 1', keys: 'h1 title', icon: 'heading', text: '# \u0001', block: true },
  { label: 'Heading 2', keys: 'h2', icon: 'heading', text: '## \u0001', block: true },
  { label: 'Heading 3', keys: 'h3', icon: 'heading', text: '### \u0001', block: true },
  { label: 'Bulleted list', keys: 'ul bullet', icon: 'list', text: '- \u0001', block: true },
  { label: 'Numbered list', keys: 'ol ordered', icon: 'outline', text: '1. \u0001', block: true },
  { label: 'Checklist', keys: 'todo task checkbox', icon: 'task', text: '- [ ] \u0001', block: true },
  { label: 'Quote', keys: 'blockquote', icon: 'quote', text: '> \u0001', block: true },
  { label: 'Callout: note', keys: 'callout info', icon: 'quote', text: '> [!note] \u0001\n> ', block: true },
  { label: 'Callout: tip', keys: 'callout', icon: 'quote', text: '> [!tip] \u0001\n> ', block: true },
  { label: 'Callout: warning', keys: 'callout caution', icon: 'quote', text: '> [!warning] \u0001\n> ', block: true },
  { label: 'Table', keys: 'grid', icon: 'layout', hint: 'Tab moves between cells', text: '| \u0001Column\u0002 | Column |\n| ------ | ------ |\n|        |        |', block: true },
  { label: 'Code block', keys: 'pre fence', icon: 'code', text: '```\u0001\n\n```', block: true },
  { label: 'Math block', keys: 'latex tex equation', icon: 'type', text: '$$\n\u0001\n$$', block: true },
  { label: 'Diagram', keys: 'mermaid chart flow', icon: 'share', text: '```mermaid\ngraph TD\n  A[\u0001Start\u0002] --> B[End]\n```', block: true },
  { label: 'Divider', keys: 'hr rule line', icon: 'width', text: '---\n\u0001', block: true },
  { label: 'Link to a note', keys: 'wikilink', icon: 'link', text: '[[\u0001', after: () => checkSuggest() },
  { label: 'Embed a note', keys: 'transclude include', icon: 'file', text: '![[\u0001', block: true, after: () => checkSuggest() },
  { label: 'Image', keys: 'picture upload photo', icon: 'image', run: () => $('#fileInput').click() },
  { label: 'Template', keys: 'insert', icon: 'template', run: () => insertTemplate() },
  { label: 'Properties', keys: 'front matter yaml metadata', icon: 'outline', run: () => addProperties() },
  { label: 'Today’s date', keys: 'now day', icon: 'calendar', text: () => formatDate(new Date(), 'YYYY-MM-DD') + '\u0001' },
  { label: 'Current time', keys: 'now clock', icon: 'calendar', text: () => formatDate(new Date(), 'HH:mm') + '\u0001' },
];

function runSlash(c, from, to) {
  const ta = el.ta;
  replace(ta, from, to, '', from); // remove the "/query"
  if (c.run) return c.run();
  let text = typeof c.text === 'function' ? c.text() : c.text;
  const ls = ta.value.lastIndexOf('\n', from - 1) + 1;
  if (c.block && ta.value.slice(ls, from).trim()) text = '\n' + text;
  const a = text.indexOf('\u0001');
  const b = text.indexOf('\u0002');
  const clean = text.replace('\u0001', '').replace('\u0002', '');
  const start = from + (a < 0 ? clean.length : a);
  replace(ta, from, from, clean, start, b > a && a >= 0 ? from + b - 1 : start);
  c.after?.();
}

function acceptSuggest() {
  const it = sug.items[sug.i];
  if (!it) return closeSuggest();
  const pos = el.ta.selectionStart;
  const after = el.ta.value.slice(pos, pos + 2);
  if (sug.kind === 'slash') {
    closeSuggest();
    return runSlash(it.value, sug.from, pos);
  }
  if (sug.kind === 'link') {
    if (after === ']]') replace(el.ta, sug.from, pos, it.value, sug.from + it.value.length + 2);
    else replace(el.ta, sug.from, pos, `${it.value}]]`, sug.from + it.value.length + 2);
  } else {
    const space = /^\s/.test(after) ? '' : ' ';
    replace(el.ta, sug.from, pos, it.value + space, sug.from + it.value.length + space.length);
  }
  closeSuggest();
}

function suggestKey(e) {
  if (!sug.box) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    sug.i = (sug.i + (e.key === 'ArrowDown' ? 1 : -1) + sug.items.length) % sug.items.length;
    $$('.pick-item', sug.box).forEach((b, k) => b.classList.toggle('active', k === sug.i));
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptSuggest(); return true; }
  if (e.key === 'Escape') { e.preventDefault(); closeSuggest(); return true; }
  return false;
}
// Typing near the bottom scrolls the editor, so the popup follows the cursor rather than closing.
el.editPane.addEventListener('scroll', () => requestAnimationFrame(positionSuggest), { passive: true });

// ------------------------------------------------------------------ outline & backlinks
function headings(text) {
  const out = [];
  let fence = false;
  let offset = 0;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence) {
      const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (m) out.push({ level: m[1].length, text: m[2], offset });
    }
    offset += line.length + 1;
  }
  return out;
}
const plain = (md) => md.replace(/[*_`~=]|\[\[|\]\]|\[([^\]]*)\]\([^)]*\)/g, (m, t) => t ?? '');

function renderOutline() {
  if (state.panel !== 'outline') return;
  const box = $('#outline');
  if (!state.cur) { box.innerHTML = '<div class="tree-empty">Open a note to see its outline.</div>'; return; }
  const hs = headings(el.ta.value);
  const min = Math.min(...hs.map((h) => h.level));
  box.innerHTML = hs.length
    ? hs.map((h, k) => `<button class="hit outline-item" style="--lv:${h.level - min}" data-k="${k}">${esc(plain(h.text))}</button>`).join('')
    : '<div class="tree-empty">This note has no headings yet. Start a line with # to add one.</div>';
  box.onclick = (e) => {
    const b = e.target.closest('[data-k]');
    if (!b) return;
    const h = hs[+b.dataset.k];
    if (el.ws.dataset.mode === 'read') el.preview.querySelector(`[id="${CSS.escape(slug(h.text))}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else selectRange(h.offset, h.offset);
    if (mobile.matches) closeDrawer();
  };
}
const outlineSoon = debounce(renderOutline, 300);

let backlinkSeq = 0;
async function renderBacklinks() {
  if (state.panel !== 'links') return;
  const box = $('#backlinks');
  const cur = state.cur;
  if (!cur) { box.innerHTML = '<div class="tree-empty">Open a note to see what links to it.</div>'; return; }
  const seq = ++backlinkSeq;
  let r;
  try { r = await api('GET', `/api/backlinks?path=${enc(cur.path)}`); }
  catch (e) { if (seq === backlinkSeq) box.innerHTML = `<div class="tree-empty">${e.offline ? 'Backlinks need the server.' : esc(e.message)}</div>`; return; }
  if (seq !== backlinkSeq) return;
  const name = stem(cur.path);
  const rx = new RegExp(`(\\[\\[[^\\]]*\\]\\]|${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  const line = (l) => esc(l).replace(rx, '<mark>$1</mark>');
  const section = (title, list, empty) => `<div class="list-label">${title} · ${list.length}</div>`
    + (list.length ? list.map((n) => `<button class="hit" data-open="${esc(n.path)}"><b>${esc(stem(n.path))}</b>${n.lines.map((l) => `<small>${line(l)}</small>`).join('')}</button>`).join('') : `<div class="tree-empty">${empty}</div>`);
  box.innerHTML = section('Linked', r.linked, 'No notes link here yet.') + section('Mentioned', r.unlinked, `No other notes mention “${esc(name)}”.`);
}
$('#backlinks').addEventListener('click', (e) => { const b = e.target.closest('[data-open]'); if (b) openNote(b.dataset.open, { newTab: e.ctrlKey || e.metaKey }); });
const backlinksSoon = debounce(renderBacklinks, 1200);

// ------------------------------------------------------------------ daily notes & templates
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function formatDate(d, fmt) {
  const m = d.getMonth();
  const h = d.getHours();
  const map = {
    YYYY: d.getFullYear(), YY: String(d.getFullYear()).slice(2), MMMM: MONTHS[m], MMM: MONTHS[m].slice(0, 3), MM: pad(m + 1), M: m + 1,
    dddd: DAYS[d.getDay()], ddd: DAYS[d.getDay()].slice(0, 3), DD: pad(d.getDate()), D: d.getDate(),
    HH: pad(h), H: h, hh: pad(h % 12 || 12), h: h % 12 || 12, mm: pad(d.getMinutes()), ss: pad(d.getSeconds()), A: h < 12 ? 'AM' : 'PM',
  };
  return fmt.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|H|hh|h|mm|ss|A/g, (t, lit) => lit ?? String(map[t]));
}

/** Fill in {{title}}, {{date}}, {{date:FORMAT}}, {{time}}, {{yesterday}}, {{tomorrow}}, {{weekday}} and {{cursor}}. */
function applyTemplate(text, title, when = new Date()) {
  const day = 86_400_000;
  let cursor = false;
  return text.replace(/\{\{\s*(\w+)(?::([^}]+))?\s*\}\}/g, (m, key, fmt) => {
    switch (key.toLowerCase()) {
      case 'title': return title;
      case 'date': return formatDate(when, fmt || 'YYYY-MM-DD');
      case 'time': return formatDate(when, fmt || 'HH:mm');
      case 'yesterday': return formatDate(new Date(+when - day), fmt || 'YYYY-MM-DD');
      case 'tomorrow': return formatDate(new Date(+when + day), fmt || 'YYYY-MM-DD');
      case 'weekday': return formatDate(when, 'dddd');
      case 'cursor': if (cursor) return ''; cursor = true; return '\u0001';
      default: return m;
    }
  });
}

async function noteText(path) {
  try { return (await api('GET', `/api/note?path=${enc(path)}`)).content; }
  catch { return (await idb.get(`${VAULT}|note|${path}`))?.content ?? ''; }
}

async function openDaily(offset = 0) {
  const s = state.settings;
  const when = new Date(Date.now() + offset * 86_400_000);
  const name = cleanName(formatDate(when, s.dailyFormat || 'YYYY-MM-DD')) || formatDate(when, 'YYYY-MM-DD');
  const folder = (s.dailyFolder || '').split('/').map(cleanName).filter(Boolean).join('/');
  const path = join(folder, `${name}.md`);
  if (noteByPath(path)) return openNote(path);
  const template = s.dailyTemplate && noteByPath(s.dailyTemplate) ? applyTemplate(await noteText(s.dailyTemplate), name, when) : '';
  await newNote(folder, name, { content: template, editTitle: false });
}

function templateNotes() {
  const folder = (state.settings.templatesFolder || 'Templates').replace(/^\/+|\/+$/g, '');
  return state.tree.notes.filter((n) => n.path.startsWith(folder + '/'));
}

function pickTemplate(title, then) {
  const list = templateNotes();
  if (!list.length) return toast(`Put notes in “${state.settings.templatesFolder || 'Templates'}” to use them as templates`);
  picker({
    placeholder: title,
    source: (q) => list.map((n) => ({ n, m: fuzzy(q, stem(n.path)) })).filter((x) => x.m)
      .sort((a, b) => b.m.score - a.m.score)
      .map(({ n, m }) => ({ icon: 'template', label: stem(n.path), html: markMatch(stem(n.path), m.idx), run: () => then(n.path) })),
  });
}

function insertTemplate() {
  if (!state.cur) return toast('Open a note first');
  pickTemplate('Insert a template…', async (path) => {
    const text = applyTemplate(await noteText(path), stem(state.cur.path));
    const at = el.ta.selectionStart;
    const cursor = text.indexOf('\u0001');
    const clean = text.replace('\u0001', '');
    replace(el.ta, at, el.ta.selectionEnd, clean, at + (cursor >= 0 ? cursor : clean.length));
  });
}

function newFromTemplate() {
  pickTemplate('New note from template…', async (path) => {
    const name = await dialog({ title: 'Name the new note', input: { value: defaultName() }, buttons: [{ label: 'Cancel' }, { label: 'Create', primary: true, value: true }] });
    if (!name || !cleanName(name)) return;
    newNote(defaultFolder(), cleanName(name), { content: applyTemplate(await noteText(path), cleanName(name)), editTitle: false });
  });
}

// ------------------------------------------------------------------ share links
async function shareDialog(path) {
  let shares;
  try { shares = (await api('GET', `/api/shares?path=${enc(path)}`)).shares; }
  catch (e) { return toast(e.offline ? 'Sharing needs the server' : e.message, 'err'); }
  const box = document.createElement('div');
  const url = (t) => `${location.origin}/s/${t}`;
  const paint = () => {
    box.innerHTML = (shares.length ? shares.map((s) => `
      <div class="share-row"><input class="txt" readonly value="${esc(url(s.token))}"><button class="btn sm" data-copy="${esc(s.token)}">Copy</button><button class="btn sm danger-outline" data-rm="${esc(s.token)}">Remove</button></div>
      <small class="share-meta">${s.views} view${s.views === 1 ? '' : 's'} · ${s.expires ? `expires ${fmtDate(s.expires)}` : 'never expires'}</small>`).join('') : '')
      + `<div class="share-row new"><select class="sel" data-days><option value="0">Never expires</option><option value="1">Expires in a day</option><option value="7">Expires in a week</option><option value="30">Expires in 30 days</option></select>
         <button class="btn sm ${shares.length ? '' : 'primary'}" data-create>${shares.length ? 'Another link' : 'Create link'}</button></div>`;
  };
  box.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) return copyText(url(c.dataset.copy), 'Link copied');
    try {
      const rm = e.target.closest('[data-rm]');
      if (rm) { await api('DELETE', `/api/shares?token=${enc(rm.dataset.rm)}`); shares = shares.filter((s) => s.token !== rm.dataset.rm); paint(); }
      if (e.target.closest('[data-create]')) {
        const s = await api('POST', '/api/shares', { path, days: +box.querySelector('[data-days]').value });
        shares.unshift(s);
        paint();
        copyText(url(s.token), 'Link created and copied');
      }
    } catch (err) { toast(err.message, 'err'); }
  });
  paint();
  dialog({
    title: `Share “${stem(path)}”`,
    text: 'Anyone with the link can read this note, but not edit it, along with the images it uses. Nothing else in the vault is visible. Your server has to be reachable from where the link is opened.',
    content: box,
    buttons: [{ label: 'Done', primary: true }],
  });
}

// ------------------------------------------------------------------ accounts (each account is a vault)
const accounts = { list: store.get('accounts', []), needServer: false };
const currentAccount = () => accounts.list.find((a) => a.id === VAULT) || { id: VAULT, name: VAULT, icon: null };

/** An account's picture: an uploaded image, or a glyph on its own tint. */
function avatar(a, cls = '') {
  const ic = a?.icon || {};
  if (ic.type === 'image') return `<span class="avatar ${cls}"><img src="/api/account-icon?id=${enc(a.id)}&v=${ic.v}" alt=""></span>`;
  const glyph = ic.name === 'snowflake' || !ic.name ? 'logo' : ic.name;
  return `<span class="avatar ${cls}" style="--ah:${ic.hue ?? 212}">${icon(glyph)}</span>`;
}

async function loadAccounts() {
  const r = await api('GET', '/api/accounts');
  accounts.list = r.accounts;
  accounts.needServer = r.createNeedsServerPassword;
  store.set('accounts', r.accounts);
  renderAccountBtn();
  return r.accounts;
}

function renderAccountBtn() {
  const a = currentAccount();
  $('#vaultBtn').innerHTML = avatar(a, 'sm');
  $('#vaultBtn').title = `${a.name}${a.locked ? ' · password protected' : ''}`;
}

/** Decide which account to open. Returns false when the landing page takes over instead. */
async function chooseAccount() {
  let list;
  try { list = await loadAccounts(); } catch (e) {
    if (e.offline) { renderAccountBtn(); return true; } // keep working from this device's copy
    throw e;
  }
  const chosen = store.get('vault', null) !== null; // has this browser picked an account before?
  const cur = list.find((a) => a.id === VAULT);
  if (list.length === 1 && cur?.open) return true; // one open account: nothing to choose
  if (chosen && cur?.open) return true;
  const only = list.length === 1 && list[0].open ? list[0] : null;
  if (!cur && only) { store.set('vault', only.id); location.reload(); return false; }
  showLanding({ account: chosen && cur?.locked ? cur.id : null });
  return false;
}

function enterAccount(id) {
  store.set('vault', id);
  history.replaceState(null, '', location.pathname);
  location.reload();
}

async function switchAccount(id) {
  if (id === VAULT) return;
  const a = accounts.list.find((x) => x.id === id);
  await flushSave();
  if (a && !a.open) return showLanding({ account: id });
  enterAccount(id);
}

let landingFrom = null;
async function showLanding({ account = null, create = false } = {}) {
  closeLayer();
  if (state.cur) await flushSave().catch(() => {});
  try { await loadAccounts(); } catch { /* show what we have */ }
  const land = $('#landing');
  land.hidden = false;
  document.body.classList.add('locked');
  const grid = $('#accountGrid');
  grid.innerHTML = accounts.list.map((a) => `<button class="account-tile${a.id === VAULT ? ' current' : ''}" data-account="${esc(a.id)}">
      ${avatar(a, 'xl')}<span class="account-name">${esc(a.name)}</span>${a.locked ? `<span class="account-lock">${icon(a.open ? 'check' : 'key')}${a.open ? 'Unlocked' : 'Password'}</span>` : ''}
    </button>`).join('') + `<button class="account-tile add" data-add>${'<span class="avatar xl add">' + icon('plus') + '</span>'}<span class="account-name">Add account</span></button>`;
  landingFrom = state.cur ? 'app' : 'boot';
  $('#unlockForm').hidden = true;
  $('#createForm').hidden = true;
  grid.hidden = false;
  $('#landingSub').textContent = accounts.list.length > 1 ? 'Choose an account' : 'Welcome back';
  if (account) openUnlock(account);
  if (create) openCreate();
}

function closeLanding() {
  $('#landing').hidden = true;
  document.body.classList.remove('locked');
}

function openUnlock(id) {
  const a = accounts.list.find((x) => x.id === id);
  if (!a) return;
  $('#accountGrid').hidden = true;
  $('#unlockForm').hidden = false;
  $('#unlockForm').dataset.id = id;
  $('#unlockWho').innerHTML = `${avatar(a, 'xl')}<b>${esc(a.name)}</b>`;
  $('#unlockUser').value = a.name;
  $('#unlockError').textContent = '';
  $('#unlockPass').value = '';
  $('#landingSub').textContent = 'This account has a password';
  setTimeout(() => $('#unlockPass').focus(), 30);
}

function openCreate() {
  $('#accountGrid').hidden = true;
  $('#createForm').hidden = false;
  $('#createServer').hidden = !accounts.needServer;
  $('#createServer').required = accounts.needServer;
  $('#createError').textContent = '';
  $('#landingSub').textContent = 'New account';
  setTimeout(() => $('#createName').focus(), 30);
}

$('#accountGrid').addEventListener('click', (e) => {
  if (e.target.closest('[data-add]')) return openCreate();
  const t = e.target.closest('[data-account]');
  if (!t) return;
  const a = accounts.list.find((x) => x.id === t.dataset.account);
  if (!a) return;
  if (!a.open) return openUnlock(a.id);
  if (a.id === VAULT && landingFrom === 'app') return closeLanding();
  enterAccount(a.id);
});
$('#landing').addEventListener('click', (e) => {
  if (!e.target.closest('[data-back]')) return;
  $('#unlockForm').hidden = true;
  $('#createForm').hidden = true;
  $('#accountGrid').hidden = false;
  $('#landingSub').textContent = accounts.list.length > 1 ? 'Choose an account' : 'Welcome back';
});
$('#landing').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && landingFrom === 'app' && currentAccount().open !== false) closeLanding();
});

$('#unlockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const id = e.target.dataset.id;
    await api('POST', '/api/accounts/unlock', { id, password: $('#unlockPass').value, remember: $('#unlockRemember').checked });
    enterAccount(id);
  } catch (err) {
    $('#unlockError').textContent = err.offline ? 'The server can’t be reached.' : err.message;
    $('#unlockPass').select();
  } finally { btn.disabled = false; }
});

$('#createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const a = await api('POST', '/api/accounts', { name: $('#createName').value.trim(), password: $('#createPass').value, serverPassword: $('#createServer').value });
    enterAccount(a.id);
  } catch (err) {
    $('#createError').textContent = err.offline ? 'The server can’t be reached.' : err.message;
  } finally { btn.disabled = false; }
});

async function lockAccount() {
  await flushSave();
  try { await api('POST', '/api/accounts/lock', { id: VAULT }); } catch { /* locking locally still hides it */ }
  showLanding();
}

$('#vaultBtn').addEventListener('click', async (e) => {
  const anchor = e.currentTarget;
  try { await loadAccounts(); } catch { /* offline: use what we have */ }
  const cur = currentAccount();
  const others = accounts.list.filter((a) => a.id !== VAULT);
  menu(anchor, [
    { header: cur.name },
    { icon: 'gear', label: 'Account settings…', run: () => showSettings('general') },
    ...(cur.locked ? [{ icon: 'logout', label: 'Lock this account', run: lockAccount }] : []),
    '-',
    ...(others.length ? [{ header: 'Switch to' }, ...others.map((a) => ({ icon: a.locked && !a.open ? 'key' : 'user', label: a.name, run: () => switchAccount(a.id) }))] : []),
    { icon: 'plus', label: 'Add account…', run: () => showLanding({ create: true }) },
    { icon: 'layout', label: 'All accounts', run: () => showLanding() },
  ]);
});

// ------------------------------------------------------------------ live sync
let live = null;
const liveRefresh = debounce(() => { refreshTree(); backlinksSoon(); }, 250);
function connectLive() {
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

// ------------------------------------------------------------------ settings window
function showSettings(category) {
  openSettings({
    state, DEFAULTS, ACCENTS, WIDTHS, SORTS, COMMANDS,
    setSetting, setConfig, applySettings, api, toast, dialog, closeLayer, pending,
    keyFor, comboLabel, comboFromEvent, fmtBytes, fmtDateTime, relTime, saveFile,
    refreshTree, flushPending, openHistory: (p) => openHistory(p),
    stem, dirname, isMac, idb, VAULT, syncNow, spell, startSpell, GROUPS, formatDate, templateNotes,
    importFiles, liveConnected: () => live?.readyState === 1, avatar, loadAccounts, currentAccount, showLanding, switchAccount, lockAccount,
    accounts: () => accounts.list,
    replaceSettings(next) { state.settings = mergeSettings(next); applySettings(); setMode(state.settings.mode, false); renderTree(); startSpell(); },
  }, category);
}

// ------------------------------------------------------------------ lifecycle
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (state.cur?.dirty) { pending.put(state.cur.path, state.cur.content, state.cur.version); if (!manual()) save(); }
  } else refreshTree();
});
window.addEventListener('pagehide', () => { if (state.cur?.dirty) pending.put(state.cur.path, state.cur.content, state.cur.version); });
window.addEventListener('online', () => { if (!manual()) flushPending(); });

/**
 * Sync modes:
 *   live      changes stream in from the server as they happen (with a slow poll as backup)
 *   interval  check the server every N seconds
 *   manual    nothing is sent until you press Sync; edits wait on this device
 */
let pollTimer = 0;
let pollKey = '';
function schedulePoll() {
  const mode = state.settings.syncMode;
  const every = mode === 'manual' ? 0 : mode === 'live' ? 60_000 : Math.max(5, +state.settings.pollInterval || 20) * 1000;
  const key = `${mode}:${every}`;
  if (key === pollKey) return;
  pollKey = key;
  clearInterval(pollTimer);
  if (every) pollTimer = setInterval(() => { if (document.visibilityState === 'visible') refreshTree(); }, every);
  connectLive();
}

async function boot() {
  if (!(await chooseAccount())) return;
  applySettings();
  if (store.get('collapsed', false)) el.app.classList.add('sb-collapsed');
  $$('.panel').forEach((p) => { p.hidden = p.dataset.panel !== state.panel; });
  $$('.ptab[data-panel]').forEach((b) => b.classList.toggle('active', b.dataset.panel === state.panel));
  setMode(state.settings.mode, false);
  setFocus(false);
  el.main.classList.add('no-note');
  const s = state.settings;
  if (s.startup === 'empty') { state.tabs = [{ path: null, scroll: 0 }]; state.active = 0; }
  if (s.startup === 'note' && s.startupNote) { state.tabs = [{ path: s.startupNote, scroll: 0 }]; state.active = 0; }
  renderTabs();
  api('GET', '/api/config').then((c) => { state.config = c; }).catch(() => {});
  await refreshTree();
  if (state.panel === 'search') renderSearch();

  // Restore tabs, dropping any whose note no longer exists.
  const exists = (p) => state.tree.notes.some((n) => n.path === p) || !!pending.all()[p];
  const activeTab = state.tabs[state.active];
  state.tabs = state.tabs.filter((t) => t === activeTab || !t.path || exists(t.path));
  state.active = state.tabs.indexOf(activeTab);
  if (activeTab.path && !exists(activeTab.path)) activeTab.path = null;
  const fromHash = pathFromHash();
  if (fromHash && exists(fromHash)) {
    const i = state.tabs.findIndex((t) => t.path === fromHash);
    if (i >= 0) state.active = i; else state.tabs[state.active].path = fromHash;
  }
  const t = state.tabs[state.active];
  if (!t.path || !(await loadNote(t.path, { history: 'replace' }))) showEmpty();
  renderTabs();
  if (!manual()) flushPending();
  else if (Object.keys(pending.all()).length) setSync('local');
  await receiveShare();
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (window.requestIdleCallback) requestIdleCallback(() => startSpell(), { timeout: 2000 });
  else setTimeout(startSpell, 400);
}

/** Text shared to Polarboard from another app (installed app share sheet) lands in Inbox. */
async function receiveShare() {
  const p = new URLSearchParams(location.search);
  if (!p.has('text') && !p.has('url') && !p.has('title')) return;
  history.replaceState(null, '', location.pathname);
  const text = [p.get('title'), p.get('text'), p.get('url')].filter(Boolean).join(' · ');
  try {
    const r = await api('POST', '/api/append', { path: 'Inbox', text: `- ${formatDate(new Date(), 'YYYY-MM-DD HH:mm')} ${text}` });
    await refreshTree();
    openNote(r.path);
    toast('Added to Inbox');
  } catch { toast('Could not save what was shared', 'err'); }
}
boot();
