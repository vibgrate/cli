import * as fs from 'node:fs';
import * as path from 'node:path';
import { serializeGraph } from './serialize.js';
import { renderReport } from './report.js';
import { renderHtml } from './html.js';
import type { VgGraph } from '../schema.js';

/**
 * Write the build artifacts under `.vibgrate/`. `graph.json` is the committable
 * map; `GRAPH_REPORT.md` and `graph.html` are convenience artifacts (volatile —
 * gitignored by default via `vg share`).
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

export function defaultGraphPath(root: string): string {
  return path.join(vibgrateDir(root), 'graph.json');
}

export function writeArtifacts(graph: VgGraph, options: WriteOptions): WrittenArtifacts {
  const dir = vibgrateDir(options.root);
  fs.mkdirSync(dir, { recursive: true });
  ensureVibgrateGitignore(options.root);

  const graphPath = options.graphPath ?? defaultGraphPath(options.root);
  fs.mkdirSync(path.dirname(graphPath), { recursive: true });
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
    const reportPath = path.join(dir, 'GRAPH_REPORT.md');
    fs.writeFileSync(reportPath, renderReport(graph));
    written.reportPath = reportPath;
  }

  if (options.html !== false) {
    const htmlPath = path.join(dir, 'graph.html');
    fs.writeFileSync(htmlPath, renderHtml(graph));
    written.htmlPath = htmlPath;
  }

  // facts.jsonl (deterministic NDJSON) when facts were derived (--deep).
  if (graph.facts && graph.facts.length) {
    const factsPath = path.join(dir, 'facts.jsonl');
    fs.writeFileSync(factsPath, graph.facts.map((f) => JSON.stringify(f)).join('\n') + '\n');
    written.factsPath = factsPath;
  }

  return written;
}
