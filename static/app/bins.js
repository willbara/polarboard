// Trash and archive: the bin and box in the rail swap the sidebar for a list of what
// is in them, and a note opens read-only in a reader. Archived notes live in .archive/
// on the server, out of the tree, search and links, until they are unarchived.

import { esc, render } from '../markdown.js';
import { icon } from '../icons.js';
import { enhance } from '../rich.js';
import { splitFront } from '../props.js';
import { $, api, basename, copyText, dirname, enc, fmtBytes, relTime, state, stem } from './core.js';
import { flushPending, flushSave, pending, saveTimer } from './sync.js';
import { forgetTabs, showEmpty } from './tabs.js';
import { refreshTree } from './tree.js';
import { closeLayer, dialog, toast } from './ui.js';
import { expandEmbeds, previewOpts, richOpts } from './writing.js';

const BINS = {
  trash: {
    list: () => api('GET', '/api/trash'),
    empty: 'The trash is empty. Deleted notes wait here until it empties itself (Settings → Sync).',
    row: (t) => ({
      key: t.id, name: t.dir ? basename(t.from) : stem(t.from), ic: t.dir ? 'folder' : /\.md$/i.test(t.from) ? 'file' : 'image',
      sub: [dirname(t.from), `Deleted ${relTime(t.deleted)}`, t.dir ? `${t.files} file${t.files === 1 ? '' : 's'}` : ''],
      back: 'Restore', drop: 'Delete for good',
    }),
  },
  archive: {
    list: () => api('GET', '/api/archive'),
    empty: 'Nothing archived. Right-click a note or folder and choose Archive to keep it here, read-only and out of the way.',
    row: (a) => ({ key: a.path, name: stem(a.path), ic: 'file', sub: [dirname(a.path), `Archived ${relTime(a.archived)}`], back: 'Unarchive', drop: 'Move to trash' }),
  },
};
const shown = { trash: '', archive: '' };
const items = { trash: [], archive: [] };

/** Draw the open bin's list. Quietly skips the redraw if nothing changed (it runs on every tree refresh). */
export async function renderBins(force = false) {
  const kind = state.panel;
  const bin = BINS[kind];
  if (!bin) return;
  const box = $(`#${kind}List`);
  let list;
  try { list = (await bin.list()).items; }
  catch (e) { box.innerHTML = `<div class="tree-empty">${e.offline ? 'This needs the server.' : esc(e.message)}</div>`; shown[kind] = ''; return; }
  const sig = JSON.stringify(list);
  if (state.panel !== kind || (!force && sig === shown[kind])) return;
  shown[kind] = sig;
  items[kind] = list;
  if (kind === 'trash') $('#emptyTrashBtn').hidden = !list.length;
  box.innerHTML = list.length ? list.map((x) => {
    const r = bin.row(x);
    return `<div class="hit bin-row" data-key="${esc(r.key)}" tabindex="0" role="button">${icon(r.ic)}
      <b>${esc(r.name)}<span>${esc(r.sub.filter(Boolean).join(' · '))}</span></b>
      <button class="icon-btn sm" data-back title="${r.back}" aria-label="${r.back} ${esc(r.name)}">${icon('restore')}</button>
      <button class="icon-btn sm" data-drop title="${r.drop}" aria-label="${r.drop}: ${esc(r.name)}">${icon(kind === 'trash' ? 'x' : 'trash')}</button></div>`;
  }).join('') : `<div class="tree-empty">${bin.empty}</div>`;
}

// ------------------------------------------------------------------ actions
const done = async (msg) => { if (msg) toast(msg); await refreshTree(); renderBins(true); };

async function restoreTrash(t) {
  try { const r = await api('POST', '/api/trash/restore', { id: t.id }); await done(`Restored to ${r.path}`); } catch (e) { toast(e.message, 'err'); }
}
async function purgeTrash(t) {
  const ok = await dialog({ title: `Delete “${basename(t.from)}” for good?`, text: 'It cannot be restored afterwards.', buttons: [{ label: 'Cancel' }, { label: 'Delete', danger: true, value: true }] });
  if (!ok) return;
  try { await api('DELETE', `/api/trash?id=${enc(t.id)}`); await done(); } catch (e) { toast(e.message, 'err'); }
}
async function unarchive(a) {
  try { const r = await api('POST', '/api/archive/restore', { path: a.path }); await done(`Back in ${dirname(r.path) || 'your notes'}`); } catch (e) { toast(e.message, 'err'); }
}
async function archiveToTrash(a) {
  try { await api('DELETE', `/api/archive?path=${enc(a.path)}`); await done(`Moved “${stem(a.path)}” to the trash`); } catch (e) { toast(e.message, 'err'); }
}
const ACTIONS = { trash: [restoreTrash, purgeTrash], archive: [unarchive, archiveToTrash] };

