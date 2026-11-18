import { esc, slug } from '../markdown.js';
import { icon } from '../icons.js';
import { $, $$, SORTS, api, copyText, debounce, dirname, el, enc, mobile, noteByPath, relTime, state, stem, store, vstore } from './core.js';
import { insertTemplate, openDaily } from './daily.js';
import { setFocus } from './layout.js';
import { deleteNote, download, duplicateNote, exportDialog, moveNoteDialog, newFolder, newNote, openHistory, shareDialog, tagsDialog } from './notes.js';
import { resolvedTheme, setSetting } from './prefs.js';
import { showSettings } from './shell.js';
import { selectRange } from './spellui.js';
import { newTab, openNote } from './tabs.js';
import { byName, noteMenu, renderTree, toggleStar } from './tree.js';
import { commandPalette, menu, quickSwitcher } from './ui.js';
import { addProperties, block } from './writing.js';
import { comboLabel, edit, keyFor } from './commands.js';
import { archiveItem, renderBins } from './bins.js';

// ------------------------------------------------------------------ panels
export function showPanel(name, reveal = false) {
  state.panel = name;
  store.set('panel', name);
  $$('.panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  $$('.ptab[data-panel], .rail-btn[data-panel]').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
  if (reveal && el.app.classList.contains('sb-collapsed')) toggleSidebar(true);
  if (reveal && el.app.classList.contains('focus')) setFocus(false);
  if (mobile.matches && reveal) openDrawer();
  if (name === 'search') { renderSearch(); setTimeout(() => $('#searchInput').focus(), 30); }
  if (name === 'tags') renderTags();
  if (name === 'starred') renderStarred();
  if (name === 'outline') renderOutline();
  if (name === 'links') renderBacklinks();
  if (name === 'trash' || name === 'archive') renderBins(true);
}
$$('.ptab[data-panel]').forEach((b) => b.addEventListener('click', () => showPanel(b.dataset.panel)));
// The bin and the archive box in the rail: a second click goes back to the notes.
$$('.rail-btn[data-panel]').forEach((b) => b.addEventListener('click', () => {
  const open = state.panel === b.dataset.panel && !el.app.classList.contains('sb-collapsed');
  showPanel(open && !mobile.matches ? 'files' : b.dataset.panel, true);
}));
$('#railSwitch').addEventListener('click', () => quickSwitcher());
$('#railDaily').addEventListener('click', () => openDaily());
$('#railPalette').addEventListener('click', () => commandPalette());
$('#railNew').addEventListener('click', () => newNote());
$('#collapseBtn').addEventListener('click', () => { state.open.clear(); vstore.set('open', []); renderTree(); });

export function toggleSidebar(force) {
  if (mobile.matches) { el.app.classList.contains('drawer-open') ? closeDrawer() : openDrawer(); return; }
  const show = force ?? el.app.classList.contains('sb-collapsed');
  el.app.classList.toggle('sb-collapsed', !show);
  store.set('collapsed', !show);
}
export function openDrawer() { el.app.classList.add('drawer-open'); }
export function closeDrawer() { el.app.classList.remove('drawer-open'); }
$('#sidebarBtn').addEventListener('click', () => toggleSidebar());
$('#scrim').addEventListener('click', closeDrawer);

// starred
export function renderStarred() {
  if (state.panel !== 'starred') return;
  const list = state.tree.notes.filter((n) => n.starred).sort((a, b) => b.starred - a.starred);
  $('#starredList').innerHTML = list.length
    ? list.map((n) => `<div class="hit star-row${state.cur?.path === n.path ? ' active' : ''}" data-open="${esc(n.path)}" tabindex="0" role="button">
        <b>${esc(stem(n.path))}<span>${esc(dirname(n.path))}</span></b>
        <button class="icon-btn sm unstar" data-unstar="${esc(n.path)}" title="Remove from starred" aria-label="Remove ${esc(stem(n.path))} from starred">${icon('x')}</button></div>`).join('')
    : `<div class="tree-empty">Star notes you come back to often. Right-click a note, or press ${esc(comboLabel(keyFor('star')) || 'Alt S')}.</div>`;
}
$('#starredList').addEventListener('click', (e) => {
  const un = e.target.closest('[data-unstar]');
  if (un) { e.stopPropagation(); toggleStar(un.dataset.unstar); return; }
  const row = e.target.closest('[data-open]');
  if (row) openNote(row.dataset.open, { newTab: e.ctrlKey || e.metaKey });
});
$('#starredList').addEventListener('keydown', (e) => {
  const row = e.target.closest('[data-open]');
  if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openNote(row.dataset.open); }
});
$('#starredList').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('[data-open]');
  if (row) { e.preventDefault(); noteMenu(row.dataset.open, { x: e.clientX, y: e.clientY }); }
});

