import { commands, highlight } from '../editor.js';
import { icon } from '../icons.js';
import { currentAccount, lockAccount, showLanding } from './accounts.js';
import { $, copyText, el, isMac, state, stem } from './core.js';
import { insertTemplate, newFromTemplate, openDaily } from './daily.js';
import { setFocus, setMode } from './layout.js';
import { deleteNote, download, duplicateNote, exportDialog, moveNoteDialog, newFolder, newNote, openHistory, shareDialog, tagsDialog } from './notes.js';
import { closeDrawer, showPanel, toggleSidebar } from './panels.js';
import { resolvedTheme, setSetting } from './prefs.js';
import { showSettings } from './shell.js';
import { nextIssue } from './spellui.js';
import { save, syncNow } from './sync.js';
import { closeTab, newTab, switchTab } from './tabs.js';
import { commandPalette, quickSwitcher } from './ui.js';
import { addProperties, block, togglePreviewEdit } from './writing.js';
import { toggleStar } from './tree.js';
import { find, findStep, openFind } from './find.js';
import { closeSide, swapSide } from './side.js';
import { archiveItem } from './bins.js';

// ------------------------------------------------------------------ hotkeys
export const CODE_KEYS = {
  Backslash: '\\', Slash: '/', Comma: ',', Period: '.', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
  Minus: '-', Equal: '=', Backquote: '`', Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End',
};
export function keyName(e) {
  const c = e.code || '';
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^Numpad\d$/.test(c)) return c.slice(6);
  if (/^F\d{1,2}$/.test(c)) return c;
  if (CODE_KEYS[c]) return CODE_KEYS[c];
  return e.key && e.key.length === 1 ? e.key.toUpperCase() : null;
}
export function comboFromEvent(e) {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) return null;
  const k = keyName(e);
  if (!k) return null;
  const parts = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (isMac && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(k);
  return parts.join('+');
}
export const KEY_LABELS = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space' };
export function comboLabel(combo) {
  if (!combo) return 'Not set';
  const mods = isMac ? { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' } : { Mod: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
  return combo.split('+').map((p) => mods[p] || KEY_LABELS[p] || p).join(isMac ? '' : ' ');
}

/** Editor commands act on the main editor, or on a block being edited in the preview. */
export const activeEditor = () => (document.activeElement?.classList?.contains('block-ta') ? document.activeElement : el.ta);
export const edit = (fn) => () => {
  const t = activeEditor();
  if (state.cur && (t !== el.ta || el.ws.dataset.mode !== 'read')) fn(t);
};
export const COMMANDS = [
  { id: 'quickOpen', group: 'General', label: 'Open a note', def: 'Mod+O', icon: 'search', run: () => quickSwitcher() },
  { id: 'palette', group: 'General', label: 'Command palette', def: 'Mod+Shift+P', icon: 'command', run: () => commandPalette() },
  { id: 'search', group: 'General', label: 'Search inside notes', def: 'Mod+P', icon: 'search', run: () => { showPanel('search', true); $('#searchInput').select(); } },
  { id: 'daily', group: 'General', label: 'Open today’s note', def: 'Alt+D', icon: 'calendar', run: () => openDaily() },
  { id: 'newNote', group: 'General', label: 'New note', def: 'Alt+N', run: () => newNote() },
  { id: 'newTab', group: 'General', label: 'New tab', def: 'Alt+T', run: () => newTab() },
  { id: 'closeTab', group: 'General', label: 'Close tab', def: 'Alt+W', run: () => closeTab(state.active) },
  { id: 'nextTab', group: 'General', label: 'Next tab', def: 'Alt+]', run: () => switchTab((state.active + 1) % state.tabs.length) },
  { id: 'prevTab', group: 'General', label: 'Previous tab', def: 'Alt+[', run: () => switchTab((state.active - 1 + state.tabs.length) % state.tabs.length) },
  { id: 'toggleRead', group: 'General', label: 'Switch between writing and reading', def: 'Mod+E', run: () => { if (state.cur) setMode(el.ws.dataset.mode === 'read' ? 'write' : 'read'); } },
  { id: 'toggleSidebar', group: 'General', label: 'Show or hide the sidebar', def: 'Mod+\\', run: () => toggleSidebar() },
  { id: 'focusMode', group: 'General', label: 'Focus mode', def: 'Mod+Shift+F', run: () => setFocus(!el.app.classList.contains('focus')) },
  { id: 'history', group: 'General', label: 'Version history of this note', def: 'Alt+H', run: () => openHistory() },
  { id: 'toggleTheme', group: 'General', label: 'Switch light and dark', def: 'Alt+L', run: () => setSetting('theme', resolvedTheme() === 'dark' ? 'light' : 'dark') },
  { id: 'save', group: 'General', label: 'Save and sync now', def: 'Mod+S', icon: 'refresh', run: () => syncNow() },
  { id: 'insertTemplate', group: 'General', label: 'Insert a template', def: 'Alt+Shift+T', icon: 'template', run: () => insertTemplate() },
  { id: 'outline', group: 'General', label: 'Show the outline', def: 'Alt+O', icon: 'outline', run: () => showPanel('outline', true) },
  { id: 'backlinks', group: 'General', label: 'Show backlinks', def: 'Alt+B', icon: 'link', run: () => showPanel('links', true) },
  { id: 'find', group: 'General', label: 'Find in this note', def: 'Mod+F', icon: 'search', run: () => openFind(false) },
  { id: 'replace', group: 'General', label: 'Find and replace', def: 'Mod+H', icon: 'search', run: () => openFind(true) },
  { id: 'findNext', group: 'General', label: 'Next match', def: 'F3', run: () => (find.open ? findStep(1) : openFind(false)) },
  { id: 'findPrev', group: 'General', label: 'Previous match', def: 'Shift+F3', run: () => (find.open ? findStep(-1) : openFind(false)) },
  { id: 'openSide', group: 'General', label: 'Open a note to the side', def: 'Mod+Alt+O', icon: 'columns', run: () => quickSwitcher({ toSide: true }) },
  { id: 'closeSide', group: 'General', label: 'Close the side note', def: '', icon: 'x', run: () => closeSide() },
  { id: 'swapSide', group: 'General', label: 'Swap the side note with the editor', def: '', icon: 'swap', run: () => swapSide() },
  { id: 'star', group: 'General', label: 'Star or unstar this note', def: 'Alt+S', icon: 'star', run: () => state.cur && toggleStar(state.cur.path) },
  { id: 'starred', group: 'General', label: 'Show starred notes', def: '', icon: 'star', run: () => showPanel('starred', true) },
  { id: 'export', group: 'General', label: 'Export this note (PDF, HTML, Markdown)', def: '', icon: 'download', run: () => exportDialog() },
  { id: 'properties', group: 'Editor', label: 'Add properties', def: '', icon: 'outline', run: () => addProperties() },
  { id: 'formatTable', group: 'Editor', label: 'Tidy the table', def: 'Mod+Shift+L', scope: 'editor', icon: 'layout', run: edit(commands.formatTable) },
  { id: 'previewEdit', group: 'General', label: 'Edit in preview on or off', def: '', icon: 'edit', run: () => togglePreviewEdit() },
  { id: 'nextIssue', group: 'Editor', label: 'Next writing suggestion', def: 'F8', scope: 'editor', icon: 'check', run: () => nextIssue() },
  { id: 'settings', group: 'General', label: 'Open settings', def: 'Mod+,', run: () => showSettings() },
  { id: 'bold', group: 'Editor', label: 'Bold', def: 'Mod+B', scope: 'editor', run: edit(commands.bold) },
  { id: 'italic', group: 'Editor', label: 'Italic', def: 'Mod+I', scope: 'editor', run: edit(commands.italic) },
  { id: 'strike', group: 'Editor', label: 'Strikethrough', def: 'Mod+Shift+X', scope: 'editor', run: edit(commands.strike) },
  { id: 'highlight', group: 'Editor', label: 'Highlight', def: 'Mod+Shift+M', scope: 'editor', run: edit(commands.mark) },
  { id: 'code', group: 'Editor', label: 'Inline code', def: 'Mod+Shift+E', scope: 'editor', run: edit(commands.code) },
  { id: 'link', group: 'Editor', label: 'Link', def: 'Mod+K', scope: 'editor', run: edit(commands.link) },
  { id: 'heading', group: 'Editor', label: 'Cycle heading level', def: 'Mod+Shift+H', scope: 'editor', run: edit(commands.heading) },
  { id: 'list', group: 'Editor', label: 'Bulleted list', def: 'Mod+Shift+8', scope: 'editor', run: edit(commands.list) },
  { id: 'ordered', group: 'Editor', label: 'Numbered list', def: 'Mod+Shift+7', scope: 'editor', run: edit(commands.ordered) },
  { id: 'checkbox', group: 'Editor', label: 'Toggle checkbox', def: 'Mod+Enter', scope: 'editor', run: edit(commands.checkbox) },
  { id: 'quote', group: 'Editor', label: 'Quote', def: 'Mod+Shift+.', scope: 'editor', run: edit(commands.quote) },
];
/** Everything the command palette can run: hotkey commands plus a few one-offs. */
export function allCommands() {
  const extra = [
    ['New note', 'filePlus', () => newNote()],
    ['New note from template', 'template', () => newFromTemplate()],
    ['New folder', 'folderPlus', () => newFolder()],
    ['Yesterday’s note', 'calendar', () => openDaily(-1)],
    ['Tomorrow’s note', 'calendar', () => openDaily(1)],
    ['Share this note', 'share', () => state.cur && shareDialog(state.cur.path)],
    ['Tags for this note', 'tag', () => state.cur && tagsDialog(state.cur.path)],
    ['Duplicate this note', 'copy', () => state.cur && duplicateNote(state.cur.path)],
    ['Move this note', 'move', () => state.cur && moveNoteDialog(state.cur.path)],
    ['Archive this note', 'archive', () => state.cur && archiveItem(state.cur.path)],
    ['Delete this note', 'trash', () => state.cur && deleteNote(state.cur.path)],
    ['Show the archive', 'archive', () => showPanel('archive', true)],
    ['Show the trash', 'trash', () => showPanel('trash', true)],
    ['Copy link to this note', 'link', () => state.cur && copyText(`[[${stem(state.cur.path)}]]`, 'Link copied')],
    ['Show tags', 'hash', () => showPanel('tags', true)],
    ['Import notes', 'download', () => showSettings('files')],
    ['Find unused attachments', 'image', () => showSettings('files')],
    ['Switch account', 'user', () => showLanding()],
    ['Add account', 'plus', () => showLanding({ create: true })],
    ...(currentAccount().locked ? [['Lock this account', 'logout', () => lockAccount()]] : []),
    ...[['general', 'General'], ['appearance', 'Appearance'], ['interface', 'Interface'], ['editor', 'Editor'], ['files', 'Files and links'], ['hotkeys', 'Hotkeys'], ['keychain', 'Keychain'], ['sync', 'Sync']]
      .map(([id, l]) => [`Settings: ${l}`, 'sliders', () => showSettings(id)]),
  ].map(([label, ic, run]) => ({ id: `x-${label}`, label, icon: ic, group: 'More', run }));
  return [...COMMANDS, ...extra];
}

export const keyFor = (id) => {
  const c = COMMANDS.find((x) => x.id === id);
  return id in state.settings.hotkeys ? state.settings.hotkeys[id] : c?.def || '';
};

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (e.defaultPrevented || el.layer.firstChild) return;
    if (el.app.classList.contains('focus') && document.activeElement !== el.title) { setFocus(false); return; }
    if (el.app.classList.contains('drawer-open')) closeDrawer();
    return;
  }
  if (el.layer.firstChild) return; // menus and dialogs handle their own keys
  const combo = comboFromEvent(e);
  if (!combo) return;
  if (/^Alt\+[1-9]$/.test(combo)) { e.preventDefault(); switchTab(Math.min(+combo.slice(4), state.tabs.length) - 1); return; }
  const inEditor = document.activeElement === el.ta || !!document.activeElement?.classList?.contains('block-ta');
  for (const c of COMMANDS) {
    if (keyFor(c.id) !== combo || (c.scope === 'editor' && !inEditor)) continue;
    if (c.run() === false) return; // nothing to do here: leave the key to the browser
    e.preventDefault();
    return;
  }
});
