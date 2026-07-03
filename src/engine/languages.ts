/**
 * Language registry: 20 supported languages (first wave + the Phase-3 expansion).
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
  { id: 'php', label: 'PHP', extensions: ['.php'], grammarFile: 'tree-sitter-php' },
  { id: 'kotlin', label: 'Kotlin', extensions: ['.kt', '.kts'], grammarFile: 'tree-sitter-kotlin' },
  { id: 'swift', label: 'Swift', extensions: ['.swift'], grammarFile: 'tree-sitter-swift' },
  { id: 'scala', label: 'Scala', extensions: ['.scala', '.sc'], grammarFile: 'tree-sitter-scala' },
  { id: 'dart', label: 'Dart', extensions: ['.dart'], grammarFile: 'tree-sitter-dart' },
  { id: 'lua', label: 'Lua', extensions: ['.lua'], grammarFile: 'tree-sitter-lua' },
  { id: 'ex', label: 'Elixir', extensions: ['.ex', '.exs'], grammarFile: 'tree-sitter-elixir' },
  // Known limitation: the bundled bash grammar's external scanner throws under
  // web-tree-sitter 0.25.10 on `case`/heredoc constructs. Such files degrade
  // gracefully (per-file empty parse + a surfaced warning, never a build crash);
  // functions in case/heredoc-free scripts extract normally.
  { id: 'sh', label: 'Shell', extensions: ['.sh', '.bash'], grammarFile: 'tree-sitter-bash' },
  { id: 'zig', label: 'Zig', extensions: ['.zig'], grammarFile: 'tree-sitter-zig' },
  { id: 'c', label: 'C', extensions: ['.c'], grammarFile: 'tree-sitter-c' },
  // C++ owns `.h`: the cpp grammar is a superset of C, so C headers parse clean
  // under it, while C++ headers (classes/templates) break the C grammar.
  {
    id: 'cpp',
    label: 'C++',
    extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.h'],
    grammarFile: 'tree-sitter-cpp',
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
