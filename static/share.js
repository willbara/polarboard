// Read-only page for a note shared by link (/s/<token>).
import { render, esc } from './markdown.js';
import { enhance } from './rich.js';

const token = location.pathname.split('/')[2] || '';
const $ = (s) => document.querySelector(s);

async function show() {
  let note;
  try {
    const res = await fetch(`/api/public/${encodeURIComponent(token)}`);
    note = await res.json();
    if (!res.ok) throw new Error(note.error || 'This link does not work');
  } catch (e) {
    document.title = 'Link unavailable';
    $('#title').textContent = 'This link isn’t available';
    $('#content').innerHTML = `<p>${esc(e.message)}</p>`;
    return;
  }
  const file = (p) => `/api/public/${encodeURIComponent(token)}/file?path=${encodeURIComponent(p)}`;
  const tryDecode = (s) => { try { return decodeURI(s); } catch { return s; } };
  document.title = note.title;
  $('#title').textContent = note.title;
  $('#content').innerHTML = render(note.content, {
    image: (src) => (/^(https?:|data:)/i.test(src) ? src : file(tryDecode(src.replace(/^\/+/, '')))),
    embed: (name) => file(name.includes('/') ? name : `${note.attachmentFolder}/${name}`),
    exists: () => false,
  });
  // Links to other notes in the vault lead nowhere for a visitor.
  for (const a of document.querySelectorAll('a.wikilink, a.tag')) {
    const span = document.createElement('span');
    span.className = a.className;
    span.textContent = a.textContent;
    a.replaceWith(span);
  }
  for (const box of document.querySelectorAll('input[type="checkbox"]')) box.disabled = true;
  for (const box of document.querySelectorAll('.note-embed')) box.innerHTML = `<div class="embed-missing">“${esc(box.dataset.note)}” is embedded here, but it isn't part of this shared note.</div>`;
  $('#foot').textContent = `Updated ${new Date(note.modified).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })} · shared from Polarboard`;
  enhance($('#content'));
}
show();
