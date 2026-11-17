import { esc } from '../markdown.js';
import { icon } from '../icons.js';
import { idb } from '../offline.js';
import { $, $$, SORTS, VAULT, api, basename, copyText, dirname, el, enc, folderMeta, join, noteByPath, state, stem, vstore } from './core.js';
import { attachNoteDialog, attachToFolder, deleteFolder, deleteNote, download, duplicateNote, exportDialog, moveNoteDialog, newFolder, newNote, openHistory, renameFolder, renameNote, shareDialog, tagsDialog } from './notes.js';
import { plain, renderTags } from './panels.js';
import { cacheNote, flushSave, manual, pending, savingP, setSync } from './sync.js';
import { newTab, openNote, persistTabs, renderNoteTags, renderRecent, renderTabs, setHash, showMeta } from './tabs.js';
import { menu, toast } from './ui.js';
import { block, setEditorValue, updateStatus } from './writing.js';
import { edit } from './commands.js';

// ------------------------------------------------------------------ tree
export async function refreshTree() {
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
export function mergeLocalNotes() {
  for (const path of Object.keys(pending.all())) {
    if (noteByPath(path)) continue;
    state.tree.notes.push({ path, version: null, modified: Date.now(), created: Date.now(), tags: [], ownTags: [], inherited: [], local: true });
    for (let d = dirname(path); d; d = dirname(d)) if (!state.tree.folders.includes(d)) state.tree.folders.push(d);
  }
}

/** Keep an offline copy of every note, fetching only the ones that changed. */
export let prefetching = false;
export let lastPrefetch = 0;
export async function prefetchNotes(force = false) {
  if (prefetching || (!force && Date.now() - lastPrefetch < 60_000)) return;
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

export function patchTreeNote(info) {
  const i = state.tree.notes.findIndex((n) => n.path === info.path);
  const old = i >= 0 ? state.tree.notes[i] : null;
  if (old) state.tree.notes[i] = { ...old, ...info };
  else state.tree.notes.push(info);
  if ((old?.tags || []).join('\n') !== (info.tags || []).join('\n')) renderTags();
}

export async function checkRemoteChange() {
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

export function buildTree() {
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

export const countNotes = (f) => f.notes.length + [...f.folders.values()].reduce((a, c) => a + countNotes(c), 0);
export const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
export const SORTERS = {
  name: (a, b) => byName(stem(a.path), stem(b.path)),
  'name-desc': (a, b) => byName(stem(b.path), stem(a.path)),
  modified: (a, b) => b.modified - a.modified,
  'modified-asc': (a, b) => a.modified - b.modified,
  created: (a, b) => (b.created || 0) - (a.created || 0),
  'created-asc': (a, b) => (a.created || 0) - (b.created || 0),
};

export function renderTree() {
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

export function setOpen(path, open) {
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
export let dragPath = null;
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
export function moveLocalNote(from, to) {
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

export async function moveItem(from, to) {
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

export async function setMeta(path, set) {
  try {
    await api('POST', '/api/meta', { path, set });
    await refreshTree();
  } catch (e) { toast(e.message, 'err'); }
}

// ------------------------------------------------------------------ context menus
export function rowMenu(row, anchor) {
  if (row.dataset.note) noteMenu(row.dataset.note, anchor);
  else folderMenu(row.dataset.folder, anchor);
}

export function noteMenu(path, anchor) {
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

export function folderMenu(path, anchor) {
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

export function sortMenu(path, anchor) {
  const cur = folderMeta(path).sort;
  menu(anchor, [
    { header: `Sort “${basename(path)}”` },
    ...SORTS.map(([v, l]) => ({ icon: cur === v ? 'check' : 'blank', label: l, run: () => setMeta(path, { sort: v }) })),
    '-',
    { icon: !cur ? 'check' : 'blank', label: 'Use the default order', run: () => setMeta(path, { sort: null }) },
  ]);
}
