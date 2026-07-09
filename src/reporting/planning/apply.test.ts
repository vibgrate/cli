import { describe, it, expect, vi } from 'vitest';
import { pmCommandFor, applyPlan, type UpgradeCommand } from './apply.js';
import type { PlannedUpgrade } from './types.js';

function upgrade(over: Partial<PlannedUpgrade> & Pick<PlannedUpgrade, 'package' | 'ecosystem' | 'to'>): PlannedUpgrade {
  return {
    from: '1.0.0',
    kind: 'minor',
    blastRadius: 'low',
    fixes: { total: 0, bySeverity: { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 } },
    reason: 'test',
    ...over,
  } as PlannedUpgrade;
}

describe('pmCommandFor', () => {
  it('builds the right pin command per ecosystem', () => {
    expect(pmCommandFor('npm', 'lodash', '4.17.21', 'pnpm')).toEqual({ cmd: 'pnpm', args: ['add', 'lodash@4.17.21'] });
    expect(pmCommandFor('npm', 'lodash', '4.17.21', 'yarn')).toEqual({ cmd: 'yarn', args: ['add', 'lodash@4.17.21'] });
    expect(pmCommandFor('npm', 'lodash', '4.17.21')).toEqual({ cmd: 'npm', args: ['install', 'lodash@4.17.21'] });
    expect(pmCommandFor('pypi', 'flask', '3.0.0')).toEqual({ cmd: 'pip', args: ['install', 'flask==3.0.0'] });
    expect(pmCommandFor('cargo', 'serde', '1.0.1')).toEqual({ cmd: 'cargo', args: ['add', 'serde@1.0.1'] });
    expect(pmCommandFor('go', 'github.com/x/y', '1.2.3')).toEqual({ cmd: 'go', args: ['get', 'github.com/x/y@v1.2.3'] });
    expect(pmCommandFor('go', 'github.com/x/y', 'v1.2.3')).toEqual({ cmd: 'go', args: ['get', 'github.com/x/y@v1.2.3'] });
    expect(pmCommandFor('composer', 'sym/console', '6.0')).toEqual({ cmd: 'composer', args: ['require', 'sym/console:6.0'] });
    expect(pmCommandFor('nuget', 'Newtonsoft.Json', '13.0.1')).toEqual({ cmd: 'dotnet', args: ['add', 'package', 'Newtonsoft.Json', '--version', '13.0.1'] });
    expect(pmCommandFor('dart', 'http', '1.1.0')).toEqual({ cmd: 'dart', args: ['pub', 'add', 'http:1.1.0'] });
  });

  it('returns null for ecosystems without a clean one-shot pin (java, hex, swift)', () => {
    expect(pmCommandFor('java', 'g:a', '1.0')).toBeNull();
    expect(pmCommandFor('hex', 'phoenix', '1.7')).toBeNull();
    expect(pmCommandFor('swift', 'nio', '2.0')).toBeNull();
  });

  it('adds -w for pnpm at a workspace root, but only for pnpm', () => {
    expect(pmCommandFor('npm', 'lodash', '4.17.21', 'pnpm', { workspaceRoot: true })).toEqual({
      cmd: 'pnpm',
      args: ['add', '-w', 'lodash@4.17.21'],
    });
    // npm/yarn/bun add to the root package.json without a flag.
    expect(pmCommandFor('npm', 'lodash', '4.17.21', 'npm', { workspaceRoot: true })).toEqual({
      cmd: 'npm',
      args: ['install', 'lodash@4.17.21'],
    });
    expect(pmCommandFor('npm', 'lodash', '4.17.21', 'yarn', { workspaceRoot: true })).toEqual({
      cmd: 'yarn',
      args: ['add', 'lodash@4.17.21'],
    });
  });
});

