// Settings window: a category list on the left, the chosen page on the right.
// Client settings live in this browser; account settings (name, picture,
// password, history, git, attachments) live on the server.

import { icon } from './icons.js';
import { esc } from './markdown.js';

const CATS = [
  ['general', 'General', 'gear'],
  ['appearance', 'Appearance', 'palette'],
  ['interface', 'Interface', 'layout'],
  ['editor', 'Editor', 'type'],
  ['files', 'Files and links', 'paperclip'],
  ['hotkeys', 'Hotkeys', 'keyboard'],
  ['keychain', 'Keychain', 'key'],
  ['sync', 'Sync', 'cloud'],
];

// ------------------------------------------------------------------ controls
const get = (o, path) => path.split('.').reduce((a, k) => a?.[k], o);
const FMT = {};

function row(label, desc, ctl, cls = '') {
  return `<div class="pref ${cls}"><div class="pref-label"><span>${label}</span>${desc ? `<small>${desc}</small>` : ''}</div><div class="pref-ctl">${ctl}</div></div>`;
}
function group(title, inner, note = '') {
  return `<div class="pref-group">${title ? `<h4>${title}</h4>` : ''}${note ? `<p>${note}</p>` : ''}${inner}</div>`;
}
function seg(o, key, opts, kind = 's') {
  return `<div class="opts" data-seg="${key}" data-kind="${kind}">${opts.map(([v, l]) =>
    `<button data-v="${esc(String(v))}" class="${String(get(o, key)) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
}
function toggle(o, key, kind = 's') {
  const on = !!get(o, key);
  return `<button class="switch${on ? ' on' : ''}" data-toggle="${key}" data-kind="${kind}" role="switch" aria-checked="${on}"></button>`;
}
function range(o, key, min, max, step, fmt = (v) => v, kind = 's') {
  FMT[key] = fmt;
  const v = get(o, key);
  return `<div class="range"><input type="range" data-range="${key}" data-kind="${kind}" min="${min}" max="${max}" step="${step}" value="${v}"><output>${fmt(v)}</output></div>`;
}
function select(o, key, opts, kind = 's') {
  const cur = String(get(o, key));
  return `<select class="sel" data-select="${key}" data-kind="${kind}">${opts.map(([v, l]) =>
    `<option value="${esc(String(v))}"${cur === String(v) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}
function text(o, key, ph, kind = 's') {
  return `<input class="txt" data-text="${key}" data-kind="${kind}" value="${esc(get(o, key) ?? '')}" placeholder="${esc(ph)}" spellcheck="false" autocomplete="off">`;
}
const btn = (act, label, cls = '', extra = '') => `<button class="btn sm ${cls}" data-act="${act}" ${extra}>${label}</button>`;

function coerce(old, v) {
  if (typeof old === 'number') return Number(v);
  if (typeof old === 'boolean') return v === true || v === 'true';
  return v;
}

function bindControls(body, ctx, rerender) {
  const target = (kind) => (kind === 'c' ? ctx.state.config : ctx.state.settings);
  const commit = (key, kind, raw) => {
    const value = coerce(get(target(kind), key), raw);
    if (kind === 'c') ctx.setConfig(key, value); else ctx.setSetting(key, value);
  };
  body.addEventListener('click', (e) => {
    const s = e.target.closest('[data-seg] [data-v]');
    if (s) { const box = s.parentElement; commit(box.dataset.seg, box.dataset.kind, s.dataset.v); rerender(); return; }
    const t = e.target.closest('[data-toggle]');
    if (t) { commit(t.dataset.toggle, t.dataset.kind, !get(target(t.dataset.kind), t.dataset.toggle)); rerender(); }
  });
  body.addEventListener('input', (e) => {
    const r = e.target.closest('[data-range]');
    if (!r) return;
    commit(r.dataset.range, r.dataset.kind, +r.value);
    r.nextElementSibling.textContent = (FMT[r.dataset.range] || ((v) => v))(+r.value);
  });
  body.addEventListener('change', (e) => {
    const s = e.target.closest('[data-select]');
    if (s) { commit(s.dataset.select, s.dataset.kind, s.value); rerender(); return; }
    const t = e.target.closest('[data-text]');
    if (t) commit(t.dataset.text, t.dataset.kind, t.value.trim());
  });
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-text]')) e.target.blur();
  });
}

const pct = (v) => `${Math.round(v * 100)}%`;
const notesOpts = (ctx) => ctx.state.tree.notes.map((n) => [n.path, n.path.replace(/\.md$/i, '')]);
const folderOpts = (ctx) => ctx.state.tree.folders.map((f) => [f, f]);

// ------------------------------------------------------------------ pages
const CREDITS = [
  ['Harper', '3.2.0', 'Apache-2.0', 'Grammar, spelling and style checks, by Automattic', 'https://github.com/Automattic/harper', 'harper'],
  ['highlight.js', '11.12.0', 'BSD-3-Clause', 'Code highlighting in the preview', 'https://highlightjs.org', 'hljs'],
  ['KaTeX', '0.19.1', 'MIT', 'Math in the preview', 'https://katex.org', 'katex'],
  ['Mermaid', '12.3.0', 'MIT', 'Diagrams in the preview', 'https://mermaid.js.org', 'mermaid'],
];

const SYNC_MODES = {
  live: 'Changes save as you type and arrive from other devices the moment they happen.',
  interval: 'Changes save as you type. Other devices’ changes are checked on a timer.',
  manual: 'Changes stay on this device until you press Sync (or Ctrl S). Good for spotty connections.',
};

