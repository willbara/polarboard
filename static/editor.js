// Editor helpers: a colour-only highlight layer that sits under a transparent
// textarea, plus markdown-aware editing commands. The layer may only change
// colour/background/decoration, never glyph widths, or the caret drifts.

import { esc, TAG_RE } from './markdown.js';

const mk = (s) => `<span class="t-mk">${s}</span>`;

function hlInline(text) {
  const slots = [];
  const put = (h) => `\u0000${slots.push(h) - 1}\u0000`;
  let s = esc(text);
  s = s.replace(/(`+)[^`]+?\1/g, (m) => put(`<span class="t-code">${m}</span>`));
  s = s.replace(/!?\[\[[^\]]*\]\]/g, (m) => put(`<span class="t-link">${m}</span>`));
  s = s.replace(/!?\[[^\]]*\]\([^)\s]*\)/g, (m) => {
    const i = m.indexOf('](');
    return put(`<span class="t-link">${m.slice(0, i + 1)}</span><span class="t-url">${m.slice(i + 1)}</span>`);
  });
  s = s.replace(/https?:\/\/[^\s<]+/g, (m) => put(`<span class="t-url">${m}</span>`));
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, (_, d, c) => `<span class="t-b">${mk(d)}${c}${mk(d)}</span>`);
  s = s.replace(/(^|[^*\w])([*_])(?=[^\s*_])([^*_]*?[^\s*_])\2(?![*\w])/g, (_, p, d, c) => `${p}<span class="t-i">${mk(d)}${c}${mk(d)}</span>`);
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, (_, c) => `<span class="t-del">${mk('~~')}${c}${mk('~~')}</span>`);
  s = s.replace(/==(?=\S)([\s\S]*?\S)==/g, (_, c) => `<span class="t-mark">${mk('==')}${c}${mk('==')}</span>`);
  s = s.replace(TAG_RE, (m) => (/\p{L}/u.test(m) ? `<span class="t-tag">${m}</span>` : m));
  for (let n = 0; n < 3 && s.includes('\u0000'); n++) s = s.replace(/\u0000(\d+)\u0000/g, (_, k) => slots[k]);
  return s;
}

export function highlight(src) {
  const out = [];
  let fence = null;
  let front = src.startsWith('---\n');
  src.split('\n').forEach((line, n) => {
    if (front) {
      out.push(`<span class="t-meta">${esc(line)}</span>`);
      if (n > 0 && line === '---') front = false;
      return;
    }
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      out.push(`<span class="t-block">${esc(line)}</span>`);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      return;
    }
    if (f) { fence = f[1]; out.push(`<span class="t-block t-fence">${esc(line)}</span>`); return; }
    let m;
    if ((m = line.match(/^(#{1,6})(\s.*)?$/))) {
      out.push(`<span class="t-h t-h${m[1].length}">${mk(m[1])}${hlInline(m[2] || '')}</span>`);
    } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(`<span class="t-hr">${esc(line)}</span>`);
    } else if ((m = line.match(/^(\s{0,3}>\s?)(.*)$/))) {
      out.push(`<span class="t-quote">${mk(esc(m[1]))}${hlInline(m[2])}</span>`);
    } else if ((m = line.match(/^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\](?:\s|$))?(.*)$/))) {
      const done = m[4] && /x/i.test(m[4]);
      const box = m[4] ? `<span class="t-box">${m[4]}</span>` : '';
      const body = hlInline(m[5]);
      out.push(`${m[1]}<span class="t-list">${esc(m[2])}</span>${m[3]}${box}${done ? `<span class="t-done">${body}</span>` : body}`);
    } else {
      out.push(hlInline(line));
    }
  });
  // The zero-width space keeps a trailing empty line the same height as in the textarea.
  return out.join('\n') + '​';
}

/** Rectangle of the caret, measured from the highlight layer (its text mirrors the textarea). */
export function caretRect(layer, offset) {
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  let node;
  let left = offset;
  while ((node = walker.nextNode())) {
    if (left <= node.length) {
      const r = document.createRange();
      r.setStart(node, left);
      r.setEnd(node, left);
      const rect = r.getClientRects()[0] || r.getBoundingClientRect();
      return rect;
    }
    left -= node.length;
  }
  return null;
}

// ------------------------------------------------------------- editing

