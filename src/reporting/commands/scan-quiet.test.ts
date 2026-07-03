// Owned by the public CLI. Exercises `vg scan --quiet` promotional-output
// suppression through the vendored core-open scan runner: the free-plan
// "Keep tracking your DriftScore" panel must disappear under quiet while the
// drift report itself is unchanged. Lives here (not under src/core-open, which
// the vendor script wipes on every sync) so it survives re-vendoring.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { runCoreScan } from '../../core-open/index.js';
import type { ScanOptions } from '../../core-open/index.js';

describe('scan --quiet promotional-output suppression', () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmpdir(), 'vg-quiet-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0', dependencies: {} }));
    // The panel only renders for DSN-less (free) scans — make sure the
    // environment can't leak a workspace DSN into the run.
    vi.stubEnv('VIBGRATE_DSN', '');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function textOpts(extra: Partial<ScanOptions>): ScanOptions {
    return { format: 'text', concurrency: 4, offline: true, noLocalArtifacts: true, vibgrateVersion: 'test', ...extra };
  }

  function printed(): string {
    return logSpy.mock.calls.flat().join('\n');
  }

  it('prints the upsell panel on a free (DSN-less) text scan by default', async () => {
    await runCoreScan(dir, textOpts({}));
    expect(printed()).toContain('KEEP TRACKING YOUR DRIFTSCORE');
  });

  it('quiet suppresses the upsell panel but keeps the drift report', async () => {
    await runCoreScan(dir, textOpts({ quiet: true }));
    const out = printed();
    expect(out).not.toContain('KEEP TRACKING YOUR DRIFTSCORE');
    expect(out).toContain('Drift Score Summary');
  });
});
