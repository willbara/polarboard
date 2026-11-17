import { render, esc, frontmatterEnd, slug } from '../markdown.js';
import { highlight, caretRect, replace, handleKey } from '../editor.js';
import { icon } from '../icons.js';
import { enhance } from '../rich.js';
import { splitFront, mountProps } from '../props.js';
import { $, $$, VAULT, WIDTHS, api, basename, dirname, el, enc, fmtDate, fmtNum, join, pad, relTime, state, stem } from './core.js';
import { noteText } from './daily.js';
import { setMode } from './layout.js';
import { findNote } from './notes.js';
import { outlineSoon, renderOutline, renderTags, showPanel } from './panels.js';
import { setSetting } from './prefs.js';
import { blockLints, clearLints, resetLintText, scheduleLint, shiftLints, spellOn } from './spellui.js';
import { checkSuggest, closeSuggest, suggestKey } from './suggest.js';
import { manual, pending, resolveConflict, scheduleSave, setSync, syncNow } from './sync.js';
import { toast } from './ui.js';
import { edit } from './commands.js';
import { find, refreshFind } from './find.js';

// ------------------------------------------------------------------ editor
/**
 * Put a note's text in the editor. Front matter (properties) is kept apart in
 * state.cur.front and shown in the properties panel; the editor holds the rest.
 */
export function setEditorValue(text, keepSelection = false) {
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
  resetLintText(text);
  if (!keepSelection) clearLints();
  scheduleLint(keepSelection ? 300 : 120);
  renderOutline();
}

export let hlFrame = 0;
export function renderHL() {
  cancelAnimationFrame(hlFrame);
  hlFrame = requestAnimationFrame(() => { el.hl.innerHTML = highlight(el.ta.value); if (find.open) refreshFind(); });
}

export const vaultUrl = (rel) => `/vault/${enc(VAULT)}/${rel.split('/').map(enc).join('/')}`;
export const tryDecode = (s) => { try { return decodeURI(s); } catch { return s; } };
export const previewOpts = {
  image: (src) => (/^(https?:|data:|blob:)/i.test(src) ? src : vaultUrl(resolveFile(src))),
  embed: (name) => (/^https?:/i.test(name) ? name : vaultUrl(resolveEmbed(name))),
  exists: (name) => !!findNote(name),
  get math() { return state.settings.richMath; },
  get diagrams() { return state.settings.richDiagrams; },
};
export const richOpts = () => ({ code: state.settings.richCode, math: state.settings.richMath, diagrams: state.settings.richDiagrams });

export let previewTimer = 0;
export function renderPreview(now = false) {
  const mode = el.ws.dataset.mode;
  if (mode === 'write' || !state.cur) return;
  clearTimeout(previewTimer);
  if (block.active) return; // don't rebuild under a block that is being edited
  const go = () => {
    el.preview.innerHTML = render(el.ta.value, { ...previewOpts, lines: true });
    el.preview.classList.toggle('editable', previewEditable());
    expandEmbeds(el.preview).then(() => { enhance(el.preview, richOpts()); if (find.open) refreshFind(); });
  };
  if (now) go(); else previewTimer = setTimeout(go, mode === 'split' ? 250 : 120);
}

