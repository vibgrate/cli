import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Module resolution for import edges. Resolves an import specifier (relative,
 * `tsconfig` path alias, or workspace-package name) to a repo-relative file —
 * the fix for alias-heavy TS monorepos (Nx/Turborepo) where every cross-package
 * import looked "external" and tanked call resolution.
 *
 * Deterministic: it reads the repo's tsconfig(s) and workspace manifests once at
 * construction, then `resolve()` is pure over those in-memory maps. Still the
 * heuristic rung — precise SCIP/stack-graphs slot above it later — but now
 * scope-aware of the project's own module map.
 */

export interface ModuleResolver {
  /** Resolve `source` imported from `fromRel`; returns a repo-rel path or null (external). */
  resolve(fromRel: string, source: string): string | null;
}

const JS_TS_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const OTHER_EXT = ['.py', '.pyi', '.go', '.rs', '.rb', '.java', '.cs'];

// Which target extensions a dotted import from a given file may resolve to.
// Keeps Python imports matching Python files, Java matching Java, etc. — a
// dotted module path must not cross languages.
const EXT_GROUPS: Record<string, string[]> = {
  '.py': ['.py', '.pyi'],
  '.pyi': ['.py', '.pyi'],
  '.java': ['.java'],
  '.cs': ['.cs'],
  '.go': ['.go'],
  '.rs': ['.rs'],
  '.rb': ['.rb'],
};
for (const e of JS_TS_EXT) EXT_GROUPS[e] = JS_TS_EXT;

export function buildModuleResolver(root: string, relSet: Set<string>): ModuleResolver {
  const probe = makeProbe(relSet);
  const suffixIndex = buildSuffixIndex(relSet);
  const tsPaths = loadTsconfigPaths(root); // {baseUrlRel, paths}
  const workspaces = loadWorkspacePackages(root); // name -> dirRel

  function resolveAlias(source: string): string | null {
    if (!tsPaths) return null;
    for (const [pattern, targets] of tsPaths.paths) {
      const m = matchPattern(pattern, source);
      if (m === null) continue;
      for (const target of targets) {
        const sub = target.replace('*', m);
        const rel = posixJoin(tsPaths.baseUrlRel, sub);
        const hit = probe(rel);
        if (hit) return hit;
      }
    }
    return null;
  }

  function resolveWorkspace(source: string): string | null {
    if (!workspaces.size) return null;
    // longest package-name match (so @org/a/b prefers @org/a/b over @org/a)
    let best: { dirRel: string; rest: string } | null = null;
    for (const [name, dirRel] of workspaces) {
      if (source === name || source.startsWith(`${name}/`)) {
        const rest = source === name ? '' : source.slice(name.length + 1);
        if (!best || name.length > best.dirRel.length) best = { dirRel, rest };
      }
    }
    if (!best) return null;
    const base = best.rest ? posixJoin(best.dirRel, best.rest) : best.dirRel;
    return probe(base) ?? probe(posixJoin(base, 'src/index')) ?? probe(posixJoin(base, 'index'));
  }

  return {
    resolve(fromRel, source) {
      // JS/TS relative (`./x`, `../x`) — join against the importer's directory.
      if (source.startsWith('./') || source.startsWith('../')) {
        return probe(posixJoin(path.posix.dirname(fromRel), source));
      }
      // Python-style relative (`.models`, `..core.utils`, `.`) — leading dots are
      // package levels, not a filename. One dot = the file's package (its dir),
      // each extra dot goes up one package.
      if (source.startsWith('.')) {
        return resolvePyRelative(probe, fromRel, source);
      }
      return (
        resolveAlias(source) ??
        resolveWorkspace(source) ??
        resolveSuffix(suffixIndex, fromRel, source) ??
        resolveDotted(probe, source)
      );
    },
  };
}

// --- suffix-based module resolution (Python/Java packages, src-layout) ---

interface SuffixEntry {
  rel: string;
  key: string; // path without extension (or directory, for __init__/index)
  ext: string;
}

/**
 * Index every file by the LAST segment of its module key, so a dotted import can
 * be matched against the *tail* of a repo path. This is what makes real Python
 * and Java layouts resolve: `from src.feature_pipeline.services.x import Y` in a
 * monorepo where the file actually lives at
 * `feature-pipeline/src/feature_pipeline/services/x.py` (per-subproject `src/`
 * roots, PYTHONPATH-style), or `import com.example.Foo` →
 * `.../src/main/java/com/example/Foo.java`. A repo-root/`src/` prefix probe
 * (the old behaviour) resolved none of these, so cross-file edges were ~0.
 */
