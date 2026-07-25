import { describe, it, expect } from 'vitest';
import {
  detectSandboxCapabilities,
  firejailArgv,
  selectSandboxBackend,
  type SandboxCapabilities,
} from './sandbox-backend.js';

describe('sandbox backend ladder', () => {
  it('detectSandboxCapabilities always includes host', () => {
    const caps = detectSandboxCapabilities('win32');
    expect(caps.backends.some((b) => b.id === 'host' && b.available)).toBe(true);
    expect(caps.bestTier).toBe('L0');
    expect(caps.backends.find((b) => b.id === 'firecracker')?.available).toBe(false);
  });

  it('selectSandboxBackend prefers exact then stronger then weaker', () => {
    const caps: SandboxCapabilities = {
      platform: 'linux',
      bestTier: 'L2',
      backends: [
        { id: 'host', tier: 'L0', available: true, reason: 'host' },
        { id: 'bwrap', tier: 'L1', available: true, reason: 'bwrap' },
        { id: 'firejail', tier: 'L2', available: true, reason: 'fj' },
        { id: 'firecracker', tier: 'L3', available: false, reason: 'n/a' },
      ],
    };
    expect(selectSandboxBackend('L2', caps).id).toBe('firejail');
    expect(selectSandboxBackend('L1', caps).id).toBe('bwrap');
    expect(selectSandboxBackend('L3', caps).id).toBe('firejail'); // best available ≥ request falls to available
  });

  it('firejailArgv is stable', () => {
    const argv = firejailArgv(['/repo'], 'npm test', { denyNetwork: true, cwd: '/repo' });
    expect(argv[0]).toBe('firejail');
    expect(argv).toContain('--net=none');
    expect(argv).toContain('--whitelist=/repo');
    expect(argv.slice(-3)).toEqual(['/bin/sh', '-c', 'npm test']);
  });
});
