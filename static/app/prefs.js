import { icon } from '../icons.js';
import { $, WIDTHS, api, el, state, store } from './core.js';
import { setMode } from './layout.js';
import { schedulePoll } from './shell.js';
import { runLint, startSpell } from './spellui.js';
import { flushPending, manual, saveLocal } from './sync.js';
import { prefetchNotes, refreshTree, renderTree } from './tree.js';
import { toast } from './ui.js';
import { renderPreview, updateCounts } from './writing.js';
import { plain } from './panels.js';

// ------------------------------------------------------------------ settings
export function resolvedTheme() {
  const t = state.settings.theme;
  return t === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t;
}

export function applySettings() {
  const s = state.settings;
  const r = document.documentElement;
  r.dataset.theme = resolvedTheme();
  r.dataset.font = s.font;
  r.style.setProperty('--hue', s.hue);
  r.style.setProperty('--acc-s', `${s.accentSat}%`);
  r.style.setProperty('--grain', s.grain);
  r.style.setProperty('--glow', s.glow);
  r.style.setProperty('--editor-size', `${s.fontSize}px`);
  r.style.setProperty('--editor-lh', s.lineHeight);
  r.style.setProperty('--measure', WIDTHS[s.width]?.[0] || WIDTHS.medium[0]);
  const custom = String(s.customFont || '').replace(/["';{}<>\\]/g, '').trim();
  if (custom) r.style.setProperty('--editor-font', `"${custom}", var(--font-sans)`);
  else r.style.removeProperty('--editor-font');
  r.classList.toggle('grain-anim', !!s.grainAnim);
  el.ta.spellcheck = s.spellEngine === 'browser';
  el.editor.classList.toggle('plain', !s.syntaxColors);
  el.main.classList.toggle('no-toolbar', !s.showToolbar);
  el.main.classList.toggle('no-arrows', !s.showArrows);
  el.main.classList.toggle('no-crumbs', !s.showCrumbs);
  el.tree.classList.toggle('no-file-icons', !s.showFileIcons);
  const items = { words: '#stWords', chars: '#stChars', read: '#stRead', width: '#stWidth', created: '#stCreated', modified: '#stModified' };
  for (const [k, sel] of Object.entries(items)) $(sel).hidden = !s.status[k];
  $('#stWidth span').textContent = WIDTHS[s.width]?.[1] || '';
  $('#themeBtn').innerHTML = icon(resolvedTheme() === 'dark' ? 'moon' : 'sun');
  $('meta[name="theme-color"]').setAttribute('content', getComputedStyle($('.tabbar')).backgroundColor);
  paintFavicon();
  schedulePoll();
  store.set('settings', s);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys[keys.length - 1]] = value;
}

export function setSetting(path, value) {
  setPath(state.settings, path, value);
  applySettings();
  if (path === 'sort') renderTree();
  if (path === 'mode') setMode(value, false);
  if (path === 'readingWpm') updateCounts();
  if (/^(spellEngine|dialect|harperRules)/.test(path)) startSpell();
  if (path.startsWith('spellGroups')) runLint();
  if (/^rich/.test(path) || path === 'previewEdit') renderPreview(true);
  if (path === 'previewEdit') $('#editPreviewBtn').classList.toggle('on', !!value);
  if (path === 'syncMode') { schedulePoll(true); if (!manual()) flushPending(); else if (state.cur?.dirty) saveLocal(); }
  if (path === 'offlineAll' && value) prefetchNotes(true);
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applySettings);

export let cfgTimer = 0;
export function setConfig(path, value) {
  setPath(state.config, path, value);
  clearTimeout(cfgTimer);
  cfgTimer = setTimeout(async () => {
    try { state.config = await api('PUT', '/api/config', state.config); refreshTree(); }
    catch (e) { toast(e.message, 'err'); }
  }, 350);
}

/** The browser-tab icon is the snowflake in the current accent colour. */
export function paintFavicon() {
  const probe = document.createElement('span');
  probe.style.color = 'var(--accent)';
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  const arm = '<path d="M12 2v20M9.5 3.5 12 6l2.5-2.5M9.5 20.5 12 18l2.5 2.5"/>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">`
    + [0, 60, 120].map((d) => `<g transform="rotate(${d} 12 12)">${arm}</g>`).join('') + '</svg>';
  $('#favicon').href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}
