import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * "Contract" extraction for `vg fix`: the named symbols the source imports from
 * a package (its default, namespace, named exports, and destructured requires).
 *
 * These are the API surfaces an upgrade must preserve, so the report can point a
 * developer (or a breaking-change analysis) at exactly what to re-verify against
 * the new version. The parser is pure and exported for tests; {@link collectContracts}
 * is a bounded, deterministic walk of the source tree.
 */

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.vibgrate', 'vendor',
  '.venv', 'venv', 'env', '__pycache__', 'target', '.next', '.nuxt', 'coverage', '.cache',
]);
const MAX_FILES = 8000;
const MAX_DEPTH = 12;
const MAX_FILE_BYTES = 1_048_576;
/** Cap on the distinct contract symbols reported per package (keeps output bounded). */
export const MAX_CONTRACTS = 40;

const SOURCE_EXT: Record<'npm' | 'pypi', Set<string>> = {
  npm: new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte']),
  pypi: new Set(['.py']),
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parse the specifiers of one ESM/CJS import clause (`Default, { A, B as C }` / `* as NS`). */
function parseJsClause(clause: string, out: Set<string>): void {
  const trimmed = clause.trim();
  if (!trimmed) return;
  // Namespace import: `* as NS`
  if (/^\*\s+as\s+\w+/.test(trimmed)) {
    out.add('* (namespace)');
    return;
  }
  // Named block `{ ... }`, with an optional leading default identifier.
  const braceMatch = /\{([^}]*)\}/.exec(trimmed);
  const beforeBrace = braceMatch ? trimmed.slice(0, braceMatch.index) : trimmed;
  const defaultId = beforeBrace.replace(/,/g, '').trim();
  if (defaultId && /^\w+$/.test(defaultId)) out.add('default');
  if (braceMatch) {
    for (const raw of braceMatch[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0]?.trim();
      if (name && /^[\w$]+$/.test(name)) out.add(name);
    }
  }
}

/** Extract the imported contract symbols for `pkg` from a single file's `content`. */
export function extractContracts(content: string, pkg: string, ecosystem: 'npm' | 'pypi' | 'unknown'): string[] {
  const out = new Set<string>();
  const e = escapeRegExp(pkg);
  if (ecosystem === 'npm') {
    const importRe = new RegExp(`import\\s+([^;'"\\n]*?)\\s+from\\s+['"]${e}(?:/[^'"]*)?['"]`, 'g');
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(content))) parseJsClause(m[1], out);
    const requireDestructureRe = new RegExp(`\\{([^}]*)\\}\\s*=\\s*require\\(\\s*['"]${e}(?:/[^'"]*)?['"]\\s*\\)`, 'g');
    while ((m = requireDestructureRe.exec(content))) {
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(':')[0]?.trim();
        if (name && /^[\w$]+$/.test(name)) out.add(name);
      }
    }
  } else if (ecosystem === 'pypi') {
    const fromRe = new RegExp(`^\\s*from\\s+${e}(?:\\.[\\w.]+)?\\s+import\\s+(.+)$`, 'gm');
    let m: RegExpExecArray | null;
    while ((m = fromRe.exec(content))) {
      const names = m[1].replace(/[()]/g, '').split(',');
      for (const raw of names) {
        const name = raw.trim().split(/\s+as\s+/)[0]?.trim();
        if (name === '*') out.add('* (module)');
        else if (name && /^[\w.]+$/.test(name)) out.add(name);
      }
    }
    const importRe = new RegExp(`^\\s*import\\s+${e}\\b`, 'gm');
    if (importRe.test(content)) out.add(`${pkg} (module)`);
  }
  return [...out].sort();
}

/**
 * Walk the source tree (bounded) collecting the distinct contract symbols used
 * from `pkg`. Deterministic: files are visited in sorted order and the result is
 * sorted and capped at {@link MAX_CONTRACTS}.
 */
export function collectContracts(root: string, pkg: string, ecosystem: 'npm' | 'pypi' | 'unknown'): string[] {
  if (ecosystem === 'unknown') return [];
  const exts = SOURCE_EXT[ecosystem];
  if (!exts) return [];
  const found = new Set<string>();
  let filesSeen = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || filesSeen >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (filesSeen >= MAX_FILES) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && exts.has(path.extname(entry.name))) {
        filesSeen++;
        const full = path.join(dir, entry.name);
        let content: string;
        try {
          if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
          content = fs.readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        for (const sym of extractContracts(content, pkg, ecosystem)) found.add(sym);
      }
    }
  };
  walk(root, 0);
  return [...found].sort().slice(0, MAX_CONTRACTS);
}
