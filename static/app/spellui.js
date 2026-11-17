import { esc } from '../markdown.js';
import { caretRect, replace } from '../editor.js';
import { icon } from '../icons.js';
import { Spell } from '../spell.js';
import { $, $$, api, el, state, vstore } from './core.js';
import { setMode } from './layout.js';
import { menu, toast } from './ui.js';
import { edit } from './commands.js';
import { block } from './writing.js';

// ------------------------------------------------------------------ writing checks (Harper)
export const spell = new Spell();
export const lint = { items: [], timer: 0, ready: false, error: '' };
export let prevText = '';
export const spellOn = () => state.settings.spellEngine === 'harper';

export async function startSpell() {
  const st = $('#stLint');
  if (!spellOn()) { clearLints(); st.hidden = true; return; }
  st.hidden = false;
  setLintStatus(spell.ready ? 'checking' : 'loading');
  try {
    const words = await loadWords();
    const s = state.settings;
    await spell.configure({ dialect: s.dialect, rules: s.harperRules, words });
    lint.ready = true;
    lint.error = '';
    scheduleLint(0);
  } catch (e) {
    lint.error = e.message || String(e);
    setLintStatus('error');
  }
}

export async function loadWords() {
  try {
    const r = await api('GET', '/api/dictionary');
    vstore.set('words', r.words);
    return r.words;
  } catch { return vstore.get('words', []); }
}

export function scheduleLint(ms = 450) {
  clearTimeout(lint.timer);
  if (!spellOn() || !state.cur || !lint.ready) return;
  lint.timer = setTimeout(runLint, ms);
}

export async function runLint() {
  const text = el.ta.value;
  setLintStatus('checking');
  let items;
  try { items = await spell.check(text, state.settings.spellGroups); } catch (e) { lint.error = e.message; return setLintStatus('error'); }
  if (!items || el.ta.value !== text) return; // the text moved on; a newer check is coming
  lint.items = items;
  renderLints();
  setLintStatus();
}

export function renderLints() { paintLints(el.lints, el.ta.value, lint.items); }

/** Draw underlines: a copy of the text, invisible except for the wavy lines under each issue. */
export function paintLints(layer, text, items) {
  let html = '';
  let pos = 0;
  items.forEach((l, i) => {
    if (l.start < pos || l.end > text.length) return;
    html += esc(text.slice(pos, l.start)) + `<span class="lint g-${l.group}" data-i="${i}">${esc(text.slice(l.start, l.end))}</span>`;
    pos = l.end;
  });
  layer.innerHTML = html + esc(text.slice(pos)) + '\u200b';
}

export function clearLints() { lint.items = []; el.lints.innerHTML = ''; }
export function resetLintText(text) { prevText = text; }

/** Keep underlines in place while typing: shift the ones after the edit, drop the ones it touched. */
export function shiftLints(next) {
  const prev = prevText;
  prevText = next;
  if (!lint.items.length || prev === next) return;
  lint.items = shiftItems(prev, next, lint.items);
  renderLints();
}

export function shiftItems(prev, next, items) {
  const max = Math.min(prev.length, next.length);
  let a = 0;
  while (a < max && prev[a] === next[a]) a++;
  let b = 0;
  while (b < max - a && prev[prev.length - 1 - b] === next[next.length - 1 - b]) b++;
  const oldEnd = prev.length - b;
  const delta = next.length - prev.length;
  return items
    .filter((l) => l.end < a || l.start > oldEnd)
    .map((l) => (l.start > oldEnd ? { ...l, start: l.start + delta, end: l.end + delta } : l));
}

/** The main editor as a lint target; the block editor in the preview makes its own (blockLints). */
export const mainLints = {
  get ta() { return el.ta; },
  get items() { return lint.items; },
  set items(v) { lint.items = v; },
  render() { renderLints(); setLintStatus(); },
  recheck(ms = 150) { scheduleLint(ms); },
};

/** Writing checks for the block editor in the preview: same underlines and menu, its own text. */
export function blockLints(ta, layer) {
  const t = {
    ta, items: [], timer: 0,
    render() { paintLints(layer, ta.value, t.items); },
    recheck(ms = 450) {
      clearTimeout(t.timer);
      if (!spellOn() || !lint.ready) return;
      t.timer = setTimeout(async () => {
        const text = ta.value;
        let items;
        try { items = await spell.check(text, state.settings.spellGroups, 'block'); } catch { return; }
        if (!items || ta.value !== text || !ta.isConnected) return;
        t.items = items;
        t.render();
      }, ms);
    },
  };
  let prev = ta.value;
  ta.addEventListener('input', () => {
    if (t.items.length) t.items = shiftItems(prev, ta.value, t.items);
    prev = ta.value;
    t.render();
    t.recheck();
  });
  ta.addEventListener('contextmenu', (e) => {
    const l = lintAt(layer, t.items, e);
    if (!l) return;
    e.preventDefault();
    lintMenu(l, { x: e.clientX, y: e.clientY }, t);
  });
  t.render();
  t.recheck(0);
  return t;
}

