import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { TOOLS } from '../src/mcp/tools.js';
import type { VgGraph } from '../src/schema.js';

const tool = TOOLS.find((t) => t.name === 'upgrade_impact')!;
const stubGraph = {} as VgGraph;

function writeArtifact(root: string): void {
  const artifact = {
    schemaVersion: '1.0',
    projects: [
      {
        type: 'node',
        path: '.',
        name: 'app',
        dependencies: [{ package: 'redux', resolvedVersion: '3.7.2', latestStable: '5.0.1', majorsBehind: 2 }],
      },
    ],
    extended: {
      vulnerabilities: {
        source: 'osv',
        totalAdvisories: 1,
        severityCounts: { low: 0, moderate: 0, high: 1, critical: 0, unknown: 0 },
        packages: [
          { ecosystem: 'npm', package: 'redux', version: '3.7.2', advisories: [{ id: 'GHSA-redux', aliases: [], summary: null, severity: 'high', cvss: 7.5, cvssVector: null, fixedVersions: ['4.0.0'], published: null, withdrawn: null, references: [] }] },
        ],
      },
    },
  };
  fs.mkdirSync(path.join(root, '.vibgrate'), { recursive: true });
  fs.writeFileSync(path.join(root, '.vibgrate', 'scan_result.json'), JSON.stringify(artifact));
}

describe('upgrade_impact MCP tool', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmpdir(), 'vg-ui-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('requires a package', async () => {
    expect(((await tool.handler(stubGraph, {}, { root: dir })) as { error: string }).error).toBe('bad_request');
  });

  it('builds an impact brief from the scan artifact + source usage', async () => {
    writeArtifact(dir);
    for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(dir, `c${i}.ts`), `import { createStore } from 'redux';`);

    const res = (await tool.handler(stubGraph, { package: 'redux' }, { root: dir })) as {
      status: string;
      ecosystem: string;
      majorsBehind: number;
      interimMajors: string[];
      blastRadius: string;
      recommendation: string;
      fixesVulnerabilities: string[];
      usage: { filesTouched: number };
      changelog?: unknown;
    };
    expect(res.status).toBe('ok');
    expect(res.ecosystem).toBe('npm');
    expect(res.majorsBehind).toBe(2);
    expect(res.interimMajors).toEqual(['4.x']);
    expect(res.usage.filesTouched).toBe(7);
    expect(res.blastRadius).toBe('high');
    expect(res.recommendation).toBe('multi-major-plan');
    expect(res.fixesVulnerabilities).toEqual(['GHSA-redux']);
    // Changelog is opt-in: absent unless changelog:true is passed.
    expect(res.changelog).toBeUndefined();
  });

  it('skips the online changelog fetch under --local (no network)', async () => {
    writeArtifact(dir);
    const res = (await tool.handler(stubGraph, { package: 'redux', changelog: true }, { root: dir, local: true })) as {
      status: string;
      changelog?: unknown;
    };
    expect(res.status).toBe('ok');
    expect(res.changelog).toBeUndefined();
  });

  it('still returns a version-jump brief without a scan (ecosystem unknown, no usage)', async () => {
    const res = (await tool.handler(stubGraph, { package: 'nothing-here' }, { root: dir })) as {
      status: string;
      ecosystem: string;
      usage: { filesTouched: number };
    };
    expect(res.status).toBe('ok');
    expect(res.ecosystem).toBe('unknown');
    expect(res.usage.filesTouched).toBe(0);
  });
});
