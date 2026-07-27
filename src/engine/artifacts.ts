import * as fs from 'node:fs';
import * as path from 'node:path';
import { serializeGraph } from './serialize.js';
import { renderReport } from './report.js';
import { renderHtml } from './html.js';
import { globalGraphPath, globalGraphPathForRef, repositoryStoreDir } from '../runtime/paths.js';
import { detectGitRef } from '../runtime/git-ref.js';
import type { VgGraph } from '../schema.js';

/**
 * Graph artifact layout (Fusion Runtime Phase 1).
 *
 * By default the code map lives in the **global** application store
 * (XDG / Application Support), keyed by repository id — not inside the repo.
 * That keeps `vg` / `vg serve` / auto-refresh from dirtying the working tree.
 *
 * Legacy in-repo path `.vibgrate/graph.json` is still **read** when present
 * (migration), and is still the write target when:
 *   - `VIBGRATE_GRAPH_IN_REPO=1` (or true/yes), or
 *   - callers pass an explicit `graphPath` / `--graph`.
 *
 * `vg share` continues to opt into a committed in-repo map by writing under
 * `.vibgrate/` (and rewriting its gitignore).
 */

export interface WriteOptions {
  root: string;
  html?: boolean; // default true
  report?: boolean; // default true
  graphPath?: string; // override graph.json path
}

export interface WrittenArtifacts {
  graphPath: string;
  reportPath?: string;
  htmlPath?: string;
  factsPath?: string;
}

export function vibgrateDir(root: string): string {
  return path.join(root, '.vibgrate');
}

/** Historical in-repo map path (still read as a fallback). */
export function legacyGraphPath(root: string): string {
  return path.join(vibgrateDir(root), 'graph.json');
}

/**
 * When true, default writes go to `.vibgrate/graph.json` (pre–Phase-1 layout).
 * Useful for CI that asserts in-repo artifacts, and for `vg share` workflows.
 */
