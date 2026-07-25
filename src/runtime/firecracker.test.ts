import { describe, it, expect } from 'vitest';
import {
  buildFirecrackerConfig,
  firecrackerArgv,
  resolveFirecrackerPaths,
  tryCreateFirecrackerEnv,
} from './firecracker.js';

const paths = {
  binary: '/usr/bin/firecracker',
  kernel: '/opt/vg/vmlinux',
  rootfs: '/opt/vg/rootfs.ext4',
};

describe('buildFirecrackerConfig', () => {
  it('is deterministic and omits network when denyNetwork', () => {
    const a = buildFirecrackerConfig(paths, {
      writableRoots: ['/repo/b', '/repo/a'],
      command: 'npm test',
      configPath: '/tmp/fc.json',
      denyNetwork: true,
    });
    const b = buildFirecrackerConfig(paths, {
      writableRoots: ['/repo/b', '/repo/a'],
      command: 'npm test',
      configPath: '/tmp/fc.json',
      denyNetwork: true,
    });
    expect(a).toEqual(b);
    expect(a['network-interfaces']).toBeUndefined();
    expect((a['boot-source'] as { boot_args: string }).boot_args).toContain('vg_net=off');
    expect((a['vg-writable-roots'] as string[])[0]).toMatch(/repo\/a|repo\/b/);
    // sorted roots
    const roots = a['vg-writable-roots'] as string[];
    expect([...roots].sort((x, y) => x.localeCompare(y))).toEqual(roots);
  });

  it('adds a network interface when denyNetwork is false', () => {
    const cfg = buildFirecrackerConfig(paths, {
      writableRoots: ['/repo'],
      command: 'true',
      configPath: '/tmp/fc.json',
      denyNetwork: false,
    });
    expect(Array.isArray(cfg['network-interfaces'])).toBe(true);
  });
});

describe('firecrackerArgv', () => {
  it('builds a stable one-shot invoke', () => {
    expect(firecrackerArgv('/bin/firecracker', '/tmp/c.json')).toEqual([
      '/bin/firecracker',
      '--config-file',
      '/tmp/c.json',
      '--no-api',
    ]);
  });
});

describe('resolveFirecrackerPaths / tryCreateFirecrackerEnv', () => {
  it('returns null when images are not configured', () => {
    expect(resolveFirecrackerPaths({}, () => false)).toBeNull();
    expect(tryCreateFirecrackerEnv({ writableRoots: ['/r'], paths: null })).toBeNull();
  });

  it('returns an L3 env when paths are injected', () => {
    const env = tryCreateFirecrackerEnv({
      writableRoots: ['/repo'],
      paths,
      reason: 'test L3',
    });
    expect(env).not.toBeNull();
    expect(env!.tier).toBe('L3');
    expect(env!.label).toBe('firecracker');
    expect(env!.reason).toBe('test L3');
  });
});
