import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';
import { langById, type LanguageDef } from './languages.js';

/**
 * Grammar loader. Resolves the pre-compiled tree-sitter `.wasm` for a language
 * from, in order:
 *   1. the `--grammars <dir>` override (offline / air-gapped)
 *   2. ../grammars next to dist (bundled in the published package)
 *   3. the installed `tree-sitter-wasms` package (dev / fallback)
 *
 * Languages are cached. The grammar set version is recorded in provenance so the
 * determinism contract is explicit about which grammars produced the graph.
 */

const require = createRequire(import.meta.url);

let parserInit: Promise<void> | null = null;
const languageCache = new Map<string, Language>();

// The `--grammars <dir>` override, set per process (and per parse worker, via the
// parse payload) before parsing. Configured by a command option, not an env var.
let grammarsOverride: string | undefined;
export function setGrammarsOverride(dir?: string): void {
  grammarsOverride = dir ? path.resolve(dir) : undefined;
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

let cachedTreeSitterWasmsDir: string | null = null;
function treeSitterWasmsOutDir(): string {
  if (cachedTreeSitterWasmsDir) return cachedTreeSitterWasmsDir;
  const pkgJson = require.resolve('tree-sitter-wasms/package.json');
  cachedTreeSitterWasmsDir = path.join(path.dirname(pkgJson), 'out');
  return cachedTreeSitterWasmsDir;
}

/** The grammar-set version string recorded in provenance (determinism input). */
export function grammarSetVersion(): string {
  try {
    const pkgJson = require.resolve('tree-sitter-wasms/package.json');
    const { version } = JSON.parse(fs.readFileSync(pkgJson, 'utf8')) as { version: string };
    return `tree-sitter-wasms@${version}`;
  } catch {
    return 'tree-sitter-wasms@unknown';
  }
}

/** Candidate directories holding grammar .wasm files, highest priority first. */
function grammarDirs(): string[] {
  const dirs: string[] = [];
  // the `--grammars <dir>` override (offline / air-gapped), if set
  if (grammarsOverride) dirs.push(grammarsOverride);
  // ../grammars relative to dist/ (bundled in the published artifact)
  dirs.push(path.join(thisDir(), '..', 'grammars'));
  dirs.push(path.join(thisDir(), 'grammars'));
  // node_modules fallback
  try {
    dirs.push(treeSitterWasmsOutDir());
  } catch {
    /* tree-sitter-wasms not resolvable — rely on the dirs above */
  }
  return dirs;
}

/** The first existing directory that holds grammar .wasm files (for `vg bundle`). */
export function grammarsSourceDir(): string | null {
  for (const dir of grammarDirs()) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.wasm'))) return dir;
  }
  return null;
}

function resolveGrammarFile(grammarFile: string): string {
  const fileName = `${grammarFile}.wasm`;
  for (const dir of grammarDirs()) {
    const candidate = path.join(dir, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `grammar "${fileName}" not found. Looked in: ${grammarDirs().join(', ')}. ` +
      `Pass --grammars <dir> pointing at a directory of grammar .wasm files.`,
  );
}

async function ensureParserInit(): Promise<void> {
  if (!parserInit) parserInit = Parser.init();
  await parserInit;
}

/** Load (and cache) the tree-sitter Language for a vg language id. */
export async function loadLanguage(langId: string): Promise<Language> {
  const cached = languageCache.get(langId);
  if (cached) return cached;
  const def = langById(langId);
  if (!def) throw new Error(`unknown language id "${langId}"`);
  await ensureParserInit();
  const wasmPath = resolveGrammarFile(def.grammarFile);
  const language = await Language.load(fs.readFileSync(wasmPath));
  languageCache.set(langId, language);
  return language;
}

/** Construct a fresh parser bound to a language. */
export async function parserFor(def: LanguageDef): Promise<Parser> {
  const language = await loadLanguage(def.id);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}
