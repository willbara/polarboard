import { openSettings } from '../settings.js';
import { idb } from '../offline.js';
import { GROUPS } from '../spell.js';
import { accounts, avatar, chooseAccount, currentAccount, loadAccounts, lockAccount, showLanding, switchAccount } from './accounts.js';
import { COMMANDS, comboFromEvent, comboLabel, keyFor } from './commands.js';
import { $, $$, ACCENTS, DEFAULTS, FORMATS, SORTS, VAULT, WIDTHS, api, dirname, el, fmtBytes, fmtDateTime, hooks, isMac, mergeSettings, relTime, state, stem, store } from './core.js';
import { formatDate, templateNotes } from './daily.js';
import { setFocus, setMode } from './layout.js';
import { importFiles, openHistory, saveFile } from './notes.js';
import { renderSearch } from './panels.js';
import { applySettings, cfgSaved, setConfig, setSetting } from './prefs.js';
import { spell, startSpell } from './spellui.js';
import { connectLive, flushPending, live, manual, pending, save, setSync, syncNow } from './sync.js';
import { loadNote, openNote, pathFromHash, renderTabs, showEmpty } from './tabs.js';
import { refreshTree, renderTree } from './tree.js';
import { closeLayer, dialog, toast } from './ui.js';
import { replace } from '../editor.js';
import { restoreSide } from './side.js';

// ------------------------------------------------------------------ settings window
export function showSettings(category) {
  openSettings({
    state, DEFAULTS, ACCENTS, FORMATS, WIDTHS, SORTS, COMMANDS,
    setSetting, setConfig, configSaved: () => cfgSaved, applySettings, api, toast, dialog, closeLayer, pending,
    keyFor, comboLabel, comboFromEvent, fmtBytes, fmtDateTime, relTime, saveFile,
    refreshTree, flushPending, openHistory: (p) => openHistory(p),
    stem, dirname, isMac, idb, VAULT, syncNow, spell, startSpell, GROUPS, formatDate, templateNotes,
    importFiles, liveConnected: () => live?.readyState === 1, avatar, loadAccounts, currentAccount, showLanding, switchAccount, lockAccount,
    accounts: () => accounts.list,
    replaceSettings(next) { state.settings = mergeSettings(next); applySettings(); setMode(state.settings.mode, false); renderTree(); startSpell(); },
  }, category);
}

// ------------------------------------------------------------------ lifecycle
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (state.cur?.dirty) { pending.put(state.cur.path, state.cur.content, state.cur.version); if (!manual()) save(); }
  } else refreshTree({ poll: true });
});
window.addEventListener('pagehide', () => { if (state.cur?.dirty) pending.put(state.cur.path, state.cur.content, state.cur.version); });
window.addEventListener('online', () => { if (!manual()) flushPending(); });

/**
 * Sync modes:
 *   live      changes stream in from the server as they happen (with a slow poll as backup)
 *   interval  check the server every N seconds
 *   manual    nothing is sent until you press Sync; edits wait on this device
 */
export let pollTimer = 0;
export let pollKey = '';
export function schedulePoll(force = false) {
  const mode = state.settings.syncMode;
  const every = mode === 'manual' ? 0 : mode === 'live' ? 60_000 : Math.max(5, +state.settings.pollInterval || 20) * 1000;
  const key = `${mode}:${every}`;
  if (key === pollKey && !force) return;
  pollKey = key;
  clearInterval(pollTimer);
  if (every) pollTimer = setInterval(() => { if (document.visibilityState === 'visible') refreshTree({ poll: true }); }, every);
  connectLive();
}

Object.assign(hooks, { toast, showLanding, flushPending });

/** Icon-only buttons are named after their tooltip for screen readers. */
export function labelIconButtons(root = document) {
  for (const b of root.querySelectorAll('button[title]:not([aria-label])')) if (!b.textContent.trim()) b.setAttribute('aria-label', b.title.replace(/\s*\(.*\)$/, ''));
}
$('#skipLink').addEventListener('click', (e) => { e.preventDefault(); if (state.cur) { if (el.ws.dataset.mode === 'read') el.previewPane.focus(); else el.ta.focus(); } });

export async function boot() {
  labelIconButtons();
  if (!(await chooseAccount())) return;
  applySettings();
  if (store.get('collapsed', false)) el.app.classList.add('sb-collapsed');
  $$('.panel').forEach((p) => { p.hidden = p.dataset.panel !== state.panel; });
  $$('.ptab[data-panel]').forEach((b) => b.classList.toggle('active', b.dataset.panel === state.panel));
  setMode(state.settings.mode, false);
  setFocus(false);
  el.main.classList.add('no-note');
  const s = state.settings;
  if (s.startup === 'empty') { state.tabs = [{ path: null, scroll: 0 }]; state.active = 0; }
  if (s.startup === 'note' && s.startupNote) { state.tabs = [{ path: s.startupNote, scroll: 0 }]; state.active = 0; }
  renderTabs();
  api('GET', '/api/config').then((c) => { state.config = c; }).catch(() => {});
  await refreshTree();
  restoreSide();
  if (state.panel === 'search') renderSearch();

  // Restore tabs, dropping any whose note no longer exists.
  const exists = (p) => state.tree.notes.some((n) => n.path === p) || !!pending.all()[p];
  const activeTab = state.tabs[state.active];
  state.tabs = state.tabs.filter((t) => t === activeTab || !t.path || exists(t.path));
  state.active = state.tabs.indexOf(activeTab);
  if (activeTab.path && !exists(activeTab.path)) activeTab.path = null;
  const fromHash = pathFromHash();
  if (fromHash && exists(fromHash)) {
    const i = state.tabs.findIndex((t) => t.path === fromHash);
    if (i >= 0) state.active = i; else state.tabs[state.active].path = fromHash;
  }
  const t = state.tabs[state.active];
  if (!t.path || !(await loadNote(t.path, { history: 'replace' }))) showEmpty();
  renderTabs();
  if (!manual()) flushPending();
  else if (Object.keys(pending.all()).length) setSync('local');
  await receiveShare();
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (window.requestIdleCallback) requestIdleCallback(() => startSpell(), { timeout: 2000 });
  else setTimeout(startSpell, 400);
}

/** Text shared to Polarboard from another app (installed app share sheet) lands in Inbox. */
export async function receiveShare() {
  const p = new URLSearchParams(location.search);
  if (!p.has('text') && !p.has('url') && !p.has('title')) return;
  history.replaceState(null, '', location.pathname);
  const text = [p.get('title'), p.get('text'), p.get('url')].filter(Boolean).join(' · ');
  try {
    const r = await api('POST', '/api/append', { path: 'Inbox', text: `- ${formatDate(new Date(), 'YYYY-MM-DD HH:mm')} ${text}` });
    await refreshTree();
    openNote(r.path);
    toast('Added to Inbox');
  } catch { toast('Could not save what was shared', 'err'); }
}
