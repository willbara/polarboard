// Polarboard markdown renderer. Small and safe: raw HTML is always escaped.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const TAG_RE = /(?<![^\s(\[,;])#([\p{L}\p{N}_\/-]+)/gu;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}>/;
const HEAD_RE = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const hasLetter = (s) => /\p{L}/u.test(s);

export function frontmatterEnd(lines) {
  if (lines[0] !== '---') return 0;
  const end = lines.indexOf('---', 1);
  return end > 0 ? end + 1 : 0;
}

export function extractTags(src) {
  const tags = new Map();
  let fence = false;
  for (const line of src.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    for (const m of line.replace(/`+[^`]*`+/g, '').matchAll(TAG_RE)) {
      const t = m[1].replace(/[\/-]+$/, '');
      if (hasLetter(t) && !tags.has(t.toLowerCase())) tags.set(t.toLowerCase(), t);
    }
  }
  return [...tags.values()];
}

export function slug(s) {
  return String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
}

/**
 * opts.image(src)  -> url for an image path written in the note
 * opts.embed(name) -> url for an Obsidian-style ![[embed]]
 * opts.exists(name)-> whether a [[wikilink]] target exists
 */
export function render(src, opts = {}) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').split('\n');
  return blocks(lines, frontmatterEnd(lines), lines.length, opts);
}

function isTableStart(L, i, end) {
  return i + 1 < end && L[i].includes('|') && L[i + 1].includes('|') && SEP_RE.test(L[i + 1]);
}

function isBlockStart(L, i, end) {
  const l = L[i];
  return FENCE_RE.test(l) || /^\s*\$\$/.test(l) || HEAD_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l) || LIST_RE.test(l) || isTableStart(L, i, end);
}

const FILE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|pdf)$/i;

function blocks(L, i, end, o) {
  let out = '';
  // With o.lines, each top-level block records which source lines it came from
  // (data-a = first line, data-b = line after the last), so it can be edited in place.
  let open = null;
  const tag = (stop) => {
    if (!open || out.length <= open.mark) return;
    out = out.slice(0, open.mark) + out.slice(open.mark).replace(/^<([a-z0-9]+)/i, `<$1 data-a="${open.s0}" data-b="${Math.min(stop, end)}"`);
  };
  const track = o.lines && !o.noLines;
  while (i < end) {
    if (track && open) { tag(i); open = null; }
    const line = L[i];
    let m;
    if (!line.trim()) { i++; continue; }
    if (track) open = { s0: i, mark: out.length };

    // ![[Another note]] (or ![[Note#Heading]]) on its own line embeds that note.
    if ((m = line.match(/^\s*!\[\[([^\]|#]+)(#[^\]|]*)?(?:\|[^\]]*)?\]\]\s*$/)) && !FILE_EXT.test(m[1].trim()) && o.embeds !== false) {
      const name = m[1].trim();
      out += `<div class="note-embed" data-note="${esc(name)}" data-heading="${esc((m[2] || '').slice(1))}"><div class="embed-wait">${esc(name)}${m[2] ? ' › ' + esc(m[2].slice(1)) : ''}</div></div>`;
      i++;
      continue;
    }

    if ((m = line.match(FENCE_RE))) {
      const fence = m[1];
      const buf = [];
      let j = i + 1;
      while (j < end && !L[j].trimStart().startsWith(fence)) buf.push(L[j++]);
      const lang = m[2].toLowerCase();
      if (lang === 'mermaid' && o.diagrams !== false) {
        out += `<pre class="mermaid" data-src="${esc(buf.join('\n'))}">${esc(buf.join('\n'))}</pre>`;
      } else if ((lang === 'math' || lang === 'latex' || lang === 'tex') && o.math !== false) {
        out += `<div class="math math-block" data-tex="${esc(buf.join('\n'))}">${esc(buf.join('\n'))}</div>`;
      } else {
        const attr = lang ? ` data-lang="${esc(lang)}"` : '';
        out += `<pre class="code"${attr}><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(buf.join('\n'))}</code></pre>`;
      }
      i = j + 1;
      continue;
    }

    // $$ display math, on its own lines or on one line
    if (o.math !== false && /^\s*\$\$/.test(line)) {
      const one = line.trim().match(/^\$\$(.+)\$\$$/);
      if (one) { out += `<div class="math math-block" data-tex="${esc(one[1])}">${esc(one[1])}</div>`; i++; continue; }
      const buf = [line.trim().slice(2)];
      let j = i + 1;
      while (j < end && !L[j].includes('$$')) buf.push(L[j++]);
      if (j < end) {
        buf.push(L[j].slice(0, L[j].indexOf('$$')));
        const tex = buf.join('\n').trim();
        out += `<div class="math math-block" data-tex="${esc(tex)}">${esc(tex)}</div>`;
        i = j + 1;
        continue;
      }
    }

    if ((m = line.match(HEAD_RE))) {
      const n = m[1].length;
      out += `<h${n} id="${esc(slug(m[2]))}">${inline(m[2], o)}</h${n}>`;
      i++;
      continue;
    }

    if (HR_RE.test(line)) { out += '<hr>'; i++; continue; }

    if (QUOTE_RE.test(line)) {
      const buf = [];
      while (i < end && QUOTE_RE.test(L[i])) buf.push(L[i++].replace(/^\s{0,3}>\s?/, ''));
      const inner = { ...o, noLines: true };
      const c = buf[0].match(/^\[!(\w+)\][+-]?\s*(.*)$/);
      if (c) {
        const kind = c[1].toLowerCase();
        const title = c[2] || kind[0].toUpperCase() + kind.slice(1);
        out += `<div class="callout" data-kind="${esc(kind)}"><div class="callout-title">${inline(title, o)}</div>${blocks(buf, 1, buf.length, inner)}</div>`;
      } else {
        out += `<blockquote>${blocks(buf, 0, buf.length, inner)}</blockquote>`;
      }
      continue;
    }

    if (isTableStart(L, i, end)) {
      const head = cells(line);
      const align = cells(L[i + 1]).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '');
      i += 2;
      const rows = [];
      while (i < end && L[i].includes('|') && L[i].trim()) rows.push(cells(L[i++]));
      const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c, o)}</${tag}>`;
      out += '<div class="table-wrap"><table><thead><tr>' + head.map((c, k) => td('th', c, k)).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + head.map((_, k) => td('td', r[k] ?? '', k)).join('') + '</tr>').join('') + '</tbody></table></div>';
      continue;
    }

    if (LIST_RE.test(line)) {
      const [html, next] = list(L, i, end, o);
      out += html;
      i = next;
      continue;
    }

    const buf = [];
    while (i < end && L[i].trim() && (!buf.length || !isBlockStart(L, i, end))) buf.push(L[i++]);
    out += `<p>${inline(buf.map((l) => l.trim()).join('\n'), o).replace(/\n/g, '<br>')}</p>`;
  }
  if (track) tag(i);
  return out;
}

