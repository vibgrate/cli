import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stableStringify } from './serialize.js';
import { hashString } from './hash.js';
import { inventory, installedTreeVersion } from './drift.js';
import { lockfileVersion } from './lockfile.js';

/**
 * `vg lib` — the Context7 superset (VG-VS-CONTEXT7). A deterministic, on-disk
 * library-currency catalog: version-correct usage docs for the **exact version
 * in your lockfile**, drift-annotated, from on-disk sources (no key).
 *
 * The catalog (`vibgrate.lib.json`) is small and committable; doc bodies live in
 * `.vibgrate/lib/<id>.md` so the team shares them on pull. Ingestion is
 * deterministic from local sources; URL/llms.txt ingestion is opt-in network.
 */

export const LIB_SCHEMA = 'vg-lib/1.0' as const;

export interface LibSource {
  type: 'local' | 'llms.txt' | 'website' | 'openapi' | 'git';
  location: string;
}

export interface LibEntry {
  id: string;
  name: string;
  version: string; // cataloged doc version ('*' if unknown)
  source: LibSource;
  docFile: string; // relative to root (.vibgrate/lib/<id>.md)
  docHash: string;
  bytes: number;
}

export interface LibCatalog {
  schemaVersion: typeof LIB_SCHEMA;
  libraries: Record<string, LibEntry>;
}

export function catalogPath(root: string): string {
  return path.join(root, 'vibgrate.lib.json');
}
export function libDir(root: string): string {
  return path.join(root, '.vibgrate', 'lib');
}

export function libId(name: string): string {
  return name.trim().toLowerCase().replace(/^@/, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export function loadCatalog(root: string): LibCatalog {
  const file = catalogPath(root);
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as LibCatalog;
      if (data.schemaVersion === LIB_SCHEMA && data.libraries) return data;
    } catch {
      /* fall through to empty */
    }
  }
  return { schemaVersion: LIB_SCHEMA, libraries: {} };
}

export function saveCatalog(root: string, catalog: LibCatalog): void {
  fs.writeFileSync(catalogPath(root), `${stableStringify(catalog, 2)}\n`);
}

/** Resolve a fuzzy name to a catalog entry (exact id, name, or substring). */
export function resolveLib(catalog: LibCatalog, name: string): LibEntry | undefined {
  const id = libId(name);
  if (catalog.libraries[id]) return catalog.libraries[id];
  const lower = name.toLowerCase();
  const all = Object.values(catalog.libraries);
  return (
    all.find((e) => e.name.toLowerCase() === lower) ??
    all.find((e) => e.id.includes(id) || e.name.toLowerCase().includes(lower))
  );
}

/** The lockfile/manifest version of a dependency, for drift annotation. */
export function installedVersion(root: string, name: string): string | undefined {
  const rec = inventory(root).records.find((r) => r.name === name);
  return rec?.installed ?? rec?.declared;
}

export interface VersionResolution {
  /** The version we serve docs for: lockfile pin → installed tree → declared range. */
  served?: string;
  source: 'lockfile' | 'installed' | 'declared' | 'unknown';
  lockfile?: string;
  installed?: string;
  declared?: string;
  /** Set when the lockfile pin and the installed tree disagree (the dev should fix). */
  mismatch?: { lockfile: string; installed: string; note: string };
}

const stripRange = (v?: string): string | undefined => v?.replace(/^[v^~>=<\s]+/, '');

/**
 * Resolve the version to serve docs for, **lockfile-first**, and detect a
 * lockfile↔installed disagreement (VG-LIB-SUPERSET-PLAN D13 / G8). Precedence:
 * lockfile pin → installed tree → declared range. When both a lockfile pin and an
 * installed version are readable and differ, surface a mismatch the dev should fix —
 * a signal Context7 can't produce (it has no view of your installed tree).
 */
export function resolveVersion(root: string, name: string): VersionResolution {
  const rec = inventory(root).records.find((r) => r.name === name);
  const declared = rec?.declared;
  // npm installed comes from node_modules (via inventory); other ecosystems read their
  // installed tree (Python .dist-info, PHP installed.json) so the mismatch alert applies too.
  const installed = rec?.installed ?? (rec ? installedTreeVersion(root, rec.ecosystem, name) : undefined);
  const lockfile = rec ? lockfileVersion(root, rec.ecosystem, name) : undefined;

  let mismatch: VersionResolution['mismatch'];
  if (lockfile && installed && stripRange(lockfile) !== stripRange(installed)) {
    mismatch = {
      lockfile,
      installed,
      note: `lockfile pins ${lockfile} but the installed tree has ${installed} — your install is out of sync with the lockfile (re-install or commit the lock)`,
    };
  }

  const served = lockfile ?? installed ?? declared;
  const source: VersionResolution['source'] = lockfile
    ? 'lockfile'
    : installed
      ? 'installed'
      : declared
        ? 'declared'
        : 'unknown';
  return { served, source, lockfile, installed, declared, mismatch };
}

