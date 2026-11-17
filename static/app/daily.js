import { replace } from '../editor.js';
import { icon } from '../icons.js';
import { idb } from '../offline.js';
import { $, VAULT, api, cleanName, el, enc, join, noteByPath, pad, state, stem } from './core.js';
import { defaultFolder, defaultName, newNote } from './notes.js';
import { openNote } from './tabs.js';
import { dialog, fuzzy, markMatch, picker, toast } from './ui.js';

// ------------------------------------------------------------------ daily notes & templates
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function formatDate(d, fmt) {
  const m = d.getMonth();
  const h = d.getHours();
  const map = {
    YYYY: d.getFullYear(), YY: String(d.getFullYear()).slice(2), MMMM: MONTHS[m], MMM: MONTHS[m].slice(0, 3), MM: pad(m + 1), M: m + 1,
    dddd: DAYS[d.getDay()], ddd: DAYS[d.getDay()].slice(0, 3), DD: pad(d.getDate()), D: d.getDate(),
    HH: pad(h), H: h, hh: pad(h % 12 || 12), h: h % 12 || 12, mm: pad(d.getMinutes()), ss: pad(d.getSeconds()), A: h < 12 ? 'AM' : 'PM',
  };
  return fmt.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|H|hh|h|mm|ss|A/g, (t, lit) => lit ?? String(map[t]));
}

/** Fill in {{title}}, {{date}}, {{date:FORMAT}}, {{time}}, {{yesterday}}, {{tomorrow}}, {{weekday}} and {{cursor}}. */
export function applyTemplate(text, title, when = new Date()) {
  const day = 86_400_000;
  let cursor = false;
  return text.replace(/\{\{\s*(\w+)(?::([^}]+))?\s*\}\}/g, (m, key, fmt) => {
    switch (key.toLowerCase()) {
      case 'title': return title;
      case 'date': return formatDate(when, fmt || 'YYYY-MM-DD');
      case 'time': return formatDate(when, fmt || 'HH:mm');
      case 'yesterday': return formatDate(new Date(+when - day), fmt || 'YYYY-MM-DD');
      case 'tomorrow': return formatDate(new Date(+when + day), fmt || 'YYYY-MM-DD');
      case 'weekday': return formatDate(when, 'dddd');
      case 'cursor': if (cursor) return ''; cursor = true; return '\u0001';
      default: return m;
    }
  });
}

export async function noteText(path) {
  try { return (await api('GET', `/api/note?path=${enc(path)}`)).content; }
  catch { return (await idb.get(`${VAULT}|note|${path}`))?.content ?? ''; }
}

export async function openDaily(offset = 0) {
  const s = state.settings;
  const when = new Date(Date.now() + offset * 86_400_000);
  const name = cleanName(formatDate(when, s.dailyFormat || 'YYYY-MM-DD')) || formatDate(when, 'YYYY-MM-DD');
  const folder = (s.dailyFolder || '').split('/').map(cleanName).filter(Boolean).join('/');
  const path = join(folder, `${name}.md`);
  if (noteByPath(path)) return openNote(path);
  const template = s.dailyTemplate && noteByPath(s.dailyTemplate) ? applyTemplate(await noteText(s.dailyTemplate), name, when) : '';
  await newNote(folder, name, { content: template, editTitle: false });
}

export function templateNotes() {
  const folder = (state.settings.templatesFolder || 'Templates').replace(/^\/+|\/+$/g, '');
  return state.tree.notes.filter((n) => n.path.startsWith(folder + '/'));
}

export function pickTemplate(title, then) {
  const list = templateNotes();
  if (!list.length) return toast(`Put notes in “${state.settings.templatesFolder || 'Templates'}” to use them as templates`);
  picker({
    placeholder: title,
    source: (q) => list.map((n) => ({ n, m: fuzzy(q, stem(n.path)) })).filter((x) => x.m)
      .sort((a, b) => b.m.score - a.m.score)
      .map(({ n, m }) => ({ icon: 'template', label: stem(n.path), html: markMatch(stem(n.path), m.idx), run: () => then(n.path) })),
  });
}

export function insertTemplate() {
  if (!state.cur) return toast('Open a note first');
  pickTemplate('Insert a template…', async (path) => {
    const text = applyTemplate(await noteText(path), stem(state.cur.path));
    const at = el.ta.selectionStart;
    const cursor = text.indexOf('\u0001');
    const clean = text.replace('\u0001', '');
    replace(el.ta, at, el.ta.selectionEnd, clean, at + (cursor >= 0 ? cursor : clean.length));
  });
}

export function newFromTemplate() {
  pickTemplate('New note from template…', async (path) => {
    const name = await dialog({ title: 'Name the new note', input: { value: defaultName() }, buttons: [{ label: 'Cancel' }, { label: 'Create', primary: true, value: true }] });
    if (!name || !cleanName(name)) return;
    newNote(defaultFolder(), cleanName(name), { content: applyTemplate(await noteText(path), cleanName(name)), editTitle: false });
  });
}
