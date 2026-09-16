/**
 * Deterministic package-manifest extraction.
 *
 * Pulls declared dependencies from package manifests (package.json, go.mod,
 * pom.xml, .csproj/.vbproj/.sqlproj, pyproject.toml, Cargo.toml) into the
 * code map as `package` nodes + `import` edges to external packages.
 * Complements source-level imports so hubs/impact/ask can see the
 * dependency surface without lockfile noise (lockfiles stay skipped by
 * discover).
 *
 * This is also the sole source of real project boundaries for the
 * architecture map (`index_packages` in the Haile kernel groups everything
 * under one of these `package` nodes, or falls back to a much cruder
 * per-community grouping when none exist). A repo whose manifest kind is
 * missing here — a Maven multi-module repo before pom.xml support landed,
 * for instance — silently loses real project structure everywhere
 * downstream. Add new ecosystems here, not by teaching a *consumer* to
 * paper over their absence.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { XMLParser } from 'fast-xml-parser';
import { nodeId, edgeId } from './ids.js';
import { isSkippedDirName } from './discover.js';
import { parseToml } from '../core-open/utils/toml.js';
import type { GraphEdge, GraphNode } from '../schema.js';

export interface ManifestExtract {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Number of manifest files processed. */
  files: number;
  deps: number;
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function asArray<T>(v: T | T[] | undefined): T[] {
  return Array.isArray(v) ? v : v ? [v] : [];
}

const emptyNode = (
  partial: Pick<GraphNode, 'id' | 'kind' | 'name' | 'qualifiedName' | 'file' | 'lang'> & {
    span?: GraphNode['span'];
  },
): GraphNode => ({
  ...partial,
  span: partial.span ?? { start: 1, end: 1 },
  importance: 0,
  centrality: { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 },
  area: -1,
  isHub: false,
  tested: null,
});

/**
 * Walk the project for package.json / go.mod (respecting the same skip rules as
 * discover) and return package nodes + dependency edges. Pure over filesystem
 * content; stable sort on output.
 */
export function extractManifests(
  root: string,
  opts: { exclude?: string[]; paths?: string[] } = {},
): ManifestExtract {
  const absRoot = path.resolve(root);
  const ig = buildRootIgnore(absRoot, opts.exclude ?? []);
  const scopes = (opts.paths?.length ? opts.paths : ['.'])
    .map((p) => path.resolve(absRoot, p))
    .filter((p) => fs.existsSync(p));

  const found = new Map<string, string>(); // rel → abs
  for (const scope of scopes) {
    walkManifests(absRoot, scope, ig, found);
  }

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  let deps = 0;

  for (const rel of [...found.keys()].sort()) {
    const abs = found.get(rel)!;
    const base = path.posix.basename(rel);
    try {
      if (base === 'package.json') {
        deps += ingestPackageJson(rel, abs, nodes, edges);
      } else if (base === 'go.mod') {
        deps += ingestGoMod(rel, abs, nodes, edges);
      } else if (base === 'pom.xml') {
        deps += ingestPomXml(rel, abs, nodes, edges);
      } else if (isDotnetProjectFile(base)) {
        deps += ingestCsproj(rel, abs, nodes, edges);
      } else if (base === 'pyproject.toml') {
        deps += ingestPyproject(rel, abs, nodes, edges);
      } else if (base === 'Cargo.toml') {
        deps += ingestCargoToml(rel, abs, nodes, edges);
      }
    } catch {
      /* unreadable / invalid — skip */
    }
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) || a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst),
    ),
    files: found.size,
    deps,
  };
}

/**
 * Register a `package` node plus the `file` node for its manifest and the
 * `contains` edge between them — the boilerplate every ecosystem's ingest
 * function needs regardless of how it parses dependencies.
 */
function makePackageNode(
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  opts: { rel: string; qualifiedName: string; displayName: string; lang: string },
): string {
  const localId = nodeId({ kind: 'package', qualifiedName: opts.qualifiedName, file: opts.rel });
  nodes.set(
    localId,
    emptyNode({
      id: localId,
      kind: 'package',
      name: opts.displayName,
      qualifiedName: opts.qualifiedName,
      file: opts.rel,
      lang: opts.lang,
    }),
  );
  const fileId = nodeId({ kind: 'file', qualifiedName: opts.rel, file: opts.rel });
  nodes.set(
    fileId,
    emptyNode({
      id: fileId,
      kind: 'file',
      name: path.posix.basename(opts.rel),
      qualifiedName: opts.rel,
      file: opts.rel,
      lang: opts.lang,
    }),
  );
  addEdge(edges, 'contains', fileId, localId, 1.0);
  return localId;
}

