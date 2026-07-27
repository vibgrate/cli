/**
 * Deterministic package-manifest extraction.
 *
 * Pulls declared dependencies from package.json and go.mod into the code map as
 * `package` nodes + `import` edges to external packages. Complements source-level
 * imports so hubs/impact/ask can see the dependency surface without lockfile noise
 * (lockfiles stay skipped by discover).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { nodeId, edgeId } from './ids.js';
import { SKIP_DIRS } from './discover.js';
import type { GraphEdge, GraphNode } from '../schema.js';

export interface ManifestExtract {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Number of package.json + go.mod files processed. */
  files: number;
  deps: number;
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
  const localId = nodeId({ kind: 'package', qualifiedName: pkgName, file: rel });
  nodes.set(
    localId,
    emptyNode({
      id: localId,
      kind: 'package',
      name: pkgName.includes('/') ? pkgName.split('/').pop()! : pkgName,
      qualifiedName: pkgName,
      file: rel,
      lang: 'json',
    }),
  );

  // Also a file node so the graph links the manifest file itself.
  const fileId = nodeId({ kind: 'file', qualifiedName: rel, file: rel });
  nodes.set(
    fileId,
    emptyNode({
      id: fileId,
      kind: 'file',
      name: path.posix.basename(rel),
      qualifiedName: rel,
      file: rel,
      lang: 'json',
    }),
  );
  addEdge(edges, 'contains', fileId, localId, 1.0);

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

  const localId = nodeId({ kind: 'package', qualifiedName: moduleName, file: rel });
  nodes.set(
    localId,
    emptyNode({
      id: localId,
      kind: 'package',
      name: moduleName.split('/').pop() ?? moduleName,
      qualifiedName: moduleName,
      file: rel,
      lang: 'go',
    }),
  );
  const fileId = nodeId({ kind: 'file', qualifiedName: rel, file: rel });
  nodes.set(
    fileId,
    emptyNode({
      id: fileId,
      kind: 'file',
      name: path.posix.basename(rel),
      qualifiedName: rel,
      file: rel,
      lang: 'go',
    }),
  );
  addEdge(edges, 'contains', fileId, localId, 1.0);

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
      if (SKIP_DIRS.has(entry.name)) continue;
      if (rel && ig.ignores(`${rel}/`)) continue;
      walkManifests(root, abs, ig, found);
    } else if (entry.isFile()) {
      const base = entry.name;
      if (base !== 'package.json' && base !== 'go.mod') continue;
      if (rel && ig.ignores(rel)) continue;
      found.set(rel, abs);
    }
  }
}
