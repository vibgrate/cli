import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';
import { grammarDirs, ensureParserInit } from '../grammars.js';

/**
 * Grammar loading for the **toolchain** corpus (infrastructure, CI, config).
 *
 * Deliberately separate from `engine/grammars.ts`'s language registry. Adding
 * these grammars to `LANGUAGES` would make `discover.ts` treat every `.tf` /
 * `.yaml` / `.json` in a repository as a *source* file, which silently changes:
 *
 *   - `project-classification.ts` source-file counts — and those pick the
 *     billing tier, so a config-heavy repo would jump a tier for free;
 *   - DriftScore, coverage ratios, file-hotspot and code-quality metrics.
 *
 * So the toolchain corpus is discovered separately (via `docs-ingest`, which
 * already classifies exactly these files) and parsed with its own grammar set.
 * The source corpus is untouched.
 *
 * ## Why only HCL
 *
 * YAML, JSON and TOML are *not* parsed with tree-sitter here. The repository
 * already depends on `yaml` (which yields byte ranges on every node, plus
 * multi-document, anchor and merge-key support that a grammar would force us to
 * reimplement) and `smol-toml`. Reusing audited parsers beats adding grammars.
 * HCL has no such parser in the tree, so it gets a grammar.
 *
 * ## Supply chain
 *
 * `@tree-sitter-grammars/tree-sitter-hcl` carries a native `install` script
 * (`node-gyp-build`) for its Node bindings. It is therefore a **devDependency**
 * only: `scripts/bundle-grammars.mjs` copies its prebuilt `.wasm` into
 * `grammars/` at build time, and that file ships inside the published tarball.
 * End users receive the grammar; they never install the grammar package and
 * never run its install script.
 */

const require = createRequire(import.meta.url);

/** Toolchain grammar ids → the `.wasm` base name and its owning npm package. */
export const TOOLCHAIN_GRAMMARS: Record<string, { wasm: string; pkg: string }> = {
  hcl: { wasm: 'tree-sitter-hcl', pkg: '@tree-sitter-grammars/tree-sitter-hcl' },
};

const languageCache = new Map<string, Language>();

/**
 * Directories to search for a toolchain grammar, highest priority first: the
 * same set the source grammars use (so `--grammars <dir>` and the bundled
 * `grammars/` both work), then the owning devDependency's package root as the
 * dev/test fallback before a `pnpm build` has run.
 */
function toolchainGrammarDirs(pkg: string): string[] {
  const dirs = [...grammarDirs()];
  try {
    dirs.push(path.dirname(require.resolve(`${pkg}/package.json`)));
  } catch {
    /* devDependency absent (e.g. a published install) — the bundled dirs cover it */
  }
  return dirs;
}

/** Absolute path to a toolchain grammar's `.wasm`, or null when unavailable. */
export function resolveToolchainGrammar(id: string): string | null {
  const spec = TOOLCHAIN_GRAMMARS[id];
  if (!spec) return null;
  for (const dir of toolchainGrammarDirs(spec.pkg)) {
    const candidate = path.join(dir, `${spec.wasm}.wasm`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Load (and cache) a toolchain grammar.
 *
 * Returns `null` rather than throwing when the grammar is unavailable: a
 * missing toolchain grammar must degrade to "no structural extraction for that
 * format", never fail a build. The caller surfaces a warning.
 */
export async function loadToolchainLanguage(id: string): Promise<Language | null> {
  const cached = languageCache.get(id);
  if (cached) return cached;
  const wasmPath = resolveToolchainGrammar(id);
  if (!wasmPath) return null;
  try {
    await ensureParserInit();
    const language = await Language.load(fs.readFileSync(wasmPath));
    languageCache.set(id, language);
    return language;
  } catch {
    return null;
  }
}

/** A parser bound to a toolchain grammar, or null when the grammar is unavailable. */
export async function toolchainParser(id: string): Promise<Parser | null> {
  const language = await loadToolchainLanguage(id);
  if (!language) return null;
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

/**
 * Version string for the toolchain grammar set — a determinism input recorded
 * in provenance alongside `grammarSetVersion()`. Resolved from the owning
 * package when present; `unknown` once the package is absent (published
 * installs), which is stable because the shipped `.wasm` is fixed at publish.
 */
export function toolchainGrammarSetVersion(): string {
  const parts: string[] = [];
  for (const id of Object.keys(TOOLCHAIN_GRAMMARS).sort()) {
    const { pkg } = TOOLCHAIN_GRAMMARS[id];
    let version = 'bundled';
    try {
      const json = require.resolve(`${pkg}/package.json`);
      version = (JSON.parse(fs.readFileSync(json, 'utf8')) as { version: string }).version;
    } catch {
      /* published install — the bundled .wasm is fixed, so `bundled` is stable */
    }
    parts.push(`${pkg}@${version}`);
  }
  return parts.join(',');
}

/** Reset the language cache. Test-only. */
export function resetToolchainGrammarCache(): void {
  languageCache.clear();
}