export function onInput() {
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

export function keepCaretVisible() {
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

export const INDENTS = { tab: '\t', 2: '  ', 4: '    ' };
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

// ------------------------------------------------------------------ status bar
export function countWords(text) {
  const body = text.split('\n').slice(frontmatterEnd(text.split('\n'))).join('\n');
  return (body.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || []).length;
}

export function updateCounts() {
  const text = el.ta.value;
  const words = countWords(text);
  const { selectionStart: s, selectionEnd: e } = el.ta;
  const selWords = s !== e && document.activeElement === el.ta ? countWords(text.slice(s, e)) : 0;
  $('#stWords').textContent = selWords ? `${fmtNum(selWords)} of ${fmtNum(words)} words` : `${fmtNum(words)} word${words === 1 ? '' : 's'}`;
  $('#stChars').textContent = `${fmtNum(text.length)} chars`;
  $('#stRead').textContent = `${Math.max(1, Math.round(words / (state.settings.readingWpm || 230)))} min read`;
}

export function updateStatus() {
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

// ------------------------------------------------------------------ images
export async function uploadImages(files) {
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
export function swapToken(token, text) {
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
export let dragDepth = 0;
export const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
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

// ------------------------------------------------------------------ properties (front matter)
export function setFront(text) {
  const cur = state.cur;
  if (!cur) return;
  cur.front = text;
  cur.content = text + el.ta.value;
  cur.dirty = true;
  if (state.sync !== 'conflict') setSync(manual() ? 'local' : 'pending');
  scheduleSave();
  paintProps();
}
export const propTag = (t) => { state.tag = t.toLowerCase(); showPanel('tags', true); renderTags(); };
export const propsEdit = mountProps($('#props'), () => state.cur?.front || '', setFront, { onTag: propTag });
export const propsView = mountProps($('#propsView'), () => state.cur?.front || '', setFront, { onTag: propTag });
export function paintProps() { propsEdit.paint(); propsView.paint(); }

/** Properties only exist once added on purpose. */
export function addProperties() {
  if (!state.cur) return toast('Open a note first');
  if (!state.cur.front) setFront('---\n---\n');
  const box = el.ws.dataset.mode === 'read' ? $('#propsView') : $('#props');
  box.querySelector('[data-new]')?.click();
}

// ------------------------------------------------------------------ files & embeds
export function normalizePath(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return out.join('/');
}
/** Image paths: relative to the note if that file exists (Obsidian's default), else from the vault root. */
export function resolveFile(src) {
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
export function resolveEmbed(name) {
  const n = name.replace(/^\/+/, '');
  if (n.includes('/')) return normalizePath(n);
  const files = state.tree.files || [];
  const attach = state.config.attachmentFolder || 'attachments';
  const lower = n.toLowerCase();
  return files.find((f) => f.toLowerCase() === `${attach}/${lower}`.toLowerCase())
    || files.find((f) => basename(f).toLowerCase() === lower) || `${attach}/${n}`;
}

export function sectionOf(text, heading) {
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
export async function expandEmbeds(root, chain = [state.cur?.path]) {
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
export const block = { active: null };
export const previewEditable = () => !!state.settings.previewEdit && el.ws.dataset.mode === 'read' && !!state.cur;

export function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

export function startBlockEdit(target, atEnd = false) {
  const lines = el.ta.value.split('\n');
  const a = atEnd ? lines.length : +target.dataset.a;
  const b = atEnd ? lines.length : +target.dataset.b;
  const src = lines.slice(a, b).join('\n');
  const wrap = document.createElement('div');
  wrap.className = 'block-editor';
  wrap.innerHTML = `<div class="block-field"><textarea class="block-ta" spellcheck="${state.settings.spellEngine === 'browser'}" aria-label="Edit this block"></textarea><pre class="block-lints" aria-hidden="true"></pre></div>
    <div class="block-hint"><span>Markdown</span><span><kbd>Ctrl Enter</kbd> or click outside to finish · <kbd>Esc</kbd> cancel</span></div>`;
  const ta = wrap.querySelector('textarea');
  ta.value = src;
  if (atEnd) el.preview.appendChild(wrap); else target.replaceWith(wrap);
  block.active = { a, b, ta, src, atEnd };
  autosize(ta);
  block.lints = spellOn() ? blockLints(ta, wrap.querySelector('.block-lints')) : null;
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(src.length, src.length);
  const s = state.settings;
  ta.addEventListener('input', () => autosize(ta));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancelBlock(); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitBlock(); return; }
    if (handleKey(ta, e, { indent: INDENTS[s.indent] || '\t', smartLists: s.smartLists, autoPair: s.autoPair, tables: s.tableKeys })) autosize(ta);
  });
  // A menu opened from the block (a writing suggestion) keeps it open; focus comes back when the menu closes.
  ta.addEventListener('blur', () => setTimeout(() => { if (block.active?.ta === ta && document.activeElement !== ta && !el.layer.contains(document.activeElement)) commitBlock(); }, 150));
}

/** Write the edited block back into the note. Returns how many lines it added or removed, and where. */
export function commitBlock() {
  const b = block.active;
  if (!b) return null;
  block.active = null;
  block.lints = null;
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

export function cancelBlock() {
  block.active = null;
  block.lints = null;
  renderPreview(true);
}

export function editBlock(target) {
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
