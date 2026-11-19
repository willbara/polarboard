import { esc } from '../markdown.js';
import { icon } from '../icons.js';
import { idb } from '../offline.js';
import { $, $$, ICON_COLORS, SORTS, VAULT, api, basename, copyText, dirname, el, enc, folderColor, folderMeta, join, mobile, noteByPath, noteColor, state, stem, vstore } from './core.js';
import { attachNoteDialog, attachToFolder, deleteFolder, deleteNote, download, duplicateNote, exportDialog, moveNoteDialog, newFolder, newNote, openHistory, renameFolder, renameNote, shareDialog, tagsDialog } from './notes.js';
import { plain, renderStarred, renderTags } from './panels.js';
import { cacheNote, flushSave, manual, pending, savingP, setSync } from './sync.js';
import { newTab, openNote, persistTabs, renderNoteTags, renderRecent, renderTabs, setHash, showMeta } from './tabs.js';
import { menu, toast } from './ui.js';
import { block, setEditorValue, updateStatus } from './writing.js';
import { edit } from './commands.js';
import { openSide, refreshSide } from './side.js';
import { archiveItem, renderBins } from './bins.js';

// ------------------------------------------------------------------ tree
/**
 * Fetch the sidebar. Polls pass { poll: true }: if nothing changed on the server the
 * answer is an empty 304 and nothing is re-rendered. After this device changes
 * something, call it without options so the tree is always fetched in full.
 */
export let treeTag = '';
export async function refreshTree({ poll = false } = {}) {
  try {
    const opts = { etag: poll && treeTag && !Object.keys(pending.all()).length ? treeTag : '' };
    const fresh = await api('GET', '/api/tree', undefined, opts);
    if (fresh.notModified) { state.lastSync = Date.now(); return checkRemoteChange(); }
    treeTag = opts.etagOut || '';
    state.tree = fresh;
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
  renderStarred();
  renderRecent();
  renderBins();
  refreshSide();
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
    const pinned = (x) => (x.name !== undefined ? !!folderMeta(x.path).pinned : !!x.pinned);
    const folders = [...node.folders.values()].sort((a, b) => (order === 'name-desc' ? byName(b.name, a.name) : byName(a.name, b.name)));
    const notes = node.notes.filter((n) => n.path !== ownNote).sort(sorter);
    // Pinned folders and notes first, then the other folders, then the other notes.
    const rows = [...folders.filter(pinned), ...notes.filter(pinned), ...folders.filter((f) => !pinned(f)), ...notes.filter((n) => !pinned(n))];
    let html = '';
    for (const x of rows) html += x.name !== undefined ? folderRow(x) : noteRow(x);
    return html;

    function folderRow(f) {
      const open = state.open.has(f.path);
      const fnote = folderMeta(f.path).note;
      const hasNote = fnote && known.has(fnote);
      const pin = pinned(f);
      const color = folderColor(f.path);
      return `<div class="row folder${open ? ' open' : ''}${state.folder === f.path ? ' sel' : ''}${hasNote ? ' has-note' : ''}" data-folder="${esc(f.path)}"${hasNote ? ` data-fnote="${esc(fnote)}"` : ''} style="--d:${d}${color ? `;--ic:var(--ic-${color})` : ''}" draggable="true" role="treeitem" aria-level="${d + 1}" aria-expanded="${open}" tabindex="-1"${pin ? ' aria-description="pinned"' : ''} title="${countNotes(f)} notes${hasNote ? ' · click opens its note' : ''}">
        ${icon(open ? 'folderOpen' : 'folder')}<span class="name">${esc(f.name)}</span>${pin ? icon('pin', 'pin') : ''}
        <button class="more" data-more title="More" tabindex="-1" aria-label="More for ${esc(f.name)}">${icon('more')}</button></div>`
        + (open ? walk(f, d + 1) : '');
    }

    function noteRow(n) {
      const color = noteColor(n);
      return `<div class="row note${n.path === curPath ? ' active' : ''}" data-note="${esc(n.path)}" style="--d:${d}${color ? `;--ic:var(--ic-${color})` : ''}" draggable="true" role="treeitem" aria-level="${d + 1}" aria-selected="${n.path === curPath}" tabindex="-1"${n.starred || n.pinned ? ` aria-description="${[n.starred && 'starred', n.pinned && 'pinned'].filter(Boolean).join(', ')}"` : ''}>
        ${icon('file')}<span class="name">${esc(stem(n.path))}</span>${n.starred ? icon('star', 'pin star') : ''}${n.pinned ? icon('pin', 'pin') : ''}<button class="more" data-more title="More" tabindex="-1" aria-label="More for ${esc(stem(n.path))}">${icon('more')}</button></div>`;
    }
  };
  const html = walk(buildTree(), 0);
  const had = el.tree.contains(document.activeElement) ? rowKey(document.activeElement.closest('.row')) : null;
  el.tree.innerHTML = html || '<div class="tree-empty">No notes yet.<br>Create one with the buttons above.</div>';
  // One row is reachable with Tab (the open note, else the first); arrow keys move from there.
  const rows = $$('.row', el.tree);
  const home = (had && rows.find((r) => rowKey(r) === had)) || rows.find((r) => r.classList.contains('active')) || rows[0];
  if (home) { home.tabIndex = 0; if (had) home.focus({ preventScroll: true }); }
  const label = SORTS.find(([v]) => v === state.settings.sort)?.[1] || '';
  $('#sortBtn').title = `Sort: ${label}`;
}

