/**
 * Language registry: the first-wave ~8 languages (VG-DEVELOPMENT-PLAN Phase 0).
 *
 * Each language maps to a tree-sitter grammar shipped (pre-compiled to .wasm) by
 * `tree-sitter-wasms`. `grammarFile` is the base name under that package's `out/`
 * directory (and our bundled `grammars/` copy). The grammar *version* is recorded
 * in provenance so the determinism contract is explicit about its inputs.
 */

export interface LanguageDef {
  /** Canonical short id used in the schema (`lang` field) and `--only`. */
  id: string;
  /** Human label. */
  label: string;
  /** File extensions (lowercase, with leading dot). */
  extensions: string[];
  /** tree-sitter-wasms grammar base name, e.g. `tree-sitter-typescript`. */
  grammarFile: string;
}

export const LANGUAGES: LanguageDef[] = [
  {
    id: 'ts',
    label: 'TypeScript',
    extensions: ['.ts', '.mts', '.cts'],
    grammarFile: 'tree-sitter-typescript',
  },
  {
    id: 'tsx',
    label: 'TSX',
    extensions: ['.tsx'],
    grammarFile: 'tree-sitter-tsx',
  },
  {
    id: 'js',
    label: 'JavaScript',
    extensions: ['.js', '.mjs', '.cjs', '.jsx'],
    grammarFile: 'tree-sitter-javascript',
  },
  {
    id: 'py',
    label: 'Python',
    extensions: ['.py', '.pyi'],
    grammarFile: 'tree-sitter-python',
  },
  {
    id: 'go',
    label: 'Go',
    extensions: ['.go'],
    grammarFile: 'tree-sitter-go',
  },
  {
    id: 'java',
    label: 'Java',
    extensions: ['.java'],
    grammarFile: 'tree-sitter-java',
  },
  {
    id: 'rust',
    label: 'Rust',
    extensions: ['.rs'],
    grammarFile: 'tree-sitter-rust',
  },
  {
    id: 'cs',
    label: 'C#',
    extensions: ['.cs'],
    grammarFile: 'tree-sitter-c_sharp',
  },
  {
    id: 'rb',
    label: 'Ruby',
    extensions: ['.rb'],
    grammarFile: 'tree-sitter-ruby',
  },
];

const EXT_TO_LANG = new Map<string, LanguageDef>();
for (const lang of LANGUAGES) {
  for (const ext of lang.extensions) EXT_TO_LANG.set(ext, lang);
}

const ID_TO_LANG = new Map<string, LanguageDef>(LANGUAGES.map((l) => [l.id, l]));

export function langForExtension(ext: string): LanguageDef | undefined {
  return EXT_TO_LANG.get(ext.toLowerCase());
}

export function langById(id: string): LanguageDef | undefined {
  return ID_TO_LANG.get(id);
}

export function allLanguageIds(): string[] {
  return LANGUAGES.map((l) => l.id);
}
