// Text differences for "compare versions": a line diff (Myers' algorithm), with a
// word diff inside lines that were changed rather than added or removed.

/**
 * Shortest edit script between two arrays. Returns [op, value] pairs where op is
 * ' ' (kept), '-' (only in a) or '+' (only in b). Common ends are trimmed first, and
 * a very different middle falls back to "all removed, all added" to stay fast.
 */
export function diffArrays(a, b, maxD = 4000) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const head = a.slice(0, pre).map((x) => [' ', x]);
  const tail = a.slice(a.length - suf).map((x) => [' ', x]);
  return [...head, ...myers(A, B, maxD), ...tail];
}

function myers(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((x) => ['+', x]);
  if (!m) return a.map((x) => ['-', x]);
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return [...a.map((x) => ['-', x]), ...b.map((x) => ['+', x])];
  // walk back through the saved frontiers
  const out = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[off + k - 1] < vd[off + k + 1]) ? k + 1 : k - 1;
    const px = vd[off + prevK];
    const py = px - prevK;
    while (x > px && y > py) { out.push([' ', a[--x]]); y--; }
    if (x === px) out.push(['+', b[--y]]); else out.push(['-', a[--x]]);
  }
  while (x > 0 && y > 0) { out.push([' ', a[--x]]); y--; }
  return out.reverse();
}

const TOKENS = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

/** Word-level differences between two lines. */
export function diffWords(a, b) {
  return diffArrays(a.match(TOKENS) || [], b.match(TOKENS) || [], 600);
}

const escHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * The differences as HTML rows: line numbers, a +/- gutter and the text, with
 * unchanged stretches folded down to `context` lines around each change.
 */
export function diffHtml(oldText, newText, { context = 3 } = {}) {
  const ops = diffArrays(oldText.split('\n'), newText.split('\n'));
  const rows = [];
  let ai = 0;
  let bi = 0;
  let added = 0;
  let removed = 0;
  for (let i = 0; i < ops.length; i++) {
    const [op, text] = ops[i];
    // a run of removed lines followed by added lines: pair them up and mark the words
    if (op === '-') {
      let j = i;
      while (j < ops.length && ops[j][0] === '-') j++;
      let k = j;
      while (k < ops.length && ops[k][0] === '+') k++;
      const dels = ops.slice(i, j).map((o) => o[1]);
      const ins = ops.slice(j, k).map((o) => o[1]);
      const paired = Math.min(dels.length, ins.length);
      const pieces = [];
      for (let p = 0; p < dels.length; p++) {
        const words = p < paired && similar(dels[p], ins[p]) ? diffWords(dels[p], ins[p]) : null;
        pieces.push({ op: '-', a: ++ai, html: words ? words.filter((w) => w[0] !== '+').map((w) => (w[0] === '-' ? `<del>${escHtml(w[1])}</del>` : escHtml(w[1]))).join('') : escHtml(dels[p]) });
        removed++;
      }
      for (let p = 0; p < ins.length; p++) {
        const words = p < paired && similar(dels[p], ins[p]) ? diffWords(dels[p], ins[p]) : null;
        pieces.push({ op: '+', b: ++bi, html: words ? words.filter((w) => w[0] !== '-').map((w) => (w[0] === '+' ? `<ins>${escHtml(w[1])}</ins>` : escHtml(w[1]))).join('') : escHtml(ins[p]) });
        added++;
      }
      rows.push(...pieces);
      i = k - 1;
      continue;
    }
    if (op === '+') { rows.push({ op: '+', b: ++bi, html: escHtml(text) }); added++; continue; }
    rows.push({ op: ' ', a: ++ai, b: ++bi, html: escHtml(text) });
  }
  if (!added && !removed) return { html: '', added, removed };
  // fold unchanged lines that are far from any change
  const near = new Uint8Array(rows.length);
  rows.forEach((r, i) => { if (r.op !== ' ') for (let d = -context; d <= context; d++) if (rows[i + d]) near[i + d] = 1; });
  let html = '';
  for (let i = 0; i < rows.length; i++) {
    if (!near[i]) {
      let j = i;
      while (j < rows.length && !near[j]) j++;
      const hidden = rows.slice(i, j).map(line).join('');
      html += `<button class="diff-fold" data-fold>${j - i} unchanged line${j - i === 1 ? '' : 's'}</button><template>${hidden}</template>`;
      i = j - 1;
      continue;
    }
    html += line(rows[i]);
  }
  return { html, added, removed };
}

function line(r) {
  const cls = r.op === '+' ? 'ins' : r.op === '-' ? 'del' : 'eq';
  const sign = r.op === ' ' ? '' : r.op === '+' ? '+' : '−';
  return `<div class="diff-line ${cls}"><span class="ln">${r.a ?? ''}</span><span class="ln">${r.b ?? ''}</span><span class="sg" aria-hidden="true">${sign}</span><span class="tx">${r.html || ' '}</span></div>`;
}

/** Worth a word diff? Two lines that share at least a third of their text. */
function similar(a, b) {
  if (!a.trim() || !b.trim()) return false;
  const words = diffWords(a, b);
  const same = words.filter((w) => w[0] === ' ').reduce((n, w) => n + w[1].length, 0);
  return same * 3 >= Math.max(a.length, b.length);
}
