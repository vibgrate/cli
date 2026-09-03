import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  ensureHaileModule,
  haileModuleInstalled,
  haileModuleStatus,
  installHaileModule,
  kickHaileReadiness,
  removeHaileModule,
} from './haile-module.js';
import { readConsent, writeConsent } from './module-core.js';
import { haileModuleDir, resetHaileProviderCache } from '../engine/haile/haile-provider.js';

let tmp: string;
let savedEnv: Record<string, string | undefined>;
const ENV = ['XDG_CACHE_HOME', 'VIBGRATE_MODULE_DIR', 'VIBGRATE_NO_KERNEL', 'VIBGRATE_MODULE_REGISTRY', 'VIBGRATE_HAILE_PATH'] as const;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-haile-module-'));
  process.env.XDG_CACHE_HOME = tmp; // isolate module dir + consent state
  delete process.env.VIBGRATE_MODULE_DIR;
  delete process.env.VIBGRATE_NO_KERNEL;
  delete process.env.VIBGRATE_MODULE_REGISTRY;
  delete process.env.VIBGRATE_HAILE_PATH;
  resetHaileProviderCache();
});

afterEach(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  resetHaileProviderCache();
});

/** Build a real npm-shaped tarball (package/dist/index.js …) with system tar. */
function makeTarball(indexJs: string): Buffer {
  const stage = fs.mkdtempSync(path.join(tmp, 'pkg-'));
  fs.mkdirSync(path.join(stage, 'package', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'package', 'dist', 'index.js'), indexJs);
  fs.writeFileSync(path.join(stage, 'package', 'LICENSE'), 'proprietary');
  const out = path.join(stage, 'pkg.tgz');
  execFileSync('tar', ['-czf', out, '-C', stage, 'package']);
  return fs.readFileSync(out);
}

const PROVIDER_JS = `export function createHaileProvider() {
  return {
    version: () => 'tarball-haile@1',
    classify: () => null,
  };
}`;

function registryFetch(tarball: Buffer, opts: { integrity?: string; version?: string } = {}): typeof fetch {
  const version = opts.version ?? '0.1.1';
  const meta = {
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        dist: {
          tarball: 'https://registry.test/tarball.tgz',
          integrity: opts.integrity ?? `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
        },
      },
    },
  };
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('tarball')) return new Response(new Uint8Array(tarball), { status: 200 });
    return new Response(JSON.stringify(meta), { status: 200 });
  }) as typeof fetch;
}

const failingFetch = (async () => {
  throw new Error('registry unreachable');
}) as unknown as typeof fetch;

describe('ensureHaileModule (default-install posture)', () => {
  it('installs when absent, then no-ops when installed', async () => {
    const io = { fetchImpl: registryFetch(makeTarball(PROVIDER_JS)) };
    expect((await ensureHaileModule(io)).status).toBe('installed');
    expect(haileModuleInstalled()).toMatchObject({ installed: true, version: '0.1.1' });
    expect((await ensureHaileModule(io)).status).toBe('already-installed');
    removeHaileModule();
    expect(haileModuleInstalled().installed).toBe(false);
  });

  it('reports unavailable when the registry cannot be reached — never throws', async () => {
    const result = await ensureHaileModule({ fetchImpl: failingFetch });
    expect(result.status).toBe('unavailable');
    expect(haileModuleInstalled().installed).toBe(false);
  });

  it('honours VIBGRATE_NO_KERNEL and a recorded denial', async () => {
    process.env.VIBGRATE_NO_KERNEL = '1';
    expect((await ensureHaileModule({ fetchImpl: failingFetch })).status).toBe('disabled');
    delete process.env.VIBGRATE_NO_KERNEL;
    writeConsent({ ...readConsent(), haile: 'denied' });
    expect((await ensureHaileModule({ fetchImpl: failingFetch })).status).toBe('declined');
  });

  it('refuses a tarball that fails the integrity check, leaving nothing behind', async () => {
    const result = await installHaileModule({ fetchImpl: registryFetch(makeTarball(PROVIDER_JS), { integrity: 'sha512-BAD' }) });
    expect(result.status).toBe('unavailable');
    expect(haileModuleInstalled().installed).toBe(false);
  });
});

describe('kickHaileReadiness (per-invocation background provision)', () => {
  const stampPath = () => path.join(path.dirname(haileModuleDir()), 'haile.last-attempt');

  it('writes the throttle stamp and never throws when the install fails', () => {
    expect(() => kickHaileReadiness({ fetchImpl: failingFetch })).not.toThrow();
    expect(fs.existsSync(stampPath())).toBe(true);
  });

  it('is throttled: a fresh stamp suppresses the next attempt', () => {
    kickHaileReadiness({ fetchImpl: failingFetch });
    const first = fs.readFileSync(stampPath(), 'utf8');
    kickHaileReadiness({ fetchImpl: failingFetch });
    expect(fs.readFileSync(stampPath(), 'utf8')).toBe(first);
  });

  it('is a no-op under VIBGRATE_NO_KERNEL and after a recorded denial', () => {
    process.env.VIBGRATE_NO_KERNEL = '1';
    kickHaileReadiness({ fetchImpl: failingFetch });
    expect(fs.existsSync(stampPath())).toBe(false);
    delete process.env.VIBGRATE_NO_KERNEL;
    writeConsent({ ...readConsent(), haile: 'denied' });
    kickHaileReadiness({ fetchImpl: failingFetch });
    expect(fs.existsSync(stampPath())).toBe(false);
  });
});

describe('haileModuleStatus (what the editor may offer)', () => {
  const stampPath = () => path.join(path.dirname(haileModuleDir()), 'haile.last-attempt');

  it('is absent before any attempt and while a fresh kick is in flight', () => {
    expect(haileModuleStatus()).toEqual({ status: 'absent' });
    kickHaileReadiness({ fetchImpl: failingFetch });
    expect(haileModuleStatus()).toEqual({ status: 'absent' });
  });

  it('is unavailable once a settled attempt left no module behind', () => {
    kickHaileReadiness({ fetchImpl: failingFetch });
    const at = Number(fs.readFileSync(stampPath(), 'utf8'));
    expect(haileModuleStatus(at + 5 * 60 * 1000)).toEqual({ status: 'unavailable' });
  });

  it('is present with the version once installed, and honours the opt-outs', async () => {
    await installHaileModule({ fetchImpl: registryFetch(makeTarball(PROVIDER_JS)) });
    expect(haileModuleStatus()).toEqual({ status: 'present', version: '0.1.1' });
    process.env.VIBGRATE_NO_KERNEL = '1';
    expect(haileModuleStatus()).toEqual({ status: 'disabled' });
    delete process.env.VIBGRATE_NO_KERNEL;
    writeConsent({ ...readConsent(), haile: 'denied' });
    expect(haileModuleStatus()).toEqual({ status: 'declined' });
  });
});
