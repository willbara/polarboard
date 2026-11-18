import { esc } from '../markdown.js';
import { icon } from '../icons.js';
import { allCommands, comboLabel, keyFor } from './commands.js';
import { $, $$, cleanName, dirname, el, mobile, state, stem } from './core.js';
import { defaultFolder, newNote } from './notes.js';
import { newTab, openNote } from './tabs.js';
import { block } from './writing.js';
import { openSide } from './side.js';

// ------------------------------------------------------------------ menu / dialog / toast
export let layerCleanup = null;
export function closeLayer() {
  const fn = layerCleanup;
  layerCleanup = null;
  fn?.();
  el.layer.innerHTML = '';
}

/** Focus goes back to where it was when a menu or dialog closes, unless something else took it. */
export function focusReturn() {
  const prev = document.activeElement;
  return () => {
    const now = document.activeElement;
    if (prev?.isConnected && prev !== document.body && (!now || now === document.body || !now.isConnected)) prev.focus({ preventScroll: true });
  };
}

/** Keep Tab and Shift Tab inside a dialog. */
export function trapTab(e, box) {
  if (e.key !== 'Tab') return;
  const items = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', box)
    .filter((x) => !x.disabled && x.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

export function menu(anchor, items) {
  closeLayer();
  const back = focusReturn();
  const m = document.createElement('div');
  m.className = 'menu glass';
  m.setAttribute('role', 'menu');
  items.forEach((it) => {
    if (it === '-') { m.appendChild(document.createElement('hr')); return; }
    if (it.header || it.message) {
      const h = document.createElement('div');
      h.className = it.message ? `menu-msg g-${it.kind || ''}` : 'menu-label';
      h.textContent = it.header || it.message;
      m.appendChild(h);
      return;
    }
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitem');
    if (it.danger) b.className = 'danger';
    // it.swatch (a CSS color from our own palette, never user text) draws a color dot instead of an icon;
    // it.on marks the current choice with a check.
    b.innerHTML = (it.swatch ? `<span class="menu-swatch" style="--sw:${it.swatch}"></span>` : icon(it.icon, it.icon === 'blank' ? 'blank' : ''))
      + `<span>${esc(it.label)}</span>${it.on ? icon('check', 'menu-check') : ''}`;
    b.addEventListener('click', () => { closeLayer(); it.run(); });
    m.appendChild(b);
  });
  el.layer.appendChild(m);
  const isEl = typeof anchor.getBoundingClientRect === 'function' && anchor.isConnected;
  const r = isEl ? anchor.getBoundingClientRect() : { left: anchor.x ?? 100, right: anchor.x ?? 100, top: anchor.y ?? 100, bottom: anchor.y ?? 100 };
  const w = m.offsetWidth;
  const h = m.offsetHeight;
  let x = isEl ? r.right - w : r.left;
  let y = r.bottom + 6;
  x = Math.max(8, Math.min(x, innerWidth - w - 8));
  if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 6);
  if (y + h > innerHeight - 8) y = Math.max(8, innerHeight - h - 8);
  Object.assign(m.style, { left: `${x}px`, top: `${y}px` });
  m.querySelector('button')?.focus({ preventScroll: true });
  const away = (e) => { if (!m.contains(e.target)) closeLayer(); };
  const key = (e) => {
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeLayer(); }
    const bs = $$('button', m);
    const i = bs.indexOf(document.activeElement);
    const go = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: bs.length - 1 }[e.key];
    if (go !== undefined && bs.length) { e.preventDefault(); bs[(go + bs.length) % bs.length].focus(); }
  };
  let armed = false;
  const timer = setTimeout(() => { armed = true; document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', key, true); });
  layerCleanup = () => {
    clearTimeout(timer);
    if (armed) { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true); }
    queueMicrotask(back);
  };
}

/**
 * A modal dialog. With stack: true it opens on top of the current one
 * (used by confirmations inside Settings) instead of replacing it.
 */
