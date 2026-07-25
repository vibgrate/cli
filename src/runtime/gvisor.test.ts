import { describe, it, expect } from 'vitest';
import { gvisorArgv, resolveGvisorPaths, tryCreateGvisorEnv } from './gvisor.js';

const paths = { binary: '/usr/bin/runsc', rootfs: '/opt/vg/rootfs' };

describe('gvisorArgv', () => {
  it('is deterministic and denies network by default', () => {
    const a = gvisorArgv(paths, {
      writableRoots: ['/repo/b', '/repo/a'],
      command: 'npm test',
      cwd: '/repo/a',
    });
    const b = gvisorArgv(paths, {
      writableRoots: ['/repo/b', '/repo/a'],
      command: 'npm test',
      cwd: '/repo/a',
    });
    expect(a).toEqual(b);
    expect(a[0]).toBe('/usr/bin/runsc');
    expect(a).toContain('--network=none');
    expect(a).toContain('--bind');
    expect(a.slice(-4)).toEqual(['--', '/bin/sh', '-c', 'npm test']);
  });

  it('can allow host network', () => {
    const argv = gvisorArgv(paths, {
      writableRoots: ['/r'],
      command: 'true',
      denyNetwork: false,
    });
    expect(argv).toContain('--network=host');
  });
});

describe('resolveGvisorPaths / tryCreateGvisorEnv', () => {
  it('returns null when unset', () => {
    expect(resolveGvisorPaths({}, () => false, () => null)).toBeNull();
    expect(tryCreateGvisorEnv({ writableRoots: ['/r'], paths: null })).toBeNull();
  });

  it('returns L2 env when paths injected', () => {
    const env = tryCreateGvisorEnv({
      writableRoots: ['/repo'],
      paths,
      reason: 'test gvisor',
    });
    expect(env?.tier).toBe('L2');
    expect(env?.label).toBe('gvisor');
  });
});