/** The issue under the pointer, if any. */
export function lintAt(layer, items, e) {
  if (!items.length) return null;
  const hit = $$('.lint', layer).find((span) => [...span.getClientRects()].some((r) =>
    e.clientX >= r.left - 1 && e.clientX <= r.right + 1 && e.clientY >= r.top - 2 && e.clientY <= r.bottom + 2));
  return hit ? items[+hit.dataset.i] : null;
}

export function setLintStatus(mode) {
  const b = $('#stLint');
  const n = lint.items.length;
  const label = mode === 'loading' ? 'Loading writing checks…'
    : mode === 'checking' && !n ? 'Checking…'
    : mode === 'error' ? 'Checks unavailable'
    : n ? `${n} suggestion${n === 1 ? '' : 's'}` : 'No issues';
  b.querySelector('span').textContent = label;
  b.dataset.state = mode === 'error' ? 'error' : n ? 'issues' : mode === 'loading' ? 'loading' : 'clean';
  b.title = mode === 'error' ? `Harper could not start: ${lint.error}` : 'Writing checks by Harper. Click to list them.';
}

export function applySuggestion(l, s, t = mainLints) {
  const ta = t.ta;
  if (ta.value.slice(l.start, l.end) !== l.problem) return t.recheck(0);
  if (s.kind === 1) replace(ta, l.start, l.end, '');
  else if (s.kind === 2) replace(ta, l.end, l.end, s.text);
  else replace(ta, l.start, l.end, s.text, l.start + s.text.length);
  if (t !== mainLints) ta.focus({ preventScroll: true });
  t.recheck(150);
}

export async function addWord(word) {
  try {
    const r = await api('PUT', '/api/dictionary', { add: word });
    vstore.set('words', r.words);
  } catch {
    vstore.set('words', [...new Set([...vstore.get('words', []), word])]);
  }
  await spell.addWords([word]);
  const same = (x) => x.group === 'spelling' && x.problem.toLowerCase() === word.toLowerCase();
  lint.items = lint.items.filter((x) => !same(x));
  renderLints();
  setLintStatus();
  if (block.lints) { block.lints.items = block.lints.items.filter((x) => !same(x)); block.lints.render(); }
  toast(`Added “${word}” to the dictionary`);
}

export function lintMenu(l, anchor, t = mainLints) {
  const sugs = l.suggestions.map((s) => ({
    icon: 'check',
    label: s.kind === 1 ? 'Remove it' : s.kind === 2 ? `Add “${s.text}”` : s.text ? `Change to “${s.text}”` : 'Remove it',
    run: () => applySuggestion(l, s, t),
  }));
  menu(anchor, [
    { message: l.message, kind: l.group },
    ...sugs,
    ...(sugs.length ? ['-'] : []),
    ...(l.group === 'spelling' ? [{ icon: 'plus', label: `Add “${l.problem}” to dictionary`, run: () => addWord(l.problem) }] : []),
    { icon: 'x', label: 'Ignore', run: async () => { await spell.ignore(t.ta.value, l); t.items = t.items.filter((x) => x !== l); t.render(); } },
  ]);
}

el.ta.addEventListener('contextmenu', (e) => {
  const l = lintAt(el.lints, lint.items, e);
  if (!l) return; // the browser's own menu
  e.preventDefault();
  lintMenu(l, { x: e.clientX, y: e.clientY });
});

export function selectRange(start, end) {
  if (el.ws.dataset.mode === 'read') setMode('write');
  el.ta.focus({ preventScroll: true });
  el.ta.setSelectionRange(start, end);
  const rect = caretRect(el.hl, start);
  if (rect) {
    const pane = el.editPane.getBoundingClientRect();
    el.editPane.scrollTop += rect.top - pane.top - pane.height * 0.35;
  }
}

export function nextIssue() {
  if (!lint.items.length) return toast('No writing suggestions');
  const pos = el.ta.selectionEnd;
  const l = lint.items.find((x) => x.start > pos) || lint.items[0];
  selectRange(l.start, l.end);
  const span = el.lints.querySelector(`[data-i="${lint.items.indexOf(l)}"]`);
  if (span) { const r = span.getBoundingClientRect(); lintMenu(l, { x: r.left, y: r.bottom }); }
}

$('#stLint').addEventListener('click', (e) => {
  if (lint.error) return toast(`Writing checks could not start: ${lint.error}`, 'err');
  if (!lint.items.length) return;
  menu(e.currentTarget, [
    { header: `${lint.items.length} suggestion${lint.items.length === 1 ? '' : 's'}` },
    ...lint.items.slice(0, 30).map((l) => ({
      icon: l.group === 'spelling' ? 'type' : 'edit',
      label: `${l.problem.slice(0, 24) || '·'} · ${l.message.slice(0, 60)}`,
      run: () => selectRange(l.start, l.end),
    })),
  ]);
});
