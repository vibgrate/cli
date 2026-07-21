import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { ensureVibgrateGitignore, writeArtifacts } from '../src/engine/artifacts.js';
import { writeNavigationConfig } from '../src/install/registry.js';
import { clearSavings, recordSaving, savingsRecorded, savingsLedgerPath, readSavings } from '../src/engine/savings.js';
import { cacheDir } from '../src/engine/cache.js';
import { makeProject, cleanup } from './helpers.js';
import type { VgGraph } from '../src/schema.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

function project(files: Record<string, string> = {}): string {
  const dir = makeProject(files);
  dirs.push(dir);
  return dir;
}

function gitignorePath(root: string): string {
  return path.join(root, '.vibgrate', '.gitignore');
}

/** Minimal but schema-shaped graph — enough for writeArtifacts to serialize. */
function tinyGraph(): VgGraph {
  return {
    version: 1,
    provenance: { corpusHash: 'x', toolchain: 't', resolver: [] },
    meta: { counts: { nodes: 0, edges: 0, areas: 0 }, languages: [] },
    nodes: [],
    edges: [],
  } as unknown as VgGraph;
}

describe('default .vibgrate/.gitignore', () => {
  it('is created with the volatile artifacts (and graph.json) ignored', () => {
    const root = project();
    ensureVibgrateGitignore(root);
    const lines = fs.readFileSync(gitignorePath(root), 'utf8').split('\n');
    for (const entry of ['.gitignore', 'cache/', 'graph.json', 'graph.html', 'GRAPH_REPORT.md', 'facts.jsonl', 'mcp-navigation.json']) {
      expect(lines).toContain(entry);
    }
    // Committable scanner artifacts must not be ignored by default.
    expect(lines).not.toContain('baseline.json');
    expect(lines).not.toContain('standards.json');
    expect(lines).not.toContain('attestation.intoto.jsonl');
  });

  it('never touches an existing .vibgrate/.gitignore, even an empty one', () => {
    const root = project({ '.vibgrate/.gitignore': '' });
    ensureVibgrateGitignore(root);
    expect(fs.readFileSync(gitignorePath(root), 'utf8')).toBe('');

    fs.writeFileSync(gitignorePath(root), 'mine\n');
    ensureVibgrateGitignore(root);
    expect(fs.readFileSync(gitignorePath(root), 'utf8')).toBe('mine\n');
  });

  it('lands alongside the artifacts on writeArtifacts', () => {
    const root = project();
    writeArtifacts(tinyGraph(), { root, html: false, report: false });
    expect(fs.existsSync(gitignorePath(root))).toBe(true);
  });

  it('lands with the navigation config when `vg install` creates .vibgrate first', () => {
    const root = project();
    writeNavigationConfig(root);
    expect(fs.existsSync(gitignorePath(root))).toBe(true);
    expect(fs.existsSync(path.join(root, '.vibgrate', 'mcp-navigation.json'))).toBe(true);
  });
});

describe('clearSavings', () => {
  it('deletes the ledger and the stats-share state, and is idempotent', () => {
    const root = project();
    recordSaving(root, { tool: 'query_graph', outcome: 'complete', vgTokens: 10, baselineTokens: 400 }, 1000);
    fs.writeFileSync(path.join(cacheDir(root), 'stats-share.json'), '{"offset":42}\n');
    expect(savingsRecorded(root)).toBe(true);

    expect(clearSavings(root)).toBe(true);
    expect(savingsRecorded(root)).toBe(false);
    expect(fs.existsSync(savingsLedgerPath(root))).toBe(false);
    expect(fs.existsSync(path.join(cacheDir(root), 'stats-share.json'))).toBe(false);
    expect(readSavings(root, 30, 2000).queries).toBe(0);

    // Nothing left → false, and no throw.
    expect(clearSavings(root)).toBe(false);
  });

  it('recording works again after a clear', () => {
    const root = project();
    recordSaving(root, { tool: 'query_graph', outcome: 'complete', vgTokens: 10, baselineTokens: 400 }, 1000);
    clearSavings(root);
    recordSaving(root, { tool: 'query_graph', outcome: 'complete', vgTokens: 20, baselineTokens: 800 }, 2000);
    const report = readSavings(root, 30, 2000);
    expect(report.queries).toBe(1);
    expect(report.vgTokens).toBe(20);
  });
});
