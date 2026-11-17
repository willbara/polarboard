// Writing checks with Harper (https://github.com/Automattic/harper), Apache-2.0.
// Harper runs as WebAssembly in a background worker, entirely in this browser.
// Nothing you write is sent anywhere.

// Harper's lint kinds, grouped into the switches shown in Settings.
export const GROUPS = {
  spelling: { label: 'Spelling', kinds: ['Spelling', 'Typo'] },
  grammar: { label: 'Grammar', kinds: ['Agreement', 'Grammar', 'BoundaryError', 'WordOrder', 'Eggcorn', 'Malapropism', 'Usage'] },
  punctuation: { label: 'Punctuation and capitalization', kinds: ['Punctuation', 'Capitalization', 'Formatting'] },
  style: { label: 'Style and clarity', kinds: ['Style', 'Readability', 'Redundancy', 'Repetition', 'WordChoice', 'Enhancement', 'Nonstandard', 'Regionalism', 'Miscellaneous'] },
};
const KIND_GROUP = Object.fromEntries(Object.entries(GROUPS).flatMap(([g, { kinds }]) => kinds.map((k) => [k, g])));
export const groupOf = (kind) => KIND_GROUP[kind] || 'style';
// Words a notes app uses constantly that general dictionaries don't know.
const BUILTIN_WORDS = ['Polarboard', 'markdown', 'Markdown', 'wikilink', 'wikilinks', 'frontmatter', 'Obsidian', 'homelab'];
export const DIALECTS = [['American', 'American'], ['British', 'British'], ['Canadian', 'Canadian'], ['Australian', 'Australian'], ['Indian', 'Indian']];

// Text Polarboard owns that a writing checker should never flag.
const SKIP = [
  /`+[^`\n]*`+/g, // inline code
  /!?\[\[[^\]\n]*\]\]/g, // wikilinks and embeds
  /\]\([^)\s]*\)/g, // link targets
  /https?:\/\/\S+/g, // bare URLs
  /(?<![^\s(\[,;])#[\p{L}\p{N}_\/-]+/gu, // tags
  /\$[^$\n]+\$/g, // inline math
  /^\s*>\s*\[![\w-]+\][+-]?/gm, // callout markers like > [!tip]
];

function skippedRanges(text) {
  const ranges = [];
  for (const rx of SKIP) for (const m of text.matchAll(rx)) ranges.push([m.index, m.index + m[0].length]);
  // front matter
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---', 4);
    if (end > 0) ranges.push([0, end + 4]);
  }
  return ranges;
}

/** Harper counts characters as Unicode scalar values; the editor counts UTF-16 units. */
function charToUtf16(text) {
  if (!/[\uD800-\uDFFF]/.test(text)) return (i) => i;
  const map = [];
  let u = 0;
  for (const ch of text) { map.push(u); u += ch.length; }
  map.push(u);
  return (i) => map[Math.min(i, map.length - 1)];
}

export class Spell {
  constructor() {
    this.linter = null;
    this.loading = null;
    this.mod = null;
    this.seq = 0;
    this.dialect = null;
    this.rules = null;
  }

  get ready() { return !!this.linter; }

  start() {
    this.loading ||= (async () => {
      // The slim build lints identically to the full one (same 971 rules) and loads one file instead of two.
      const [mod, { slimBinary }] = await Promise.all([
        import('/static/vendor/harper/index.js'),
        import('/static/vendor/harper/slimBinary.js'),
      ]);
      this.mod = mod;
      const linter = new mod.WorkerLinter({ binary: slimBinary });
      await linter.setup();
      this.linter = linter;
      return linter;
    })().catch((e) => { this.loading = null; throw e; });
    return this.loading;
  }

  /** settings: { dialect, rules: { RuleName: bool }, words: [] } */
  async configure({ dialect = 'American', rules = {}, words = [] } = {}) {
    const linter = await this.start();
    if (dialect !== this.dialect) {
      await linter.setDialect(this.mod.Dialect[dialect] ?? this.mod.Dialect.American);
      this.dialect = dialect;
    }
    const key = JSON.stringify(rules);
    if (key !== this.rules) {
      const config = await linter.getDefaultLintConfig();
      await linter.setLintConfig({ ...config, ...rules });
      this.rules = key;
    }
    words = [...BUILTIN_WORDS, ...words];
    const wordKey = words.join('\n');
    if (wordKey !== this.words) {
      await linter.clearWords();
      if (words.length) await linter.importWords(words);
      this.words = wordKey;
    }
  }

  async describeRules() {
    const linter = await this.start();
    const [config, descriptions] = await Promise.all([linter.getDefaultLintConfig(), linter.getLintDescriptions()]);
    return Object.keys(config).sort().map((name) => ({ name, on: config[name] !== false, description: descriptions[name] || '' }));
  }

  /**
   * Lint markdown text. Returns null if a newer request on the same channel replaced
   * this one (the main editor and the block editor in the preview use separate channels).
   */
  async check(text, groups, channel = 'main') {
    const linter = await this.start();
    this.seqs ||= {};
    const mine = this.seqs[channel] = (this.seqs[channel] || 0) + 1;
    const raw = await linter.lint(text, { language: 'markdown' });
    if (mine !== this.seqs[channel]) return null;
    const skip = skippedRanges(text);
    const toU = charToUtf16(text);
    const out = [];
    for (const lint of raw) {
      const span = lint.span();
      const start = toU(span.start);
      const end = toU(span.end);
      const kind = lint.lint_kind();
      const group = groupOf(kind);
      if (groups && groups[group] === false) continue;
      if (end <= start || skip.some(([a, b]) => start < b && end > a)) continue;
      out.push({
        start, end, kind, group,
        message: lint.message(),
        problem: text.slice(start, end),
        suggestions: lint.suggestions().slice(0, 6).map((s) => ({ kind: s.kind(), text: s.get_replacement_text() })),
        raw: lint,
      });
    }
    return out;
  }

  async ignore(text, lint) {
    if (this.linter && lint.raw) await this.linter.ignoreLint(text, lint.raw);
  }

  async addWords(words) {
    if (this.linter && words.length) {
      await this.linter.importWords(words);
      this.words = [...new Set([...(this.words ? this.words.split('\n') : []), ...words])].join('\n');
    }
  }
}
