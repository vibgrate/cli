/**
 * Embedded-script container formats — files whose code lives in script regions
 * inside a non-code host document:
 *
 *  - single-file components: Vue (`.vue`), Svelte (`.svelte`), Astro
 *    (`.astro`, frontmatter fence + client `<script>`s);
 *  - plain HTML with inline `<script>` blocks (`.html`/`.htm`);
 *  - `<% … %>` templates: ERB (`.erb`, Ruby) and EJS (`.ejs`, JavaScript).
 *
 * The graph parses these by masking: every character outside the script
 * region(s) is replaced with a space (newlines kept), and the result is parsed
 * with the ordinary grammar of the embedded language. Masking preserves byte
 * offsets and line numbers exactly, so defs/calls/imports land on their true
 * positions in the original file and every downstream stage (resolution,
 * impact, display) works unchanged. Pure and deterministic: identical source →
 * identical mask.
 *
 * Template/markup content is intentionally out of scope — imports, exported
 * bindings, and calls all live in the script regions, which is what call/import
 * edges are built from.
 */

export interface EmbeddedScript {
  /** Effective grammar to parse the masked source with ('ts' | 'tsx' | 'js' | 'rb'). */
  langId: string;
  /** The original source with all non-script content blanked to spaces. */
  masked: string;
}

interface ScriptTagSpec {
  kind: 'script-tags';
  /** Grammar when a block has no `lang` attribute. */
  defaultLang: string;
  /** Also extract a leading `---` frontmatter fence (Astro). */
  frontmatter?: boolean;
}

interface DelimitedSpec {
  kind: 'delimited';
  /** The container's fixed embedded language. */
  lang: string;
}

/** Container language ids (must match the languages.ts registry entries). */
const CONTAINERS: Record<string, ScriptTagSpec | DelimitedSpec> = {
  vue: { kind: 'script-tags', defaultLang: 'js' },
  svelte: { kind: 'script-tags', defaultLang: 'js' },
  astro: { kind: 'script-tags', defaultLang: 'ts', frontmatter: true }, // frontmatter is TS
  html: { kind: 'script-tags', defaultLang: 'js' },
  erb: { kind: 'delimited', lang: 'rb' },
  ejs: { kind: 'delimited', lang: 'js' },
};

export function isContainerLang(langId: string): boolean {
  return langId in CONTAINERS;
}

interface Range {
  start: number;
  end: number;
}

// `<script …>body</script>` — non-greedy body, so multiple blocks (Vue's
// `<script>` + `<script setup>`, Svelte's `context="module"`) each match.
// A void `<script src=… />` has an empty body and contributes nothing.
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

// Astro frontmatter: a `---` fence on the first line, closed by a `---` line.
const ASTRO_FENCE_RE = /^---\r?\n([\s\S]*?)(\r?\n)---(?:\r?\n|$)/;

// `<% code %>` regions (ERB/EJS): `=`/`-` output tags included, `#`/`%%`
// comment/escape forms excluded, optional `-`/`_` trim markers kept out of the
// body. Non-greedy to the first closer, the standard template behaviour.
const DELIMITED_RE = /<%(?![%#])[=\-_]?([\s\S]*?)[-_]?%>/g;

const LANG_ATTR_RE = /\blang\s*=\s*["']?([A-Za-z]+)/i;

/** Rank grammars so mixed blocks pick the most permissive one (tsx ⊇ ts ⊇ js for our queries). */
const GRAMMAR_RANK: Record<string, number> = { js: 0, ts: 1, tsx: 2 };

function grammarForAttr(attrs: string, fallback: string): string {
  const m = LANG_ATTR_RE.exec(attrs);
  if (!m) return fallback;
  const lang = m[1].toLowerCase();
  if (lang === 'ts' || lang === 'typescript') return 'ts';
  if (lang === 'tsx') return 'tsx';
  return 'js'; // js / jsx / anything exotic → the JS grammar
}

/**
 * Extract the script regions of a container-format file. Returns null for
 * non-container language ids (the caller parses the source as-is). A container
 * file with no script region returns a fully-blank mask — the file still gets
 * a graph node, it just defines nothing.
 */
export function extractEmbeddedScript(langId: string, source: string): EmbeddedScript | null {
  const spec = CONTAINERS[langId];
  if (!spec) return null;

  if (spec.kind === 'delimited') {
    const ranges: Range[] = [];
    for (const m of source.matchAll(DELIMITED_RE)) {
      const body = m[1] ?? '';
      if (!body.trim()) continue;
      const start = m.index + m[0].indexOf(body);
      ranges.push({ start, end: start + body.length });
    }
    // Fragments are expressions/statements cut from one template — terminate
    // each region (on the trim/closing char, still inside the match, so the
    // length is unchanged) so `<%= a %> … <%= b %>` on one line parses as two
    // statements rather than one garbled one.
    return { langId: spec.lang, masked: mask(source, ranges, { terminate: true }) };
  }

  const ranges: Range[] = [];
  let grammar = spec.defaultLang;

  if (spec.frontmatter) {
    const fence = ASTRO_FENCE_RE.exec(source);
    if (fence) {
      const start = fence[0].indexOf('\n') + 1;
      ranges.push({ start, end: start + fence[1].length });
    }
  }

  for (const m of source.matchAll(SCRIPT_RE)) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    if (!body) continue;
    const start = m.index + '<script'.length + attrs.length + 1; // past the tag's '>'
    ranges.push({ start, end: start + body.length });
    const g = grammarForAttr(attrs, spec.defaultLang);
    if (GRAMMAR_RANK[g] > GRAMMAR_RANK[grammar]) grammar = g;
  }

  return { langId: grammar, masked: mask(source, ranges) };
}

/**
 * Blank everything outside `ranges` to spaces, preserving newlines (and CR).
 * With `terminate`, the character right after each range (part of the closing
 * delimiter, never a newline) becomes `;` — a statement boundary for the
 * embedded language.
 */
function mask(source: string, ranges: Range[], opts: { terminate?: boolean } = {}): string {
  const out = new Array<string>(source.length);
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    out[i] = ch === '\n' || ch === '\r' ? ch : ' ';
  }
  for (const r of ranges) {
    for (let i = r.start; i < r.end && i < source.length; i++) out[i] = source[i];
    if (opts.terminate && r.end < source.length && out[r.end] === ' ') out[r.end] = ';';
  }
  return out.join('');
}
