// Note properties: the YAML front matter at the top of a note, shown as a small
// editable panel instead of raw text. Only a simple subset of YAML is edited
// (key: value and lists); anything more complex is kept exactly as written.

import { esc } from './markdown.js';
import { icon } from './icons.js';

/** Split a note into its front matter block (with fences and trailing newline) and the rest. */
export function splitFront(text) {
  if (!text.startsWith('---\n') && text !== '---') return { front: '', body: text };
  const m = /\n---[ \t]*(\n|$)/.exec(text.slice(3));
  if (!m) return { front: '', body: text };
  const end = 3 + m.index + m[0].length;
  return { front: text.slice(0, end).replace(/\n?$/, '\n'), body: text.slice(end) };
}

const DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;
const unquote = (v) => (/^(['"]).*\1$/.test(v) ? v.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'") : v);

function typeOf(value, block) {
  if (block.length && block.every((l) => /^\s*-\s/.test(l) || !l.trim())) return 'list';
  if (block.some((l) => l.trim())) return 'raw';
  if (/^\[.*\]$/.test(value)) return 'list';
  if (/^(true|false)$/i.test(value)) return 'bool';
  if (/^-?\d+(\.\d+)?$/.test(value)) return 'number';
  if (DATE.test(unquote(value))) return 'date';
  return 'text';
}

/** Parse front matter into entries: { key, type, value, raw: original lines, dirty }. */
export function parseFront(front) {
  const lines = front.replace(/\n$/, '').split('\n').slice(1, -1);
  const entries = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^([^\s#:][^:]*?):(?:\s+(.*)|\s*)$/);
    if (m) {
      cur = { key: m[1].trim(), first: (m[2] || '').trim(), block: [], raw: [line] };
      entries.push(cur);
    } else if (cur) {
      cur.raw.push(line);
      cur.block.push(line);
    } else {
      entries.push({ key: null, type: 'raw', raw: [line], keep: true }); // a comment or blank line before any key
    }
  }
  for (const e of entries) {
    if (e.key === null) continue;
    e.type = typeOf(e.first, e.block);
    if (e.type === 'list') {
      e.value = e.block.length
        ? e.block.filter((l) => l.trim()).map((l) => unquote(l.replace(/^\s*-\s*/, '').trim()))
        : e.first.slice(1, -1).split(',').map((x) => unquote(x.trim())).filter(Boolean);
    } else if (e.type === 'bool') e.value = /^true$/i.test(e.first);
    else if (e.type === 'raw') e.value = e.raw.slice(1).join('\n');
    else e.value = unquote(e.first);
    delete e.first;
    delete e.block;
  }
  return entries;
}

function scalar(v) {
  const s = String(v ?? '');
  if (s === '') return '""';
  if (/^[\s]|[\s]$|^[-?:,\[\]{}#&*!|>'"%@`]|: | #|^(true|false|null|yes|no|~)$|^-?\d+(\.\d+)?$/i.test(s)) return JSON.stringify(s);
  return s;
}

function emit(e) {
  if (e.type === 'list') return e.value.length ? [`${e.key}:`, ...e.value.map((x) => `  - ${scalar(x)}`)] : [`${e.key}: []`];
  if (e.type === 'bool') return [`${e.key}: ${e.value ? 'true' : 'false'}`];
  if (e.type === 'number') return [`${e.key}: ${Number(e.value) || 0}`];
  if (e.type === 'date') return [`${e.key}: ${e.value || ''}`];
  return [`${e.key}: ${scalar(e.value)}`];
}

/** Back to front matter text. Untouched entries keep their exact original lines. */
export function serializeFront(entries) {
  const lines = entries.flatMap((e) => (e.dirty ? emit(e) : e.raw));
  return `---\n${lines.length ? lines.join('\n') + '\n' : ''}---\n`;
}

const TYPES = [['text', 'Text'], ['list', 'List'], ['number', 'Number'], ['bool', 'Checkbox'], ['date', 'Date']];
const TYPE_ICON = { text: 'type', list: 'list', number: 'hash', bool: 'check', date: 'calendar', raw: 'code' };

function convert(e, type) {
  const v = e.value;
  const asText = Array.isArray(v) ? v.join(', ') : String(v ?? '');
  e.type = type;
  if (type === 'list') e.value = asText ? asText.split(',').map((x) => x.trim()).filter(Boolean) : [];
  else if (type === 'bool') e.value = /^(true|yes|1)$/i.test(asText);
  else if (type === 'number') e.value = parseFloat(asText) || 0;
  else if (type === 'date') e.value = DATE.test(asText) ? asText.slice(0, 10) : new Date().toISOString().slice(0, 10);
  else e.value = asText;
  e.dirty = true;
}

/**
 * Render the panel into box and keep it in sync.
 * getFront() returns the current front matter text; setFront(text) stores a new one ('' removes it).
 */
export function mountProps(box, getFront, setFront, { onTag } = {}) {
  let rawMode = false;
  let entries = [];
  const commit = () => setFront(serializeFront(entries));

  const valueHtml = (e, i) => {
    if (e.type === 'list') {
      return `<div class="prop-list">${e.value.map((x, k) => `<span class="ntag${e.key === 'tags' ? ' own' : ''}" ${e.key === 'tags' ? `data-tagname="${esc(x)}"` : ''}>${esc(x)}<button data-li="${i}:${k}" title="Remove">${icon('x')}</button></span>`).join('')}
        <input class="prop-add-item" data-i="${i}" placeholder="${e.value.length ? '' : 'Add…'}" spellcheck="false"></div>`;
    }
    if (e.type === 'bool') return `<input type="checkbox" class="prop-check" data-i="${i}"${e.value ? ' checked' : ''}>`;
    if (e.type === 'number') return `<input class="prop-input" type="number" data-i="${i}" value="${esc(e.value)}">`;
    if (e.type === 'date') return `<input class="prop-input" type="${/[ T]\d/.test(e.value) ? 'text' : 'date'}" data-i="${i}" value="${esc(e.value)}">`;
    if (e.type === 'raw') return `<code class="prop-raw" title="Edit as text to change this">${esc(e.value)}</code>`;
    return `<input class="prop-input" data-i="${i}" value="${esc(e.value)}" spellcheck="false">`;
  };

  const paint = () => {
    const front = getFront();
    if (!front) { box.innerHTML = ''; box.hidden = true; return; }
    box.hidden = false;
    if (rawMode) {
      const yaml = front.replace(/^---\n/, '').replace(/---\n?$/, '');
      box.innerHTML = `<div class="props-head"><span>${icon('code')}Properties as text</span><button class="icon-btn sm" data-raw-done title="Done">${icon('check')}</button></div>
        <textarea class="props-yaml" spellcheck="false">${esc(yaml)}</textarea>`;
      const ta = box.querySelector('textarea');
      ta.style.height = `${Math.max(80, ta.scrollHeight)}px`;
      return;
    }
    entries = parseFront(front);
    box.innerHTML = `<div class="props-head"><span>${icon('outline')}Properties</span>
        <span class="grow"></span>
        <button class="icon-btn sm" data-raw title="Edit as text">${icon('code')}</button>
        <button class="icon-btn sm" data-remove-all title="Remove all properties">${icon('trash')}</button></div>
      ${entries.map((e, i) => (e.key === null ? '' : `<div class="prop" data-row="${i}">
        <label class="prop-key-wrap" title="${esc(TYPES.find((t) => t[0] === e.type)?.[1] || 'Complex value')}">${icon(TYPE_ICON[e.type])}
          <input class="prop-key" data-i="${i}" value="${esc(e.key)}" spellcheck="false"></label>
        <div class="prop-val">${valueHtml(e, i)}</div>
        <select class="prop-type" data-i="${i}" title="Type"${e.type === 'raw' ? ' disabled' : ''}>${TYPES.map(([v, l]) => `<option value="${v}"${v === e.type ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <button class="icon-btn sm prop-del" data-del="${i}" title="Remove">${icon('x')}</button></div>`)).join('')}
      <button class="prop-new" data-new>${icon('plus')}Add property</button>`;
  };

  box.addEventListener('change', (e) => {
    const t = e.target;
    const i = +t.dataset.i;
    const entry = entries[i];
    if (!entry) return;
    if (t.classList.contains('prop-key')) {
      const key = t.value.trim().replace(/:/g, '');
      if (!key || entries.some((x, k) => k !== i && x.key === key)) { t.value = entry.key; return; }
      entry.key = key;
    } else if (t.classList.contains('prop-type')) convert(entry, t.value);
    else if (t.classList.contains('prop-check')) entry.value = t.checked;
    else if (t.classList.contains('prop-input')) entry.value = entry.type === 'number' ? parseFloat(t.value) || 0 : t.value;
    else return;
    entry.dirty = true;
    commit();
    if (t.classList.contains('prop-type')) paint();
  });
  box.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t.classList.contains('prop-add-item') && (e.key === 'Enter' || e.key === ',')) {
      e.preventDefault();
      const v = t.value.trim().replace(/^#/, '');
      const entry = entries[+t.dataset.i];
      if (v && !entry.value.includes(v)) { entry.value.push(v); entry.dirty = true; commit(); paint(); box.querySelector(`.prop-add-item[data-i="${t.dataset.i}"]`)?.focus(); }
    } else if (e.key === 'Enter' && (t.classList.contains('prop-input') || t.classList.contains('prop-key'))) {
      e.preventDefault();
      t.blur();
    } else if (e.key === 'Backspace' && t.classList.contains('prop-add-item') && !t.value) {
      const entry = entries[+t.dataset.i];
      if (entry.value.length) { entry.value.pop(); entry.dirty = true; commit(); paint(); box.querySelector(`.prop-add-item[data-i="${t.dataset.i}"]`)?.focus(); }
    }
  });
  box.addEventListener('focusout', (e) => {
    if (e.target.classList.contains('props-yaml')) {
      const yaml = e.target.value.replace(/\n*$/, '\n');
      setFront(`---\n${yaml.trim() ? yaml : ''}---\n`);
    }
  });
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button, [data-tagname]');
    if (!b) return;
    if (b.dataset.tagname && !e.target.closest('button')) return onTag?.(b.dataset.tagname);
    if (b.hasAttribute('data-raw')) { rawMode = true; paint(); box.querySelector('textarea')?.focus(); return; }
    if (b.hasAttribute('data-raw-done')) { box.querySelector('textarea')?.blur(); rawMode = false; paint(); return; }
    if (b.hasAttribute('data-remove-all')) { setFront(''); return; }
    if (b.dataset.del != null) { entries.splice(+b.dataset.del, 1); commit(); paint(); return; }
    if (b.dataset.li) {
      const [i, k] = b.dataset.li.split(':').map(Number);
      entries[i].value.splice(k, 1);
      entries[i].dirty = true;
      commit();
      paint();
      return;
    }
    if (b.hasAttribute('data-new')) {
      let key = 'property';
      for (let n = 2; entries.some((x) => x.key === key); n++) key = `property ${n}`;
      entries.push({ key, type: 'text', value: '', raw: [], dirty: true });
      commit();
      paint();
      const inputs = box.querySelectorAll('.prop-key');
      const last = inputs[inputs.length - 1];
      last?.focus();
      last?.select();
    }
  });
  return { paint, reset: () => { rawMode = false; paint(); } };
}
