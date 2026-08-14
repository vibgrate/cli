// A plan limit reported by scan preflight (repository cap, scan credits, VM
// minutes) must block only the *upload*, never the local scan: the CLI warns
// with the server's reason, runs the scan to completion, and repeats the
// warning after the results. Regression for the repo-cap case, where the CLI
// used to process.exit(1) before scanning anything. `--strict` keeps the old
// hard-fail for CI.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { scanCommand } from './scan.js';

const DSN = 'vibgrate+https://keyid1234:secret5678@ingest.vibgrate.dev/ws-test';

function preflightBody(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    status: 'ok',
    workspaceId: 'ws-test',
    plan: { tier: 'team', label: 'Team' },
    scans: { used: 3, limit: 100, remaining: 97, allowed: true, yearMonth: '2026-08' },
    ...overrides,
  };
}

describe('scan continues locally when a plan limit blocks the push', () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let fetchCalls: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmpdir(), 'vg-plan-limit-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 't', version: '1.0.0', dependencies: {} }),
    );
    vi.stubEnv('VIBGRATE_DSN', DSN);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) called`);
    }) as never);
    fetchCalls = [];
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function stubPreflight(body: Record<string, unknown>): void {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url);
      fetchCalls.push(u);
      if (u.includes('/v1/ingest/scan/preflight')) {
        return new Response(JSON.stringify(body), { status: 200 });
      }
      // Satisfy the scanner's npm-registry connectivity probe (HEAD request).
      if (u.includes('registry.npmjs.org')) {
        return new Response(null, { status: 200 });
      }
      return new Response(JSON.stringify({ status: 'error', error: 'unexpected call' }), { status: 404 });
    }));
  }

  function stderrText(): string {
    return errorSpy.mock.calls.flat().join('\n');
  }

  async function runScan(extraArgs: string[] = []): Promise<void> {
    await scanCommand.parseAsync(
      [dir, '--no-graph', '--no-local-artifacts', '--quiet', ...extraArgs],
      { from: 'user' },
    );
  }

  it('warns and scans locally when the repository cap is reached', async () => {
    stubPreflight(preflightBody({
      repositories: { total: 10, max: 10, isNew: true, allowed: false },
      error: 'Repository limit reached: this workspace already maps 10 of 10 repositories on the Team plan.',
      upgradeUrl: 'https://vibgrate.com/pricing',
    }));

    await runScan();

    expect(exitSpy).not.toHaveBeenCalled();
    const err = stderrText();
    expect(err).toContain('Repository limit reached');
    expect(err).toContain('Repositories: 10/10 (Team plan)');
    expect(err).toContain('Scanning locally — results will not be uploaded to Vibgrate Cloud.');
    // The warning is repeated after the scan output.
    expect(err).toContain('Results were not uploaded: Repository limit reached');
    // The upload endpoint is never hit — only preflight went out.
    expect(fetchCalls.some((u) => u.includes('/v1/ingest/scan/preflight'))).toBe(true);
    expect(fetchCalls.some((u) => u.includes('/v1/ingest/scan') && !u.includes('preflight'))).toBe(false);
  });

  it('warns and scans locally when scan credits are exhausted', async () => {
    stubPreflight(preflightBody({
      scans: { used: 100, limit: 100, remaining: 0, allowed: false, yearMonth: '2026-08' },
    }));

    await runScan();

    expect(exitSpy).not.toHaveBeenCalled();
    const err = stderrText();
    expect(err).toContain('Scan ingestion not allowed for this workspace.');
    expect(err).toContain('Credits: 100/100 (Team plan)');
    expect(fetchCalls.some((u) => u.includes('/v1/ingest/scan') && !u.includes('preflight'))).toBe(false);
  });

  it('still fails hard under --strict when the repository cap is reached', async () => {
    stubPreflight(preflightBody({
      repositories: { total: 10, max: 10, isNew: true, allowed: false },
    }));

    await expect(runScan(['--strict'])).rejects.toThrow('process.exit(1) called');
  });

  it('pushes normally when preflight allows the upload', async () => {
    stubPreflight(preflightBody({
      repositories: { total: 4, max: 10, isNew: true, allowed: true },
    }));

    await runScan();

    expect(exitSpy).not.toHaveBeenCalled();
    // The push path runs (the stubbed upload 404s, reported as a soft failure).
    expect(fetchCalls.some((u) => u.includes('/v1/ingest/scan') && !u.includes('preflight'))).toBe(true);
    expect(stderrText()).not.toContain('Results were not uploaded');
  });
});
