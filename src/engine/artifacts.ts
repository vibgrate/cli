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

export function defaultGraphPath(root: string): string {
  return path.join(vibgrateDir(root), 'graph.json');
}

export function writeArtifacts(graph: VgGraph, options: WriteOptions): WrittenArtifacts {
  const dir = vibgrateDir(options.root);
  fs.mkdirSync(dir, { recursive: true });

  const graphPath = options.graphPath ?? defaultGraphPath(options.root);
  fs.mkdirSync(path.dirname(graphPath), { recursive: true });
  fs.writeFileSync(graphPath, serializeGraph(graph));

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
