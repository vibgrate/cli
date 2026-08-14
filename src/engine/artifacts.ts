import * as fs from 'node:fs';
import * as path from 'node:path';
import { serializeGraph } from './serialize.js';
import { mapFileExists, snapshotPathFor, writeGraphSnapshot } from './snapshot.js';
import { renderReport } from './report.js';
import { renderHtml } from './html.js';
import { globalGraphPath, globalGraphPathForRef, repositoryStoreDir } from '../runtime/paths.js';
import { deleteTagsSidecarFor } from './relevance-enrich.js';
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
    if (mapFileExists(branchPath)) return branchPath;
  }
  const globalPath = globalGraphPath(root, 'current', env);
  if (mapFileExists(globalPath)) return globalPath;
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
  '# Created by vg — local graph artifacts stay out of git by default.',
  '# Run `vg share` to commit the map for your team (it rewrites this file).',
  '# vg appends newly-introduced local artifacts to this list while this',
  '# header line stays; remove the header (or empty the file) to manage the',
  '# ignores yourself and vg will never touch it again.',
  '.gitignore',
  'cache/',
  'graph.json',
  'graph.snap',
  'graph.tags.snap',
  // Binary semantic index next to the map (never model-named; never under cache/).
  'embeddings',
  'graph.html',
  'GRAPH_REPORT.md',
  'facts.jsonl',
  'mcp-navigation.json',
  // Machine-local telemetry the LSP/`vg code` accrue over time — never meant
  // for git: score-history.jsonl is per-machine trend data (lsp/score-history.ts),
  // run-outcomes.jsonl is per-machine agent-run telemetry (code/run-outcome.ts).
  // Neither is a snapshot artifact like scan_result.json/baseline.json, which
  // are intentionally left out of this list for a user to commit if they choose.
  'score-history.jsonl',
  'run-outcomes.jsonl',
  // Standing approval rules are one developer's consent — sharing them via git
  // would silently grant their "Always allow" decisions to every teammate's
  // agent runs (code/approvals.ts).
  'code-approvals.json',
  // Isolated worktree checkouts for VG Code worktree sessions — full working
  // copies that must never be committed into the repository that hosts them
  // (code/worktree-session.ts).
  'worktrees',
];

/** Marks a .vibgrate/.gitignore as vg-authored (safe to keep current). */
const GITIGNORE_MARKER = /^# Created (once )?by vg\b/;

export function ensureVibgrateGitignore(root: string): void {
  const file = path.join(vibgrateDir(root), '.gitignore');
  fs.mkdirSync(vibgrateDir(root), { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `${DEFAULT_GITIGNORE.join('\n')}\n`);
    return;
  }
  // A vg-authored .gitignore written before an entry joined DEFAULT_GITIGNORE
  // would keep tracking the newer machine-local files (e.g.
  // code-approvals.json — one developer's consent must not ride into the team
  // repo), so vg keeps ITS OWN file current: entries are appended while the
  // vg header is present. A file without the header — including an emptied
  // one — is the user's, and is never touched (the documented opt-out).
  const existing = fs.readFileSync(file, 'utf8');
  if (!GITIGNORE_MARKER.test(existing.split(/\r?\n/, 1)[0] ?? '')) return;
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = DEFAULT_GITIGNORE.filter((entry) => !entry.startsWith('#') && !have.has(entry));
  if (missing.length) {
    fs.writeFileSync(file, `${existing.replace(/\n*$/, '\n')}${missing.join('\n')}\n`);
  }
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

  // Global-store maps are machine-consumed only, so the snapshot IS the map
  // there — skipping the pretty-JSON serialize is the bulk of the write cost
  // on large repos. Everywhere a human (or git) can see the file — legacy
  // in-repo layout, VIBGRATE_GRAPH_IN_REPO, `vg share`, an explicit --graph
  // path — the canonical graph.json is still written, with the snapshot as a
  // sidecar cache.
  const storeMode = isPathInside(graphPath, repositoryStoreDir(options.root));

  // A (re)written graph at this path is a NEW graph: drop the relevance-tags
  // sidecar bound to the previous content so nothing stale can outlive its
  // graph (the sidecar would also self-invalidate via corpusHash, but a
  // removed/replaced graph must take its derived artifacts with it).
  deleteTagsSidecarFor(graphPath);

  if (storeMode) {
    if (!writeGraphSnapshot(graphPath, graph, { standalone: true })) {
      // Store not writable for the binary — fall back to the JSON write below
      // rather than losing the build.
    } else {
      // Drop any JSON left by an older CLI at this path so a downgrade can
      // never silently serve a stale map from beside a newer snapshot.
      fs.rmSync(graphPath, { force: true });
    }
  }

  if (!storeMode || !fs.existsSync(snapshotPathFor(graphPath))) {
    // Atomic write (temp + rename): `vg serve` hot-reloads the map on mtime
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
    // Binary sidecar cache for fast loads; best-effort, JSON stays canonical.
    writeGraphSnapshot(graphPath, graph);
  }

  const written: WrittenArtifacts = {
    graphPath: storeMode && !fs.existsSync(graphPath) ? snapshotPathFor(graphPath) : graphPath,
  };

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
