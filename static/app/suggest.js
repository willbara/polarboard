import { esc } from '../markdown.js';
import { caretRect, replace } from '../editor.js';
import { icon } from '../icons.js';
import { $, $$, dirname, el, state, stem } from './core.js';
import { formatDate, insertTemplate } from './daily.js';
import { fuzzy, markMatch } from './ui.js';
import { addProperties, block } from './writing.js';

// ------------------------------------------------------------------ [[ and # suggestions
export const sug = { box: null, items: [], i: 0, kind: '', from: 0 };

export function checkSuggest() {
  const ta = el.ta;
  if (document.activeElement !== ta || ta.selectionStart !== ta.selectionEnd) return closeSuggest();
  const pos = ta.selectionStart;
  const before = ta.value.slice(Math.max(0, pos - 160), pos);
  let m;
  if (state.settings.linkSuggest && (m = before.match(/\[\[([^\[\]\n|#]*)$/))) return openSuggest('link', pos - m[1].length, m[1]);
  const lineStart = ta.value.lastIndexOf('\n', pos - 1) + 1;
  if (state.settings.tagSuggest && (m = before.match(/(?:^|[\s(])#([\p{L}\p{N}_\/-]+)$/u)) && !/^#{1,6}\s/.test(ta.value.slice(lineStart, pos))) {
    return openSuggest('tag', pos - m[1].length, m[1]);
  }
  // "/" at the start of a line or after a space opens the slash menu
  if (state.settings.slashMenu && (m = ta.value.slice(lineStart, pos).match(/(?:^|\s)\/([\p{L}\d-]{0,24})$/u))) {
    return openSuggest('slash', pos - m[1].length - 1, m[1]);
  }
  closeSuggest();
}

export function openSuggest(kind, from, q) {
  let items;
  if (kind === 'link') {
    items = state.tree.notes
      .map((n) => ({ n, m: fuzzy(q, stem(n.path)) || fuzzy(q, n.path) }))
      .filter((x) => x.m && x.n.path !== state.cur?.path)
      .sort((a, b) => b.m.score - a.m.score || b.n.modified - a.n.modified)
      .slice(0, 8)
      .map(({ n, m }) => ({ value: stem(n.path), html: markMatch(stem(n.path), q ? m.idx : []), detail: dirname(n.path), icon: 'file' }));
    if (q && !state.tree.notes.some((n) => stem(n.path).toLowerCase() === q.toLowerCase())) items.push({ value: q, html: `New note “${esc(q)}”`, icon: 'filePlus' });
  } else if (kind === 'slash') {
    items = SLASH
      .map((c) => ({ c, m: fuzzy(q, c.label) || fuzzy(q, c.keys || '') }))
      .filter((x) => x.m)
      .sort((a, b) => (q ? b.m.score - a.m.score : 0))
      .slice(0, q ? 8 : 40)
      .map(({ c, m }) => ({ value: c, html: q && fuzzy(q, c.label) ? markMatch(c.label, m.idx) : esc(c.label), detail: c.hint || '', icon: c.icon }));
  } else {
    const counts = new Map();
    for (const n of state.tree.notes) for (const t of n.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    items = [...counts.entries()]
      .map(([t, c]) => ({ t, c, m: fuzzy(q, t) }))
      .filter((x) => x.m && x.t.toLowerCase() !== q.toLowerCase())
      .sort((a, b) => b.m.score - a.m.score || b.c - a.c)
      .slice(0, 8)
      .map(({ t, c, m }) => ({ value: t, html: '#' + markMatch(t, m.idx), detail: `${c}`, icon: 'hash' }));
  }
  if (!items.length) return closeSuggest();
  Object.assign(sug, { items, i: 0, kind, from });
  if (!sug.box) {
    sug.box = document.createElement('div');
    sug.box.className = 'suggest glass';
    sug.box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const b = e.target.closest('[data-k]');
      if (b) { sug.i = +b.dataset.k; acceptSuggest(); }
    });
    document.body.appendChild(sug.box);
  }
  sug.box.innerHTML = items.map((it, k) => `<button class="pick-item${k === sug.i ? ' active' : ''}" data-k="${k}">${icon(it.icon)}<span class="pi-main"><span class="pi-label">${it.html}</span></span>${it.detail ? `<small>${esc(it.detail)}</small>` : ''}</button>`).join('');
  positionSuggest();
}

export function positionSuggest() {
  if (!sug.box) return;
  const rect = caretRect(el.hl, el.ta.selectionStart);
  if (!rect) return;
  const w = sug.box.offsetWidth;
  const h = sug.box.offsetHeight;
  let x = Math.min(rect.left, innerWidth - w - 8);
  let y = rect.bottom + 6;
  if (y + h > innerHeight - 8) y = rect.top - h - 6;
  Object.assign(sug.box.style, { left: `${Math.max(8, x)}px`, top: `${Math.max(8, y)}px` });
}

export function closeSuggest() { if (sug.box) { sug.box.remove(); sug.box = null; } sug.items = []; }

// ------------------------------------------------------------------ slash menu
// \u0001 marks where the cursor lands; text up to \u0002 is selected so typing replaces it.
// Block snippets start on their own line.
export const SLASH = [
  { label: 'Heading 1', keys: 'h1 title', icon: 'heading', text: '# \u0001', block: true },
  { label: 'Heading 2', keys: 'h2', icon: 'heading', text: '## \u0001', block: true },
  { label: 'Heading 3', keys: 'h3', icon: 'heading', text: '### \u0001', block: true },
  { label: 'Bulleted list', keys: 'ul bullet', icon: 'list', text: '- \u0001', block: true },
  { label: 'Numbered list', keys: 'ol ordered', icon: 'outline', text: '1. \u0001', block: true },
  { label: 'Checklist', keys: 'todo task checkbox', icon: 'task', text: '- [ ] \u0001', block: true },
  { label: 'Quote', keys: 'blockquote', icon: 'quote', text: '> \u0001', block: true },
  { label: 'Callout: note', keys: 'callout info', icon: 'quote', text: '> [!note] \u0001\n> ', block: true },
  { label: 'Callout: tip', keys: 'callout', icon: 'quote', text: '> [!tip] \u0001\n> ', block: true },
  { label: 'Callout: warning', keys: 'callout caution', icon: 'quote', text: '> [!warning] \u0001\n> ', block: true },
  { label: 'Table', keys: 'grid', icon: 'layout', hint: 'Tab moves between cells', text: '| \u0001Column\u0002 | Column |\n| ------ | ------ |\n|        |        |', block: true },
  { label: 'Code block', keys: 'pre fence', icon: 'code', text: '```\u0001\n\n```', block: true },
  { label: 'Math block', keys: 'latex tex equation', icon: 'type', text: '$$\n\u0001\n$$', block: true },
  { label: 'Diagram', keys: 'mermaid chart flow', icon: 'share', text: '```mermaid\ngraph TD\n  A[\u0001Start\u0002] --> B[End]\n```', block: true },
  { label: 'Divider', keys: 'hr rule line', icon: 'width', text: '---\n\u0001', block: true },
  { label: 'Link to a note', keys: 'wikilink', icon: 'link', text: '[[\u0001', after: () => checkSuggest() },
  { label: 'Embed a note', keys: 'transclude include', icon: 'file', text: '![[\u0001', block: true, after: () => checkSuggest() },
  { label: 'Image', keys: 'picture upload photo', icon: 'image', run: () => $('#fileInput').click() },
  { label: 'Template', keys: 'insert', icon: 'template', run: () => insertTemplate() },
  { label: 'Properties', keys: 'front matter yaml metadata', icon: 'outline', run: () => addProperties() },
  { label: 'Today’s date', keys: 'now day', icon: 'calendar', text: () => formatDate(new Date(), 'YYYY-MM-DD') + '\u0001' },
  { label: 'Current time', keys: 'now clock', icon: 'calendar', text: () => formatDate(new Date(), 'HH:mm') + '\u0001' },
];

export function runSlash(c, from, to) {
  const ta = el.ta;
  replace(ta, from, to, '', from); // remove the "/query"
  if (c.run) return c.run();
  let text = typeof c.text === 'function' ? c.text() : c.text;
  const ls = ta.value.lastIndexOf('\n', from - 1) + 1;
  if (c.block && ta.value.slice(ls, from).trim()) text = '\n' + text;
  const a = text.indexOf('\u0001');
  const b = text.indexOf('\u0002');
  const clean = text.replace('\u0001', '').replace('\u0002', '');
  const start = from + (a < 0 ? clean.length : a);
  replace(ta, from, from, clean, start, b > a && a >= 0 ? from + b - 1 : start);
  c.after?.();
}

export function acceptSuggest() {
  const it = sug.items[sug.i];
  if (!it) return closeSuggest();
  const pos = el.ta.selectionStart;
  const after = el.ta.value.slice(pos, pos + 2);
  if (sug.kind === 'slash') {
    closeSuggest();
    return runSlash(it.value, sug.from, pos);
  }
  if (sug.kind === 'link') {
    if (after === ']]') replace(el.ta, sug.from, pos, it.value, sug.from + it.value.length + 2);
    else replace(el.ta, sug.from, pos, `${it.value}]]`, sug.from + it.value.length + 2);
  } else {
    const space = /^\s/.test(after) ? '' : ' ';
    replace(el.ta, sug.from, pos, it.value + space, sug.from + it.value.length + space.length);
  }
  closeSuggest();
}

export function suggestKey(e) {
  if (!sug.box) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    sug.i = (sug.i + (e.key === 'ArrowDown' ? 1 : -1) + sug.items.length) % sug.items.length;
    $$('.pick-item', sug.box).forEach((b, k) => b.classList.toggle('active', k === sug.i));
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptSuggest(); return true; }
  if (e.key === 'Escape') { e.preventDefault(); closeSuggest(); return true; }
  return false;
}
// Typing near the bottom scrolls the editor, so the popup follows the cursor rather than closing.
el.editPane.addEventListener('scroll', () => requestAnimationFrame(positionSuggest), { passive: true });