export const rowKey = (row) => (row ? (row.dataset.note ? `n:${row.dataset.note}` : `f:${row.dataset.folder}`) : null);

/** Arrow keys walk the tree like a file manager: Right opens a folder, Left closes it or goes up. */
el.tree.addEventListener('keydown', (e) => {
  const row = e.target.closest?.('.row');
  if (!row || e.target !== row) return;
  const rows = $$('.row', el.tree);
  const i = rows.indexOf(row);
  const move = (r) => { if (!r) return; rows.forEach((x) => { x.tabIndex = -1; }); r.tabIndex = 0; r.focus(); };
  const folder = row.dataset.folder;
  const parentRow = () => {
    const p = dirname(row.dataset.note || folder);
    return p ? rows.find((r) => r.dataset.folder === p) : null;
  };
  const k = e.key;
  if (k === 'ArrowDown') move(rows[i + 1]);
  else if (k === 'ArrowUp') move(rows[i - 1]);
  else if (k === 'Home') move(rows[0]);
  else if (k === 'End') move(rows[rows.length - 1]);
  else if (k === 'ArrowRight' && folder) {
    if (!state.open.has(folder)) { setOpen(folder, true); renderTree(); } else move(rows[i + 1]?.dataset && dirname(rows[i + 1].dataset.note || rows[i + 1].dataset.folder) === folder ? rows[i + 1] : null);
  } else if (k === 'ArrowLeft') {
    if (folder && state.open.has(folder)) { setOpen(folder, false); renderTree(); } else move(parentRow());
  } else if (k === 'Enter' || k === ' ') {
    if (row.dataset.note) openNote(row.dataset.note, { newTab: e.ctrlKey || e.metaKey });
    else { setOpen(folder, !state.open.has(folder)); renderTree(); }
  } else if (k === 'F2') row.dataset.note ? renameNote(row.dataset.note) : renameFolder(folder);
  else if (k === 'Delete') row.dataset.note ? deleteNote(row.dataset.note) : deleteFolder(folder);
  else if ((k === 'F10' && e.shiftKey) || k === 'ContextMenu') { const r = row.getBoundingClientRect(); rowMenu(row, { x: r.left + 24, y: r.bottom }); }
  else return;
  e.preventDefault();
});

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

/** Star or unstar a note. Starred notes are listed in their own sidebar panel, newest first. */
export async function toggleStar(path) {
  const n = noteByPath(path);
  if (!n) return;
  const on = !n.starred;
  n.starred = on ? Date.now() : null; // show it straight away; the server's answer follows
  renderTree(); renderStarred();
  await setMeta(path, { starred: on });
  toast(on ? `Starred “${stem(path)}”` : `Removed “${stem(path)}” from starred`);
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
    ...(mobile.matches ? [] : [ // phones have no tabs and no side pane
      { icon: 'plus', label: 'Open in new tab', run: () => openNote(path, { newTab: true }) },
      { icon: 'columns', label: 'Open to the side', run: () => openSide(path) },
    ]),
    '-',
    { icon: 'edit', label: 'Rename', run: () => renameNote(path) },
    { icon: 'move', label: 'Move to…', run: () => moveNoteDialog(path) },
    { icon: 'copy', label: 'Duplicate', run: () => duplicateNote(path) },
    '-',
    { icon: 'tag', label: 'Tags…', run: () => tagsDialog(path) },
    { icon: 'star', label: n.starred ? 'Unstar' : 'Star', run: () => toggleStar(path) },
    { icon: 'pin', label: n.pinned ? 'Unpin' : 'Pin to top', run: () => setMeta(path, { pinned: !n.pinned }) },
    { icon: 'palette', label: 'Color…', run: () => colorMenu(path, anchor) },
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
    { icon: 'archive', label: 'Archive', run: () => archiveItem(path) },
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
    { icon: 'pin', label: meta.pinned ? 'Unpin' : 'Pin to top', run: () => setMeta(path, { pinned: !meta.pinned }) },
    { icon: 'palette', label: 'Color…', run: () => colorMenu(path, anchor, true) },
    '-',
    { icon: 'edit', label: 'Rename', run: () => renameFolder(path) },
    { icon: 'archive', label: 'Archive folder', run: () => archiveItem(path) },
    { icon: 'trash', label: 'Delete folder', danger: true, run: () => deleteFolder(path) },
  ]);
}

/** Pick an icon color for a note or folder. Without one, it takes its folder's color. */
export function colorMenu(path, anchor, folder = false) {
  const own = folder ? folderMeta(path).color : noteByPath(path)?.color;
  const inherited = folderColor(dirname(path));
  menu(anchor, [
    { header: folder ? 'Folder color' : 'Note color' },
    { swatch: inherited ? `var(--ic-${inherited})` : 'var(--text-3)', label: inherited ? 'Same as its folder' : 'None', on: !own, run: () => setMeta(path, { color: null }) },
    ...ICON_COLORS.map(([k, label]) => ({ swatch: `var(--ic-${k})`, label, on: own === k, run: () => setMeta(path, { color: k }) })),
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
