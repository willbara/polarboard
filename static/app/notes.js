import { render, esc } from '../markdown.js';
import { icon } from '../icons.js';
import { enhance } from '../rich.js';
import { diffHtml } from '../diff.js';
import { printNote, htmlFile, EXPORT_DEFAULTS } from '../export.js';
import { edit } from './commands.js';
import { $, $$, api, basename, cleanName, copyText, dirname, el, enc, fmtBytes, fmtDate, fmtDateTime, folderMeta, join, noteByPath, pad, relTime, state, stem, store } from './core.js';
import { noteText } from './daily.js';
import { flushSave, pending, saveTimer } from './sync.js';
import { forgetTabs, newTab, openNote, showEmpty } from './tabs.js';
import { byName, mergeLocalNotes, moveItem, patchTreeNote, refreshTree, renderTree, setMeta, setOpen } from './tree.js';
import { closeLayer, dialog, toast } from './ui.js';
import { expandEmbeds, keepCaretVisible, previewOpts, richOpts, setEditorValue } from './writing.js';

// ------------------------------------------------------------------ note actions
export function defaultFolder() {
  const s = state.settings;
  if (s.newNoteLocation === 'root') return '';
  if (s.newNoteLocation === 'folder') return state.tree.folders.includes(s.newNoteFolder) ? s.newNoteFolder : '';
  return state.folder;
}
export function defaultName() {
  const d = new Date();
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (state.settings.newNoteName === 'date') return date;
  if (state.settings.newNoteName === 'datetime') return `${date} ${pad(d.getHours())}${pad(d.getMinutes())}`;
  return 'Untitled';
}