export interface DriftNote {
  cataloged: string;
  installed?: string;
  drift: 'current' | 'behind' | 'ahead' | 'unknown';
}

export function driftFor(root: string, entry: LibEntry): DriftNote {
  const installed = installedVersion(root, entry.name);
  if (!installed || entry.version === '*') return { cataloged: entry.version, installed, drift: 'unknown' };
  const norm = (v: string) => v.replace(/^[v^~>=<\s]+/, '');
  const a = norm(entry.version);
  const b = norm(installed);
  if (a === b) return { cataloged: entry.version, installed, drift: 'current' };
  return { cataloged: entry.version, installed, drift: cmp(a, b) < 0 ? 'behind' : 'ahead' };
}

function cmp(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

export interface AddOptions {
  root: string;
  name?: string;
  version?: string;
  /** Allow network for URL/llms.txt sources. */
  allowNetwork?: boolean;
  fetchImpl?: typeof globalThis.fetch;
}

/**
 * Recognise a git source. We treat a source as git when it is unambiguously
 * one: a `git+` scheme prefix, an `scp`-style `git@host:org/repo`, or a URL
 * ending in `.git`. A plain `https://…/docs` stays a website (no `.git`), so the
 * classification is deterministic and never surprises a URL ingest.
 * Returns the clone URL (with any `git+` prefix stripped), or null.
 */
export function parseGitSource(source: string): string | null {
  if (source.startsWith('git+')) return source.slice(4);
  if (/^git@[^:]+:/.test(source)) return source;
  if (/\.git\/?$/.test(source)) return source;
  return null;
}

/** Ingest docs for a library from a local path, a git repo, or (opt-in) a URL. */
export async function addLibrary(source: string, opts: AddOptions): Promise<LibEntry> {
  const { root } = opts;
  let content: string;
  let type: LibSource['type'] = 'local';

  const gitUrl = parseGitSource(source);
  if (gitUrl) {
    if (!opts.allowNetwork) {
      throw new Error(`refusing to clone ${source} without --online (offline by default)`);
    }
    content = cloneAndReadGit(gitUrl);
    type = 'git';
  } else if (/^https?:\/\//.test(source)) {
    if (!opts.allowNetwork) {
      throw new Error(`refusing to fetch ${source} without --online (offline by default)`);
    }
    const res = await (opts.fetchImpl ?? globalThis.fetch)(source);
    if (!res.ok) throw new Error(`fetch failed (${res.status}) for ${source}`);
    content = await res.text();
    type = source.endsWith('llms.txt') ? 'llms.txt' : source.endsWith('.json') ? 'openapi' : 'website';
  } else {
    const abs = path.resolve(root, source);
    if (!fs.existsSync(abs)) throw new Error(`source not found: ${source}`);
    content = readLocal(abs);
    type = 'local';
  }

  const name = opts.name ?? inferName(source);
  const id = libId(name);
  const version = opts.version ?? installedVersion(root, name) ?? '*';

  fs.mkdirSync(libDir(root), { recursive: true });
  const docFileAbs = path.join(libDir(root), `${id}.md`);
  fs.writeFileSync(docFileAbs, content);

  const entry: LibEntry = {
    id,
    name,
    version,
    source: { type, location: source },
    docFile: path.relative(root, docFileAbs).split(path.sep).join('/'),
    docHash: hashString(content),
    bytes: Buffer.byteLength(content, 'utf8'),
  };

  const catalog = loadCatalog(root);
  catalog.libraries[id] = entry;
  saveCatalog(root, catalog);
  return entry;
}

export function readDoc(root: string, entry: LibEntry): string {
  const abs = path.resolve(root, entry.docFile);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
}

export interface LocalDocs {
  docs: string;
  version?: string;
  /** Cited on-disk source, relative to root (e.g. `node_modules/react/README.md`). */
  source: string;
}

/** Find an installed npm package directory, walking up for hoisted `node_modules`. */
function npmPackageDir(root: string, name: string): string | undefined {
  let cur = root;
  for (let i = 0; i < 12; i++) {
    const dir = path.join(cur, 'node_modules', name);
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return undefined;
}

/**
 * Local-first resolution ladder (VG-CONTEXT7-AND-MOAT §10.2 / VG-LIB-SUPERSET-PLAN
 * A.2.3): when a library isn't in the committed catalog, read its docs **from the
 * installed package on disk**, version-correct by construction and offline. Prefers
 * `llms.txt`, then the README, then the package.json description. First slice: npm
 * (`node_modules`); other ecosystems (site-packages, …) follow the same shape.
 */
export function localPackageDocs(root: string, name: string): LocalDocs | undefined {
  const dir = npmPackageDir(root, name);
  if (!dir) return undefined;
  const version = resolveVersion(root, name).served;
  for (const f of ['llms.txt', 'README.md', 'README.mdx', 'README', 'readme.md']) {
    const p = path.join(dir, f);
    try {
      const docs = fs.readFileSync(p, 'utf8');
      if (docs.trim()) {
        return { docs, version, source: path.relative(root, p).split(path.sep).join('/') };
      }
    } catch {
      /* next candidate */
    }
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      description?: string;
      version?: string;
    };
    if (pkg.description?.trim()) {
      return {
        docs: `# ${name}\n\n${pkg.description}`,
        version: version ?? pkg.version,
        source: path.relative(root, path.join(dir, 'package.json')).split(path.sep).join('/'),
      };
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Locate a package's TypeScript declaration entry (`types`/`typings`, else conventional paths). */
function dtsEntry(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      types?: string;
      typings?: string;
    };
    const rel = pkg.types ?? pkg.typings;
    if (typeof rel === 'string') {
      const p = path.join(dir, rel);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* fall through to conventional paths */
  }
  for (const c of ['index.d.ts', 'dist/index.d.ts', 'lib/index.d.ts', 'types/index.d.ts']) {
    const p = path.join(dir, c);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Extract exported declaration signatures from a `.d.ts` source. Declaration files
 * are body-less, so a brace-depth scanner is deterministic and robust: capture each
 * top-level `export …` statement from the keyword through its terminating `;` or
 * matching `}` (skipping `export {…}` / `export *` / `export default` re-exports).
 */
export function extractDtsApi(src: string, maxDecls = 200): string[] {
  const out: string[] = [];
  let depth = 0;
  let capture: string[] | null = null;
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (
      capture === null &&
      depth === 0 &&
      /^export\b/.test(line) &&
      !/^export\s+(\{|\*|default\b|type\s+\{)/.test(line)
    ) {
      capture = [];
    }
    if (capture) capture.push(raw);
    for (const ch of raw) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
    if (capture && depth === 0 && /[;}]\s*$/.test(line)) {
      out.push(capture.join('\n').trim());
      capture = null;
      if (out.length >= maxDecls) break;
    }
  }
  return out;
}

/** Version-correct typed API surface (exported signatures) from a package's `.d.ts`, if present. */
export function localApiSurface(root: string, name: string): string | undefined {
  const dir = npmPackageDir(root, name);
  if (!dir) return undefined;
  const dts = dtsEntry(dir);
  if (!dts) return undefined;
  let src: string;
  try {
    src = fs.readFileSync(dts, 'utf8');
  } catch {
    return undefined;
  }
  const decls = extractDtsApi(src);
  return decls.length ? decls.join('\n\n') : undefined;
}

/** Append the typed API surface (if any) as a fenced section — composed into served docs. */
export function withApiSurface(root: string, name: string, docs: string): string {
  const api = localApiSurface(root, name);
  return api ? `${docs}\n\n## API (types)\n\n\`\`\`ts\n${api}\n\`\`\`\n` : docs;
}

/**
 * Shallow-clone a git repo to a temp dir, read its docs, then remove the clone.
 * Network-touching, so it only runs under `--online` (gated by the caller). The
 * clone is `--depth 1` (no history) and the temp dir is always cleaned up.
 */
function cloneAndReadGit(url: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-lib-git-'));
  try {
    execFileSync('git', ['clone', '--depth', '1', '--quiet', url, dir], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    const detail = err instanceof Error && err.message ? `: ${err.message.split('\n')[0]}` : '';
    throw new Error(`git clone failed for ${url}${detail}`);
  }
  try {
    return readGitDocs(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Read the documentation out of a cloned repo, deterministically: prefer a
 * top-level `docs/` directory, else the root README, else any top-level prose.
 */
function readGitDocs(dir: string): string {
  const docsDir = path.join(dir, 'docs');
  if (fs.existsSync(docsDir) && fs.statSync(docsDir).isDirectory()) return readLocal(docsDir);
  const readme = ['README.md', 'README.mdx', 'README.txt', 'README.rst', 'readme.md']
    .map((f) => path.join(dir, f))
    .find((p) => fs.existsSync(p));
  if (readme) return fs.readFileSync(readme, 'utf8');
  return readLocal(dir);
}

function readLocal(abs: string): string {
  const stat = fs.statSync(abs);
  if (stat.isFile()) return fs.readFileSync(abs, 'utf8');
  // Directory: concatenate markdown/text files deterministically.
  const parts: string[] = [];
  const files = fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(md|mdx|txt|rst)$/i.test(e.name))
    .map((e) => e.name)
    .sort();
  for (const f of files) parts.push(`<!-- ${f} -->\n${fs.readFileSync(path.join(abs, f), 'utf8')}`);
  return parts.join('\n\n');
}

function inferName(source: string): string {
  const cleaned = source.replace(/^git\+/, '').replace(/\.git\/?$/i, '');
  const base = cleaned.replace(/\/+$/, '').split(/[/:]/).pop() ?? cleaned;
  return base.replace(/\.(md|mdx|txt|rst|json)$/i, '').replace(/^llms$/, 'docs');
}