const PAGES = {
  async general(ctx) {
    const s = ctx.state.settings;
    const [info, list] = await Promise.all([ctx.api('GET', '/api/info').catch(() => null), ctx.loadAccounts().catch(() => ctx.accounts())]);
    const me = list.find((a) => a.id === ctx.VAULT) || ctx.currentAccount();
    const ic = me.icon || {};
    const up = info ? Math.max(1, Math.round((Date.now() - info.started) / 3600000)) : 0;
    const glyphs = ['snowflake', 'mountain', 'moon', 'leaf', 'book', 'star', 'flame', 'coffee', 'feather', 'compass', 'wave', 'home', 'heart', 'code'];
    const hues = [212, 190, 160, 95, 45, 25, 350, 300, 265, 0];
    const stats = info ? `<div class="stats">
      <div class="stat"><b>${info.notes.toLocaleString()}</b><small>notes</small></div>
      <div class="stat"><b>${info.folders.toLocaleString()}</b><small>folders</small></div>
      <div class="stat"><b>${ctx.fmtBytes(info.attachments.bytes)}</b><small>${info.attachments.files} attachments</small></div>
      <div class="stat"><b>${info.history.versions.toLocaleString()}</b><small>saved versions</small></div>
    </div>` : '<div class="item-empty">The server is not reachable right now.</div>';
    const password = me.locked
      ? `<div class="form">
          <input class="txt" data-f="current" type="password" placeholder="Current password" autocomplete="current-password">
          <input class="txt" data-f="password" type="password" placeholder="New password (8+ characters)" autocomplete="new-password">
          <input class="txt" data-f="confirm" type="password" placeholder="Confirm new password" autocomplete="new-password">
          <div style="display:flex;gap:8px">${btn('change-password', 'Change password', 'outline')}${btn('remove-password', 'Remove password', 'danger-outline')}</div></div>`
      : `<p style="margin:0 0 8px;color:var(--text-3)">No password: anyone who can reach this server can open this account.</p>
        <div class="form">
          <input class="txt" data-f="password" type="password" placeholder="New password (8+ characters)" autocomplete="new-password">
          <input class="txt" data-f="confirm" type="password" placeholder="Confirm password" autocomplete="new-password">
          <div>${btn('set-password', 'Set password', 'outline')}</div></div>`;
    const others = list.filter((a) => a.id !== me.id);
    return group('Account', `
        <div class="profile">
          ${ctx.avatar(me, 'xl')}
          <div class="profile-main">
            <div class="form inline" style="margin:0"><input class="txt" data-f="acct-name" value="${esc(me.name)}" maxlength="40" placeholder="Account name">${btn('rename', 'Save name', 'outline')}</div>
            <small>${me.locked ? 'Password protected' : 'No password'} · ${info ? `${info.notes} notes` : ''}</small>
          </div>
        </div>
        <div class="pref stack"><div class="pref-label"><span>Picture</span><small>Pick a symbol and a color, or upload your own picture.</small></div>
          <div class="pref-ctl">
            <div class="glyph-grid">${glyphs.map((g) => `<button class="glyph${ic.type !== 'image' && (ic.name || 'snowflake') === g ? ' active' : ''}" data-glyph="${g}" title="${g}" style="--ah:${ic.hue ?? 212}">${icon(g === 'snowflake' ? 'logo' : g)}</button>`).join('')}</div>
            <div class="swatches" style="margin-top:10px">${hues.map((h) => `<button class="swatch${ic.type !== 'image' && (ic.hue ?? 212) === h ? ' active' : ''}" style="--h:${h};--s:55%" data-ahue="${h}" title="Color"></button>`).join('')}</div>
            <div style="display:flex;gap:8px;margin-top:12px">${btn('upload-picture', 'Upload picture…', 'outline')}${ic.type === 'image' ? btn('remove-picture', 'Use a symbol instead', 'ghost') : ''}</div>
          </div></div>
        <div class="pref stack"><div class="pref-label"><span>Password</span><small>Locks this account (and only this one) behind a password on every device.</small></div><div class="pref-ctl">${password}</div></div>`)
      + group('Other accounts', `<div class="items">${others.map((a) => `<div class="item">${ctx.avatar(a, 'sm')}<div class="grow"><b>${esc(a.name)}</b><small>${a.locked ? (a.open ? 'Password protected · unlocked here' : 'Password protected') : 'No password'}</small></div>${btn('open-account', 'Open', 'outline', `data-id="${esc(a.id)}"`)}</div>`).join('') || '<div class="item-empty">This is the only account.</div>'}</div>
          ${btn('add-account', 'Add account', 'outline')}`,
        'Every account is its own set of notes, with its own folders, tags, history, trash and settings on the server.')
      + group('Server', stats + (info ? row('Notes are stored in', '', `<span class="mono">${esc(info.vault)}</span>`)
        + row('Version', `Running for about ${up} hour${up === 1 ? '' : 's'}`, `<span class="mono">Polarboard ${esc(info.version)}</span>`) : ''))
      + group('Startup',
        row('When Polarboard opens', '', select(s, 'startup', [['restore', 'Reopen my tabs'], ['empty', 'Start with an empty tab'], ['note', 'Open a specific note']]))
        + (s.startup === 'note' ? row('Note to open', '', select(s, 'startupNote', [['', 'Choose a note…'], ...notesOpts(ctx)])) : ''))
      + group('Deleting',
        row('Ask before deleting', 'A confirmation before notes or folders are removed.', toggle(s, 'confirmDelete'))
        + row('Deleted notes go to', 'Notes in the trash can be restored from Sync.', seg(s, 'deleteMode', [['trash', 'Trash'], ['permanent', 'Delete for good']])))
      + group('This browser',
        row('Export settings', 'Save these settings as a file to copy them to another device.', btn('export', 'Export'))
        + row('Import settings', '', btn('import', 'Import…'))
        + row('Reset settings', 'Back to defaults. Your notes are not touched.', btn('reset', 'Reset', 'danger-outline')),
        'Appearance, interface, editor and hotkey settings are saved in this browser. Accounts, history, git and the attachment folder are saved on the server.')
      + group('Credits', `<div class="items">${CREDITS.map(([name, ver, lic, what, url, dir]) => `<div class="item">${icon('heart')}<div class="grow"><b>${name} <span class="badge">${ver}</span></b><small>${what} · ${lic}</small></div>
          <a class="btn sm ghost" href="${url}" target="_blank" rel="noopener noreferrer">Website</a><a class="btn sm ghost" href="/static/vendor/${dir}/LICENSE" target="_blank">License</a></div>`).join('')}</div>`,
        'Polarboard is built on these open-source projects. Thank you to their authors. Each one is bundled with its license, unchanged.')
      + (me.id !== 'main' ? group('Delete this account', row(`Delete “${esc(me.name)}”`, 'Its notes are moved aside on the server (into .polarboard-server/deleted-accounts), not erased.', btn('delete-account', 'Delete account', 'danger-outline'))) : '');
  },
  mountGeneral(body, ctx, rerender) {
    const val = (f) => body.querySelector(`[data-f="${f}"]`)?.value || '';
    const me = () => ctx.currentAccount();
    const refresh = async () => { await ctx.loadAccounts(); rerender(); };
    body.addEventListener('click', async (e) => {
      const g = e.target.closest('[data-glyph], [data-ahue]');
      const b = e.target.closest('[data-act]');
      try {
        if (g) {
          const ic = me().icon || {};
          const next = { type: 'glyph', name: g.dataset.glyph || (ic.type === 'image' ? 'snowflake' : ic.name || 'snowflake'), hue: g.dataset.ahue ? +g.dataset.ahue : ic.hue ?? 212 };
          await ctx.api('POST', '/api/account', { icon: next });
          return refresh();
        }
        if (!b) return;
        const act = b.dataset.act;
        if (act === 'rename') { await ctx.api('POST', '/api/account', { name: val('acct-name').trim() }); ctx.toast('Name saved'); return refresh(); }
        if (act === 'upload-picture') {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'image/png,image/jpeg,image/webp,image/gif';
          input.onchange = async () => {
            const f = input.files[0];
            if (!f) return;
            if (f.size > 2 * 1024 * 1024) return ctx.toast('Pick a picture under 2 MB', 'err');
            try { await ctx.api('POST', '/api/account/icon', f); refresh(); } catch (err) { ctx.toast(err.message, 'err'); }
          };
          input.click();
        }
        if (act === 'remove-picture') { await ctx.api('POST', '/api/account', { icon: { type: 'glyph', name: 'snowflake', hue: me().icon?.hue ?? 212 } }); return refresh(); }
        if (act === 'set-password' || act === 'change-password') {
          if (val('password') !== val('confirm')) return ctx.toast('The passwords do not match', 'err');
          await ctx.api('POST', '/api/account/password', { current: val('current'), password: val('password') });
          ctx.toast(act === 'set-password' ? 'Password set. This device stays unlocked.' : 'Password changed. Other devices will need it again.');
          return refresh();
        }
        if (act === 'remove-password') {
          const ok = await ctx.dialog({ stack: true, title: 'Remove the password?', text: 'Anyone who can reach this server will be able to open this account.', buttons: [{ label: 'Cancel' }, { label: 'Remove', danger: true, value: true }] });
          if (!ok) return;
          await ctx.api('POST', '/api/account/password', { current: val('current'), remove: true });
          ctx.toast('Password removed');
          return refresh();
        }
        if (act === 'open-account') { ctx.closeLayer(); ctx.switchAccount(b.dataset.id); }
        if (act === 'add-account') { ctx.closeLayer(); ctx.showLanding({ create: true }); }
        if (act === 'delete-account') {
          const box = document.createElement('div');
          box.innerHTML = (me().locked ? '<input class="txt" data-pw type="password" placeholder="This account’s password" style="width:100%;margin-bottom:8px">' : '')
            + '<input class="txt" data-server type="password" placeholder="Server password (if the server has one)" style="width:100%">';
          const ok = await ctx.dialog({ stack: true, title: `Delete “${me().name}”?`, text: 'You’ll go back to the account list. The notes are moved aside on the server, not erased.', content: box, buttons: [{ label: 'Cancel' }, { label: 'Delete', danger: true, value: true }] });
          if (!ok) return;
          await ctx.api('DELETE', '/api/account', { password: box.querySelector('[data-pw]')?.value || '', serverPassword: box.querySelector('[data-server]').value });
          localStorage.setItem('pb:vault', JSON.stringify('main'));
          location.reload();
        }
        if (act === 'export') ctx.saveFile('polarboard-settings.json', new Blob([JSON.stringify(ctx.state.settings, null, 2)], { type: 'application/json' }));
        if (act === 'import') {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'application/json,.json';
          input.onchange = async () => {
            try {
              const data = JSON.parse(await input.files[0].text());
              if (!data || typeof data !== 'object') throw new Error();
              ctx.replaceSettings(data);
              ctx.toast('Settings imported');
              rerender();
            } catch { ctx.toast('That file is not a Polarboard settings file', 'err'); }
          };
          input.click();
        }
        if (act === 'reset') {
          const ok = await ctx.dialog({ stack: true, title: 'Reset all settings?', text: 'Appearance, editor, hotkeys and the rest go back to their defaults on this browser.', buttons: [{ label: 'Cancel' }, { label: 'Reset', danger: true, value: true }] });
          if (ok) { ctx.replaceSettings({}); ctx.toast('Settings reset'); rerender(); }
        }
      } catch (err) { ctx.toast(err.message, 'err'); }
    });
    body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[data-f="acct-name"]')) body.querySelector('[data-act="rename"]').click(); });
  },

  appearance(ctx) {
    const s = ctx.state.settings;
    const swatches = `<div class="swatches">${ctx.ACCENTS.map(([h, sat, name]) =>
      `<button class="swatch${+s.hue === h && +s.accentSat === sat ? ' active' : ''}" style="--h:${h};--s:${sat}%" data-accent="${h},${sat}" title="${name}"></button>`).join('')}</div>`;
    return group('Theme', row('Color scheme', 'Auto follows your system.', seg(s, 'theme', [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']])))
      + group('Accent',
        row('Accent color', 'Used sparingly: the logo, the active tab, buttons, switches and focus outlines.', swatches)
        + row('Custom hue', '', range(s, 'hue', 0, 359, 1, (v) => `${v}°`))
        + row('Saturation', 'Turn it all the way down for a silver accent.', range(s, 'accentSat', 0, 100, 1, (v) => `${v}%`))
        + row('Glow', 'How much light the accent gives off.', range(s, 'glow', 0, 1, 0.05, pct)))
      + group('Texture',
        row('Film grain', '', range(s, 'grain', 0, 1, 0.02, pct))
        + row('Animate grain', 'Moves like film. Stays still when your system asks for reduced motion.', toggle(s, 'grainAnim')));
  },
  mountAppearance(body, ctx, rerender) {
    body.addEventListener('click', (e) => {
      const sw = e.target.closest('[data-accent]');
      if (!sw) return;
      const [h, sat] = sw.dataset.accent.split(',').map(Number);
      ctx.setSetting('hue', h);
      ctx.setSetting('accentSat', sat);
      rerender();
    });
  },

  interface(ctx) {
    const s = ctx.state.settings;
    return group('Notes',
      row('Default view', 'How notes open. Ctrl E switches at any time.', seg(s, 'mode', [['write', 'Write'], ['split', 'Split'], ['read', 'Read']]))
      + row('Clicking a note in the sidebar', 'Ctrl-click or middle-click does the opposite.', seg(s, 'tabMode', [['replace', 'Use this tab'], ['new', 'Open a new tab']])))
      + group('Header',
        row('Formatting toolbar', '', toggle(s, 'showToolbar'))
        + row('Back and forward arrows', '', toggle(s, 'showArrows'))
        + row('Folder path', 'The breadcrumb beside the arrows.', toggle(s, 'showCrumbs')))
      + group('Sidebar',
        row('File icons', '', toggle(s, 'showFileIcons'))
        + row('Default order', 'Each folder can override this from its right-click menu.', select(s, 'sort', ctx.SORTS)))
      + group('Status bar',
        row('Word count', '', toggle(s, 'status.words'))
        + row('Character count', '', toggle(s, 'status.chars'))
        + row('Reading time', '', toggle(s, 'status.read'))
        + row('Reading speed', 'Used for the reading time.', range(s, 'readingWpm', 120, 400, 10, (v) => `${v} wpm`))
        + row('Margins switch', '', toggle(s, 'status.width'))
        + row('Date created', '', toggle(s, 'status.created'))
        + row('Last edited', '', toggle(s, 'status.modified')))
      + group('Focus mode',
        row('Show controls at the edges', 'Point at the top or bottom of the window to bring the bars back. Turn off to keep them hidden until Esc.', toggle(s, 'focusReveal')));
  },

  async editor(ctx) {
    const s = ctx.state.settings;
    const words = s.spellEngine === 'harper' ? (await ctx.api('GET', '/api/dictionary').catch(() => ({ words: [] }))).words : [];
    const engines = { harper: 'Harper checks spelling, grammar, punctuation and style as you write. It runs entirely in this browser; nothing is sent anywhere.', browser: 'Your browser’s built-in spellcheck. Spelling only, and it also flags #tags and links.', off: 'No underlines.' };
    const groups = Object.entries(ctx.GROUPS).map(([key, g]) => row(g.label, '', toggle(s, `spellGroups.${key}`))).join('');
    return group('Text',
      row('Font', '', seg(s, 'font', [['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono']]))
      + row('Custom font', 'Any font installed on this device, like “IBM Plex Sans”. Overrides the choice above.', text(s, 'customFont', 'Font name'))
      + row('Text size', '', range(s, 'fontSize', 13, 24, 1, (v) => `${v}px`))
      + row('Line spacing', '', range(s, 'lineHeight', 1.3, 2.2, 0.02, (v) => (+v).toFixed(2)))
      + row('Margins', 'How wide a line of text can get.', seg(s, 'width', Object.entries(ctx.WIDTHS).map(([k, v]) => [k, v[1]]))))
      + group('Spelling and grammar',
        row('Checker', engines[s.spellEngine] || '', seg(s, 'spellEngine', [['harper', 'Harper'], ['browser', 'Browser'], ['off', 'Off']]))
        + (s.spellEngine === 'harper' ? row('English', '', select(s, 'dialect', [['American', 'American'], ['British', 'British'], ['Canadian', 'Canadian'], ['Australian', 'Australian'], ['Indian', 'Indian']]))
          + groups
          + `<div class="pref stack"><div class="pref-label"><span>Personal dictionary</span><small>Words Harper should accept. Shared by every device using this vault. Right-click an underlined word to add it quickly.</small></div>
              <div class="pref-ctl"><div class="note-tags" style="margin:0">${words.map((w) => `<span class="ntag">${esc(w)}<button data-unword="${esc(w)}" title="Remove">${icon('x')}</button></span>`).join('') || '<span class="ntag">No words yet</span>'}</div>
              <div class="form inline" style="margin:8px 0 0"><input class="txt" data-f="word" placeholder="Add a word">${btn('add-word', 'Add', 'outline')}</div></div></div>`
          + `<div class="pref stack"><div class="pref-label"><span>Individual rules</span><small>Turn single checks on or off, like sentence length or passive voice.</small></div>
              <div class="pref-ctl"><div class="rules" data-rules>${btn('load-rules', 'Show rules', 'outline')}</div></div></div>` : ''),
      s.spellEngine === 'harper' ? 'Underlines: <span class="legend g-spelling">spelling</span> <span class="legend g-grammar">grammar</span> <span class="legend g-style">style</span>. Right-click one for fixes, or press F8 to step through them.' : '')
      + group('Writing',
        row('Markdown colors', 'Shade headings, bold, links and tags while you write.', toggle(s, 'syntaxColors'))
        + row('Suggest notes after [[', 'A list of matching notes appears as you type a link.', toggle(s, 'linkSuggest'))
        + row('Suggest tags after #', '', toggle(s, 'tagSuggest'))
        + row('Slash menu', 'Type / at the start of a line (or after a space) to insert headings, tables, callouts, diagrams and more.', toggle(s, 'slashMenu'))
        + row('Table keys', 'In a table, Tab and Shift Tab move between cells and line the columns up. Enter at the end of a row adds a row.', toggle(s, 'tableKeys'))
        + row('Smart lists', 'Enter continues a list. Enter on an empty item ends it.', toggle(s, 'smartLists'))
        + row('Auto-pair brackets and quotes', 'Typing ( [ { " or ` adds the closing one. With text selected, it wraps the selection.', toggle(s, 'autoPair'))
        + row('Typewriter scrolling', 'Keep the line you are writing near the middle of the page.', toggle(s, 'typewriter'))
        + row('Tab key indents with', '', seg(s, 'indent', [['tab', 'Tab'], ['2', '2 spaces'], ['4', '4 spaces']])))
      + group('Preview',
        row('Edit in preview', 'In Read mode, click a paragraph, list or table to edit its markdown right there. The pencil button beside the view switch turns this on and off.', toggle(s, 'previewEdit'))
        + row('Highlight code', 'Colors code blocks that name their language, like ```js.', toggle(s, 'richCode'))
        + row('Math', 'Renders $inline$ and $$block$$ math with KaTeX.', toggle(s, 'richMath'))
        + row('Diagrams', 'Renders ```mermaid blocks as diagrams.', toggle(s, 'richDiagrams')));
  },
  mountEditor(body, ctx, rerender) {
    let rules = null;
    const paintRules = (filter = '') => {
      const box = body.querySelector('[data-rules]');
      const over = ctx.state.settings.harperRules;
      const f = filter.toLowerCase();
      const list = rules.filter((r) => !f || r.name.toLowerCase().includes(f) || r.description.toLowerCase().includes(f));
      box.innerHTML = `<input class="txt" data-f="rule-filter" placeholder="Filter ${rules.length} rules" value="${esc(filter)}" style="width:100%">
        <div class="items rule-list">${list.slice(0, 400).map((r) => {
          const on = r.name in over ? over[r.name] : r.on;
          return `<div class="item"><div class="grow"><b>${esc(r.name.replace(/([a-z])([A-Z])/g, '$1 $2'))}</b><small>${esc(r.description.replace(/<[^>]+>/g, '').slice(0, 220))}</small></div>
            <button class="switch${on ? ' on' : ''}" data-rule="${esc(r.name)}" data-default="${r.on}"></button></div>`;
        }).join('') || '<div class="item-empty">No rules match.</div>'}</div>`;
      const input = box.querySelector('[data-f="rule-filter"]');
      input.addEventListener('input', () => { const pos = input.selectionStart; paintRules(input.value); const again = box.querySelector('[data-f="rule-filter"]'); again.focus(); again.setSelectionRange(pos, pos); });
    };
    body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act], [data-unword], [data-rule]');
      if (!b) return;
      try {
        if (b.dataset.act === 'load-rules') {
          b.textContent = 'Loading…';
          rules = await ctx.spell.describeRules();
          paintRules();
        }
        if (b.dataset.rule) {
          const name = b.dataset.rule;
          const over = { ...ctx.state.settings.harperRules };
          const now = !b.classList.contains('on');
          if (String(now) === b.dataset.default) delete over[name]; else over[name] = now;
          b.classList.toggle('on', now);
          ctx.setSetting('harperRules', over);
        }
        if (b.dataset.act === 'add-word') {
          const w = body.querySelector('[data-f="word"]').value.trim();
          if (!w) return;
          await ctx.api('PUT', '/api/dictionary', { add: w });
          await ctx.startSpell();
          rerender();
        }
        if (b.dataset.unword) {
          const { words } = await ctx.api('GET', '/api/dictionary');
          await ctx.api('PUT', '/api/dictionary', { words: words.filter((x) => x !== b.dataset.unword) });
          await ctx.startSpell();
          rerender();
        }
      } catch (err) { ctx.toast(err.message, 'err'); }
    });
    body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[data-f="word"]')) body.querySelector('[data-act="add-word"]').click(); });
  },

  async files(ctx) {
    const s = ctx.state.settings;
    const c = await ctx.api('GET', '/api/config').catch(() => ctx.state.config);
    ctx.state.config = c;
    const templates = ctx.templateNotes().map((n) => [n.path, n.path.replace(/\.md$/i, '')]);
    const today = ctx.formatDate(new Date(), s.dailyFormat || 'YYYY-MM-DD');
    return group('New notes',
      row('Create new notes in', '', seg(s, 'newNoteLocation', [['current', 'Current folder'], ['root', 'Vault root'], ['folder', 'A set folder']]))
      + (s.newNoteLocation === 'folder' ? row('Folder', '', select(s, 'newNoteFolder', [['', 'Vault root'], ...folderOpts(ctx)])) : '')
      + row('Name new notes', '', select(s, 'newNoteName', [['untitled', 'Untitled'], ['date', 'Today’s date (2026-11-17)'], ['datetime', 'Date and time (2026-11-17 0930)']])))
      + group('Daily notes',
        row('Folder', 'Where today’s note is created. Alt D or the calendar button opens it.', text(s, 'dailyFolder', 'Daily'))
        + row('Name format', `Today becomes “${esc(today)}”. Tokens: YYYY MM DD ddd dddd MMM MMMM. Put words in [brackets].`, text(s, 'dailyFormat', 'YYYY-MM-DD'))
        + row('Template', templates.length ? 'Filled in each time a new daily note is made.' : `Add notes to “${esc(s.templatesFolder || 'Templates')}” to pick one here.`, select(s, 'dailyTemplate', [['', 'None'], ...templates])))
      + group('Templates',
        row('Templates folder', 'Notes in this folder can be inserted with Alt Shift T, or used for new notes from the command palette.', text(s, 'templatesFolder', 'Templates'))
        + `<pre class="snippet">{{title}}            the note's name
{{date}}  {{time}}    today, now   (or {{date:dddd D MMMM}})
{{yesterday}}  {{tomorrow}}  {{weekday}}
{{cursor}}           where the cursor goes</pre>`)
      + group('Attachments',
        row('Attachment folder', 'Where pasted and dropped images are saved. It is hidden from the sidebar. Shared by every device.', text(c, 'attachmentFolder', 'attachments', 'c'))
        + row('Image links', 'Markdown links work everywhere. Wikilinks match Obsidian’s style.', seg(s, 'imageLinks', [['markdown', '![](path)'], ['wiki', '![[name]]']]))
        + row('Name pasted images', '', seg(s, 'pasteName', [['timestamp', 'pasted-date-time'], ['note', 'After the note']])))
      + group('Import', `<div class="form inline" style="grid-template-columns:minmax(0,1fr) auto auto">
          <select class="sel" data-f="import-folder">${[['', 'Into the vault root'], ['Imported', 'Into a new “Imported” folder'], ...folderOpts(ctx).map(([v]) => [v, `Into ${v}`])].map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>
          ${btn('import-files', 'Choose files…', 'outline')}${btn('import-zip', 'Choose a .zip…', 'outline')}</div>`,
        'Bring in .md or .txt notes and images, or a .zip of a whole folder, such as an Obsidian vault. Folders are kept and nothing already here is overwritten.')
      + group('Unused attachments', `<div data-unused>${btn('scan-unused', 'Find unused attachments', 'outline')}</div>`,
        'Images and files that no note links to or embeds any more. Removing them moves them to the trash, so they can still be restored.')
      + group('Links',
        row('Update links when renaming', 'When a note is renamed or moved, rewrite [[links]] and markdown links to it in every other note.', toggle(s, 'updateLinks')));
  },

  mountFiles(body, ctx, rerender) {
    const pick = (accept, multiple) => new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.multiple = multiple;
      input.onchange = () => resolve([...input.files]);
      input.click();
    });
    let unused = [];
    const paintUnused = () => {
      const box = body.querySelector('[data-unused]');
      const total = unused.reduce((a, f) => a + f.size, 0);
      box.innerHTML = unused.length
        ? `<p style="margin:0 0 8px">${unused.length} unused file${unused.length === 1 ? '' : 's'}, ${ctx.fmtBytes(total)}.</p>
          <div class="items unused-list">${unused.map((f, i) => `<label class="item">${/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(f.path) ? `<img class="thumb" src="/vault/${encodeURIComponent(ctx.VAULT)}/${f.path.split('/').map(encodeURIComponent).join('/')}" alt="" loading="lazy">` : icon('file')}<div class="grow"><b>${esc(f.path.split('/').pop())}</b><small>${esc(f.path)} · ${ctx.fmtBytes(f.size)}</small></div><input type="checkbox" data-u="${i}" checked></label>`).join('')}</div>
          <div style="display:flex;gap:8px">${btn('trash-unused', 'Move selected to trash', 'danger-outline')}${btn('scan-unused', 'Check again', 'ghost')}</div>`
        : `<p style="margin:0 0 8px;color:var(--text-3)">Every attachment is in use.</p>${btn('scan-unused', 'Check again', 'ghost')}`;
    };
    body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const folder = body.querySelector('[data-f="import-folder"]')?.value || '';
      try {
        if (b.dataset.act === 'import-files') {
          const files = await pick('.md,.markdown,.txt,image/*,.pdf', true);
          if (files.length) { await ctx.importFiles(files, folder); rerender(); }
        }
        if (b.dataset.act === 'import-zip') {
          const files = await pick('.zip,application/zip', false);
          if (files.length) { b.disabled = true; b.textContent = 'Importing…'; await ctx.importFiles(files, folder); rerender(); }
        }
        if (b.dataset.act === 'scan-unused') {
          b.disabled = true;
          unused = (await ctx.api('GET', '/api/attachments')).files.filter((f) => !f.used);
          paintUnused();
        }
        if (b.dataset.act === 'trash-unused') {
          const paths = [...body.querySelectorAll('[data-u]:checked')].map((c) => unused[+c.dataset.u].path);
          if (!paths.length) return;
          const r = await ctx.api('POST', '/api/attachments/trash', { paths });
          ctx.toast(`Moved ${r.moved} file${r.moved === 1 ? '' : 's'} to the trash`);
          unused = unused.filter((f) => !paths.includes(f.path));
          paintUnused();
          ctx.refreshTree();
        }
      } catch (err) { ctx.toast(err.message, 'err'); b.disabled = false; }
    });
  },

  hotkeys(ctx) {
    const groups = {};
    for (const c of ctx.COMMANDS) (groups[c.group] ||= []).push(c);
    const used = {};
    for (const c of ctx.COMMANDS) { const k = ctx.keyFor(c.id); if (k) (used[k] ||= []).push(c); }
    const rowFor = (c) => {
      const combo = ctx.keyFor(c.id);
      const custom = c.id in ctx.state.settings.hotkeys;
      const clash = combo && used[combo].length > 1 ? used[combo].filter((x) => x.id !== c.id).map((x) => x.label) : [];
      return `<div class="hotkey"><div class="pref-label"><span>${esc(c.label)}</span>${clash.length ? `<small class="warn">Also used by ${esc(clash.join(', '))}</small>` : ''}</div>
        <div class="keys">${custom ? `<button class="icon-btn sm" data-reset="${c.id}" title="Back to ${esc(ctx.comboLabel(c.def))}">${icon('restore')}</button>` : ''}
        <button class="combo${combo ? '' : ' unset'}${clash.length ? ' conflict' : ''}" data-record="${c.id}">${esc(ctx.comboLabel(combo))}</button></div></div>`;
    };
    return group('', `<p style="margin:0;color:var(--text-3);font-size:12.5px">Click a shortcut, then press the keys you want. Backspace clears it, Esc cancels. Alt 1 to 9 always jumps to a tab. Some browsers keep a few shortcuts for themselves (Firefox keeps Ctrl Shift P), so pick another if one doesn't respond.</p>`)
      + Object.entries(groups).map(([g, list]) => group(g, list.map(rowFor).join(''))).join('')
      + group('', row('Reset every shortcut', '', btn('reset-all', 'Reset all', 'danger-outline')));
  },
  mountHotkeys(body, ctx, rerender) {
    let stop = null;
    const record = (b) => {
      stop?.();
      b.classList.add('recording');
      b.textContent = 'Press keys…';
      const onKey = (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === 'Escape') return finish();
        const combo = e.key === 'Backspace' || e.key === 'Delete' ? '' : ctx.comboFromEvent(e);
        if (combo === null) return; // only a modifier so far
        if (combo && !/^(Mod|Alt|Ctrl)\+|^F\d/.test(combo)) { b.textContent = 'Add Ctrl, Alt or ⌘'; return; }
        ctx.state.settings.hotkeys[b.dataset.record] = combo;
        ctx.setSetting('hotkeys', ctx.state.settings.hotkeys);
        finish();
      };
      const finish = () => { window.removeEventListener('keydown', onKey, true); stop = null; rerender(); };
      window.addEventListener('keydown', onKey, true);
      stop = () => window.removeEventListener('keydown', onKey, true);
    };
    body.addEventListener('click', async (e) => {
      const r = e.target.closest('[data-record]');
      if (r) return record(r);
      const reset = e.target.closest('[data-reset]');
      if (reset) {
        delete ctx.state.settings.hotkeys[reset.dataset.reset];
        ctx.setSetting('hotkeys', ctx.state.settings.hotkeys);
        return rerender();
      }
      if (e.target.closest('[data-act="reset-all"]')) {
        const ok = await ctx.dialog({ stack: true, title: 'Reset every shortcut?', buttons: [{ label: 'Cancel' }, { label: 'Reset', danger: true, value: true }] });
        if (ok) { ctx.setSetting('hotkeys', {}); rerender(); }
      }
    });
    return () => stop?.();
  },

  async keychain(ctx) {
    const me = ctx.currentAccount();
    const [tokens, shares, sessions] = await Promise.all([
      ctx.api('GET', '/api/tokens').catch(() => ({ tokens: [] })),
      ctx.api('GET', '/api/shares').catch(() => ({ shares: [] })),
      ctx.api('GET', '/api/sessions').catch(() => ({ sessions: [] })),
    ]);
    const origin = location.origin;
    const devices = !me.locked
      ? '<div class="item-empty" style="padding:0">This account has no password, so there is nothing to sign out of. Set one in General.</div>'
      : `<div class="items">${sessions.sessions.map((x) => `<div class="item">${icon('user')}<div class="grow"><b>${esc(agentName(x.agent))}${x.current ? ' <span class="badge">this device</span>' : ''}</b><small>${esc(x.ip)} · last seen ${ctx.relTime(x.seen)}</small></div>${x.current ? btn('lock', 'Lock', 'ghost') : btn('end-session', 'Lock', 'ghost', `data-id="${esc(x.id)}"`)}</div>`).join('') || '<div class="item-empty">No devices.</div>'}</div>`;
    const tokenList = tokens.tokens.length
      ? `<div class="items">${tokens.tokens.map((t) => `<div class="item">${icon('key')}<div class="grow"><b>${esc(t.name)}</b><small>Created ${ctx.fmtDateTime(t.created)} · ${t.lastUsed ? `last used ${ctx.relTime(t.lastUsed)}` : 'never used'}</small></div>${btn('revoke', 'Revoke', 'danger-outline', `data-id="${esc(t.id)}"`)}</div>`).join('')}</div>`
      : '<div class="items"><div class="item-empty">No tokens for this account yet.</div></div>';
    const fresh = KEYCHAIN.fresh;
    const freshBox = fresh ? `<p style="margin:10px 0 0">Copy this token now. It will not be shown again.</p>
      <div class="secret"><code>${esc(fresh.token)}</code>${btn('copy-token', 'Copy')}</div>
      <pre class="snippet">curl -H "Authorization: Bearer ${esc(fresh.token)}" \\
  ${esc(origin)}/api/tree

curl -X POST -H "Authorization: Bearer ${esc(fresh.token)}" \\
  -d '{"path": "Inbox", "text": "- remember this"}' \\
  ${esc(origin)}/api/append</pre>` : '';
    const shareList = shares.shares.length
      ? `<div class="items">${shares.shares.map((x) => `<div class="item">${icon('share')}<div class="grow"><b>${esc(x.path.replace(/\.md$/i, ''))}</b><small>${x.views} view${x.views === 1 ? '' : 's'} · created ${ctx.relTime(x.created)} · ${x.expires ? (x.expires < Date.now() ? 'expired' : `expires ${ctx.fmtDateTime(x.expires)}`) : 'never expires'}</small></div>
          ${btn('copy-share', 'Copy', 'ghost', `data-token="${esc(x.token)}"`)}${btn('remove-share', 'Remove', 'danger-outline', `data-token="${esc(x.token)}"`)}</div>`).join('')}</div>`
      : '<div class="items"><div class="item-empty">No shared notes. Right-click a note and choose Share link.</div></div>';
    return group('Unlocked on', devices, me.locked ? 'Devices where this account is open. Locking one makes it ask for the password again.' : '')
      + group('API tokens', tokenList + `<div class="form inline"><input class="txt" data-f="token-name" placeholder="What is it for? e.g. Home Assistant">${btn('create-token', 'Create token', 'outline')}</div>` + freshBox,
        'Tokens let scripts and other homelab services read and write this account’s notes through the API, without its password. They can’t change the account.')
      + group('Shared notes', shareList, 'Read-only links to single notes in this account. Anyone with a link can read that note and its images, and nothing else.')
      + group('Connection',
        row('Server address', '', `<span class="mono">${esc(origin)}</span>`)
        + row('Account id', 'Used by the API (the X-Vault header) and by scripts using curl -u id:password.', `<span class="mono">${esc(me.id)}</span>`)
        + row('Health check', 'For uptime monitors. Always open.', `<span class="mono">${esc(origin)}/healthz</span>`));
  },
  mountKeychain(body, ctx, rerender) {
    const val = (f) => body.querySelector(`[data-f="${f}"]`)?.value || '';
    const confirm = (title, text, label) => ctx.dialog({ stack: true, title, text, buttons: [{ label: 'Cancel' }, { label, danger: true, value: true }] });
    body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      try {
        if (act === 'lock') { ctx.closeLayer(); ctx.lockAccount(); }
        if (act === 'end-session') { await ctx.api('DELETE', `/api/sessions?id=${encodeURIComponent(b.dataset.id)}`); rerender(); }
        if (act === 'create-token') {
          KEYCHAIN.fresh = await ctx.api('POST', '/api/tokens', { name: val('token-name') || 'Token' });
          rerender();
        }
        if (act === 'copy-token' && KEYCHAIN.fresh) {
          navigator.clipboard?.writeText(KEYCHAIN.fresh.token).then(() => ctx.toast('Token copied'), () => ctx.toast('Select the token and copy it', 'err'));
        }
        if (act === 'revoke' && await confirm('Revoke this token?', 'Anything using it stops working.', 'Revoke')) {
          await ctx.api('DELETE', `/api/tokens?id=${encodeURIComponent(b.dataset.id)}`);
          rerender();
        }
        if (act === 'copy-share') navigator.clipboard?.writeText(`${location.origin}/s/${b.dataset.token}`).then(() => ctx.toast('Link copied'));
        if (act === 'remove-share' && await confirm('Remove this link?', 'Anyone who has it will no longer be able to open the note.', 'Remove')) {
          await ctx.api('DELETE', `/api/shares?token=${encodeURIComponent(b.dataset.token)}`);
          rerender();
        }
      } catch (err) { ctx.toast(err.message, 'err'); }
    });
    return () => { KEYCHAIN.fresh = null; };
  },

  async sync(ctx) {
    const s = ctx.state.settings;
    const [info, trash, config, git, cached] = await Promise.all([
      ctx.api('GET', '/api/info').catch(() => null),
      ctx.api('GET', '/api/trash').catch(() => ({ items: [] })),
      ctx.api('GET', '/api/config').catch(() => ctx.state.config),
      ctx.api('GET', '/api/git').catch(() => null),
      ctx.idb.keys(`${ctx.VAULT}|note|`),
    ]);
    ctx.state.config = config;
    const c = config;
    const local = Object.entries(ctx.pending.all());
    const online = !!info;
    const shell = !window.isSecureContext ? 'Needs HTTPS (or localhost) to keep the app itself offline. Notes are still kept offline.'
      : navigator.serviceWorker?.controller ? 'Ready. The app opens even when the server is down.' : 'Getting ready. Reload once to finish.';
    const status = `<div class="stats">
      <div class="stat"><b style="color:${online ? 'var(--ok)' : 'var(--warn)'}">${online ? 'Online' : 'Offline'}</b><small>${s.syncMode === 'live' ? (ctx.liveConnected() ? 'live connection open' : 'live connection waiting') : 'server'}</small></div>
      <div class="stat"><b>${ctx.state.lastSync ? ctx.relTime(ctx.state.lastSync) : 'Not yet'}</b><small>last synced</small></div>
      <div class="stat"><b>${local.length}</b><small>edits waiting here</small></div>
      <div class="stat"><b>${cached.length}</b><small>notes kept offline</small></div>
    </div>`;
    const waiting = local.length ? `<div class="items">${local.map(([p, v]) => `<div class="item">${icon('file')}<div class="grow"><b>${esc(ctx.stem(p))}</b><small>Edited ${ctx.relTime(v.at)}${v.base ? '' : ' · new note'}</small></div></div>`).join('')}</div>
      <div style="display:flex;gap:8px;margin-bottom:8px">${btn('push', 'Sync now', 'primary')}${btn('discard', 'Discard these edits', 'danger-outline')}</div>` : '';
    const trashList = trash.items.length
      ? `<div class="items">${trash.items.slice(0, 50).map((t) => `<div class="item">${icon(t.dir ? 'folder' : 'file')}<div class="grow"><b>${esc(t.from.replace(/\.md$/i, ''))}</b><small>Deleted ${ctx.relTime(t.deleted)} · ${ctx.fmtBytes(t.size)}${t.dir ? ` · ${t.files} files` : ''}</small></div>${btn('restore', 'Restore', 'outline', `data-id="${esc(t.id)}"`)}${btn('purge', 'Delete', 'ghost', `data-id="${esc(t.id)}"`)}</div>`).join('')}</div>`
      : '<div class="items"><div class="item-empty">The trash is empty.</div></div>';
    const g = c.git || {};
    const gitBody = !git ? '<div class="item-empty">Git status is unavailable while offline.</div>'
      : !git.available ? '<div class="item-empty">git isn’t installed on the server. Install it (the container image includes it) to use this.</div>'
      : row('Commit the vault to git automatically', 'Off by default. Version history above keeps working either way.', toggle(c, 'git.enabled', 'c'))
        + (g.enabled ? row('Commit every', git.next ? `Next check ${ctx.relTime(git.next).replace(' ago', '').replace('just now', 'soon')}` : '', select(c, 'git.interval', [[5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, 'Hour'], [360, '6 hours'], [1440, 'Day']], 'c'))
          + row('Commit message', '{count} becomes the number of changed files.', text(c, 'git.message', 'Polarboard: {count} files changed', 'c'))
          + row('Remote', 'Optional, e.g. git@github.com:you/notes.git. Use an SSH key on the server rather than putting a password in the URL.', text(c, 'git.remote', 'git@host:you/notes.git', 'c'))
          + (g.remote ? row('Push after each commit', '', toggle(c, 'git.push', 'c')) : '') : '')
        + (git.error ? `<p style="color:var(--err);margin:8px 0">${esc(git.error)}</p>` : '')
        + (git.repo ? `<p style="margin:12px 0 6px">${git.pending ? `${git.pending} changed file${git.pending === 1 ? '' : 's'} not committed yet` : 'Everything is committed'}</p>
          <div class="items">${(git.log || []).map((l) => `<div class="item">${icon('history')}<div class="grow"><b>${esc(l.message)}</b><small><span class="mono">${esc(l.hash)}</span> · ${ctx.relTime(l.time)}</small></div></div>`).join('') || '<div class="item-empty">No commits yet.</div>'}</div>` : '')
        + `<div style="display:flex;gap:8px">${btn('git-commit', 'Commit now', 'outline')}${g.remote ? btn('git-push', 'Commit and push', 'ghost') : ''}</div>`;
    const ve = encodeURIComponent(ctx.VAULT);
    return group('Status', status + waiting)
      + group('How notes sync',
        row('Sync', SYNC_MODES[s.syncMode], seg(s, 'syncMode', [['live', 'Live'], ['interval', 'Interval'], ['manual', 'Manual']]))
        + (s.syncMode === 'interval' ? row('Check other devices every', '', select(s, 'pollInterval', [[10, '10 seconds'], [20, '20 seconds'], [30, '30 seconds'], [60, 'Minute'], [120, '2 minutes'], [300, '5 minutes']])) : '')
        + (s.syncMode !== 'manual' ? row('Save after you stop typing for', '', range(s, 'saveDelay', 300, 5000, 100, (v) => `${(v / 1000).toFixed(1)} s`)) : ''),
        'If the connection drops, edits wait on this device and are sent when it comes back: right away in Live and Interval, or when you press Sync in Manual.')
      + group('Offline',
        row('Keep every note on this device', 'Changed notes download quietly in the background, so you can read and edit any of them without a connection. Off keeps only the notes you open.', toggle(s, 'offlineAll'))
        + row('Offline copy', `${cached.length} notes stored in this browser`, btn('clear-cache', 'Clear', 'ghost'))
        + row('Offline app', shell, ''))
      + group('Version history',
        row('Keep earlier versions', 'Snapshots are stored on the server in .polarboard/history.', toggle(c, 'history.enabled', 'c'))
        + (c.history.enabled ? row('Save a snapshot at most every', '', select(c, 'history.interval', [[1, 'Minute'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, 'Hour']], 'c'))
          + row('Versions to keep per note', '', select(c, 'history.keep', [[10, '10'], [25, '25'], [50, '50'], [100, '100'], [250, '250'], [0, 'No limit']], 'c'))
          + row('Delete versions older than', '', select(c, 'history.days', [[0, 'Never'], [7, '1 week'], [30, '1 month'], [90, '3 months'], [365, '1 year']], 'c')) : '')
        + row('Stored history', info ? `${info.history.versions.toLocaleString()} versions using ${ctx.fmtBytes(info.history.bytes)}` : '',
          (ctx.state.cur ? btn('note-history', 'This note’s history', 'outline') : '') + btn('clear-history', 'Clear all', 'danger-outline')))
      + group('Git', gitBody, 'An optional extra on top of version history: a real git repository in the vault folder, committed on a schedule.')
      + group('Trash', row('Empty the trash automatically after', '', select(c, 'trashDays', [[0, 'Never'], [7, '1 week'], [30, '30 days'], [90, '90 days'], [365, '1 year']], 'c'))
        + trashList + (trash.items.length ? btn('empty-trash', 'Empty trash', 'danger-outline') : ''))
      + group('Backup',
        row('Download a backup', 'A .zip of this vault: every note, folder, attachment and Polarboard’s metadata. Tokens are left out.',
          `<a class="btn sm outline" href="/api/export?vault=${ve}" download>Download .zip</a><a class="btn sm ghost" href="/api/export?vault=${ve}&history=1" download>With history</a>`));
  },
  mountSync(body, ctx, rerender) {
    body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      const confirm = (title, text, label) => ctx.dialog({ stack: true, title, text, buttons: [{ label: 'Cancel' }, { label, danger: true, value: true }] });
      try {
        if (act === 'push') { await ctx.syncNow(); ctx.toast('Synced'); rerender(); }
        if (act === 'discard' && await confirm('Discard unsent edits?', 'Edits kept on this device that never reached the server will be lost.', 'Discard')) { ctx.pending.clear(); rerender(); }
        if (act === 'clear-cache') { const n = await ctx.idb.clear(`${ctx.VAULT}|`); ctx.toast(`Removed ${n} offline copies`); rerender(); }
        if (act === 'note-history') ctx.openHistory(ctx.state.cur.path);
        if (act === 'clear-history' && await confirm('Clear all version history?', 'Every saved version of every note in this vault is deleted. Your notes stay as they are.', 'Clear')) {
          await ctx.api('DELETE', '/api/history'); ctx.toast('History cleared'); rerender();
        }
        if (act === 'git-commit' || act === 'git-push') {
          b.disabled = true;
          const r = await ctx.api('POST', '/api/git/commit', { push: act === 'git-push' });
          ctx.toast(r.committed ? `Committed ${r.files} file${r.files === 1 ? '' : 's'}` : 'Nothing new to commit');
          rerender();
        }
        if (act === 'restore') { const r = await ctx.api('POST', '/api/trash/restore', { id: b.dataset.id }); ctx.toast(`Restored to ${r.path}`); await ctx.refreshTree(); rerender(); }
        if (act === 'purge' && await confirm('Delete this for good?', 'It cannot be restored afterwards.', 'Delete')) {
          await ctx.api('DELETE', `/api/trash?id=${encodeURIComponent(b.dataset.id)}`); rerender();
        }
        if (act === 'empty-trash' && await confirm('Empty the trash?', 'Everything in it is deleted for good.', 'Empty trash')) {
          await ctx.api('DELETE', '/api/trash'); rerender();
        }
      } catch (err) { ctx.toast(err.message, 'err'); rerender(); }
    });
  },
};