/** Archive a note or a folder: it leaves the tree and becomes read-only until unarchived. */
export async function archiveItem(path) {
  const inside = (p) => p === path || p.startsWith(path + '/');
  if (state.cur && inside(state.cur.path)) await flushSave();
  if (Object.keys(pending.all()).some(inside)) await flushPending();
  try {
    await api('POST', '/api/archive', { path });
    if (state.cur && inside(state.cur.path)) { clearTimeout(saveTimer); state.cur = null; }
    for (const p of Object.keys(pending.all())) if (inside(p)) pending.drop(p);
    forgetTabs(inside);
    if (!state.cur) showEmpty();
    if (inside(state.folder)) state.folder = '';
    await done(`Archived “${/\.md$/i.test(path) ? stem(path) : basename(path)}”`);
  } catch (e) { toast(e.message, 'err'); }
}

$('#emptyTrashBtn').addEventListener('click', async () => {
  const ok = await dialog({ title: 'Empty the trash?', text: 'Everything in it is deleted for good.', buttons: [{ label: 'Cancel' }, { label: 'Empty trash', danger: true, value: true }] });
  if (!ok) return;
  try { await api('DELETE', '/api/trash'); await done(); } catch (e) { toast(e.message, 'err'); }
});

// ------------------------------------------------------------------ reader
async function openReader(kind, x) {
  const r = BINS[kind].row(x);
  const [back, drop] = ACTIONS[kind];
  let text = null;
  if (r.ic === 'file') {
    try { text = (await api('GET', kind === 'trash' ? `/api/trash/note?id=${enc(x.id)}` : `/api/archive/note?path=${enc(x.path)}`)).content; }
    catch (e) { return toast(e.message, 'err'); }
  }
  const box = document.createElement('div');
  box.className = 'reader';
  box.innerHTML = `<header class="history-head">
      <h3>${icon(kind === 'trash' ? 'trash' : 'archive')} ${esc(r.name)} <small>${esc(r.sub.filter(Boolean).join(' · '))} · read only</small></h3>
      ${text != null ? '<button class="btn sm" data-act="copy">Copy text</button>' : ''}
      <button class="btn sm ghost" data-act="drop">${r.drop}</button>
      <button class="btn sm primary" data-act="back">${r.back}</button>
      <button class="icon-btn sm" data-act="close" title="Close" aria-label="Close">${icon('x')}</button>
    </header>
    <div class="history-view scroll">${text == null
      ? `<div class="history-empty">${x.dir ? `A folder with ${x.files} file${x.files === 1 ? '' : 's'} (${fmtBytes(x.size)}).` : `A file (${fmtBytes(x.size)}).`} Restore it to open it.</div>`
      : `<article class="md">${render(splitFront(text).body, previewOpts)}</article>`}</div>`;
  box.addEventListener('click', (e) => {
    if (e.target.matches('input[type=checkbox]') || e.target.closest('a[href="#"]')) { e.preventDefault(); return; } // read only
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') closeLayer();
    if (act === 'copy') copyText(text);
    if (act === 'back') { closeLayer(); back(x); }
    if (act === 'drop') { closeLayer(); drop(x); }
  });
  dialog({ content: box, cls: 'history-dialog reader-dialog' });
  if (text != null) {
    const view = box.querySelector('.history-view');
    await expandEmbeds(view, []);
    enhance(view, richOpts());
  }
}

for (const kind of Object.keys(BINS)) {
  const list = $(`#${kind}List`);
  const item = (e) => items[kind].find((x) => BINS[kind].row(x).key === e.target.closest('[data-key]')?.dataset.key);
  list.addEventListener('click', (e) => {
    const x = item(e);
    if (!x) return;
    const [back, drop] = ACTIONS[kind];
    if (e.target.closest('[data-back]')) back(x);
    else if (e.target.closest('[data-drop]')) drop(x);
    else openReader(kind, x);
  });
  list.addEventListener('keydown', (e) => {
    const x = item(e);
    if (x && e.target.matches('[data-key]') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openReader(kind, x); }
  });
}
