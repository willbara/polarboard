import { esc } from '../markdown.js';
import { caretRect, replace } from '../editor.js';
import { $, debounce, el, state } from './core.js';
import { setMode } from './layout.js';
import { toast } from './ui.js';
import { block } from './writing.js';

// ------------------------------------------------------------------ find & replace
// Ctrl F finds in the open note, Ctrl H also replaces. In writing mode matches are
// painted on a layer behind the text (like the writing-check underlines); in reading
// mode they are marked in the preview. Replacing always works on the markdown.
export const find = { open: false, matches: [], cur: -1, error: '', marks: [] };
const bar = $('#findbar');
const input = $('#findInput');
const repl = $('#replaceInput');
const opt = (k) => bar.querySelector(`[data-find="${k}"]`).getAttribute('aria-pressed') === 'true';
const reading = () => el.ws.dataset.mode === 'read';
const MAX = 5000;

export function openFind(withReplace = false) {
  if (!state.cur) return false;
  if (withReplace && reading()) setMode('write');
  const sel = document.activeElement === el.ta ? el.ta.value.slice(el.ta.selectionStart, el.ta.selectionEnd) : '';
  if (sel && !sel.includes('\n') && sel.length < 200) input.value = sel;
  find.open = true;
  bar.hidden = false;
  $('#replaceRow').hidden = !withReplace;
  $('#findMore').setAttribute('aria-expanded', String(withReplace));
  el.main.classList.add('finding');
  (withReplace && input.value ? repl : input).focus();
  (withReplace && input.value ? repl : input).select();
  runFind(true);
  return true;
}

export function closeFind(toEditor = true) {
  if (!find.open) return;
  find.open = false;
  bar.hidden = true;
  el.main.classList.remove('finding');
  el.finds.innerHTML = '';
  unmarkPreview();
  const m = find.matches[find.cur];
  find.matches = [];
  if (toEditor && !reading() && state.cur) {
    el.ta.focus({ preventScroll: true });
    if (m) el.ta.setSelectionRange(m.start, m.end);
  }
}

/** The pattern for the current query and options, or null (and find.error) if it isn't valid. */
export function pattern() {
  const q = input.value;
  find.error = '';
  if (!q) return null;
  let src = opt('regex') ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (opt('word')) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  try { return new RegExp(src, `gu${opt('case') ? '' : 'i'}`); } catch (e) { find.error = 'Invalid pattern'; return null; }
}