function buildSuffixIndex(relSet: Set<string>): Map<string, SuffixEntry[]> {
  const byLast = new Map<string, SuffixEntry[]>();
  for (const rel of relSet) {
    const dot = rel.lastIndexOf('.');
    if (dot < 0) continue;
    const ext = rel.slice(dot);
    if (!EXT_GROUPS[ext]) continue;
    let key = rel.slice(0, dot);
    const base = key.slice(key.lastIndexOf('/') + 1);
    if (base === '__init__' || base === 'index') {
      key = key.slice(0, Math.max(0, key.length - base.length - 1)); // → directory key
    }
    if (!key) continue;
    const last = key.slice(key.lastIndexOf('/') + 1);
    const list = byLast.get(last);
    if (list) list.push({ rel, key, ext });
    else byLast.set(last, [{ rel, key, ext }]);
  }
  return byLast;
}

/**
 * Resolve a dotted module path (Python/Java) by matching it against the tail of
 * a repo file's path, restricted to the importer's language group. On multiple
 * matches, pick the file sharing the longest path prefix with the importer
 * (same subproject), then the shortest path, then lexicographically — fully
 * deterministic.
 */
function resolveSuffix(
  index: Map<string, SuffixEntry[]>,
  fromRel: string,
  source: string,
): string | null {
  if (!/^[A-Za-z_][\w.]*$/.test(source) || !source.includes('.')) return null;
  const fromDot = fromRel.lastIndexOf('.');
  const fromExt = fromDot >= 0 ? fromRel.slice(fromDot) : '';
  const allowed = EXT_GROUPS[fromExt];
  if (!allowed) return null; // unknown importer language — don't risk a cross-language match
  const q = source.replace(/\./g, '/');
  const last = q.slice(q.lastIndexOf('/') + 1);
  const cands = index.get(last);
  if (!cands) return null;
  const matches = cands.filter(
    (c) => allowed.includes(c.ext) && (c.key === q || c.key.endsWith('/' + q)),
  );
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].rel;
  return pickClosest(matches, fromRel).rel;
}

function pickClosest(matches: SuffixEntry[], fromRel: string): SuffixEntry {
  const fromSegs = fromRel.split('/');
  const score = (rel: string): number => {
    const segs = rel.split('/');
    let i = 0;
    while (i < segs.length && i < fromSegs.length && segs[i] === fromSegs[i]) i++;
    return i;
  };
  return [...matches].sort((a, b) => {
    const d = score(b.rel) - score(a.rel);
    if (d) return d;
    if (a.rel.length !== b.rel.length) return a.rel.length - b.rel.length;
    return a.rel < b.rel ? -1 : 1;
  })[0];
}

/**
 * Dotted-module resolution (Python/Java style): `app.core.security` →
 * `app/core/security(.py|/__init__.py)`. Tries a repo-root and `src/` layout.
 * Safe across languages — it only returns a hit when a real repo file matches,
 * so JS packages that contain a dot (e.g. `socket.io`) fall through to external.
 */
function resolveDotted(probe: (base: string) => string | null, source: string): string | null {
  if (!/^[A-Za-z_][\w.]*$/.test(source) || !source.includes('.')) return null;
  const slashed = source.replace(/\./g, '/');
  return probe(slashed) ?? probe(posixJoin('src', slashed));
}

/**
 * Resolve a Python-style relative import. `source` is leading dots plus an
 * optional dotted module (`.models`, `..core.utils`, or just `.`). The number of
 * dots is the package level: one dot = the importer's own package (directory),
 * each additional dot ascends one package. A bare `from . import x` resolves to
 * the package itself (its `__init__.py`); the dotted-module form targets the
 * submodule file.
 */
function resolvePyRelative(
  probe: (base: string) => string | null,
  fromRel: string,
  source: string,
): string | null {
  let dots = 0;
  while (source[dots] === '.') dots++;
  const rest = source.slice(dots); // dotted submodule path, possibly empty
  let dir = path.posix.dirname(fromRel);
  for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
  const sub = rest.replace(/\./g, '/');
  return probe(sub ? posixJoin(dir, sub) : dir);
}

/** A resolver that only handles relative imports (no fs) — for tests/embedding. */
export function relativeResolver(relSet: Set<string>): ModuleResolver {
  const probe = makeProbe(relSet);
  return {
    resolve(fromRel, source) {
      if (source.startsWith('.')) return probe(posixJoin(path.posix.dirname(fromRel), source));
      return resolveDotted(probe, source);
    },
  };
}

// --- probing ---

function makeProbe(relSet: Set<string>): (base: string) => string | null {
  return (base: string) => {
    const norm = normalizeRel(base);
    if (!norm) return null;
    if (relSet.has(norm)) return norm;
    for (const ext of JS_TS_EXT) if (relSet.has(norm + ext)) return norm + ext;
    for (const ext of JS_TS_EXT) if (relSet.has(`${norm}/index${ext}`)) return `${norm}/index${ext}`;
    for (const ext of OTHER_EXT) if (relSet.has(norm + ext)) return norm + ext;
    if (relSet.has(`${norm}/__init__.py`)) return `${norm}/__init__.py`;
    return null;
  };
}

function normalizeRel(p: string): string {
  const norm = path.posix.normalize(p);
  const stripped = norm.startsWith('./') ? norm.slice(2) : norm;
  return stripped.startsWith('..') ? '' : stripped;
}