export function preferInRepoGraph(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.VIBGRATE_GRAPH_IN_REPO?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Default **write** path for the map. Global store unless the operator opts
 * into the legacy in-repo layout. When git is available, prefer a
 * branch-keyed snapshot (Fusion §4.1.1) so switching branches does not
 * overwrite another ref's on-disk map.
 */
export function defaultGraphPath(root: string, env: NodeJS.ProcessEnv = process.env): string {
  if (preferInRepoGraph(env)) return legacyGraphPath(root);
  const { ref, kind } = detectGitRef(root);
  if (kind !== 'none' && ref) return globalGraphPathForRef(root, ref, env);
  return globalGraphPath(root, 'current', env);
}

/**
 * Resolve where to **read** the map from.
 * Order: explicit override → legacy in-repo when `VIBGRATE_GRAPH_IN_REPO` is set
 * → branch-keyed global (if on a git ref) → `current` global snapshot →
 * legacy in-repo → default write path.
 *
 * The in-repo env short-circuit matters for CI and the release benchmark: they
 * force portable `.vibgrate/graph.json` artifacts and must not pay a synchronous
 * `git rev-parse` (or prefer a leftover global snapshot) on every resolve.
 */
export function resolveGraphPath(root: string, override?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (override?.trim()) return path.resolve(override.trim());
  if (preferInRepoGraph(env)) {
    const legacy = legacyGraphPath(root);
    if (fs.existsSync(legacy)) return legacy;
    return legacy;
  }
  const { ref, kind } = detectGitRef(root);
  if (kind !== 'none' && ref) {
    const branchPath = globalGraphPathForRef(root, ref, env);
    if (fs.existsSync(branchPath)) return branchPath;
  }
  const globalPath = globalGraphPath(root, 'current', env);
  if (fs.existsSync(globalPath)) return globalPath;
  const legacy = legacyGraphPath(root);
  if (fs.existsSync(legacy)) return legacy;
  return defaultGraphPath(root, env);
}

/**
 * By default the graph artifacts are *local*: builds and auto-refreshes rewrite
 * them constantly, and without an ignore file every `vg ask`/`vg serve` leaves
 * the branch dirty (untracked or modified `.vibgrate/` files) — irritating for
 * humans and a source of junk commits from AI agents. So the first time vg
 * writes into `.vibgrate/` it also drops a `.gitignore` covering the graph
 * artifacts, the cache, and itself.
 *
 * Deliberately create-once: an existing `.vibgrate/.gitignore` is NEVER
 * touched, whatever its content — `vg share` owns it after opt-in (rewritten to
 * commit `graph.json`), and a user-managed file (even an empty one) is theirs.
 * Scanner artifacts meant for git (`baseline.json`, `standards.json`,
 * `attestation.intoto.jsonl`) are intentionally not listed.
 *
 * With the global store default, this gitignore is only created when something
 * is still written under `.vibgrate/` (in-repo mode or other in-repo writers).
 */
const DEFAULT_GITIGNORE = [
  '# Created once by vg — local graph artifacts stay out of git by default.',
  '# Run `vg share` to commit the map for your team (it rewrites this file).',
  '# vg never touches an existing .vibgrate/.gitignore: edit it (or leave it',
  '# empty) to manage these ignores yourself.',
  '.gitignore',
  'cache/',
  'graph.json',
  'graph.html',
  'GRAPH_REPORT.md',
  'facts.jsonl',
  'mcp-navigation.json',
];

export function ensureVibgrateGitignore(root: string): void {
  const file = path.join(vibgrateDir(root), '.gitignore');
  if (fs.existsSync(file)) return;
  fs.mkdirSync(vibgrateDir(root), { recursive: true });
  fs.writeFileSync(file, `${DEFAULT_GITIGNORE.join('\n')}\n`);
}

/**
 * Directory for companion artifacts (report, html, facts) next to the map.
 * Global maps → repository store root; in-repo maps → `.vibgrate/`.
 */
export function companionArtifactDir(root: string, graphPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const resolved = path.resolve(graphPath);
  const legacy = path.resolve(legacyGraphPath(root));
  if (resolved === legacy) return vibgrateDir(root);
  const globalDefault = path.resolve(globalGraphPath(root, 'current', env));
  if (resolved === globalDefault) return repositoryStoreDir(root, env);
  // Custom --graph: keep companions next to the map file.
  return path.dirname(resolved);
}

export function writeArtifacts(graph: VgGraph, options: WriteOptions): WrittenArtifacts {
  const graphPath = options.graphPath ?? defaultGraphPath(options.root);
  const companions = companionArtifactDir(options.root, graphPath);
  const inRepo = isPathInside(companions, options.root) || isPathInside(graphPath, options.root);

  fs.mkdirSync(path.dirname(graphPath), { recursive: true });
  fs.mkdirSync(companions, { recursive: true });

  // Only drop `.vibgrate/.gitignore` when we still touch the in-repo layout.
  if (inRepo && isPathInside(companions, vibgrateDir(options.root))) {
    ensureVibgrateGitignore(options.root);
  } else if (path.resolve(graphPath) === path.resolve(legacyGraphPath(options.root))) {
    ensureVibgrateGitignore(options.root);
  }

  // Atomic write (temp + rename): `vg serve` hot-reloads graph.json on mtime
  // change, so a rebuild — including its own in-process auto-refresh — must
  // never expose a half-written file to a concurrent reader.
  const tmp = `${graphPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, serializeGraph(graph));
    fs.renameSync(tmp, graphPath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }

  const written: WrittenArtifacts = { graphPath };

  if (options.report !== false) {
    const reportPath = path.join(companions, 'GRAPH_REPORT.md');
    fs.writeFileSync(reportPath, renderReport(graph));
    written.reportPath = reportPath;
  }

  if (options.html !== false) {
    const htmlPath = path.join(companions, 'graph.html');
    fs.writeFileSync(htmlPath, renderHtml(graph));
    written.htmlPath = htmlPath;
  }

  // facts.jsonl (deterministic NDJSON) when facts were derived.
  if (graph.facts && graph.facts.length) {
    const factsPath = path.join(companions, 'facts.jsonl');
    fs.writeFileSync(factsPath, graph.facts.map((f) => JSON.stringify(f)).join('\n') + '\n');
    written.factsPath = factsPath;
  }

  return written;
}

function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
