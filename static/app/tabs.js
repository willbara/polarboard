import { esc } from '../markdown.js';
import { icon } from '../icons.js';
import { idb } from '../offline.js';
import { edit } from './commands.js';
import { $, VAULT, api, dirname, el, enc, mobile, noteByPath, relTime, state, stem, vstore } from './core.js';
import { tagsDialog } from './notes.js';
import { closeDrawer, markActiveHit, renderBacklinks, renderTags, showPanel } from './panels.js';
import { cacheNote, flushSave, pending, scheduleSave, setSync } from './sync.js';
import { refreshTree, renderTree, setMeta, setOpen } from './tree.js';
import { toast } from './ui.js';
import { block, setEditorValue, updateStatus } from './writing.js';
import { replace } from '../editor.js';

// ------------------------------------------------------------------ opening & tabs
/**
 * Open a note the way Obsidian does: reuse its tab if it is already open,
 * otherwise show it in the current tab (or a new one with newTab).
 */
export async function openNote(path, { fromHash = false, newTab = false } = {}) {
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
export async function loadNote(path, { history: hist = 'push', scroll = 0, pscroll = 0 } = {}) {
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

export function persistTabs() { vstore.set('tabs', { tabs: state.tabs.map((t) => t.path), active: state.active }); }

export function rememberScroll() {
  const t = state.tabs[state.active];
  if (t && state.cur) { t.scroll = el.editPane.scrollTop; t.pscroll = el.previewPane.scrollTop; }
}

export function renderTabs() {
  const box = $('#tabs');
  box.innerHTML = state.tabs.map((t, i) => {
    const label = t.path ? stem(t.path) : 'New tab';
    const dirty = i === state.active && state.cur?.dirty ? ' dirty' : '';
    return `<div class="tab${i === state.active ? ' active' : ''}${dirty}" data-i="${i}" role="tab" aria-selected="${i === state.active}" title="${esc(t.path || 'New tab')}">
      <span class="label">${esc(label)}</span><button class="close" data-close title="Close tab" aria-label="Close tab">${icon('x')}</button></div>`;
  }).join('');
  box.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

export async function switchTab(i, { history: hist = 'replace' } = {}) {
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

export async function newTab() {
  rememberScroll();
  await flushSave();
  state.tabs.splice(state.active + 1, 0, { path: null, scroll: 0 });
  state.active++;
  showEmpty();
}

export async function closeTab(i) {
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
export function forgetTabs(match) {
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

export function setHash(path, replaceState = false) {
  const h = '#/' + path.split('/').map(enc).join('/');
  if (location.hash === h) return;
  if (replaceState) history.replaceState(null, '', h); else history.pushState(null, '', h);
}

export function pathFromHash() {
  if (!location.hash.startsWith('#/')) return null;
  try { return location.hash.slice(2).split('/').map(decodeURIComponent).join('/'); } catch { return null; }
}
window.addEventListener('popstate', () => {
  const p = pathFromHash();
  if (p) openNote(p, { fromHash: true });
});

export function showNote() {
  el.main.classList.remove('no-note');
  setEditorValue(state.cur.content);
  showMeta();
  el.editPane.scrollTop = 0;
  el.previewPane.scrollTop = 0;
  renderTree();
  if (state.panel === 'search') markActiveHit();
  renderBacklinks();
}

export function showMeta() {
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
export function renderNoteTags() {
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

export function showEmpty() {
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

export function renderRecent() {
  const recent = [...state.tree.notes].sort((a, b) => b.modified - a.modified).slice(0, 5);
  $('#recent').innerHTML = recent.length
    ? `<div class="list-label">Recent</div>` + recent.map((n) => `<button class="hit" data-open="${esc(n.path)}"><b>${esc(stem(n.path))}<span>${relTime(n.modified)}</span></b></button>`).join('')
    : '';
}
$('#recent').addEventListener('click', (e) => { const b = e.target.closest('[data-open]'); if (b) openNote(b.dataset.open); });