function cells(row) {
  return row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
}

const indentOf = (s) => s.replace(/\t/g, '    ').length;

function list(L, i, end, o) {
  const items = [];
  while (i < end) {
    const line = L[i];
    const m = line.match(LIST_RE);
    if (m && !HR_RE.test(line)) {
      items.push({ ind: indentOf(m[1]), ord: /\d/.test(m[2]), start: parseInt(m[2], 10), text: m[3] || '', line: i, kids: [] });
      i++;
    } else if (!line.trim()) {
      if (i + 1 < end && LIST_RE.test(L[i + 1])) i++;
      else break;
    } else if (/^\s+\S/.test(line) && items.length) {
      items[items.length - 1].text += '\n' + line.trim();
      i++;
    } else break;
  }
  const root = { ind: -1, kids: [] };
  const stack = [root];
  for (const it of items) {
    while (stack.length > 1 && stack[stack.length - 1].ind >= it.ind) stack.pop();
    stack[stack.length - 1].kids.push(it);
    stack.push(it);
  }
  return [renderList(root.kids, o), i];
}

function renderList(items, o) {
  let out = '';
  let k = 0;
  while (k < items.length) {
    const ord = items[k].ord;
    const group = [];
    while (k < items.length && items[k].ord === ord) group.push(items[k++]);
    const tag = ord ? 'ol' : 'ul';
    const start = ord && group[0].start !== 1 ? ` start="${group[0].start}"` : '';
    out += `<${tag}${start}>${group.map((it) => renderItem(it, o)).join('')}</${tag}>`;
  }
  return out;
}