function agentName(ua = '') {
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl/i.test(ua) ? 'curl' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

const KEYCHAIN = { fresh: null };
const MOUNTS = { general: 'mountGeneral', appearance: 'mountAppearance', editor: 'mountEditor', files: 'mountFiles', hotkeys: 'mountHotkeys', keychain: 'mountKeychain', sync: 'mountSync' };

// ------------------------------------------------------------------ window
export function openSettings(ctx, start = 'general') {
  const root = document.createElement('div');
  root.className = 'prefs';
  root.innerHTML = `
    <nav class="prefs-nav" aria-label="Settings sections"><div class="brand">${icon('logo')}Settings</div>
      ${CATS.map(([id, label, ic]) => `<button data-cat="${id}">${icon(ic)}<span>${label}</span></button>`).join('')}</nav>
    <section class="prefs-main">
      <header class="prefs-head"><h3></h3><button class="icon-btn sm" data-close title="Close (Esc)" aria-label="Close">${icon('x')}</button></header>
      <div class="prefs-body scroll"></div>
    </section>`;
  let body = root.querySelector('.prefs-body');
  let current = start;
  let teardown = null;
  let seq = 0;

  async function show(cat, keepScroll = false) {
    const mine = ++seq;
    const top = body.scrollTop;
    if (cat !== current) KEYCHAIN.fresh = null;
    current = cat;
    root.querySelectorAll('[data-cat]').forEach((b) => b.classList.toggle('active', b.dataset.cat === cat));
    root.querySelector('.prefs-head h3').textContent = CATS.find((c) => c[0] === cat)[1];
    let html;
    try { html = await PAGES[cat](ctx); } catch (e) { html = `<div class="item-empty">This page could not load: ${esc(e.message)}</div>`; }
    if (mine !== seq) return;
    teardown?.();
    teardown = null;
    // Swap the body element so listeners from the previous page go with it.
    const fresh = body.cloneNode(false);
    fresh.innerHTML = html;
    body.replaceWith(fresh);
    body = fresh;
    bindControls(fresh, ctx, () => show(current, true));
    if (MOUNTS[cat]) teardown = PAGES[MOUNTS[cat]](fresh, ctx, () => show(current, true)) || null;
    fresh.scrollTop = keepScroll ? top : 0;
  }

  root.addEventListener('click', (e) => {
    const c = e.target.closest('[data-cat]');
    if (c) show(c.dataset.cat);
    if (e.target.closest('[data-close]')) ctx.closeLayer();
  });
  ctx.dialog({ content: root, cls: 'prefs-dialog' }).then(() => { teardown?.(); KEYCHAIN.fresh = null; });
  show(start);
}