function ingestPackageJson(
  rel: string,
  abs: string,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
): number {
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8')) as {
    name?: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const pkgName = (raw.name && String(raw.name).trim()) || path.posix.dirname(rel) || '.';
  const localId = makePackageNode(nodes, edges, {
    rel,
    qualifiedName: pkgName,
    displayName: pkgName.includes('/') ? pkgName.split('/').pop()! : pkgName,
    lang: 'json',
  });

  let n = 0;
  const depMaps = [raw.dependencies, raw.peerDependencies, raw.optionalDependencies];
  const names = new Set<string>();
  for (const m of depMaps) {
    if (!m || typeof m !== 'object') continue;
    for (const name of Object.keys(m)) {
      if (name) names.add(name);
    }
  }
  for (const name of [...names].sort()) {
    const extId = ensureExternal(nodes, name);
    addEdge(edges, 'import', localId, extId, 1.0);
    n++;
  }
  return n;
}

function ingestGoMod(
  rel: string,
  abs: string,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
): number {
  const text = fs.readFileSync(abs, 'utf8');
  let moduleName = path.posix.dirname(rel) || '.';
  const moduleMatch = /^\s*module\s+(\S+)/m.exec(text);
  if (moduleMatch) moduleName = moduleMatch[1];

  const localId = makePackageNode(nodes, edges, {
    rel,
    qualifiedName: moduleName,
    displayName: moduleName.split('/').pop() ?? moduleName,
    lang: 'go',
  });

  // require blocks and single-line requires (ignore replace/exclude).
  const reqNames = new Set<string>();
  const block = /require\s*\(([\s\S]*?)\)/g;
  let bm: RegExpExecArray | null;
  while ((bm = block.exec(text)) !== null) {
    for (const line of bm[1].split('\n')) {
      const m = /^\s*(\S+)\s+v\S+/.exec(line);
      if (m && !line.trim().startsWith('//')) reqNames.add(m[1]);
    }
  }
  const single = /^\s*require\s+(\S+)\s+v\S+/gm;
  let sm: RegExpExecArray | null;
  while ((sm = single.exec(text)) !== null) reqNames.add(sm[1]);

  let n = 0;
  for (const name of [...reqNames].sort()) {
    const extId = ensureExternal(nodes, name);
    addEdge(edges, 'import', localId, extId, 1.0);
    n++;
  }
  return n;
}

/** `${groupId}:${artifactId}`, Maven's own coordinate format — matches how a reader would look it up. */
function ingestPomXml(
  rel: string,
  abs: string,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
): number {
  const parsed = xml.parse(fs.readFileSync(abs, 'utf8')) as { project?: Record<string, unknown> };
  const project = parsed.project;
  if (!project) return 0;
  const artifactId = String(project.artifactId ?? path.posix.dirname(rel).split('/').pop() ?? 'pom');
  const groupId = typeof project.groupId === 'string' ? project.groupId : undefined;
  const displayName = String((project.name as string | undefined) ?? artifactId);

  const localId = makePackageNode(nodes, edges, {
    rel,
    qualifiedName: groupId ? `${groupId}:${artifactId}` : artifactId,
    displayName,
    lang: 'java',
  });

  const deps = asArray<{ dependency?: unknown }>(project.dependencies as never)
    .flatMap((d) => asArray<Record<string, unknown>>(d?.dependency as never))
    .filter((d): d is Record<string, unknown> => Boolean(d));
  const names = new Set<string>();
  for (const d of deps) {
    const g = typeof d.groupId === 'string' ? d.groupId : '';
    const a = typeof d.artifactId === 'string' ? d.artifactId : '';
    if (g && a) names.add(`${g}:${a}`);
  }
  let n = 0;
  for (const name of [...names].sort()) {
    const extId = ensureExternal(nodes, name);
    addEdge(edges, 'import', localId, extId, 1.0);
    n++;
  }
  return n;
}

const DOTNET_PROJECT_EXTENSIONS = ['.csproj', '.vbproj', '.sqlproj'];

function isDotnetProjectFile(base: string): boolean {
  return DOTNET_PROJECT_EXTENSIONS.some((ext) => base.endsWith(ext));
}

function ingestCsproj(
  rel: string,
  abs: string,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
): number {
  const parsed = xml.parse(fs.readFileSync(abs, 'utf8')) as { Project?: Record<string, unknown> };
  const project = parsed.Project;
  const projectName = path.posix.basename(rel).replace(/\.(cs|vb|sql)proj$/i, '');
  const localId = makePackageNode(nodes, edges, {
    rel,
    qualifiedName: projectName,
    displayName: projectName,
    lang: csprojLang(rel),
  });
  if (!project) return 0;

  const names = new Set<string>();
  for (const ig of asArray<Record<string, unknown>>(project.ItemGroup as never)) {
    for (const ref of asArray<Record<string, unknown>>(ig?.PackageReference as never)) {
      const name = (ref?.['@_Include'] as string | undefined) ?? (ref?.['@_include'] as string | undefined);
      if (name) names.add(String(name));
    }
  }
  let n = 0;
  for (const name of [...names].sort()) {
    const extId = ensureExternal(nodes, name);
    addEdge(edges, 'import', localId, extId, 1.0);
    n++;
  }
  return n;
}