// search
export let searchSeq = 0;
export const runSearch = debounce(async (q) => {
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

export function renderSearch() {
  const q = $('#searchInput').value.trim();
  if (q) return runSearch(q);
  const recent = [...state.tree.notes].sort((a, b) => b.modified - a.modified).slice(0, 12);
  $('#searchResults').innerHTML = `<div class="search-help"><code>tag:work</code> <code>path:Daily</code> <code>title:plan</code> <code>"exact words"</code> <code>-skip</code></div>` + '<div class="list-label">Recently edited</div>' +
    recent.map((n) => `<button class="hit" data-open="${esc(n.path)}"><b>${esc(stem(n.path))}</b><small>${esc(dirname(n.path) || 'Vault')} · ${relTime(n.modified)}</small></button>`).join('');
  markActiveHit();
}
export function markActiveHit() { $$('#searchResults .hit').forEach((h) => h.classList.toggle('active', h.dataset.open === state.cur?.path)); }
$('#searchInput').addEventListener('input', (e) => runSearch(e.target.value.trim()));
$('#searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const first = $('#searchResults .hit'); if (first) openNote(first.dataset.open); }
  if (e.key === 'Escape') { e.preventDefault(); e.target.value = ''; renderSearch(); el.ta.focus(); }
});
$('#searchResults').addEventListener('click', (e) => { const b = e.target.closest('[data-open]'); if (b) openNote(b.dataset.open, { newTab: e.ctrlKey || e.metaKey }); });

// tags
export function renderTags() {
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
    { icon: 'star', label: noteByPath(cur.path)?.starred ? 'Unstar' : 'Star', run: () => toggleStar(cur.path) },
    { icon: 'history', label: 'Version history', run: () => openHistory(cur.path) },
    { icon: 'share', label: 'Share link…', run: () => shareDialog(cur.path) },
    { icon: 'template', label: 'Insert template…', run: () => insertTemplate() },
    { icon: 'outline', label: cur.front ? 'Edit properties' : 'Add properties', run: () => addProperties() },
    '-',
    { icon: 'link', label: 'Copy link', run: () => copyText(`[[${stem(cur.path)}]]`, 'Link copied') },
    { icon: 'copy', label: 'Copy markdown', run: () => copyText(cur.content) },
    { icon: 'download', label: 'Export (PDF, HTML, Markdown)…', run: () => exportDialog(cur.path) },
    '-',
    { icon: 'archive', label: 'Archive', run: () => archiveItem(cur.path) },
    { icon: 'trash', label: 'Delete', danger: true, run: () => deleteNote(cur.path) },
  ]);
});
$('#themeBtn').addEventListener('click', () => setSetting('theme', resolvedTheme() === 'dark' ? 'light' : 'dark'));
$('#settingsBtn').addEventListener('click', () => showSettings());

// ------------------------------------------------------------------ outline & backlinks
export function headings(text) {
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
export const plain = (md) => md.replace(/[*_`~=]|\[\[|\]\]|\[([^\]]*)\]\([^)]*\)/g, (m, t) => t ?? '');

export function renderOutline() {
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
export const outlineSoon = debounce(renderOutline, 300);

export let backlinkSeq = 0;
export async function renderBacklinks() {
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
export const backlinksSoon = debounce(renderBacklinks, 1200);