export function matchesIn(text, re) {
  const out = [];
  if (!re) return out;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) && out.length < MAX) {
    if (!m[0].length) { re.lastIndex++; continue; }
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Re-run the search. keepPlace picks the first match after the caret instead of the current index. */
export function runFind(fromCaret = false) {
  if (!find.open) return;
  const re = pattern();
  const prev = find.matches[find.cur];
  if (reading()) {
    markPreview(re);
    find.matches = find.marks.map((_, i) => ({ start: i, end: i }));
    if (find.cur >= find.matches.length) find.cur = find.matches.length - 1;
    if (find.cur < 0 && find.matches.length) find.cur = 0;
  } else {
    find.matches = matchesIn(el.ta.value, re);
    const at = fromCaret ? el.ta.selectionStart : prev ? prev.start : 0;
    const next = find.matches.findIndex((m) => m.end > at);
    find.cur = find.matches.length ? (next < 0 ? 0 : next) : -1;
    if (el.ws.dataset.mode === 'split') markPreview(re);
  }
  paintFinds();
  showMatch(false);
}

/** Draw the matches behind the editor text. */
export function paintFinds() {
  if (!find.open || reading()) { el.finds.innerHTML = ''; return updateCount(); }
  const text = el.ta.value;
  let html = '';
  let pos = 0;
  find.matches.forEach((m, i) => {
    html += esc(text.slice(pos, m.start)) + `<mark class="find-hit${i === find.cur ? ' cur' : ''}">${esc(text.slice(m.start, m.end))}</mark>`;
    pos = m.end;
  });
  el.finds.innerHTML = html + esc(text.slice(pos)) + '​';
  updateCount();
}

function updateCount() {
  const n = find.matches.length;
  const c = $('#findCount');
  c.textContent = find.error || (!input.value ? '' : n ? `${find.cur + 1} of ${n >= MAX ? `${MAX}+` : n}` : 'No results');
  c.classList.toggle('none', !!input.value && !n);
  bar.querySelectorAll('[data-step], #replaceOne, #replaceAll').forEach((b) => { b.disabled = !n; });
  if (reading()) bar.querySelectorAll('#replaceOne, #replaceAll').forEach((b) => { b.disabled = true; });
}

/** Scroll the current match into view. */
export function showMatch(center = true) {
  const m = find.matches[find.cur];
  if (!m) return;
  if (reading()) {
    find.marks.forEach((x, i) => x.forEach((n) => n.classList.toggle('cur', i === find.cur)));
    find.marks[find.cur]?.[0]?.scrollIntoView({ block: center ? 'center' : 'nearest' });
    return;
  }
  const r = caretRect(el.hl, m.start);
  if (!r) return;
  const pane = el.editPane.getBoundingClientRect();
  const top = pane.top + 70; // under the find bar
  if (center || r.top < top || r.bottom > pane.bottom - 30) el.editPane.scrollTop += r.top - pane.top - pane.height * 0.4;
}

export function findStep(dir) {
  const n = find.matches.length;
  if (!n) return;
  find.cur = (find.cur + dir + n) % n;
  paintFinds();
  showMatch(true);
}

/** The replacement text for one match: $1 and friends work when "regular expression" is on. */
function replacement(text, m, re) {
  if (!opt('regex')) return repl.value;
  const one = new RegExp(re.source, re.flags.replace('g', ''));
  return text.slice(m.start, m.end).replace(one, repl.value);
}

export function replaceOne() {
  const re = pattern();
  const m = find.matches[find.cur];
  if (!m || !re || reading()) return;
  const text = el.ta.value;
  const r = replacement(text, m, re);
  replace(el.ta, m.start, m.end, r, m.start + r.length);
  repl.focus();
  find.matches = matchesIn(el.ta.value, re);
  find.cur = find.matches.length ? Math.max(0, find.matches.findIndex((x) => x.start >= m.start + r.length)) : -1;
  paintFinds();
  showMatch(false);
}

export function replaceAll() {
  const re = pattern();
  if (!re || !find.matches.length || reading()) return;
  const text = el.ta.value;
  const list = find.matches;
  const first = list[0].start;
  const last = list[list.length - 1].end;
  let out = '';
  let pos = first;
  for (const m of list) { out += text.slice(pos, m.start) + replacement(text, m, re); pos = m.end; }
  out += text.slice(pos, last);
  replace(el.ta, first, last, out, first); // one step to undo
  repl.focus();
  toast(`Replaced ${list.length} match${list.length === 1 ? '' : 'es'}`);
  runFind();
}

// reading mode: mark matches in the rendered preview (within each run of text)
export function markPreview(re) {
  unmarkPreview();
  if (!re) return;
  const walker = document.createTreeWalker(el.preview, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('script, style, .katex, svg, textarea') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const hits = matchesIn(node.data, re);
    if (!hits.length) continue;
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const h of hits) {
      frag.append(node.data.slice(pos, h.start));
      const mk = document.createElement('mark');
      mk.className = 'find-hit';
      mk.textContent = node.data.slice(h.start, h.end);
      frag.append(mk);
      find.marks.push([mk]);
      pos = h.end;
      if (find.marks.length >= MAX) break;
    }
    frag.append(node.data.slice(pos));
    node.replaceWith(frag);
    if (find.marks.length >= MAX) break;
  }
}

export function unmarkPreview() {
  for (const group of find.marks) for (const mk of group) if (mk.isConnected) mk.replaceWith(mk.textContent);
  find.marks = [];
  el.preview.normalize();
}

/** Called after the editor text or the preview is redrawn (note switch, typing, sync). */
export const refreshFind = debounce(() => { if (find.open) runFind(); }, 120);

input.addEventListener('input', () => runFind(true));
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
});
repl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); (e.ctrlKey || e.metaKey) && e.altKey ? replaceAll() : replaceOne(); }
});
bar.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  if (e.altKey && ['c', 'w', 'r'].includes(e.key.toLowerCase())) {
    e.preventDefault();
    bar.querySelector(`[data-find="${{ c: 'case', w: 'word', r: 'regex' }[e.key.toLowerCase()]}"]`).click();
  }
});
bar.addEventListener('click', (e) => {
  const o = e.target.closest('[data-find]');
  if (o) { o.setAttribute('aria-pressed', String(!opt(o.dataset.find))); runFind(); input.focus(); return; }
  const s = e.target.closest('[data-step]');
  if (s) { findStep(+s.dataset.step); return; }
  if (e.target.closest('#findMore')) {
    const row = $('#replaceRow');
    if (row.hidden && reading()) setMode('write');
    row.hidden = !row.hidden;
    $('#findMore').setAttribute('aria-expanded', String(!row.hidden));
    (row.hidden ? input : repl).focus();
    runFind();
    return;
  }
  if (e.target.closest('#replaceOne')) replaceOne();
  if (e.target.closest('#replaceAll')) replaceAll();
  if (e.target.closest('#findClose')) closeFind();
});
