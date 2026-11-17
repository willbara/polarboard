import { commands } from '../editor.js';
import { icon } from '../icons.js';
import { comboLabel, keyFor } from './commands.js';
import { $, $$, cleanName, dirname, el, join, mobile, state, stem, store } from './core.js';
import { findNote, newNote } from './notes.js';
import { closeDrawer, renderTags, showPanel } from './panels.js';
import { newTab, openNote } from './tabs.js';
import { moveItem } from './tree.js';
import { block, commitBlock, editBlock, onInput, previewEditable, renderPreview } from './writing.js';

// ------------------------------------------------------------------ focus mode
// Hides everything but the page. Pointing at the top or bottom edge brings
// the controls that live there back until the pointer leaves.
export function setFocus(on) {
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

export let revealTimer = 0;
export function revealFor(x, y, touch) {
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
export async function commitTitle() {
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
export function setMode(mode, remember = true) {
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
