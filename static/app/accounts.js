import { esc } from '../markdown.js';
import { icon } from '../icons.js';
import { $, VAULT, api, enc, state, store } from './core.js';
import { boot, showSettings } from './shell.js';
import { flushSave } from './sync.js';
import { closeLayer, menu } from './ui.js';

// ------------------------------------------------------------------ accounts (each account is a vault)
export const accounts = { list: store.get('accounts', []), needServer: false };
export const currentAccount = () => accounts.list.find((a) => a.id === VAULT) || { id: VAULT, name: VAULT, icon: null };

/** An account's picture: an uploaded image, or a glyph on its own tint. */
export function avatar(a, cls = '') {
  const ic = a?.icon || {};
  if (ic.type === 'image') return `<span class="avatar ${cls}"><img src="/api/account-icon?id=${enc(a.id)}&v=${ic.v}" alt=""></span>`;
  const glyph = !ic.name ? 'feather' : ic.name;
  return `<span class="avatar ${cls}" style="--ah:${ic.hue ?? 212}">${icon(glyph)}</span>`;
}

export async function loadAccounts() {
  const r = await api('GET', '/api/accounts');
  accounts.list = r.accounts;
  accounts.needServer = r.createNeedsServerPassword;
  store.set('accounts', r.accounts);
  renderAccountBtn();
  return r.accounts;
}

export function renderAccountBtn() {
  const a = currentAccount();
  $('#vaultBtn').innerHTML = avatar(a, 'sm');
  $('#vaultBtn').title = `${a.name}${a.locked ? ' · password protected' : ''}`;
}

/** Decide which account to open. Returns false when the landing page takes over instead. */
export async function chooseAccount() {
  let list;
  try { list = await loadAccounts(); } catch (e) {
    if (e.offline) { renderAccountBtn(); return true; } // keep working from this device's copy
    throw e;
  }
  const chosen = store.get('vault', null) !== null; // has this browser picked an account before?
  const cur = list.find((a) => a.id === VAULT);
  if (list.length === 1 && cur?.open) return true; // one open account: nothing to choose
  if (chosen && cur?.open) return true;
  const only = list.length === 1 && list[0].open ? list[0] : null;
  if (!cur && only) { store.set('vault', only.id); location.reload(); return false; }
  showLanding({ account: chosen && cur?.locked ? cur.id : null });
  return false;
}

export function enterAccount(id) {
  store.set('vault', id);
  history.replaceState(null, '', location.pathname);
  location.reload();
}

export async function switchAccount(id) {
  if (id === VAULT) return;
  const a = accounts.list.find((x) => x.id === id);
  await flushSave();
  if (a && !a.open) return showLanding({ account: id });
  enterAccount(id);
}

export let landingFrom = null;
export async function showLanding({ account = null, create = false } = {}) {
  closeLayer();
  if (state.cur) await flushSave().catch(() => {});
  try { await loadAccounts(); } catch { /* show what we have */ }
  const land = $('#landing');
  land.hidden = false;
  document.body.classList.add('locked');
  const grid = $('#accountGrid');
  grid.innerHTML = accounts.list.map((a) => `<button class="account-tile${a.id === VAULT ? ' current' : ''}" data-account="${esc(a.id)}">
      ${avatar(a, 'xl')}<span class="account-name">${esc(a.name)}</span>${a.locked ? `<span class="account-lock">${icon(a.open ? 'check' : 'key')}${a.open ? 'Unlocked' : 'Password'}</span>` : ''}
    </button>`).join('') + `<button class="account-tile add" data-add>${'<span class="avatar xl add">' + icon('plus') + '</span>'}<span class="account-name">Add account</span></button>`;
  landingFrom = state.cur ? 'app' : 'boot';
  $('#unlockForm').hidden = true;
  $('#createForm').hidden = true;
  grid.hidden = false;
  $('#landingSub').textContent = accounts.list.length > 1 ? 'Choose an account' : 'Welcome back';
  if (account) openUnlock(account);
  if (create) openCreate();
}

