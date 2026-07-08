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
    expect(out).toContain('DriftScore Summary');
  });

  // Regression: a user logged in via the stored credential (no `--dsn`, no
  // `VIBGRATE_DSN`) resolves a workspace DSN in the CLI, which passes
  // `authenticated: true` into the scan. The scanner's own dsn/env check can't
  // see the stored login, so without these signals a paid-plan bare scan was
  // mislabelled "Vibgrate Free" and shown the login upsell panel — even while
  // the same run pushed to the workspace.
  it('suppresses the panel for an authenticated paid-plan scan', async () => {
    await runCoreScan(dir, textOpts({ authenticated: true, planTier: 'team' }));
    const out = printed();
    expect(out).not.toContain('KEEP TRACKING YOUR DRIFTSCORE');
    expect(out).not.toContain("You're on Vibgrate Free");
    // The real report is unaffected.
    expect(out).toContain('DriftScore Summary');
  });

  it('suppresses the panel when authenticated but the plan is unknown', async () => {
    // Preflight did not run (offline / no push): never risk telling a paying
    // customer they are on the free plan.
    await runCoreScan(dir, textOpts({ authenticated: true }));
    expect(printed()).not.toContain('KEEP TRACKING YOUR DRIFTSCORE');
  });

  it('shows the panel with an upgrade CTA (not login) for an authenticated free-plan scan', async () => {
    await runCoreScan(
      dir,
      textOpts({ authenticated: true, planTier: 'free', upgradeUrl: 'https://dash.vibgrate.com/ws123' }),
    );
    const out = printed();
    expect(out).toContain('KEEP TRACKING YOUR DRIFTSCORE');
    // Upgrade CTA, not the login flow.
    expect(out).toContain('More on Team or Business');
    expect(out).toContain('https://dash.vibgrate.com/ws123');
    expect(out).not.toContain('Start tracking');
    expect(out).not.toContain('vg login');
    expect(out).not.toContain('ran locally');
  });

  it('shows the login panel when unauthenticated', async () => {
    await runCoreScan(dir, textOpts({ authenticated: false }));
    const out = printed();
    expect(out).toContain('KEEP TRACKING YOUR DRIFTSCORE');
    expect(out).toContain('Start tracking');
    expect(out).toContain('vg login');
  });
});