export function dialog({ title, text, input, pick, buttons = [], content, cls = '', stack = false }) {
  if (!stack) closeLayer();
  const back = focusReturn();
  return new Promise((resolve) => {
    const bd = document.createElement('div');
    bd.className = 'backdrop';
    bd.innerHTML = `<div class="dialog glass ${cls}" role="dialog" aria-modal="true" aria-label="${esc(title || 'Dialog')}">
      ${title ? `<h3>${esc(title)}</h3>` : ''}${text ? `<p>${esc(text)}</p>` : ''}
      ${input ? `<input class="field" value="${esc(input.value || '')}" placeholder="${esc(input.placeholder || '')}" type="${input.type || 'text'}" spellcheck="false">` : ''}
      ${pick ? `<div class="pick">${pick.map((p, i) => `<button data-i="${i}">${icon(p.icon || 'folder')}<span>${esc(p.label)}</span></button>`).join('')}</div>` : ''}
      <div class="dialog-body"></div>
      ${buttons.length ? `<div class="actions">${buttons.map((b, i) => `<button class="btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}" data-b="${i}">${esc(b.label)}</button>`).join('')}</div>` : ''}
    </div>`;
    const box = bd.firstElementChild;
    if (content) box.querySelector('.dialog-body').appendChild(content);
    const field = box.querySelector('.field');
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      bd.remove();
      if (layerCleanup === cleanup) layerCleanup = null;
      back();
      resolve(v);
    };
    const cleanup = () => done(null);
    const valueOf = (b) => (b.value === true && field ? field.value : b.value ?? null);
    const onKey = (e) => {
      if (el.layer.lastElementChild !== bd) return; // only the top dialog listens
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      trapTab(e, box);
      if (e.key === 'Enter' && field && document.activeElement === field) {
        e.preventDefault();
        const p = buttons.find((b) => b.primary);
        done(p ? valueOf(p) : field.value);
      }
    };
    document.addEventListener('keydown', onKey, true);
    bd.addEventListener('pointerdown', (e) => { if (e.target === bd) done(null); });
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-b]');
      if (b && b.closest('.dialog') === box && !b.closest('.dialog-body')) return done(valueOf(buttons[+b.dataset.b]));
      const p = e.target.closest('.pick [data-i]');
      if (p) done(pick[+p.dataset.i].value);
    });
    el.layer.appendChild(bd);
    if (!stack) layerCleanup = cleanup;
    if (field) { field.focus(); field.select(); }
    else if (!content) box.querySelector('.btn.primary, .btn.danger, .pick button, .btn')?.focus();
    else requestAnimationFrame(() => { if (!box.contains(document.activeElement)) box.querySelector('button, input, select, textarea, [href]')?.focus({ preventScroll: true }); });
  });
}

export let toastBox;
export function toast(msg, kind = '') {
  if (!toastBox) {
    toastBox = document.createElement('div');
    toastBox.className = 'toasts';
    toastBox.setAttribute('role', 'status'); // screen readers announce each toast
    toastBox.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastBox);
  }
  const t = document.createElement('div');
  t.className = `toast glass ${kind}`;
  t.textContent = msg;
  toastBox.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'err' ? 4200 : 2400);
}

// ------------------------------------------------------------------ fuzzy matching
/** Score how well q matches s as a subsequence. Higher is better; null means no match. */
export function fuzzy(q, s) {
  if (!q) return { score: 0, idx: [] };
  const ql = q.toLowerCase();
  const sl = s.toLowerCase();
  const direct = sl.indexOf(ql);
  if (direct >= 0) {
    const idx = [...Array(ql.length).keys()].map((k) => direct + k);
    return { score: 1000 - direct * 2 - s.length * 0.1 + (direct === 0 || /[\s/_-]/.test(s[direct - 1]) ? 200 : 0), idx };
  }
  let score = 0;
  let j = 0;
  let last = -2;
  const idx = [];
  for (let i = 0; i < sl.length && j < ql.length; i++) {
    if (sl[i] !== ql[j]) continue;
    score += i === last + 1 ? 12 : 1;
    if (i === 0 || /[\s/_-]/.test(s[i - 1])) score += 8;
    idx.push(i);
    last = i;
    j++;
  }
  return j === ql.length ? { score: score - s.length * 0.05, idx } : null;
}
export function markMatch(s, idx) {
  if (!idx?.length) return esc(s);
  const set = new Set(idx);
  return [...s].map((ch, i) => (set.has(i) ? `<mark>${esc(ch)}</mark>` : esc(ch))).join('');
}