describe('applyPlan', () => {
  it('runs a command per upgrade and reports outcomes', () => {
    const run = vi.fn((_cmd: UpgradeCommand) => ({ ok: true }));
    const results = applyPlan('/repo', [upgrade({ package: 'lodash', ecosystem: 'npm', to: '4.17.21' })], { run, packageManager: 'pnpm' });
    expect(run).toHaveBeenCalledWith({ cmd: 'pnpm', args: ['add', 'lodash@4.17.21'] }, '/repo');
    expect(results[0].status).toBe('applied');
  });

  it('reports manual for ecosystems without a pin command (never silently dropped)', () => {
    const results = applyPlan('/repo', [upgrade({ package: 'g:a', ecosystem: 'java', to: '2.0' })], { run: () => ({ ok: true }) });
    expect(results[0].status).toBe('manual');
  });

  it('marks failures and does not throw', () => {
    const results = applyPlan('/repo', [upgrade({ package: 'x', ecosystem: 'npm', to: '2.0.0' })], {
      run: () => ({ ok: false, detail: 'exit 1' }),
    });
    expect(results[0].status).toBe('failed');
    expect(results[0].detail).toBe('exit 1');
  });

  it('dry-run previews commands without running them', () => {
    const run = vi.fn(() => ({ ok: true }));
    const results = applyPlan('/repo', [upgrade({ package: 'lodash', ecosystem: 'npm', to: '4.17.21' })], { run, dryRun: true });
    expect(run).not.toHaveBeenCalled();
    expect(results[0].status).toBe('skipped');
    expect(results[0].detail).toMatch(/would run: npm install lodash@4.17.21/);
  });

  it('runs the pin command in the owning workspace package directory (no -w)', () => {
    const run = vi.fn((_cmd: UpgradeCommand, _cwd: string) => ({ ok: true }));
    const results = applyPlan('/repo', [upgrade({ package: 'wrangler', ecosystem: 'npm', to: '4.108.0' })], {
      run,
      packageManager: 'pnpm',
      resolveTargets: () => [{ dir: 'packages/dash', isWorkspaceRoot: false }],
    });
    expect(run).toHaveBeenCalledWith({ cmd: 'pnpm', args: ['add', 'wrangler@4.108.0'] }, '/repo/packages/dash');
    expect(results[0].status).toBe('applied');
  });

  it('adds -w only when the owning manifest is the pnpm workspace root', () => {
    const run = vi.fn((_cmd: UpgradeCommand, _cwd: string) => ({ ok: true }));
    applyPlan('/repo', [upgrade({ package: 'typescript', ecosystem: 'npm', to: '6.0.3' })], {
      run,
      packageManager: 'pnpm',
      resolveTargets: () => [{ dir: '.', isWorkspaceRoot: true }],
    });
    expect(run).toHaveBeenCalledWith({ cmd: 'pnpm', args: ['add', '-w', 'typescript@6.0.3'] }, '/repo');
  });

  it('applies to every owning package and lists them in the detail', () => {
    const run = vi.fn((_cmd: UpgradeCommand, _cwd: string) => ({ ok: true }));
    const results = applyPlan('/repo', [upgrade({ package: 'typescript', ecosystem: 'npm', to: '6.0.3' })], {
      run,
      packageManager: 'pnpm',
      resolveTargets: () => [
        { dir: 'packages/a', isWorkspaceRoot: false },
        { dir: 'packages/b', isWorkspaceRoot: false },
      ],
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(1, { cmd: 'pnpm', args: ['add', 'typescript@6.0.3'] }, '/repo/packages/a');
    expect(run).toHaveBeenNthCalledWith(2, { cmd: 'pnpm', args: ['add', 'typescript@6.0.3'] }, '/repo/packages/b');
    expect(results[0].status).toBe('applied');
    expect(results[0].detail).toBe('applied in packages/a, packages/b');
  });

  it('reports which package failed when only one owner errors', () => {
    const run = vi.fn((_cmd: UpgradeCommand, cwd: string) =>
      cwd.endsWith('packages/b') ? { ok: false, detail: 'exit 1' } : { ok: true },
    );
    const results = applyPlan('/repo', [upgrade({ package: 'typescript', ecosystem: 'npm', to: '6.0.3' })], {
      run,
      packageManager: 'pnpm',
      resolveTargets: () => [
        { dir: 'packages/a', isWorkspaceRoot: false },
        { dir: 'packages/b', isWorkspaceRoot: false },
      ],
    });
    expect(results[0].status).toBe('failed');
    expect(results[0].detail).toBe('packages/b: exit 1');
  });

  it('reports a missing toolchain (ENOENT) as manual, not failed', () => {
    const results = applyPlan('/repo', [upgrade({ package: 'sha2', ecosystem: 'cargo', to: '0.11.0' })], {
      run: () => ({ ok: false, toolMissing: true, detail: 'cargo is not installed or not on PATH' }),
    });
    expect(results[0].status).toBe('manual');
    expect(results[0].detail).toMatch(/cargo is not installed.*upgrade manually/);
  });
});
