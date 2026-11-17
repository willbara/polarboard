// Richer previews: code highlighting (highlight.js), math (KaTeX) and diagrams
// (Mermaid). Each library is vendored under /static/vendor and only loads the
// first time a note actually needs it.

const once = {};
function load(key, fn) { return (once[key] ||= fn().catch((e) => { delete once[key]; throw e; })); }

function script(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}
function css(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.appendChild(l);
}

const hljs = () => load('hljs', () => script('/static/vendor/hljs/highlight.min.js').then(() => window.hljs));
const katex = () => load('katex', async () => { css('/static/vendor/katex/katex.min.css'); return (await import('/static/vendor/katex/katex.mjs')).default; });
const mermaid = () => load('mermaid', () => script('/static/vendor/mermaid/mermaid.min.js').then(() => window.mermaid));

let diagramSeq = 0;

/** Upgrade rendered markdown inside root. opts: { code, math, diagrams } (all default true). */
export async function enhance(root, opts = {}) {
  const jobs = [];
  const codes = opts.code === false ? [] : [...root.querySelectorAll('pre.code code[class^="language-"]')];
  if (codes.length) {
    jobs.push(hljs().then((h) => {
      for (const el of codes) {
        const lang = el.className.replace('language-', '');
        if (!h.getLanguage(lang) || el.dataset.done) continue;
        el.innerHTML = h.highlight(el.textContent, { language: lang, ignoreIllegals: true }).value;
        el.classList.add('hljs');
        el.dataset.done = '1';
      }
    }));
  }
  const maths = opts.math === false ? [] : [...root.querySelectorAll('.math[data-tex]')];
  if (maths.length) {
    jobs.push(katex().then((k) => {
      for (const el of maths) {
        if (el.dataset.done) continue;
        k.render(el.dataset.tex, el, { displayMode: el.classList.contains('math-block'), throwOnError: false, trust: false, strict: 'ignore' });
        el.dataset.done = '1';
      }
    }));
  }
  const diagrams = opts.diagrams === false ? [] : [...root.querySelectorAll('pre.mermaid[data-src]')];
  if (diagrams.length) {
    jobs.push(mermaid().then(async (m) => {
      const dark = document.documentElement.dataset.theme !== 'light';
      m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral', fontFamily: 'inherit' });
      for (const el of diagrams) {
        if (el.dataset.done) continue;
        try {
          const { svg } = await m.render(`pb-diagram-${++diagramSeq}`, el.dataset.src);
          el.innerHTML = svg;
          el.classList.add('rendered');
        } catch (e) {
          el.classList.add('failed');
          el.title = String(e.message || e).slice(0, 300);
        }
        el.dataset.done = '1';
      }
    }));
  }
  await Promise.allSettled(jobs);
}