// ------------------------------------------------------------------ quick switcher & command palette
export function picker({ placeholder, source, sideHint = false }) {
  closeLayer();
  const bd = document.createElement('div');
  bd.className = 'backdrop picker-backdrop';
  bd.innerHTML = `<div class="picker glass" role="dialog" aria-label="${esc(placeholder)}">
    <input class="picker-input" placeholder="${esc(placeholder)}" spellcheck="false" autocomplete="off">
    <div class="picker-list scroll" role="listbox"></div>
    <div class="picker-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Ctrl Enter</kbd> new tab</span>${sideHint ? '<span><kbd>Alt Enter</kbd> to the side</span>' : ''}<span><kbd>Esc</kbd> close</span></div>
  </div>`;
  const input = bd.querySelector('input');
  const list = bd.querySelector('.picker-list');
  let items = [];
  let i = 0;
  const draw = () => {
    list.innerHTML = items.length ? items.map((it, k) => `<button class="pick-item${k === i ? ' active' : ''}" data-k="${k}" role="option">
      ${icon(it.icon || 'file')}<span class="pi-main"><span class="pi-label">${it.html || esc(it.label)}</span>${it.detail ? `<small>${esc(it.detail)}</small>` : ''}</span>
      ${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ''}</button>`).join('') : '<div class="tree-empty">Nothing matches.</div>';
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  const update = () => { items = source(input.value.trim()); i = 0; draw(); };
  const close = () => { document.removeEventListener('keydown', onKey, true); bd.remove(); if (layerCleanup === close) layerCleanup = null; };
  const choose = (it, e) => { if (!it) return; close(); it.run({ newTab: e.ctrlKey || e.metaKey, side: e.altKey, query: input.value.trim() }); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); i = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(items[i], e); }
  };
  input.addEventListener('input', update);
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) choose(items[+b.dataset.k], e); });
  list.addEventListener('mousemove', (e) => { const b = e.target.closest('[data-k]'); if (b && +b.dataset.k !== i) { i = +b.dataset.k; $$('.pick-item', list).forEach((x, k) => x.classList.toggle('active', k === i)); } });
  bd.addEventListener('pointerdown', (e) => { if (e.target === bd) close(); });
  document.addEventListener('keydown', onKey, true);
  el.layer.appendChild(bd);
  layerCleanup = close;
  update();
  input.focus();
}

export function quickSwitcher({ toSide = false } = {}) {
  const sideOk = !mobile.matches;
  picker({
    placeholder: toSide ? 'Open a note to the side…' : 'Open a note…',
    sideHint: sideOk && !toSide,
    source: (q) => {
      const notes = state.tree.notes;
      let out;
      if (!q) {
        out = [...notes].sort((a, b) => b.modified - a.modified).slice(0, 40).map((n) => ({ n }));
      } else {
        out = notes.map((n) => {
          const name = stem(n.path);
          const a = fuzzy(q, name);
          const b = fuzzy(q, n.path.replace(/\.md$/i, ''));
          const best = a && (!b || a.score + 50 >= b.score) ? { ...a, onName: true, score: a.score + 50 } : b;
          return best ? { n, ...best } : null;
        }).filter(Boolean).sort((x, y) => y.score - x.score).slice(0, 50);
      }
      const items = out.map(({ n, idx, onName }) => ({
        icon: 'file',
        label: stem(n.path),
        html: onName ? markMatch(stem(n.path), idx) : esc(stem(n.path)),
        detail: dirname(n.path) || '',
        run: ({ newTab, side }) => ((toSide || side) && sideOk ? openSide(n.path) : openNote(n.path, { newTab })),
      }));
      if (q && !notes.some((n) => stem(n.path).toLowerCase() === q.toLowerCase())) {
        items.push({ icon: 'filePlus', label: `Create “${q}”`, detail: defaultFolder() || 'Vault root', run: ({ newTab }) => newNote(defaultFolder(), cleanName(q), { editTitle: false, newTab }) });
      }
      return items;
    },
  });
}

export function commandPalette() {
  picker({
    placeholder: 'Run a command…',
    source: (q) => allCommands()
      .map((c) => ({ c, m: fuzzy(q, c.label) }))
      .filter((x) => x.m)
      .sort((a, b) => b.m.score - a.m.score)
      .map(({ c, m }) => ({ icon: c.icon || 'command', label: c.label, html: markMatch(c.label, m.idx), detail: c.group, hint: c.def !== undefined ? comboLabel(keyFor(c.id)).replace('Not set', '') : '', run: () => c.run() })),
  });
}
