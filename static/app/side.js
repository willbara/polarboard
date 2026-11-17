import { esc, render } from '../markdown.js';
import { icon } from '../icons.js';
import { enhance } from '../rich.js';
import { splitFront } from '../props.js';
import { $, debounce, el, mobile, state, stem, store, vstore } from './core.js';
import { noteText } from './daily.js';
import { findNote } from './notes.js';
import { openNote } from './tabs.js';
import { expandEmbeds, previewOpts, richOpts } from './writing.js';
import { toast } from './ui.js';

// ------------------------------------------------------------------ two notes side by side
// A second, read-only note to the right of the one you're writing: a reference, an
// outline, a source. Links inside it open in the same side pane (Ctrl click opens
// them in the main editor). Not on phones, where there isn't room.
export const side = { path: null, version: null, back: [] };
const pane = $('#sidePane');
const body = $('#sideBody');
const MIN_W = 260;

export function openSide(path, { keepBack = false } = {}) {
  if (mobile.matches) { openNote(path); return; }
  if (!findNote(path.replace(/\.md$/i, '')) && !state.tree.notes.some((n) => n.path === path)) return toast('That note doesn’t exist');
  if (!keepBack && side.path && side.path !== path) side.back.push(side.path);
  if (side.back.length > 30) side.back.shift();
  side.path = path;
  side.version = null;
  vstore.set('side', path);
  el.ws.classList.add('has-side');
  pane.hidden = false;
  $('#sideDivider').hidden = false;
  loadSide();
}

export function closeSide() {
  side.path = null;
  side.back = [];
  vstore.set('side', null);
  el.ws.classList.remove('has-side');
  pane.hidden = true;
  $('#sideDivider').hidden = true;
  body.innerHTML = '';
}

export async function loadSide(text) {
  const path = side.path;
  if (!path) return;
  const n = state.tree.notes.find((x) => x.path === path);
  $('#sideTitle').textContent = stem(path);
  $('#sideTitle').title = `${path} · open it in the editor`;
  $('#sideBack').disabled = !side.back.length;
  if (!n) {
    body.innerHTML = '<div class="history-empty">This note was moved or deleted.</div>';
    return;
  }
  if (text === undefined) {
    try { text = await noteText(path); } catch { text = ''; }
    if (side.path !== path) return;
    side.version = n.version;
  }
  const top = pane.scrollTop;
  const sameNote = body.dataset.path === path;
  body.dataset.path = path;
  body.innerHTML = `<h1 class="title-view">${esc(stem(path))}</h1><article class="md">${render(splitFront(text).body, previewOpts)}</article>`;
  await expandEmbeds(body, [path]);
  enhance(body, richOpts());
  pane.scrollTop = sameNote ? top : 0;
}

/** After a sync: reload the side note if it changed, or follow it if it moved. */
export function refreshSide() {
  if (!side.path) return;
  const n = state.tree.notes.find((x) => x.path === side.path);
  if (!n || n.version !== side.version) loadSide();
}

/** Swap the two notes: the side one goes into the editor and the editor's note moves aside. */
export function swapSide() {
  const main = state.cur?.path;
  const other = side.path;
  if (!other) return;
  if (main) { side.path = main; vstore.set('side', main); loadSide(); } else closeSide();
  openNote(other);
}

// While the same note is open in both places, the side copy follows your typing.
el.ta.addEventListener('input', debounce(() => {
  if (side.path && side.path === state.cur?.path) loadSide((state.cur.front || '') + el.ta.value);
}, 400));

pane.addEventListener('click', (e) => {
  if (e.target.closest('#sideClose')) return closeSide();
  if (e.target.closest('#sideSwap')) return swapSide();
  if (e.target.closest('#sideOpen')) { if (side.path) openNote(side.path, { newTab: true }); return; }
  if (e.target.closest('#sideTitle')) { if (side.path) openNote(side.path); return; }
  if (e.target.closest('#sideBack')) { const p = side.back.pop(); if (p) openSide(p, { keepBack: true }); return; }
  const wl = e.target.closest('a.wikilink');
  if (wl) {
    e.preventDefault();
    const target = findNote(wl.dataset.note.split('#')[0]);
    if (!target) return toast('That note doesn’t exist yet');
    if (e.ctrlKey || e.metaKey) openNote(target.path); else openSide(target.path);
    return;
  }
  const a = e.target.closest('a[href^="#"]');
  if (a) {
    e.preventDefault();
    const id = a.getAttribute('href').slice(1);
    if (id) body.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth' });
  }
  if (e.target.matches('input[type=checkbox]')) e.preventDefault(); // read-only here
});

// drag the divider to resize; the width is remembered
const divider = $('#sideDivider');
export function setSideWidth(px) {
  const max = el.ws.clientWidth - 320;
  const w = Math.round(Math.max(MIN_W, Math.min(px, max)));
  el.ws.style.setProperty('--sp-w', `${w}px`);
  return w;
}
divider.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  divider.setPointerCapture(e.pointerId);
  divider.classList.add('drag');
  const right = el.ws.getBoundingClientRect().right;
  const move = (ev) => setSideWidth(right - ev.clientX);
  const up = (ev) => {
    divider.releasePointerCapture(ev.pointerId);
    divider.classList.remove('drag');
    divider.removeEventListener('pointermove', move);
    divider.removeEventListener('pointerup', up);
    store.set('sideW', setSideWidth(right - ev.clientX));
  };
  divider.addEventListener('pointermove', move);
  divider.addEventListener('pointerup', up);
});
divider.addEventListener('keydown', (e) => {
  const cur = pane.getBoundingClientRect().width;
  const d = { ArrowLeft: 24, ArrowRight: -24 }[e.key];
  if (d) { e.preventDefault(); store.set('sideW', setSideWidth(cur + d)); }
});
divider.addEventListener('dblclick', () => { store.set('sideW', null); el.ws.style.removeProperty('--sp-w'); });

/** Bring back the side note from last time. */
export function restoreSide() {
  const w = store.get('sideW', null);
  if (w) el.ws.style.setProperty('--sp-w', `${w}px`);
  const p = vstore.get('side', null);
  if (p && !mobile.matches && state.tree.notes.some((n) => n.path === p)) openSide(p);
}
mobile.addEventListener('change', () => { if (mobile.matches && side.path) closeSide(); });
