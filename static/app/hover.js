import { esc, render } from '../markdown.js';
import { icon } from '../icons.js';
import { enhance } from '../rich.js';
import { splitFront } from '../props.js';
import { state, stem } from './core.js';
import { noteText } from './daily.js';
import { findNote } from './notes.js';
import { openNote } from './tabs.js';
import { previewOpts, richOpts, sectionOf } from './writing.js';

// ------------------------------------------------------------------ hover previews
// Rest the mouse on a [[link]] to read the note it points to, without opening it.
// Mouse only: on touch screens a tap simply follows the link.
export const hover = { timer: 0, hideTimer: 0, box: null, anchor: null, cache: new Map() };
const SHOW_MS = 350;
const HIDE_MS = 220;

export function hidePreview() {
  clearTimeout(hover.timer);
  clearTimeout(hover.hideTimer);
  hover.box?.remove();
  hover.box = null;
  hover.anchor = null;
}

async function textOf(path, version) {
  const key = `${path}|${version}`;
  if (!hover.cache.has(key)) {
    if (hover.cache.size > 40) hover.cache.clear();
    hover.cache.set(key, noteText(path));
  }
  return hover.cache.get(key);
}

export async function showPreview(a) {
  const [name, heading] = a.dataset.note.split('#');
  const target = findNote(name);
  hidePreview();
  hover.anchor = a;
  const box = document.createElement('div');
  box.className = 'hover-card glass';
  box.setAttribute('role', 'tooltip');
  box.innerHTML = target
    ? `<button class="hover-head" data-open="${esc(target.path)}" title="Open (Ctrl click for a new tab)">${icon('file')}<b>${esc(stem(target.path))}</b>${heading ? `<span>› ${esc(heading)}</span>` : ''}</button><div class="md hover-body"><div class="embed-wait">Loading…</div></div>`
    : `<div class="hover-head">${icon('file')}<b>${esc(name)}</b></div><div class="hover-body hover-missing">This note doesn’t exist yet. Click the link to create it.</div>`;
  document.body.appendChild(box);
  hover.box = box;
  place(box, a);
  box.addEventListener('pointerenter', () => clearTimeout(hover.hideTimer));
  box.addEventListener('pointerleave', () => { hover.hideTimer = setTimeout(hidePreview, HIDE_MS); });
  box.addEventListener('click', (e) => {
    const head = e.target.closest('[data-open]');
    const link = e.target.closest('a.wikilink');
    const goto = head ? head.dataset.open : link ? findNote(link.dataset.note.split('#')[0])?.path : null;
    if (head || link) e.preventDefault();
    if (goto) { hidePreview(); openNote(goto, { newTab: e.ctrlKey || e.metaKey }); }
  });
  if (!target) return;
  let text;
  try { text = splitFront(await textOf(target.path, target.version)).body; } catch { text = ''; }
  if (hover.box !== box) return;
  const part = heading ? sectionOf(text, heading) : text;
  const body = box.querySelector('.hover-body');
  if (part == null) { body.innerHTML = '<div class="hover-missing">That heading isn’t in the note.</div>'; return; }
  if (!part.trim()) { body.innerHTML = '<div class="hover-missing">This note is empty.</div>'; return; }
  // A long note is cut short: the card is for a glance, not for reading the whole thing.
  const cut = part.length > 6000 ? part.slice(0, part.lastIndexOf('\n', 6000) > 0 ? part.lastIndexOf('\n', 6000) : 6000) : part;
  body.innerHTML = render(cut, previewOpts);
  for (const emb of body.querySelectorAll('.note-embed')) { // no embeds inside the card, just where they'd be
    const p = document.createElement('p');
    p.className = 'hover-missing';
    p.textContent = `Embeds “${emb.dataset.note}”`;
    emb.replaceWith(p);
  }
  enhance(body, richOpts());
  if (cut.length < part.length) body.insertAdjacentHTML('beforeend', '<p class="hover-more">…</p>');
  place(box, a);
}

function place(box, a) {
  const r = a.getBoundingClientRect();
  const w = box.offsetWidth;
  const h = box.offsetHeight;
  let x = Math.max(8, Math.min(r.left, innerWidth - w - 8));
  let y = r.bottom + 8;
  if (y + h > innerHeight - 8 && r.top - h - 8 > 8) y = r.top - h - 8;
  y = Math.max(8, Math.min(y, innerHeight - h - 8));
  Object.assign(box.style, { left: `${x}px`, top: `${y}px` });
}

document.addEventListener('pointerover', (e) => {
  if (e.pointerType !== 'mouse' || !state.settings.hoverPreview) return;
  if (hover.box?.contains(e.target)) return;
  const a = e.target.closest('a.wikilink');
  if (!a || a.closest('.hover-card')) return;
  if (a === hover.anchor && hover.box) { clearTimeout(hover.hideTimer); return; }
  clearTimeout(hover.timer);
  hover.timer = setTimeout(() => { if (a.isConnected && a.matches(':hover')) showPreview(a); }, SHOW_MS);
});
document.addEventListener('pointerout', (e) => {
  const a = e.target.closest?.('a.wikilink');
  if (!a) return;
  if (a !== hover.anchor) { clearTimeout(hover.timer); return; }
  if (hover.box && !hover.box.contains(e.relatedTarget)) hover.hideTimer = setTimeout(hidePreview, HIDE_MS);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && hover.box) hidePreview(); }, true);
document.addEventListener('scroll', (e) => { if (hover.box && !hover.box.contains(e.target)) hidePreview(); }, true);
document.addEventListener('pointerdown', (e) => { if (hover.box && !hover.box.contains(e.target)) hidePreview(); }, true);
