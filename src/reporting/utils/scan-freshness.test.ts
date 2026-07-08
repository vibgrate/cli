import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanStaleness, isScanStale } from './scan-freshness.js';

/**
 * `scanStaleness` decides whether a prior `vg` scan is out of date with the
 * working tree's dependency manifests/lockfiles — the signal that makes `vg fix`
 * re-scan before planning. Times are pinned with `utimesSync` so the test never
 * races the filesystem clock.
 */

let dir: string;

/** Absolute path inside the fixture, creating parent dirs. */
function write(rel: string, content = ''): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/** Set a file's mtime to a fixed epoch-seconds value (deterministic ordering). */
function touchAt(abs: string, epochSeconds: number): void {
  fs.utimesSync(abs, epochSeconds, epochSeconds);
}

const T_OLD = 1_700_000_000; // manifests written "before" the scan
const T_SCAN = 1_700_000_100; // the scan artifact
const T_NEW = 1_700_000_200; // an edit "after" the scan

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-fresh-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('scanStaleness', () => {
  it('reports fresh when every manifest is older than the artifact', () => {
    touchAt(write('package.json', '{"dependencies":{"lodash":"^4"}}'), T_OLD);
    const artifact = write('.vibgrate/scan_result.json', '{}');
    touchAt(artifact, T_SCAN);

    const result = scanStaleness(dir, artifact);
    expect(result.stale).toBe(false);
    expect(result.newestChanged).toBeUndefined();
  });

  it('reports stale when a manifest was modified after the scan', () => {
    const pkg = write('package.json', '{"dependencies":{"lodash":"^4"}}');
    const artifact = write('.vibgrate/scan_result.json', '{}');
    touchAt(artifact, T_SCAN);
    touchAt(pkg, T_NEW); // user edited package.json after scanning

    const result = scanStaleness(dir, artifact);
    expect(result.stale).toBe(true);
    expect(result.newestChanged).toBe('package.json');
  });

  it('treats a lockfile bump as stale (e.g. a prior vg fix ran an install)', () => {
    touchAt(write('package.json'), T_OLD);
    const lock = write('package-lock.json', '{}');
    const artifact = write('.vibgrate/scan_result.json', '{}');
    touchAt(artifact, T_SCAN);
    touchAt(lock, T_NEW);

    const result = scanStaleness(dir, artifact);
    expect(result.stale).toBe(true);
    expect(result.newestChanged).toBe('package-lock.json');
  });

  it('detects staleness from a nested manifest in a monorepo', () => {
    const artifact = write('.vibgrate/scan_result.json', '{}');
    touchAt(artifact, T_SCAN);
    const nested = write('packages/api/package.json', '{}');
    touchAt(nested, T_NEW);

    const result = scanStaleness(dir, artifact);
    expect(result.stale).toBe(true);
    expect(result.newestChanged).toBe(path.join('packages', 'api', 'package.json'));
  });

  it('ignores changes inside node_modules and other build/vendor dirs', () => {
    touchAt(write('package.json'), T_OLD);
    const artifact = write('.vibgrate/scan_result.json', '{}');
    touchAt(artifact, T_SCAN);
    // A freshly installed dependency's own manifest must NOT mark the repo stale.
    touchAt(write('node_modules/lodash/package.json', '{}'), T_NEW);
    touchAt(write('dist/package.json', '{}'), T_NEW);

    expect(isScanStale(dir, artifact)).toBe(false);
  });

  it('ignores non-manifest source edits (fix only cares about dependencies)', () => {
    touchAt(write('package.json'), T_OLD);
    const artifact = write('.vibgrate/scan_result.json', '{}');
    touchAt(artifact, T_SCAN);
    touchAt(write('src/index.ts', 'export const x = 1;'), T_NEW);

    expect(isScanStale(dir, artifact)).toBe(false);
  });

  it('picks the newest changed manifest across several ecosystems', () => {
    const artifact = write('.vibgrate/scan_result.json', '{}');
    touchAt(artifact, T_SCAN);
    touchAt(write('package.json'), T_NEW);
    touchAt(write('requirements.txt'), T_NEW + 50); // newest
    touchAt(write('go.mod'), T_NEW + 25);

    const result = scanStaleness(dir, artifact);
    expect(result.stale).toBe(true);
    expect(result.newestChanged).toBe('requirements.txt');
  });

  it('fails open (reports fresh) when the artifact cannot be stat-ed', () => {
    touchAt(write('package.json'), T_NEW);
    // No artifact on disk — "missing" is the caller's concern, not staleness.
    expect(isScanStale(dir, path.join(dir, '.vibgrate', 'scan_result.json'))).toBe(false);
  });
});