/** Replace a range while keeping the browser's native undo stack where possible. */
export function replace(ta, start, end, text, selStart, selEnd) {
  ta.focus();
  ta.setSelectionRange(start, end);
  const ok = text === ''
    ? start === end || document.execCommand('delete')
    : document.execCommand('insertText', false, text);
  if (!ok) {
    ta.setRangeText(text, start, end, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (selStart != null) ta.setSelectionRange(selStart, selEnd ?? selStart);
}

function lineBounds(v, s, e) {
  const start = v.lastIndexOf('\n', s - 1) + 1;
  let end = v.indexOf('\n', e > s && v[e - 1] === '\n' ? e - 1 : e);
  if (end < 0) end = v.length;
  return [start, end];
}

function wrap(ta, left, right = left, placeholder = 'text') {
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  const sel = v.slice(s, e);
  if (v.slice(s - left.length, s) === left && v.slice(e, e + right.length) === right) {
    replace(ta, s - left.length, e + right.length, sel, s - left.length, e - left.length);
  } else if (sel.length >= left.length + right.length && sel.startsWith(left) && sel.endsWith(right)) {
    const inner = sel.slice(left.length, sel.length - right.length);
    replace(ta, s, e, inner, s, s + inner.length);
  } else {
    const inner = sel || placeholder;
    replace(ta, s, e, left + inner + right, s + left.length, s + left.length + inner.length);
  }
}

const PREFIX_RE = /^(\s*)(#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/;

function lines(ta, fn) {
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  const [ls, le] = lineBounds(v, s, e);
  const before = v.slice(ls, le).split('\n');
  const after = fn(before).join('\n');
  if (s === e) {
    const caret = Math.max(ls, s + (after.length - before.join('\n').length));
    replace(ta, ls, le, after, Math.min(caret, ls + after.length));
  } else {
    replace(ta, ls, le, after, ls, ls + after.length);
  }
}

function togglePrefix(ta, prefix, test) {
  lines(ta, (ls) => {
    const all = ls.every((l) => !l.trim() || test.test(l));
    let n = 0;
    return ls.map((l) => {
      if (!l.trim() && ls.length > 1) return l;
      if (all) return l.replace(test, '$1');
      const [, indent, old = ''] = l.match(PREFIX_RE) || [, l.match(/^\s*/)[0]];
      const body = l.slice(indent.length + old.length);
      return indent + (typeof prefix === 'function' ? prefix(++n) : prefix) + body;
    });
  });
}

export const commands = {
  bold: (ta) => wrap(ta, '**', '**', 'bold'),
  italic: (ta) => wrap(ta, '*', '*', 'italic'),
  strike: (ta) => wrap(ta, '~~', '~~', 'text'),
  mark: (ta) => wrap(ta, '==', '==', 'text'),
  code: (ta) => {
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (sel.includes('\n')) wrap(ta, '```\n', '\n```', '');
    else wrap(ta, '`', '`', 'code');
  },
  heading: (ta) => lines(ta, (ls) => ls.map((l) => {
    const m = l.match(/^(#{1,6})\s+/);
    const level = m ? m[1].length : 0;
    const body = l.replace(/^#{1,6}\s+/, '');
    return level >= 3 ? body : '#'.repeat(level + 1) + ' ' + body;
  })),
  list: (ta) => togglePrefix(ta, '- ', /^(\s*)[-*+]\s+(?!\[[ xX]\])/),
  ordered: (ta) => togglePrefix(ta, (n) => `${n}. `, /^(\s*)\d+[.)]\s+/),
  task: (ta) => togglePrefix(ta, '- [ ] ', /^(\s*)[-*+]\s+\[[ xX]\]\s+/),
  quote: (ta) => togglePrefix(ta, '> ', /^(\s*)>\s?/),
  formatTable: (ta) => {
    const t = tableAt(ta.value, ta.selectionStart);
    if (!t) return false;
    const out = formatTable(t.rows).join('\n');
    replace(ta, t.start, t.end, out, t.start + Math.min(out.length, ta.selectionStart - t.start));
    return true;
  },
  checkbox: (ta) => lines(ta, (ls) => ls.map((l) => {
    if (/^\s*[-*+]\s+\[[ xX]\]/.test(l)) return l.replace(/\[([ xX])\]/, (_, c) => (c === ' ' ? '[x]' : '[ ]'));
    if (/^\s*[-*+]\s+/.test(l)) return l.replace(/^(\s*[-*+]\s+)/, '$1[ ] ');
    return l.replace(/^(\s*)/, '$1- [ ] ');
  })),
  link: (ta) => {
    const { selectionStart: s, selectionEnd: e, value: v } = ta;
    const sel = v.slice(s, e);
    if (/^https?:\/\/\S+$/.test(sel)) {
      replace(ta, s, e, `[](${sel})`, s + 1);
    } else {
      const label = sel || 'link';
      const text = `[${label}](https://)`;
      replace(ta, s, e, text, s + label.length + 3, s + text.length - 1);
    }
  },
};

const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', '`': '`', '*': '*', '_': '_', '=': '=', '~': '~' };
const CLOSERS = new Set([')', ']', '}', '"', '`']);

// ------------------------------------------------------------- tables
const SEP_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const isRow = (l) => /^\s*\|/.test(l);
const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
const width = (s) => [...s].length;

/** The table block around pos: { start, end, rows: [lines], row, col }, or null. */
function tableAt(v, pos) {
  const ls = v.lastIndexOf('\n', pos - 1) + 1;
  let le = v.indexOf('\n', pos);
  if (le < 0) le = v.length;
  if (!isRow(v.slice(ls, le))) return null;
  let start = ls;
  while (start > 0) {
    const ps = v.lastIndexOf('\n', start - 2) + 1;
    if (!isRow(v.slice(ps, start - 1))) break;
    start = ps;
  }
  let end = le;
  while (end < v.length) {
    let ne = v.indexOf('\n', end + 1);
    if (ne < 0) ne = v.length;
    if (!isRow(v.slice(end + 1, ne))) break;
    end = ne;
  }
  const rows = v.slice(start, end).split('\n');
  const row = v.slice(start, ls).split('\n').length - 1;
  const before = v.slice(ls, pos).replace(/\\\|/g, '');
  const col = Math.max(0, (before.match(/\|/g) || []).length - 1);
  return { start, end, rows, row, col };
}

/** Pad every cell so the pipes line up. Alignment colons in the separator row are kept. */
export function formatTable(rows) {
  const parsed = rows.map((r) => (SEP_ROW.test(r) ? null : splitRow(r)));
  const seps = rows.map((r) => (SEP_ROW.test(r) ? splitRow(r) : null));
  const cols = Math.max(...parsed.map((c) => (c ? c.length : 0)), ...seps.map((c) => (c ? c.length : 0)));
  const widths = Array.from({ length: cols }, (_, k) => Math.max(3, ...parsed.map((c) => (c ? width(c[k] || '') : 0))));
  return rows.map((r, i) => {
    if (seps[i]) {
      return '| ' + widths.map((w, k) => {
        const c = seps[i][k] || '';
        const left = c.startsWith(':');
        const right = c.endsWith(':') && c.length > 1;
        return (left ? ':' : '') + '-'.repeat(Math.max(1, w - left - right)) + (right ? ':' : '');
      }).join(' | ') + ' |';
    }
    return '| ' + widths.map((w, k) => { const c = parsed[i][k] || ''; return c + ' '.repeat(w - width(c)); }).join(' | ') + ' |';
  });
}

/** Offset of the start of cell (row, col) inside the joined rows. */
function cellOffset(rows, row, col) {
  let off = 0;
  for (let i = 0; i < row; i++) off += rows[i].length + 1;
  const line = rows[row];
  let pipes = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|' && line[i - 1] !== '\\' && pipes++ === col) return off + i + (line[i + 1] === ' ' ? 2 : 1);
  }
  return off + line.length;
}

function tableKey(ta, e) {
  const { selectionStart: s, value: v } = ta;
  const t = tableAt(v, s);
  if (!t) return false;
  const sepIndex = t.rows.findIndex((r) => SEP_ROW.test(r));
  if (e.key === 'Tab') {
    e.preventDefault();
    const cols = Math.max(...t.rows.map((r) => splitRow(r).length));
    let { row, col } = t;
    col += e.shiftKey ? -1 : 1;
    if (col >= cols) { col = 0; row++; }
    if (col < 0) { col = cols - 1; row--; }
    if (row === sepIndex) row += e.shiftKey ? -1 : 1;
    if (row < 0) { row = 0; col = 0; }
    const raw = row >= t.rows.length ? [...t.rows, '|' + ' |'.repeat(cols)] : t.rows; // Tab past the end adds a row
    const rows = formatTable(raw);
    const at = t.start + cellOffset(rows, row, col);
    replace(ta, t.start, t.end, rows.join('\n'), at);
    const len = ta.value.slice(at).search(/\s*(?<!\\)\|/); // select the cell's text so typing replaces it
    if (len > 0) ta.setSelectionRange(at, at + len);
    return true;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    const le = v.indexOf('\n', s) < 0 ? v.length : v.indexOf('\n', s);
    if (v.slice(s, le).trim().replace(/\|/g, '').trim()) return false; // only at the end of a row
    e.preventDefault();
    const cur = t.rows[t.row];
    if (splitRow(cur).every((c) => !c) && t.row > sepIndex) { // an empty row ends the table
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      replace(ta, ls, le, '', ls);
      return true;
    }
    const rows = formatTable([...t.rows.slice(0, t.row + 1), '|' + ' |'.repeat(splitRow(t.rows[0]).length), ...t.rows.slice(t.row + 1)]);
    replace(ta, t.start, t.end, rows.join('\n'), t.start + cellOffset(rows, t.row + 1, 0));
    return true;
  }
  return false;
}

/**
 * Markdown-aware keys. Returns true when the key was handled.
 * opts: { indent: '\t' | '  ' | '    ', smartLists: bool, autoPair: bool }
 */
export function handleKey(ta, e, opts = {}) {
  if (e.isComposing) return false;
  const { selectionStart: s, selectionEnd: e2, value: v } = ta;
  const indent = opts.indent || '\t';
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
  if (opts.tables !== false && plain && (e.key === 'Tab' || e.key === 'Enter') && s === e2 && tableKey(ta, e)) return true;

  if (opts.autoPair && plain) {
    // Wrap a selection in any pair character; auto-close only brackets and quotes.
    if (PAIRS[e.key] && s !== e2) {
      e.preventDefault();
      replace(ta, s, e2, e.key + v.slice(s, e2) + PAIRS[e.key], s + 1, e2 + 1);
      return true;
    }
    if (s === e2 && CLOSERS.has(e.key) && v[s] === e.key) {
      e.preventDefault();
      ta.setSelectionRange(s + 1, s + 1);
      return true;
    }
    if (s === e2 && '([{"`'.includes(e.key) && e.key.length === 1) {
      const next = v[s] || ' ';
      const prev = v[s - 1] || ' ';
      const quote = e.key === '"' || e.key === '`';
      if (/[\s)\]}.,;:!?]/.test(next) && (!quote || /[\s([{]/.test(prev))) {
        e.preventDefault();
        replace(ta, s, s, e.key + PAIRS[e.key], s + 1);
        return true;
      }
    }
    if (e.key === 'Backspace' && s === e2 && s > 0 && PAIRS[v[s - 1]] && '([{"`'.includes(v[s - 1]) && v[s] === PAIRS[v[s - 1]]) {
      e.preventDefault();
      replace(ta, s - 1, s + 1, '', s - 1);
      return true;
    }
  }

  if (opts.smartLists !== false && e.key === 'Enter' && !e.shiftKey && plain && s === e2) {
    const ls = v.lastIndexOf('\n', s - 1) + 1;
    let le = v.indexOf('\n', s);
    if (le < 0) le = v.length;
    const line = v.slice(ls, le);
    const m = line.match(/^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/) || line.match(/^(\s*)(>\s?)/);
    if (!m || s < ls + m[0].length) return false;
    e.preventDefault();
    if (!line.slice(m[0].length).trim()) {
      replace(ta, ls, le, '', ls); // empty item ends the list
      return true;
    }
    let marker;
    if (m[2] && m[2].startsWith('>')) marker = m[2];
    else if (m[3]) marker = `${+m[3] + 1}${m[4]}${m[5]}`;
    else marker = `${m[2]}${m[5]}`;
    if (m[6]) marker += '[ ] ';
    const insert = '\n' + m[1] + marker;
    replace(ta, s, s, insert, s + insert.length);
    return true;
  }

  if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const [ls, le] = lineBounds(v, s, e2);
    const block = v.slice(ls, le);
    const isList = block.split('\n').every((l) => !l.trim() || /^\s*([-*+]|\d+[.)])\s/.test(l));
    if (!isList && s === e2 && !e.shiftKey) {
      e.preventDefault();
      replace(ta, s, s, indent, s + indent.length);
      return true;
    }
    e.preventDefault();
    const out = block.split('\n').map((l) => (e.shiftKey ? l.replace(/^(\t| {1,4})/, '') : l.trim() ? indent + l : l)).join('\n');
    const delta = out.length - block.length;
    if (s === e2) replace(ta, ls, le, out, Math.max(ls, s + (e.shiftKey ? delta : indent.length)));
    else replace(ta, ls, le, out, ls, ls + out.length);
    return true;
  }
  return false;
}