function renderItem(it, o) {
  let text = it.text;
  let attrs = '';
  let box = '';
  const t = text.match(/^\[([ xX])\](?:\s+|$)([\s\S]*)$/);
  if (t) {
    const done = t[1] !== ' ';
    text = t[2];
    attrs = ` class="task${done ? ' done' : ''}"`;
    box = `<input type="checkbox"${done ? ' checked' : ''}${o.noLines ? ' disabled' : ` data-line="${it.line}"`}>`;
  }
  const kids = it.kids.length ? renderList(it.kids, o) : '';
  return `<li${attrs}>${box}<span>${inline(text, o).replace(/\n/g, '<br>')}</span>${kids}</li>`;
}

function safeUrl(u, image = false) {
  const raw = u.replace(/^&lt;|&gt;$/g, '').trim();
  if (/^(https?:|mailto:|tel:|#)/i.test(raw) || !/^[\w+.-]*:/.test(raw)) return raw;
  if (image && /^data:image\/(png|jpe?g|gif|webp|avif);/i.test(raw)) return raw;
  return '#';
}

const unesc = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m) =>
  ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[m]);

function img(src, alt, o, size) {
  const url = unesc(safeUrl(src, true));
  const resolved = url === '#' ? '#' : esc(o.image ? o.image(url) : url);
  const w = /^\d+(x\d+)?$/.test(size || '') ? ` width="${size.split('x')[0]}"` : '';
  return `<img src="${resolved}" alt="${alt}" loading="lazy"${w}>`;
}

export function inline(text, o = {}) {
  const slots = [];
  const put = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = esc(text);

  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, __, c) => put(`<code>${c.trim()}</code>`));
  if (o.math !== false) {
    // $inline$ math; "$5 and $10" stays text because a closing $ must follow a non-space.
    s = s.replace(/(?<![\\$\w])\$(?=\S)([^$\n]+?)(?<=\S)\$(?![\w$])/g, (m, tex) => put(`<span class="math" data-tex="${tex}">${m}</span>`));
  }
  s = s.replace(/\\([\\`*_{}\[\]()#+\-.!~=|])/g, (_, c) => put(c));

  s = s.replace(/!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (all, name, size) => {
    if (!FILE_EXT.test(name.trim().replace(/#.*$/, ''))) { // a note embedded mid-sentence reads as a link
      const target = name.trim().replace(/#.*$/, '');
      return put(`<a class="wikilink embed-link" href="#" data-note="${target}">`) + target + put('</a>'); // already escaped
    }
    const url = o.embed ? o.embed(name.trim()) : name.trim();
    return put(img(url, esc(name.trim()), { ...o, image: null }, size?.trim()));
  });
  s = s.replace(/!\[([^\]]*)\]\(\s*(&lt;.*?&gt;|[^\s)]+)(?:\s+&quot;.*?&quot;)?\s*\)/g, (_, alt, src) => {
    const [label, size] = alt.split('|');
    return put(img(src, label, o, size?.trim()));
  });

  s = s.replace(/\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, name, _h, alias) => {
    const target = name.trim();
    const missing = o.exists && !o.exists(target) ? ' missing' : '';
    return put(`<a class="wikilink${missing}" href="#" data-note="${target}">`) + (alias || target) + put('</a>');
  });
  s = s.replace(/\[([^\]]+)\]\(\s*(&lt;.*?&gt;|[^\s)]+)(?:\s+&quot;.*?&quot;)?\s*\)/g, (_, label, href) => {
    const url = safeUrl(href);
    if (/^https?:/i.test(url)) return put(`<a href="${url}" target="_blank" rel="noopener noreferrer">`) + label + put('</a>');
    if (/\.md(#.*)?$/i.test(url)) {
      const target = decodeURIComponent(url.replace(/#.*$/, '').replace(/\.md$/i, ''));
      return put(`<a class="wikilink" href="#" data-note="${esc(target)}">`) + label + put('</a>');
    }
    return put(`<a href="${url}">`) + label + put('</a>');
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, (_, pre, url) =>
    pre + put(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`));

  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?=[^\s_])([\s\S]*?[^\s_])_(?![_\w])/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/==(?=\S)([\s\S]*?\S)==/g, '<mark>$1</mark>');

  s = s.replace(TAG_RE, (m, tag) => {
    tag = tag.replace(/[\/-]+$/, '');
    if (!hasLetter(tag)) return m;
    return `<a class="tag" href="#" data-tag="${tag}">#${tag}</a>` + m.slice(tag.length + 1);
  });

  for (let n = 0; n < 5 && s.includes('\u0000'); n++) s = s.replace(/\u0000(\d+)\u0000/g, (_, k) => slots[k]);
  return s;
}
