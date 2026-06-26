import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Dependency currency (VG-LOCAL-MODELS §9 / VG-DEVELOPMENT-PLAN Phase 2.4).
 *
 * Default path is **offline and deterministic**: inventory dependencies from
 * manifests and resolve installed versions from node_modules. Currency against
 * "latest/EOL/CVE" needs data, so it is strictly **opt-in** (`--online`, which
 * queries the public npm registry) — the offline core never touches the network.
 * Full DriftScore/CVE/EOL governance is the Vibgrate platform (the funnel).
 */

/** Supported dependency ecosystems (manifest + lockfile). Extend this list to widen coverage. */
export const ECOSYSTEMS = ['npm', 'pypi', 'go', 'rust', 'ruby', 'php', 'dotnet', 'swift', 'dart', 'java'] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

export interface DepRecord {
  name: string;
  ecosystem: Ecosystem;
  declared: string; // declared range/version
  installed?: string; // resolved installed version (npm)
  latest?: string; // from --online
  drift?: 'major' | 'minor' | 'patch' | 'current' | 'unknown';
}

export interface DriftInventory {
  records: DepRecord[];
  counts: { total: number } & Record<Ecosystem, number>;
}

export function inventory(root: string): DriftInventory {
  const manifests = findManifests(root);
  const records: DepRecord[] = [];
  records.push(...npmDeps(manifests.npm));
  records.push(...pypiDeps(manifests.pypi));
  records.push(...goDeps(manifests.go));
  records.push(...cargoDeps(manifests.rust));
  records.push(...rubyDeps(manifests.ruby));
  records.push(...phpDeps(manifests.php));
  records.push(...dotnetDeps(manifests.dotnet));
  records.push(...swiftDeps(manifests.swift));
  records.push(...dartDeps(manifests.dart));
  records.push(...javaDeps(manifests.java));
  // Dedupe across sub-projects by ecosystem+name (keep first in path order, so a
  // dep used by many packages of a monorepo counts once). Deterministic.
  const seen = new Set<string>();
  const deduped = records.filter((r) => {
    const key = `${r.ecosystem}\0${r.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name));
  const counts = { total: deduped.length } as DriftInventory['counts'];
  for (const e of ECOSYSTEMS) counts[e] = 0;
  for (const r of deduped) counts[r.ecosystem]++;
  return { records: deduped, counts };
}

/** Directories never worth descending into when hunting for manifests. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.vibgrate', 'vendor',
  '.venv', 'venv', 'env', '__pycache__', 'target', '.next', '.nuxt', 'coverage', '.cache',
]);

type ManifestSet = Record<Ecosystem, string[]>;

/** Exact-name manifest → ecosystem. `.csproj`/`.fsproj` are matched by extension below. */
const MANIFEST_BY_FILE: Record<string, Ecosystem> = {
  'package.json': 'npm',
  'requirements.txt': 'pypi',
  'pyproject.toml': 'pypi',
  'go.mod': 'go',
  'Cargo.toml': 'rust',
  Gemfile: 'ruby',
  'composer.json': 'php',
  'Package.swift': 'swift',
  'pubspec.yaml': 'dart',
  'pom.xml': 'java',
  'build.gradle': 'java',
  'build.gradle.kts': 'java',
};

/**
 * Walk the tree (bounded depth/count, skipping build/vendor dirs) for dependency
 * manifests — so a polyglot monorepo with nested manifests is inventoried, not just
 * the repo root. Results are path-sorted for determinism.
 */
function findManifests(root: string): ManifestSet {
  const set = Object.fromEntries(ECOSYSTEMS.map((e) => [e, [] as string[]])) as ManifestSet;
  const MAX_ENTRIES = 20000;
  let scanned = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || scanned > MAX_ENTRIES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      scanned++;
      if (scanned > MAX_ENTRIES) break;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
        continue;
      }
      const eco = MANIFEST_BY_FILE[e.name] ?? (/\.(cs|fs)proj$/i.test(e.name) ? 'dotnet' : undefined);
      if (eco) set[eco].push(path.join(dir, e.name));
    }
  };
  walk(root, 0);
  for (const e of ECOSYSTEMS) set[e].sort();
  return set;
}

function npmDeps(files: string[]): DepRecord[] {
  const out: DepRecord[] = [];
  for (const file of files) {
    let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const dir = path.dirname(file);
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, declared] of Object.entries(all)) {
      out.push({ name, ecosystem: 'npm', declared, installed: installedNpmVersion(dir, name) });
    }
  }
  return out;
}

/** Resolve an installed version from the nearest node_modules at or above `dir`. */
function installedNpmVersion(dir: string, name: string): string | undefined {
  let cur = dir;
  for (let i = 0; i < 12; i++) {
    const p = path.join(cur, 'node_modules', name, 'package.json');
    try {
      return (JSON.parse(fs.readFileSync(p, 'utf8')) as { version: string }).version;
    } catch {
      /* keep climbing */
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return undefined;
}

/**
 * Resolve the *installed-tree* version for ecosystems whose installed metadata lives
 * outside `node_modules` (npm is handled inline above). Powers the lockfile↔installed
 * mismatch alert (D13 / G8) for Python and PHP. Returns undefined when not found —
 * never a fabricated version.
 */
export function installedTreeVersion(root: string, ecosystem: Ecosystem, name: string): string | undefined {
  if (ecosystem === 'pypi') return installedPypiVersion(root, name);
  if (ecosystem === 'php') return installedPhpVersion(root, name);
  return undefined;
}

function normalizePep503(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, '-');
}

/** Candidate site-packages dirs inside a venv (POSIX `lib/pythonX.Y/...` + Windows `Lib/...`). */
function sitePackagesDirs(base: string): string[] {
  const out: string[] = [];
  try {
    for (const d of fs.readdirSync(path.join(base, 'lib'))) {
      if (d.startsWith('python')) out.push(path.join(base, 'lib', d, 'site-packages'));
    }
  } catch {
    /* no lib dir */
  }
  out.push(path.join(base, 'Lib', 'site-packages'));
  return out;
}

/** Python: a `<Name>-<Version>.dist-info` dir in a project venv's site-packages. */
function installedPypiVersion(root: string, name: string): string | undefined {
  const target = normalizePep503(name);
  for (const venv of ['.venv', 'venv', 'env', '.tox']) {
    for (const sp of sitePackagesDirs(path.join(root, venv))) {
      let entries: string[];
      try {
        entries = fs.readdirSync(sp);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const m = /^(.+?)-(\d[^-]*)\.dist-info$/.exec(entry);
        if (m && normalizePep503(m[1]) === target) return m[2];
      }
    }
  }
  return undefined;
}

/** PHP: `vendor/composer/installed.json` (newer `{packages:[…]}` or older root array). */
function installedPhpVersion(root: string, name: string): string | undefined {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(path.join(root, 'vendor', 'composer', 'installed.json'), 'utf8'));
  } catch {
    return undefined;
  }
  const pkgs = Array.isArray(data) ? data : (data as { packages?: unknown }).packages;
  if (!Array.isArray(pkgs)) return undefined;
  const p = pkgs.find((x) => x && typeof x === 'object' && (x as { name?: string }).name === name) as
    | { version?: string }
    | undefined;
  return typeof p?.version === 'string' ? p.version.replace(/^v/, '') : undefined;
}

function pypiDeps(files: string[]): DepRecord[] {
  const byName = new Map<string, DepRecord>();
  const add = (name: string, declared: string) => {
    const clean = name.trim().replace(/\[.*\]$/, ''); // drop extras: fastapi[all] → fastapi
    if (!clean || clean.toLowerCase() === 'python') return;
    if (!byName.has(clean)) byName.set(clean, { name: clean, ecosystem: 'pypi', declared: declared.trim() || '*' });
  };

  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (path.basename(file) === 'requirements.txt') {
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#') || t.startsWith('-')) continue;
        const m = /^([A-Za-z0-9._-]+(?:\[[^\]]*\])?)\s*([<>=!~).*]+.*)?$/.exec(t);
        if (m) add(m[1], m[2] ?? '*');
      }
    } else {
      // pyproject.toml — PEP 621 [project].dependencies + Poetry [tool.poetry.dependencies]
      for (const dep of pep621Dependencies(text)) {
        const m = /^([A-Za-z0-9._-]+(?:\[[^\]]*\])?)\s*(.*)$/.exec(dep.trim());
        if (m) add(m[1], m[2] ?? '*');
      }
      for (const [name, spec] of poetryDependencies(text)) add(name, spec);
    }
  }

  return [...byName.values()];
}

/** Extract the quoted entries of the PEP 621 `[project] dependencies = [...]` array. */
function pep621Dependencies(text: string): string[] {
  const section = sectionBody(text, 'project');
  if (!section) return [];
  const start = /dependencies\s*=\s*\[/.exec(section);
  if (!start) return [];
  // Scan from the opening `[` to its matching `]` at depth 0, respecting strings
  // (so a `]` inside an entry like "pydantic[email]" doesn't end the array early).
  let depth = 0;
  let inStr = false;
  let strCh = '';
  const out: string[] = [];
  let cur = '';
  for (let i = start.index + start[0].length - 1; i < section.length; i++) {
    const ch = section[i];
    if (inStr) {
      if (ch === strCh) {
        out.push(cur);
        inStr = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strCh = ch;
      cur = '';
    } else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  return out;
}

/** Extract `name = "spec"` lines from Poetry dependency tables. */
function poetryDependencies(text: string): [string, string][] {
  const out: [string, string][] = [];
  const lines = text.split('\n');
  let inDeps = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inDeps = /^\[tool\.poetry(\.group\.[^.\]]+)?\.dependencies\]$/.test(line);
      continue;
    }
    if (!inDeps || !line || line.startsWith('#')) continue;
    const m = /^([A-Za-z0-9._-]+)\s*=\s*["']([^"']*)["']/.exec(line);
    if (m) out.push([m[1], m[2] || '*']);
  }
  return out;
}

/** The text of a top-level TOML table `[name]` up to the next top-level table. */
function sectionBody(text: string, name: string): string | null {
  const lines = text.split('\n');
  let capturing = false;
  const body: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\[/.test(line)) {
      if (capturing) break;
      capturing = line === `[${name}]`;
      continue;
    }
    if (capturing) body.push(raw);
  }
  return capturing || body.length ? body.join('\n') : null;
}

function goDeps(files: string[]): DepRecord[] {
  const out: DepRecord[] = [];
  for (const mod of files) {
    let text: string;
    try {
      text = fs.readFileSync(mod, 'utf8');
    } catch {
      continue;
    }
    // Handles both block form (`require (\n  mod v1.2.3\n)`) and single-line
    // `require mod v1.2.3` by allowing an optional leading `require`.
    const re = /^\s*(?:require\s+)?([\w./-]+)\s+v(\S+)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[1] === 'go' || m[1] === 'require' || m[1].startsWith('module')) continue;
      out.push({ name: m[1], ecosystem: 'go', declared: `v${m[2]}` });
    }
  }
  return out;
}

/**
 * Parse `Cargo.toml` dependency tables for declared versions. Handles the inline
 * forms `name = "1.0"` and `name = { version = "1.0", … }` in `[dependencies]`,
 * `[dev-dependencies]`, and `[build-dependencies]`. The `[dependencies.foo]`
 * subtable form is a follow-up (rare in practice); exact pins come from Cargo.lock.
 */
function cargoDeps(files: string[]): DepRecord[] {
  const out: DepRecord[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const table of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
      const body = sectionBody(text, table);
      if (!body) continue;
      for (const raw of body.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const m = /^([A-Za-z0-9._-]+)\s*=\s*(.+)$/.exec(line);
        if (!m) continue;
        const rhs = m[2].trim();
        let declared = '*';
        if (rhs.startsWith('"')) {
          const sm = /^"([^"]+)"/.exec(rhs);
          if (sm) declared = sm[1];
        } else if (rhs.startsWith('{')) {
          const vm = /version\s*=\s*"([^"]+)"/.exec(rhs);
          if (vm) declared = vm[1];
        }
        out.push({ name: m[1], ecosystem: 'rust', declared });
      }
    }
  }
  return out;
}

/** Ruby `Gemfile`: `gem "name", "~> 1.2"` (version constraint optional). */
function rubyDeps(files: string[]): DepRecord[] {
  const out: DepRecord[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const re = /^\s*gem\s+["']([^"']+)["']\s*(?:,\s*["']([^"']+)["'])?/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push({ name: m[1], ecosystem: 'ruby', declared: m[2] ?? '*' });
  }
  return out;
}

/** PHP `composer.json`: `require`/`require-dev` maps; skip `php` and `ext-*` platform reqs. */
function phpDeps(files: string[]): DepRecord[] {
  const out: DepRecord[] = [];
  for (const file of files) {
    let pkg: { require?: Record<string, string>; 'require-dev'?: Record<string, string> };
    try {
      pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const all = { ...pkg.require, ...pkg['require-dev'] };
    for (const [name, declared] of Object.entries(all)) {
      if (!name.includes('/')) continue; // platform reqs (php, ext-*, lib-*) have no vendor/
      out.push({ name, ecosystem: 'php', declared });
    }
  }
  return out;
}

/** .NET `*.csproj`/`*.fsproj`: `<PackageReference Include="X" Version="Y" />` (attr order tolerant). */
function dotnetDeps(files: string[]): DepRecord[] {
  const out: DepRecord[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const tagRe = /<PackageReference\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(text))) {
      const inc = /Include\s*=\s*"([^"]+)"/i.exec(m[0]);
      if (!inc) continue;
      const ver = /Version\s*=\s*"([^"]+)"/i.exec(m[0]);
      out.push({ name: inc[1], ecosystem: 'dotnet', declared: ver?.[1] ?? '*' });
    }
  }
  return out;
}

/**
 * Swift `Package.swift`: `.package(url: "…/swift-nio.git", from: "2.0.0")`. The crate
 * name is derived from the URL's last path segment (matching Package.resolved's
 * `identity`); the declared version is the first version-looking literal after the url.
 */
function swiftDeps(files: string[]): DepRecord[] {
  const out: DepRecord[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const re = /\.package\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const win = text.slice(m.index, m.index + 200);
      const urlM = /url:\s*"([^"]+)"/.exec(win);
      if (!urlM) continue;
      const name = (urlM[1].replace(/\.git$/, '').split('/').filter(Boolean).pop() ?? urlM[1]).toLowerCase();
      const verM = /"(\d+\.\d+(?:\.\d+)?)"/.exec(win.slice(urlM.index + urlM[0].length));
      out.push({ name, ecosystem: 'swift', declared: verM?.[1] ?? '*' });
    }
  }
  return out;
}

/** Dart `pubspec.yaml`: `dependencies:` / `dev_dependencies:` blocks of `name: ^1.2.3`. */
function dartDeps(files: string[]): DepRecord[] {
  const out: DepRecord[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let section = '';
    for (const raw of text.split('\n')) {
      const top = /^([a-z_]+):\s*$/.exec(raw);
      if (top) {
        section = top[1];
        continue;
      }
      if (section !== 'dependencies' && section !== 'dev_dependencies') continue;
      const m = /^  ([A-Za-z0-9_.]+):\s*(\S.*)?$/.exec(raw);
      if (!m || m[1] === 'flutter' || m[1] === 'sdk') continue;
      const declared = (m[2] ?? '').replace(/^["']|["']$/g, '').trim() || '*';
      out.push({ name: m[1], ecosystem: 'dart', declared });
    }
  }
  return out;
}

/**
 * Java: Maven `pom.xml` (`<dependency>` blocks) and Gradle `build.gradle(.kts)`
 * (`implementation "g:a:v"`). Name is `groupId:artifactId`. Maven has no standard
 * lockfile, so the served version is the pom-declared one; Gradle pins come from
 * `gradle.lockfile`. A `${property}` Maven version is recorded as `*` (unresolved).
 */
function javaDeps(files: string[]): DepRecord[] {
  const out: DepRecord[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (path.basename(file) === 'pom.xml') {
      for (const block of text.match(/<dependency>[\s\S]*?<\/dependency>/g) ?? []) {
        const g = /<groupId>([^<]+)<\/groupId>/.exec(block);
        const a = /<artifactId>([^<]+)<\/artifactId>/.exec(block);
        if (!g || !a) continue;
        const v = /<version>([^<]+)<\/version>/.exec(block);
        const declared = v ? (v[1].trim().startsWith('${') ? '*' : v[1].trim()) : '*';
        out.push({ name: `${g[1].trim()}:${a[1].trim()}`, ecosystem: 'java', declared });
      }
    } else {
      const re = /(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|annotationProcessor)\s*[(]?\s*["']([\w.-]+):([\w.-]+):([^"']+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) out.push({ name: `${m[1]}:${m[2]}`, ecosystem: 'java', declared: m[3] });
    }
  }
  return out;
}

/** Opt-in online enrichment: query npm for `latest` and classify drift. */
export async function enrichOnline(records: DepRecord[], fetchImpl = globalThis.fetch): Promise<void> {
  for (const r of records) {
    if (r.ecosystem !== 'npm' || !r.installed) continue;
    try {
      const res = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(r.name)}/latest`);
      if (!res.ok) continue;
      const data = (await res.json()) as { version?: string };
      r.latest = data.version;
      r.drift = classify(r.installed, r.latest);
    } catch {
      r.drift = 'unknown';
    }
  }
}

function classify(installed: string, latest?: string): DepRecord['drift'] {
  if (!latest) return 'unknown';
  const a = installed.split('.').map(Number);
  const b = latest.split('.').map(Number);
  if (a[0] !== b[0]) return 'major';
  if (a[1] !== b[1]) return 'minor';
  if (a[2] !== b[2]) return 'patch';
  return 'current';
}
