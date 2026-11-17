// Export a note: PDF (through the browser's print dialog), a standalone HTML
// file, or plain markdown. PDF and HTML share one renderer and print.css.

import { render, esc } from './markdown.js';
import { enhance } from './rich.js';
import { splitFront, parseFront } from './props.js';

export const EXPORT_DEFAULTS = {
  pdfHeader: 'title', pdfHeaderText: '', pdfFooter: 'date', pdfFooterText: '', pdfPageNumbers: true,
  pdfPaper: 'A4', pdfMargins: 'normal', pdfFont: 'sans', pdfTitle: true, pdfProps: false, pdfTags: false,
};
const MARGINS = { narrow: '12mm 12mm', normal: '18mm 20mm', wide: '24mm 28mm' };

const fill = (text, ctx) => text.replace(/\{(title|date|time|path)\}/g, (_, k) => ctx[k] ?? '');

/**
 * Render a note to finished HTML, with code, math, diagrams and embeds done.
 * ctx: { title, content, path, previewOpts, richOpts, expandEmbeds(root) }
 */
async function renderNote(ctx, o) {
  const { front, body } = splitFront(ctx.content);
  const box = document.createElement('div');
  box.className = 'md';
  box.style.cssText = 'position:fixed;left:-10000px;top:0;width:760px;';
  box.innerHTML = render(body, { ...ctx.previewOpts, lines: false });
  document.body.appendChild(box);
  try {
    await ctx.expandEmbeds?.(box);
    await enhance(box, ctx.richOpts);
    box.querySelectorAll('input[type="checkbox"]').forEach((c) => { c.disabled = true; if (c.checked) c.setAttribute('checked', ''); });
  } finally { box.remove(); }
  const entries = front ? parseFront(front).filter((e) => e.key !== null) : [];
  const props = o.pdfProps && entries.length
    ? `<table class="pb-props">${entries.map((e) => `<tr><th>${esc(e.key)}</th><td>${esc(Array.isArray(e.value) ? e.value.join(', ') : e.type === 'bool' ? (e.value ? 'Yes' : 'No') : e.value)}</td></tr>`).join('')}</table>` : '';
  const tags = o.pdfTags && ctx.tags?.length ? `<div class="pb-tags">${ctx.tags.map((t) => `<span>#${esc(t)}</span>`).join('')}</div>` : '';
  return { html: box.innerHTML, props, tags };
}

async function documentHtml(ctx, o, { forFile = false } = {}) {
  const now = new Date();
  const vars = { title: ctx.title, path: ctx.path, date: now.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }), time: now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) };
  const { html, props, tags } = await renderNote(ctx, o);
  const head = o.pdfHeader === 'title' ? vars.title : o.pdfHeader === 'custom' ? fill(o.pdfHeaderText, vars) : '';
  const foot = o.pdfFooter === 'date' ? vars.date : o.pdfFooter === 'title' ? vars.title : o.pdfFooter === 'custom' ? fill(o.pdfFooterText, vars) : '';
  const pageNumbers = o.pdfPageNumbers && !forFile
    // Margin boxes print page numbers in Chromium browsers; others use their own print options.
    ? `@page { @bottom-right { content: counter(page) " / " counter(pages); font: 8.5pt sans-serif; color: #9aa0a6; } }` : '';
  const style = `@page { size: ${o.pdfPaper === 'Letter' ? 'letter' : 'A4'}; margin: ${MARGINS[o.pdfMargins] || MARGINS.normal}; } ${pageNumbers}
    ${head ? '' : '.pb-space-top{height:0}'} ${foot ? '' : '.pb-space-bot{height:0}'}`;
  const content = `${o.pdfTitle ? `<h1 class="pb-title">${esc(vars.title)}</h1>` : ''}${tags}${props}<article class="md">${html}</article>`;
  const css = forFile ? `<style>${ctx.printCss}</style>` : '<link rel="stylesheet" href="/static/print.css"><link rel="stylesheet" href="/static/vendor/katex/katex.min.css">';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${esc(vars.title)}</title>${css}<style>${style}</style></head>
    <body class="${forFile ? 'pb-export ' : ''}${o.pdfFont}">
    ${head ? `<div class="pb-head"><span>${esc(head)}</span></div>` : ''}
    ${foot ? `<div class="pb-foot"><span>${esc(foot)}</span></div>` : ''}
    ${forFile ? `<main class="pb-doc">${content}</main>`
    : `<table class="pb-page"><thead><tr><td><div class="pb-space-top"></div></td></tr></thead>
       <tbody><tr><td>${content}</td></tr></tbody>
       <tfoot><tr><td><div class="pb-space-bot"></div></td></tr></tfoot></table>`}
    </body></html>`;
}

/** Build the printable page in a hidden frame and open the print dialog ("Save as PDF"). */
export async function printNote(ctx, o) {
  const html = await documentHtml(ctx, o);
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const loaded = new Promise((r) => { frame.onload = r; setTimeout(r, 3000); });
  doc.open();
  doc.write(html);
  doc.close();
  await loaded;
  await Promise.all([...doc.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
  await doc.fonts?.ready;
  frame.contentWindow.addEventListener('afterprint', () => setTimeout(() => frame.remove(), 500));
  frame.contentWindow.focus();
  frame.contentWindow.print();
  setTimeout(() => frame.isConnected && frame.remove(), 120000);
  return html;
}

/** A single self-contained .html file: styles inlined, images embedded. */
export async function htmlFile(ctx, o) {
  ctx.printCss = await (await fetch('/static/print.css')).text();
  let html = await documentHtml(ctx, o, { forFile: true });
  const srcs = [...new Set([...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]))];
  for (const src of srcs) {
    if (src.startsWith('data:')) continue;
    try {
      const blob = await (await fetch(src.replace(/&amp;/g, '&'))).blob();
      const data = await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); });
      html = html.split(`src="${src}"`).join(`src="${data}"`);
    } catch { /* leave the link */ }
  }
  return new Blob([html], { type: 'text/html' });
}

export { documentHtml };