function csprojLang(rel: string): string {
  if (rel.endsWith('.vbproj')) return 'vb';
  if (rel.endsWith('.sqlproj')) return 'sql';
  return 'csharp';
}

function ingestPyproject(
  rel: string,
  abs: string,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
): number {
  const doc = parseToml(fs.readFileSync(abs, 'utf8'));
  if (!doc) return 0;
  const project = (doc.project as Record<string, unknown> | undefined) ?? {};
  const poetry = ((doc.tool as Record<string, unknown> | undefined)?.poetry as Record<string, unknown> | undefined) ?? {};
  const pkgName =
    (typeof project.name === 'string' && project.name) ||
    (typeof poetry.name === 'string' && poetry.name) ||
    path.posix.dirname(rel).split('/').pop() ||
    'pyproject';

  const localId = makePackageNode(nodes, edges, {
    rel,
    qualifiedName: String(pkgName),
    displayName: String(pkgName),
    lang: 'python',
  });

  const names = new Set<string>();
  // PEP 621: dependencies = ["name>=1.0", ...]
  for (const dep of Array.isArray(project.dependencies) ? (project.dependencies as unknown[]) : []) {
    const name = pep508Name(String(dep));
    if (name) names.add(name);
  }
  // Poetry: [tool.poetry.dependencies] name = "^1.0" | { version = "^1.0" }
  const poetryDeps = poetry.dependencies as Record<string, unknown> | undefined;
  if (poetryDeps && typeof poetryDeps === 'object') {
    for (const name of Object.keys(poetryDeps)) {
      if (name && name.toLowerCase() !== 'python') names.add(name);
    }
  }
  let n = 0;
  for (const name of [...names].sort()) {
    const extId = ensureExternal(nodes, name);
    addEdge(edges, 'import', localId, extId, 1.0);
    n++;
  }
  return n;
}

/** The bare distribution name from a PEP 508 requirement string (`"flask>=2.0"` -> `"flask"`). */
function pep508Name(spec: string): string | null {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
  return m ? m[1] : null;
}

function ingestCargoToml(
  rel: string,
  abs: string,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
): number {
  const doc = parseToml(fs.readFileSync(abs, 'utf8'));
  if (!doc) return 0;
  const pkg = (doc.package as Record<string, unknown> | undefined) ?? {};
  const pkgName = (typeof pkg.name === 'string' && pkg.name) || path.posix.dirname(rel).split('/').pop() || 'crate';

  const localId = makePackageNode(nodes, edges, {
    rel,
    qualifiedName: String(pkgName),
    displayName: String(pkgName),
    lang: 'rust',
  });

  const names = new Set<string>();
  for (const section of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
    const deps = doc[section] as Record<string, unknown> | undefined;
    if (deps && typeof deps === 'object') {
      for (const name of Object.keys(deps)) {
        if (name) names.add(name);
      }
    }
  }
  let n = 0;
  for (const name of [...names].sort()) {
    const extId = ensureExternal(nodes, name);
    addEdge(edges, 'import', localId, extId, 1.0);
    n++;
  }
  return n;
}

function isRecognizedManifest(base: string): boolean {
  return (
    base === 'package.json' ||
    base === 'go.mod' ||
    base === 'pom.xml' ||
    base === 'pyproject.toml' ||
    base === 'Cargo.toml' ||
    isDotnetProjectFile(base)
  );
}

function ensureExternal(nodes: Map<string, GraphNode>, name: string): string {
  const id = nodeId({ kind: 'external', qualifiedName: name, file: '' });
  if (!nodes.has(id)) {
    nodes.set(
      id,
      emptyNode({
        id,
        kind: 'external',
        name,
        qualifiedName: name,
        file: '',
        lang: 'external',
      }),
    );
  }
  return id;
}

function addEdge(
  edges: Map<string, GraphEdge>,
  kind: GraphEdge['kind'],
  src: string,
  dst: string,
  confidence: number,
): void {
  if (src === dst) return;
  const id = edgeId(kind, src, dst);
  if (edges.has(id)) return;
  edges.set(id, {
    id,
    kind,
    src,
    dst,
    resolution: 'heuristic',
    confidence,
    epistemic: 'declared',
    count: 1,
  });
}

function buildRootIgnore(root: string, exclude: string[]): Ignore {
  const ig = ignore();
  const gitignorePath = path.join(root, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    try {
      ig.add(fs.readFileSync(gitignorePath, 'utf8'));
    } catch {
      /* ignore */
    }
  }
  if (exclude.length) ig.add(exclude);
  return ig;
}

function walkManifests(
  root: string,
  dir: string,
  ig: Ignore,
  found: Map<string, string>,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (isSkippedDirName(entry.name)) continue;
      if (rel && ig.ignores(`${rel}/`)) continue;
      walkManifests(root, abs, ig, found);
    } else if (entry.isFile()) {
      const base = entry.name;
      if (!isRecognizedManifest(base)) continue;
      if (rel && ig.ignores(rel)) continue;
      found.set(rel, abs);
    }
  }
}
