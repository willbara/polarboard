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
const BUILTIN_WORDS = ['Polarboard', 'markdown', 'Markdown', 'wikilink', 'wikilinks', 'backlink', 'backlinks', 'Backlink', 'Backlinks', 'frontmatter', 'Obsidian', 'homelab'];
// Harper rules that are off unless turned on in Settings: notes are usually written with sentence-case headings.
const RULE_DEFAULTS = { UseTitleCase: false };
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
  /\{\{[^}\n]*\}\}/g, // template placeholders like {{date:dddd}}
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

  /**
   * settings: { dialect, rules: { RuleName: bool }, words: [], ignored: [hash strings], isolate }
   * isolate skips text Harper thinks isn't English. Off by default: a sentence with
   * several typos can look non-English too, and then its typos go unflagged.
   */
  async configure({ dialect = 'American', rules = {}, words = [], ignored = [], isolate = false } = {}) {
    const linter = await this.start();
    this.isolate = !!isolate;
    if (dialect !== this.dialect) {
      await linter.setDialect(this.mod.Dialect[dialect] ?? this.mod.Dialect.American);
      this.dialect = dialect;
    }
    const key = JSON.stringify(rules);
    if (key !== this.rules) {
      const config = await linter.getDefaultLintConfig();
      await linter.setLintConfig({ ...config, ...RULE_DEFAULTS, ...rules });
      this.rules = key;
    }
    words = [...BUILTIN_WORDS, ...words];
    const wordKey = words.join('\n');
    if (wordKey !== this.words) {
      await linter.clearWords();
      if (words.length) await linter.importWords(words);
      this.words = wordKey;
    }
    const ignoredKey = ignored.join(',');
    if (ignoredKey !== this.ignored) {
      await linter.clearIgnoredLints();
      // Built as text: the hashes are 64-bit, too big for a JavaScript number.
      if (ignored.length) await linter.importIgnoredLints(`{"context_hashes":[${ignored.filter((h) => /^\d+$/.test(h)).join(',')}]}`);
      this.ignored = ignoredKey;
    }
  }

  /** "PronounVerbAgreement" -> "Pronoun verb agreement" */
  static ruleLabel(rule) {
    const words = String(rule || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ');
    return words.map((w, i) => (i && /^[A-Z][a-z]/.test(w) ? w.toLowerCase() : w)).join(' ');
  }

  async describeRules() {
    const linter = await this.start();
    const [config, descriptions] = await Promise.all([linter.getDefaultLintConfig(), linter.getLintDescriptions()]);
    return Object.keys(config).sort().map((name) => ({ name, on: name in RULE_DEFAULTS ? RULE_DEFAULTS[name] : config[name] !== false, description: descriptions[name] || '' }));
  }

  /**
   * Lint markdown text. Returns null if a newer request on the same channel replaced
   * this one (the main editor and the block editor in the preview use separate channels).
   */
  async check(text, groups, channel = 'main') {
    const linter = await this.start();
    this.seqs ||= {};
    const mine = this.seqs[channel] = (this.seqs[channel] || 0) + 1;
    // Grouped by rule, so each issue knows which rule to turn off.
    const byRule = await linter.organizedLints(text, { language: 'markdown', isolateEnglish: this.isolate });
    if (mine !== this.seqs[channel]) return null;
    const raw = Object.entries(byRule).flatMap(([rule, lints]) => lints.map((l) => [rule, l]));
    const skip = skippedRanges(text);
    const toU = charToUtf16(text);
    const out = [];
    for (const [rule, lint] of raw) {
      const span = lint.span();
      const start = toU(span.start);
      const end = toU(span.end);
      const kind = lint.lint_kind();
      const group = groupOf(kind);
      if (groups && groups[group] === false) continue;
      if (end <= start || skip.some(([a, b]) => start < b && end > a)) continue;
      out.push({
        start, end, kind, group, rule,
        message: lint.message(),
        problem: text.slice(start, end),
        suggestions: lint.suggestions().slice(0, 6).map((s) => ({ kind: s.kind(), text: s.get_replacement_text() })),
        raw: lint,
      });
    }
    // Two rules can flag the same words; keep one underline there.
    out.sort((a, b) => a.start - b.start || b.end - a.end);
    return out.filter((l, i) => !i || l.start !== out[i - 1].start || l.end !== out[i - 1].end);
  }

  /** Ignore one issue here and from now on. Returns its hash (a decimal string) to save. */
  async ignore(text, lint) {
    if (!this.linter || !lint.raw) return null;
    const hash = await this.linter.contextHash(text, lint.raw);
    await this.linter.ignoreLintHash(hash);
    const key = String(hash);
    this.ignored = this.ignored ? `${this.ignored},${key}` : key;
    return key;
  }

  async addWords(words) {
    if (this.linter && words.length) {
      await this.linter.importWords(words);
      this.words = [...new Set([...(this.words ? this.words.split('\n') : []), ...words])].join('\n');
    }
  }
}
