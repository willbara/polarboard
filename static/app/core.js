import { hydrateIcons } from '../icons.js';
import { EXPORT_DEFAULTS } from '../export.js';

// ------------------------------------------------------------------ settings model
export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
hydrateIcons();
/** Filled in by app.js, so this module never has to import the feature modules. */
export const hooks = {};
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
  linkSuggest: true, tagSuggest: true, slashMenu: true, tableKeys: true, previewEdit: true, hoverPreview: true,
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

export const store = {
  get(k, d) { try { const v = localStorage.getItem('pb:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pb:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
export const clone = (o) => JSON.parse(JSON.stringify(o));
export function mergeSettings(saved = {}) {
  return {
    ...clone(DEFAULTS), ...saved,
    status: { ...DEFAULTS.status, ...(saved.status || {}) },
    spellGroups: { ...DEFAULTS.spellGroups, ...(saved.spellGroups || {}) },
    harperRules: { ...(saved.harperRules || {}) },
    hotkeys: { ...(saved.hotkeys || {}) },
  };
}

// Everything about the open vault (tabs, folders, unsent edits) is stored per vault.
export const VAULT = store.get('vault', 'main');
export const vstore = {
  get: (k, d) => store.get(`${VAULT}:${k}`, d),
  set: (k, v) => store.set(`${VAULT}:${k}`, v),
};
// One id per browser tab, so live updates can skip the changes this tab made.
export const CLIENT = Math.random().toString(36).slice(2, 12);

export const state = {
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

export const el = {
  app: $('#app'), main: $('#main'), ws: $('#workspace'), ta: $('#ta'), hl: $('#hl'), lints: $('#lints'), finds: $('#finds'), editor: $('#editor'),
  title: $('#titleInput'), titleView: $('#titleView'), preview: $('#preview'),
  editPane: $('#editPane'), previewPane: $('#previewPane'), tree: $('#tree'),
  crumbs: $('#crumbs'), layer: $('#layer'),
};
export const mobile = matchMedia('(max-width: 760px)');
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// ------------------------------------------------------------------ utils
export const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
export const stem = (p) => basename(p).replace(/\.md$/i, '');
export const join = (a, b) => (a ? `${a}/${b}` : b);
export const enc = encodeURIComponent;
export const fmtNum = (n) => n.toLocaleString();
export const cleanName = (s) => s.replace(/[\\/:*?"<>|#^\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const noteByPath = (p) => state.tree.notes.find((n) => n.path === p);
export const folderMeta = (p) => state.tree.folderMeta?.[p] || {};
export const pad = (n) => String(n).padStart(2, '0');

export function relTime(ms) {
  if (!ms) return '';
  const s = (Date.now() - ms) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 6) return `${Math.round(s / 86400)}d ago`;
  return fmtDate(ms);
}
export function fmtDate(ms) {
  const d = new Date(ms);
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}
export function fmtDateTime(ms) {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}
export function copyText(text, msg = 'Copied') {
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => hooks.toast(msg), () => hooks.toast('Could not copy', 'err'));
  else hooks.toast('Clipboard needs HTTPS or localhost', 'err');
}

/**
 * Call the server. With opts.etag, a response the client already has comes back as
 * { notModified: true } instead of the whole body (the server answers 304).
 */
export async function api(method, url, body, opts = {}) {
  const opt = { method, headers: { 'X-Vault': state.vault, 'X-Polarboard': '1', 'X-Client': CLIENT } };
  if (opts.etag) { opt.headers['If-None-Match'] = opts.etag; opt.cache = 'no-store'; }
  if (body !== undefined) {
    if (body instanceof Blob) { opt.body = body; opt.headers['Content-Type'] = body.type || 'application/octet-stream'; }
    else { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  }
  let res;
  try { res = await fetch(url, opt); } catch {
    setOnline(false);
    const err = new Error('You appear to be offline'); err.offline = true; throw err;
  }
  if (res.status === 304) { setOnline(true); return { notModified: true, etag: opts.etag }; }
  if (opts.etag !== undefined) opts.etagOut = res.headers.get('ETag');
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.login) { hooks.showLanding({ account: data.account }); }
  else setOnline(res.status < 500 || res.status === 501);
  if (!res.ok) { const err = new Error(data.error || res.statusText); err.status = res.status; err.data = data; err.offline = res.status >= 502; throw err; }
  return data;
}

/** Track the connection; when it comes back, send queued edits (unless sync is manual). */
export function setOnline(on) {
  if (on === state.online) return;
  state.online = on;
  document.documentElement.classList.toggle('offline', !on);
  if (on && state.settings.syncMode !== 'manual') setTimeout(() => hooks.flushPending(), 300);
}
