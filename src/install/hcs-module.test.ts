import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  installHcsModule,
  ensureHcsModule,
  removeHcsModule,
  hcsModuleInstalled,
} from './hcs-module.js';
import { readConsent, writeConsent } from './module-core.js';
import { hcsModuleDir, loadHcsEngine, resetHcsEngineCache } from '../engine/hcs-provider.js';

let tmp: string;
let savedEnv: Record<string, string | undefined>;
const ENV = ['XDG_CACHE_HOME', 'VIBGRATE_NO_KERNEL', 'VIBGRATE_MODULE_REGISTRY', 'VIBGRATE_HCS_PATH'] as const;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-hcs-module-'));
  process.env.XDG_CACHE_HOME = tmp; // isolate module dir + consent state
  delete process.env.VIBGRATE_NO_KERNEL;
  delete process.env.VIBGRATE_MODULE_REGISTRY;
  delete process.env.VIBGRATE_HCS_PATH;
  resetHcsEngineCache();
});

afterEach(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  resetHcsEngineCache();
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

const ENGINE_JS = `export function createHcsEngine() {
  return {
    version: () => 'tarball-hcs@1',
    renderDigest: (ndjson, opts) => 'digest:' + JSON.parse(opts).format,
    buildMap: () => '{}',
    evaluateGate: () => JSON.stringify({ pass: true }),
  };
}`;

function registryFetch(tarball: Buffer, opts: { integrity?: string; version?: string } = {}): typeof fetch {
  const version = opts.version ?? '1.2.3';
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

describe('installHcsModule', () => {
  it('installs from a registry tarball and the seam then loads it', async () => {
    const gz = makeTarball(ENGINE_JS);
    const result = await installHcsModule({ fetchImpl: registryFetch(gz) });
    expect(result).toMatchObject({ status: 'installed', version: '1.2.3' });
    expect(hcsModuleInstalled()).toMatchObject({ installed: true, version: '1.2.3' });
    expect(fs.existsSync(path.join(hcsModuleDir(), 'index.js'))).toBe(true);

    resetHcsEngineCache();
    const engine = await loadHcsEngine();
    expect(engine?.version()).toBe('tarball-hcs@1');
    expect(engine?.renderDigest('', JSON.stringify({ format: 'md' }))).toBe('digest:md');

    removeHcsModule();
    expect(hcsModuleInstalled().installed).toBe(false);
  });

  it('refuses a tarball that fails the integrity check, leaving nothing behind', async () => {
    const gz = makeTarball(ENGINE_JS);
    const result = await installHcsModule({ fetchImpl: registryFetch(gz, { integrity: 'sha512-BAD' }) });
    expect(result.status).toBe('unavailable');
    expect(result.detail).toMatch(/integrity/);
    expect(hcsModuleInstalled().installed).toBe(false);
  });

  it('does not collide with the relevance module dir or consent key', async () => {
    const gz = makeTarball(ENGINE_JS);
    await installHcsModule({ fetchImpl: registryFetch(gz) });
    expect(hcsModuleDir().endsWith(path.join('vibgrate', 'modules', 'hcs'))).toBe(true);
    writeConsent({ ...readConsent(), hcs: 'denied' });
    expect(readConsent().relevance).toBeUndefined();
    expect(readConsent().hcs).toBe('denied');
  });
});

describe('ensureHcsModule (vg hcs auto-provision)', () => {
  it('installs when absent, then no-ops when installed', async () => {
    const gz = makeTarball(ENGINE_JS);
    const io = { fetchImpl: registryFetch(gz) };
    expect((await ensureHcsModule(io)).status).toBe('installed');
    expect((await ensureHcsModule(io)).status).toBe('already-installed');
  });

  it('respects an explicit recorded decline and the kill switch', async () => {
    writeConsent({ hcs: 'denied' });
    expect((await ensureHcsModule()).status).toBe('declined');
    writeConsent({});
    process.env.VIBGRATE_NO_KERNEL = '1';
    expect((await ensureHcsModule()).status).toBe('disabled');
  });

  it('an offline registry reports unavailable — the command layer turns this loud', async () => {
    const offline = (async () => {
      throw new Error('ENETUNREACH');
    }) as unknown as typeof fetch;
    const result = await ensureHcsModule({ fetchImpl: offline });
    expect(result.status).toBe('unavailable');
  });
});

describe('loadHcsEngine (seam)', () => {
  it('loads a module from VIBGRATE_HCS_PATH (dir or file) and rejects a contract violation', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'engine-'));
    fs.writeFileSync(path.join(dir, 'index.js'), ENGINE_JS);
    process.env.VIBGRATE_HCS_PATH = dir;
    resetHcsEngineCache();
    expect((await loadHcsEngine())?.version()).toBe('tarball-hcs@1');

    // A fresh path each time — node caches ESM modules by URL.
    const badDir = fs.mkdtempSync(path.join(tmp, 'engine-bad-'));
    fs.writeFileSync(path.join(badDir, 'index.js'), 'export function createHcsEngine() { return { version: () => "x" }; }');
    process.env.VIBGRATE_HCS_PATH = badDir;
    resetHcsEngineCache();
    expect(await loadHcsEngine()).toBeNull(); // missing required methods

    process.env.VIBGRATE_NO_KERNEL = '1';
    resetHcsEngineCache();
    expect(await loadHcsEngine()).toBeNull();
  });
});