function posixJoin(a: string, b: string): string {
  return path.posix.normalize(path.posix.join(a, b));
}

/** Match a tsconfig paths pattern (`@app/*`) against a specifier; returns the `*` capture or '' on exact, null on no match. */
function matchPattern(pattern: string, source: string): string | null {
  const star = pattern.indexOf('*');
  if (star === -1) return source === pattern ? '' : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!source.startsWith(prefix) || !source.endsWith(suffix)) return null;
  if (source.length < prefix.length + suffix.length) return null;
  return source.slice(prefix.length, source.length - suffix.length);
}

// --- tsconfig ---

interface TsPaths {
  baseUrlRel: string; // relative to root
  paths: [string, string[]][];
}

function loadTsconfigPaths(root: string): TsPaths | null {
  // Prefer tsconfig.base.json (Nx) then tsconfig.json; follow `extends`.
  for (const name of ['tsconfig.base.json', 'tsconfig.json']) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) {
      const merged = readTsconfigChain(root, file, new Set());
      if (merged && merged.paths.length) return merged;
    }
  }
  return null;
}

function readTsconfigChain(root: string, file: string, seen: Set<string>): TsPaths | null {
  if (seen.has(file) || seen.size > 6) return null;
  seen.add(file);
  let cfg: { extends?: string; compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  try {
    cfg = parseJsonc(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const dir = path.dirname(file);
  let base: TsPaths = { baseUrlRel: '', paths: [] };
  if (cfg.extends && cfg.extends.startsWith('.')) {
    const extPath = path.resolve(dir, cfg.extends.endsWith('.json') ? cfg.extends : `${cfg.extends}.json`);
    if (fs.existsSync(extPath)) {
      const inherited = readTsconfigChain(root, extPath, seen);
      if (inherited) base = inherited;
    }
  }
  const co = cfg.compilerOptions ?? {};
  // baseUrl is relative to THIS config's dir; express it relative to the repo root.
  const baseUrlRel =
    co.baseUrl !== undefined
      ? path.relative(root, path.resolve(dir, co.baseUrl)).split(path.sep).join('/')
      : base.baseUrlRel;
  const paths: [string, string[]][] = [...base.paths];
  if (co.paths) for (const [k, v] of Object.entries(co.paths)) paths.push([k, v]);
  return { baseUrlRel, paths };
}

// --- workspaces ---

function loadWorkspacePackages(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const globs: string[] = [];

  const rootPkg = path.join(root, 'package.json');
  if (fs.existsSync(rootPkg)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(rootPkg, 'utf8')) as { workspaces?: string[] | { packages?: string[] } };
      const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
      if (ws) globs.push(...ws);
    } catch {
      /* ignore */
    }
  }
  const pnpmWs = path.join(root, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmWs)) {
    for (const line of fs.readFileSync(pnpmWs, 'utf8').split('\n')) {
      const m = /^\s*-\s*['"]?([^'"\n]+)['"]?\s*$/.exec(line);
      if (m) globs.push(m[1].trim());
    }
  }

  for (const dir of expandWorkspaceGlobs(root, globs)) {
    const pj = path.join(dir, 'package.json');
    try {
      const name = (JSON.parse(fs.readFileSync(pj, 'utf8')) as { name?: string }).name;
      if (name) map.set(name, path.relative(root, dir).split(path.sep).join('/'));
    } catch {
      /* ignore */
    }
  }
  return map;
}

/** Resolve simple workspace globs (`packages/*`, `apps/*`, `libs/**`) to dirs containing package.json. */
function expandWorkspaceGlobs(root: string, globs: string[]): string[] {
  const out = new Set<string>();
  for (const glob of globs) {
    const clean = glob.replace(/\/\*\*$/, '').replace(/\/\*$/, '');
    const baseDir = path.join(root, clean);
    const recurse = glob.endsWith('**');
    if (glob === clean) {
      // No wildcard — a direct package dir.
      if (fs.existsSync(path.join(baseDir, 'package.json'))) out.add(baseDir);
      continue;
    }
    collectPackageDirs(baseDir, recurse ? 4 : 1, out);
  }
  return [...out];
}

function collectPackageDirs(dir: string, depth: number, out: Set<string>): void {
  if (depth < 0) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const child = path.join(dir, e.name);
    if (fs.existsSync(path.join(child, 'package.json'))) out.add(child);
    else collectPackageDirs(child, depth - 1, out);
  }
}

// --- tolerant JSONC ---

export function parseJsonc<T = unknown>(text: string): T {
  return JSON.parse(stripJsonc(text)) as T;
}

function stripJsonc(text: string): string {
  let out = '';
  let inStr = false;
  let strCh = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inStr) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i++;
      } else if (ch === strCh) {
        inStr = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strCh = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += ch;
  }
  // drop trailing commas before } or ]
  return out.replace(/,(\s*[}\]])/g, '$1');
}
