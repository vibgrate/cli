import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSeatbeltProfile,
  bubblewrapArgv,
  createHostExecutionEnv,
  detectSecurityCapabilities,
  resolveExecutionEnv,
  seatbeltArgv,
} from './execution-env.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-exec-'));
  dirs.push(d);
  return d;
}

describe('execution env ladder', () => {
  it('creates an L0 host env that can run a trivial command', () => {
    const env = createHostExecutionEnv();
    expect(env.tier).toBe('L0');
    const res = env.run('echo fusion-ok', { cwd: process.cwd() });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('fusion-ok');
  });

  it('falls back to L0 when L1 is unavailable', () => {
    const env = resolveExecutionEnv('L1', {
      capabilities: {
        platform: 'win32',
        landlock: false,
        seatbelt: false,
        bubblewrap: false,
        firejail: false,
        gvisor: false,
      },
    });
    expect(env.tier).toBe('L0');
    expect(env.reason).toMatch(/falling back to L0/i);
  });

  it('falls back cleanly when L3 Firecracker images are unset', () => {
    const env = resolveExecutionEnv('L3', {
      capabilities: {
        platform: 'win32',
        landlock: false,
        seatbelt: false,
        bubblewrap: false,
        firejail: false,
        gvisor: false,
      },
    });
    // No Firecracker, no L2/L1 on win32 in this fake caps → L0.
    expect(env.tier).toBe('L0');
    expect(env.reason).toMatch(/L3 not available|falling back to L0/i);
  });

  it('selects seatbelt L1 when Seatbelt capability is present', () => {
    const env = resolveExecutionEnv('L1', {
      capabilities: {
        platform: 'darwin',
        landlock: false,
        seatbelt: true,
        bubblewrap: false,
        firejail: false,
        gvisor: false,
      },
      writableRoots: ['/tmp/project'],
    });
    expect(env.tier).toBe('L1');
    expect(env.label).toBe('seatbelt');
    expect(env.reason).toMatch(/Seatbelt/i);
  });

  it('selects bwrap L1 when bubblewrap is present (Linux)', () => {
    const env = resolveExecutionEnv('L1', {
      capabilities: {
        platform: 'linux',
        landlock: true,
        seatbelt: false,
        bubblewrap: true,
        firejail: false,
        gvisor: false,
      },
      writableRoots: ['/tmp/project'],
    });
    expect(env.tier).toBe('L1');
    expect(env.label).toMatch(/bwrap/);
  });

  it('selects firejail L2 when firejail is present', () => {
    const env = resolveExecutionEnv('L2', {
      capabilities: {
        platform: 'linux',
        landlock: false,
        seatbelt: false,
        bubblewrap: false,
        firejail: true,
        gvisor: false,
      },
      writableRoots: ['/tmp/project'],
    });
    expect(env.tier).toBe('L2');
    expect(env.label).toBe('firejail');
  });

  it('L2 falls back to L1 bwrap when firejail missing', () => {
    const env = resolveExecutionEnv('L2', {
      capabilities: {
        platform: 'linux',
        landlock: false,
        seatbelt: false,
        bubblewrap: true,
        firejail: false,
        gvisor: false,
      },
    });
    expect(env.tier).toBe('L1');
    expect(env.label).toMatch(/bwrap/);
  });

  it('falls back when only Landlock sysfs is present without bwrap', () => {
    const env = resolveExecutionEnv('L1', {
      capabilities: {
        platform: 'linux',
        landlock: true,
        seatbelt: false,
        bubblewrap: false,
        firejail: false,
        gvisor: false,
      },
    });
    expect(env.tier).toBe('L0');
    expect(env.reason).toMatch(/falling back to L0/i);
  });

  it('detectSecurityCapabilities is pure over platform', () => {
    const win = detectSecurityCapabilities('win32');
    expect(win.landlock).toBe(false);
    expect(win.seatbelt).toBe(false);
    expect(win.bubblewrap).toBe(false);
    expect(win.firejail).toBe(false);
  });

  it('buildSeatbeltProfile restricts writes to roots and denies network by default', () => {
    const profile = buildSeatbeltProfile(['/Users/dev/app'], { tempRoots: ['/tmp'] });
    expect(profile).toContain('(version 1)');
    expect(profile).toContain('(subpath "/Users/dev/app")');
    expect(profile).toContain('(subpath "/tmp")');
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain('(allow file-read*)');
  });

  it('seatbeltArgv and bubblewrapArgv are stable argv builders', () => {
    expect(seatbeltArgv('/tmp/p.sb', 'echo hi')).toEqual([
      'sandbox-exec',
      '-f',
      '/tmp/p.sb',
      '/bin/sh',
      '-c',
      'echo hi',
    ]);
    const b = bubblewrapArgv(['/repo'], 'make test', { denyNetwork: true, cwd: '/repo' });
    expect(b[0]).toBe('bwrap');
    expect(b).toContain('--unshare-net');
    expect(b).toContain('--bind');
    expect(b).toContain('/repo');
    expect(b.slice(-3)).toEqual(['/bin/sh', '-c', 'make test']);
  });

  it('L1 seatbelt env runs a trivial command inside the writable root (macOS)', () => {
    if (process.platform !== 'darwin') return;
    const root = tmp();
    const env = resolveExecutionEnv('L1', {
      capabilities: detectSecurityCapabilities('darwin'),
      writableRoots: [root],
      denyNetwork: true,
    });
    if (env.tier !== 'L1') return; // sandbox-exec missing in weird CI images
    const res = env.run('echo seatbelt-ok', { cwd: root });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('seatbelt-ok');
  });

  it('L1 seatbelt blocks writes outside the writable root (macOS)', () => {
    if (process.platform !== 'darwin') return;
    // Use a home-adjacent path outside os.tmpdir() so default temp roots do not
    // accidentally authorize the target (tmpdir siblings share /var/folders/…).
    const root = tmp();
    const outsideBase = path.join(os.homedir(), `.vg-seatbelt-outside-${process.pid}`);
    fs.mkdirSync(outsideBase, { recursive: true });
    dirs.push(outsideBase);
    const marker = path.join(outsideBase, 'should-not-exist.txt');
    try {
      fs.unlinkSync(marker);
    } catch {
      /* absent */
    }
    const env = resolveExecutionEnv('L1', {
      capabilities: detectSecurityCapabilities('darwin'),
      writableRoots: [root],
      denyNetwork: true,
    });
    if (env.tier !== 'L1') return;
    const res = env.run(`echo leaked > "${marker}"`, { cwd: root });
    // Seatbelt should refuse the write (non-zero) and leave the marker absent.
    expect(fs.existsSync(marker)).toBe(false);
    expect(res.exitCode).not.toBe(0);
  });
});
