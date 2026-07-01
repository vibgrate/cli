import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { attributedInventory } from '../src/mcp/attribution.js';
import { TOOLS } from '../src/mcp/tools.js';
import { buildProgram } from '../src/cli.js';
import type { VgGraph } from '../src/schema.js';
import type { VulnerabilityScanResult } from '../src/core-open/index.js';

function gitInstalled(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const HAS_GIT = gitInstalled();
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
};
function git(cwd: string, args: string[], date?: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...IDENTITY, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } });
}
function npmLock(deps: Record<string, string>): string {
  const packages: Record<string, unknown> = { '': { name: 'fix' } };
  for (const [n, v] of Object.entries(deps)) packages[`node_modules/${n}`] = { version: v };
  return JSON.stringify({ lockfileVersion: 3, packages });
}
function commit(dir: string, file: string, content: string, msg: string, date: string): void {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, ['add', file]);
  git(dir, ['commit', '-m', msg], date);
}

describe('vg why is registered', () => {
  it('exposes a `why` subcommand', () => {
    expect(buildProgram().commands.map((c) => c.name())).toContain('why');
  });
});

describe.skipIf(!HAS_GIT)('attributedInventory (check_drift attribution)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmpdir(), 'vg-attr-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds who-added / current-version attribution for npm deps', async () => {
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { lodash: '^4.17.20' } }));
    git(dir, ['add', 'package.json']);
    commit(dir, 'package-lock.json', npmLock({ lodash: '4.17.20' }), 'add lodash', '2021-01-01T00:00:00Z');
    commit(dir, 'package-lock.json', npmLock({ lodash: '4.17.21' }), 'bump lodash', '2022-01-01T00:00:00Z');

    const off = await attributedInventory(dir, {});
    expect(off.attribution).toBe('off');

    const on = await attributedInventory(dir, { attribute: true });
    expect(on.attribution).toBe('git');
    const lodash = on.records.find((r) => r.name === 'lodash');
    expect(lodash?.addedBy?.author).toBe('Ada');
    expect(lodash?.addedBy?.date.slice(0, 4)).toBe('2021');
    expect(lodash?.currentVersionBy?.date.slice(0, 4)).toBe('2022');
  });
});

describe('vuln_attribution MCP tool', () => {
  let dir: string;
  const tool = TOOLS.find((t) => t.name === 'vuln_attribution')!;
  const stubGraph = {} as VgGraph;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmpdir(), 'vg-vattr-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns not_scanned without an artifact', () => {
    expect((tool.handler(stubGraph, {}, { root: dir }) as { status: string }).status).toBe('not_scanned');
  });

  it('surfaces CRA metrics and introduction attribution from the artifact', () => {
    const vulnerabilities: VulnerabilityScanResult = {
      source: 'osv',
      totalAdvisories: 1,
      severityCounts: { low: 0, moderate: 0, high: 0, critical: 1, unknown: 0 },
      cra: { openCount: 1, openBySeverity: { low: 0, moderate: 0, high: 0, critical: 1, unknown: 0 }, slaDays: { low: 180, moderate: 90, high: 30, critical: 7, unknown: null }, slaBreaches: 1, maxOpenExposureDays: 400, meanOpenExposureDays: 400, attributedCount: 1 },
      packages: [
        {
          ecosystem: 'npm',
          package: 'lodash',
          version: '4.17.20',
          advisories: [
            { id: 'GHSA-x', aliases: ['CVE-2021-1'], summary: null, severity: 'critical', cvss: 9.8, cvssVector: null, fixedVersions: ['4.17.21'], published: null, withdrawn: null, references: [], exposureDays: 400, introduced: { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', authorName: 'Ada', authorEmail: 'ada@example.com', date: '2021-01-01T00:00:00Z', subject: 'add lodash' } },
          ],
        },
      ],
    };
    fs.mkdirSync(path.join(dir, '.vibgrate'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.vibgrate', 'scan_result.json'), JSON.stringify({ schemaVersion: '1.0', extended: { vulnerabilities } }));

    const res = tool.handler(stubGraph, {}, { root: dir }) as {
      status: string;
      cra: { slaBreaches: number } | null;
      packages: Array<{ advisories: Array<{ introduced: { authorName: string } | null; exposureDays: number | null }> }>;
    };
    expect(res.status).toBe('ok');
    expect(res.cra?.slaBreaches).toBe(1);
    expect(res.packages[0].advisories[0].exposureDays).toBe(400);
    expect(res.packages[0].advisories[0].introduced?.authorName).toBe('Ada');
  });
});