export async function newNote(folder = defaultFolder(), name = defaultName(), { editTitle = true, content: raw = '', newTab = false } = {}) {
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

export async function newFolder(parent = state.folder) {
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

export async function renameNote(path) {
  if (state.cur?.path === path) { el.title.focus(); el.title.select(); return; }
  const name = await dialog({ title: 'Rename note', input: { value: stem(path) }, buttons: [{ label: 'Cancel' }, { label: 'Rename', primary: true, value: true }] });
  if (name && cleanName(name) && cleanName(name) !== stem(path)) await moveItem(path, join(dirname(path), cleanName(name) + '.md'));
}

export async function renameFolder(path) {
  const name = await dialog({ title: 'Rename folder', input: { value: basename(path) }, buttons: [{ label: 'Cancel' }, { label: 'Rename', primary: true, value: true }] });
  if (name && cleanName(name) && cleanName(name) !== basename(path)) await moveItem(path, join(dirname(path), cleanName(name)));
}

export async function pickFolder(title, exclude = null) {
  const folders = ['', ...state.tree.folders].filter((f) => f !== exclude);
  const target = await dialog({
    title,
    pick: folders.map((f) => ({ label: f || 'Vault root', value: f, icon: 'folder' })),
    buttons: [{ label: 'Cancel' }],
  });
  return target == null || target === true ? null : target;
}

export async function moveNoteDialog(path) {
  const target = await pickFolder(`Move “${stem(path)}”`, dirname(path));
  if (target == null) return;
  await moveItem(path, join(target, basename(path)));
  if (target) { setOpen(target, true); renderTree(); }
}

export async function duplicateNote(path) {
  if (state.cur?.path === path) await flushSave();
  try {
    const r = await api('POST', '/api/duplicate', { path });
    await refreshTree();
    openNote(r.path);
  } catch (e) { toast(e.message, 'err'); }
}

/** Make a note the page that opens when its folder is clicked. */
export async function attachToFolder(path) {
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

export async function attachNoteDialog(folder) {
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
export async function tagsDialog(path, isFolder = false) {
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

export async function deleteNote(path) {
  const permanent = state.settings.deleteMode === 'permanent';
  if (state.settings.confirmDelete) {
    const ok = await dialog({
      title: `Delete “${stem(path)}”?`,
      text: permanent ? 'This deletes the note and its version history for good.' : 'It moves to the trash (the bin in the left rail), where you can restore it.',
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

export async function deleteFolder(path) {
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

export async function download(path) {
  let content = state.cur?.path === path ? state.cur.content : null;
  if (content == null) {
    try { content = (await api('GET', `/api/note?path=${enc(path)}`)).content; } catch (e) { return toast(e.message, 'err'); }
  }
  saveFile(basename(path), new Blob([content], { type: 'text/markdown' }));
}

export function saveFile(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function findNote(name) {
  const n = name.toLowerCase().replace(/\.md$/, '');
  return state.tree.notes.find((x) => x.path.toLowerCase() === n + '.md')
    || state.tree.notes.find((x) => stem(x.path).toLowerCase() === n.split('/').pop());
}

// ------------------------------------------------------------------ version history
export let histView = store.get('histView', 'preview');
export let histAgainst = store.get('histAgainst', 'current');
export async function openHistory(path = state.cur?.path) {
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
      <div class="opts history-mode" role="group" aria-label="Show">
        <button data-view="preview" class="${histView === 'preview' ? 'active' : ''}" aria-pressed="${histView === 'preview'}">Preview</button>
        <button data-view="changes" class="${histView === 'changes' ? 'active' : ''}" aria-pressed="${histView === 'changes'}">Changes</button>
      </div>
      <select class="sel history-against" aria-label="Compare with"${histView === 'changes' ? '' : ' hidden'}>
        <option value="current"${histAgainst === 'current' ? ' selected' : ''}>Since this version</option>
        <option value="previous"${histAgainst === 'previous' ? ' selected' : ''}>Made in this version</option>
      </select>
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
  const cache = new Map();
  const load = async (id) => {
    if (!cache.has(id)) cache.set(id, api('GET', `/api/history/version?path=${enc(path)}&id=${id}`).then((r) => r.content));
    return cache.get(id);
  };
  const current = async () => (state.cur?.path === path ? state.cur.content : (await api('GET', `/api/note?path=${enc(path)}`)).content);
  const paint = async () => {
    const id = selected;
    if (histView === 'preview') {
      view.innerHTML = `<article class="md">${render(text, previewOpts)}</article>`;
      enhance(view, richOpts());
      return;
    }
    // Changes: this version against the note as it is now, or against the version before it
    const i = versions.findIndex((v) => v.id === id);
    let before;
    let after;
    let what;
    try {
      if (histAgainst === 'current') { before = text; after = await current(); what = 'since this version'; }
      else { before = versions[i + 1] ? await load(versions[i + 1].id) : ''; after = text; what = versions[i + 1] ? 'in this version' : 'in the first saved version'; }
    } catch (e) { return toast(e.message, 'err'); }
    if (selected !== id) return;
    const d = diffHtml(before, after);
    view.innerHTML = d.html
      ? `<div class="diff-sum"><span class="add">+${d.added}</span> <span class="rem">−${d.removed}</span> lines changed ${what}</div><div class="diff" role="table" aria-label="Changes">${d.html}</div>`
      : `<div class="history-empty">No changes ${what}.</div>`;
  };
  const pick = async (id) => {
    selected = id;
    $$('[data-id]', box).forEach((b) => b.classList.toggle('active', b.dataset.id === id));
    try { text = await load(id); }
    catch (e) { return toast(e.message, 'err'); }
    if (selected !== id) return;
    await paint();
    view.scrollTop = 0;
    $$('[data-act="copy"], [data-act="restore"]', box).forEach((b) => { b.disabled = false; });
  };
  box.querySelector('.history-against').addEventListener('change', (e) => { histAgainst = e.target.value; store.set('histAgainst', histAgainst); if (selected) paint(); });
  box.addEventListener('click', async (e) => {
    const v = e.target.closest('[data-id]');
    if (v) return pick(v.dataset.id);
    const mode = e.target.closest('[data-view]');
    if (mode) {
      histView = mode.dataset.view;
      store.set('histView', histView);
      $$('[data-view]', box).forEach((b) => { b.classList.toggle('active', b === mode); b.setAttribute('aria-pressed', String(b === mode)); });
      box.querySelector('.history-against').hidden = histView !== 'changes';
      if (selected) paint();
      return;
    }
    const fold = e.target.closest('[data-fold]');
    if (fold) { const tpl = fold.nextElementSibling; fold.replaceWith(tpl.content); tpl.remove(); return; }
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

// ------------------------------------------------------------------ export
export async function exportDialog(path = state.cur?.path) {
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
export async function importFiles(files, folder = '') {
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

// ------------------------------------------------------------------ share links
export async function shareDialog(path) {
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