export function closeLanding() {
  $('#landing').hidden = true;
  document.body.classList.remove('locked');
}

export function openUnlock(id) {
  const a = accounts.list.find((x) => x.id === id);
  if (!a) return;
  $('#accountGrid').hidden = true;
  $('#unlockForm').hidden = false;
  $('#unlockForm').dataset.id = id;
  $('#unlockWho').innerHTML = `${avatar(a, 'xl')}<b>${esc(a.name)}</b>`;
  $('#unlockUser').value = a.name;
  $('#unlockError').textContent = '';
  $('#unlockPass').value = '';
  $('#landingSub').textContent = 'This account has a password';
  setTimeout(() => $('#unlockPass').focus(), 30);
}

export function openCreate() {
  $('#accountGrid').hidden = true;
  $('#createForm').hidden = false;
  $('#createServer').hidden = !accounts.needServer;
  $('#createServer').required = accounts.needServer;
  $('#createError').textContent = '';
  $('#landingSub').textContent = 'New account';
  setTimeout(() => $('#createName').focus(), 30);
}

$('#accountGrid').addEventListener('click', (e) => {
  if (e.target.closest('[data-add]')) return openCreate();
  const t = e.target.closest('[data-account]');
  if (!t) return;
  const a = accounts.list.find((x) => x.id === t.dataset.account);
  if (!a) return;
  if (!a.open) return openUnlock(a.id);
  if (a.id === VAULT && landingFrom === 'app') return closeLanding();
  enterAccount(a.id);
});
$('#landing').addEventListener('click', (e) => {
  if (!e.target.closest('[data-back]')) return;
  $('#unlockForm').hidden = true;
  $('#createForm').hidden = true;
  $('#accountGrid').hidden = false;
  $('#landingSub').textContent = accounts.list.length > 1 ? 'Choose an account' : 'Welcome back';
});
$('#landing').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && landingFrom === 'app' && currentAccount().open !== false) closeLanding();
});

$('#unlockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const id = e.target.dataset.id;
    await api('POST', '/api/accounts/unlock', { id, password: $('#unlockPass').value, remember: $('#unlockRemember').checked });
    enterAccount(id);
  } catch (err) {
    $('#unlockError').textContent = err.offline ? 'The server can’t be reached.' : err.message;
    $('#unlockPass').select();
  } finally { btn.disabled = false; }
});

$('#createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const a = await api('POST', '/api/accounts', { name: $('#createName').value.trim(), password: $('#createPass').value, serverPassword: $('#createServer').value });
    enterAccount(a.id);
  } catch (err) {
    $('#createError').textContent = err.offline ? 'The server can’t be reached.' : err.message;
  } finally { btn.disabled = false; }
});

export async function lockAccount() {
  await flushSave();
  try { await api('POST', '/api/accounts/lock', { id: VAULT }); } catch { /* locking locally still hides it */ }
  showLanding();
}

$('#vaultBtn').addEventListener('click', async (e) => {
  const anchor = e.currentTarget;
  try { await loadAccounts(); } catch { /* offline: use what we have */ }
  const cur = currentAccount();
  const others = accounts.list.filter((a) => a.id !== VAULT);
  menu(anchor, [
    { header: cur.name },
    { icon: 'gear', label: 'Account settings…', run: () => showSettings('general') },
    ...(cur.locked ? [{ icon: 'logout', label: 'Lock this account', run: lockAccount }] : []),
    '-',
    ...(others.length ? [{ header: 'Switch to' }, ...others.map((a) => ({ icon: a.locked && !a.open ? 'key' : 'user', label: a.name, run: () => switchAccount(a.id) }))] : []),
    { icon: 'plus', label: 'Add account…', run: () => showLanding({ create: true }) },
    { icon: 'layout', label: 'All accounts', run: () => showLanding() },
  ]);
});
