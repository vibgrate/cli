import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  installRelevanceModule,
  ensureRelevanceModule,
  removeRelevanceModule,
  moduleInstalled,
  verifyIntegrity,
  untar,
  readConsent,
  writeConsent,
} from './relevance-module.js';
import { relevanceModuleDir, resetRelevanceProviderCache, loadRelevanceProvider } from '../engine/relevance-provider.js';

let tmp: string;
let savedEnv: Record<string, string | undefined>;
const ENV = ['XDG_CACHE_HOME', 'VIBGRATE_NO_KERNEL', 'VIBGRATE_MODULE_REGISTRY', 'VIBGRATE_RELEVANCE_PATH'] as const;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-module-'));
  process.env.XDG_CACHE_HOME = tmp; // isolate module dir + consent state
  delete process.env.VIBGRATE_NO_KERNEL;
  delete process.env.VIBGRATE_MODULE_REGISTRY;
  delete process.env.VIBGRATE_RELEVANCE_PATH;
  resetRelevanceProviderCache();
});

afterEach(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  resetRelevanceProviderCache();
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

const PROVIDER_JS = `export function createRelevanceProvider() {
  return { version: () => 'tarball-relevance@1', analyzeQuery: () => ({ version: 'tarball-relevance@1', topics: [], expansions: [] }) };
}`;

function registryFetch(tarball: Buffer, opts: { integrity?: string; shasum?: string; version?: string } = {}): typeof fetch {
  const version = opts.version ?? '1.2.3';
  const meta = {
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        dist: {
          tarball: 'https://registry.test/tarball.tgz',
          integrity: opts.integrity ?? `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
          ...(opts.shasum ? { shasum: opts.shasum } : {}),
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

describe('untar (minimal ustar reader)', () => {
  it('reads files out of a real tar and rejects traversal', () => {
    const gz = makeTarball(PROVIDER_JS);
    const entries = untar(zlib.gunzipSync(gz));
    const names = entries.map((e) => e.name);
    expect(names).toContain('package/dist/index.js');
    expect(entries.find((e) => e.name === 'package/dist/index.js')!.body.toString()).toContain('createRelevanceProvider');

    // Hand-craft a header with a traversal name.
    const evil = Buffer.alloc(1024);
    evil.write('package/../../evil.js', 0);
    evil.write('0000000', 124); // size 0
    evil[156] = '0'.charCodeAt(0);
    expect(() => untar(evil)).toThrow(/unsafe path/);
  });
});

describe('verifyIntegrity', () => {
  it('accepts a correct sha512, rejects a wrong one, and requires metadata', () => {
    const buf = Buffer.from('hello');
    const good = `sha512-${createHash('sha512').update(buf).digest('base64')}`;
    expect(() => verifyIntegrity(buf, good)).not.toThrow();
    expect(() => verifyIntegrity(buf, 'sha512-AAAA')).toThrow(/integrity mismatch/);
    expect(() => verifyIntegrity(buf, undefined, createHash('sha1').update(buf).digest('hex'))).not.toThrow();
    expect(() => verifyIntegrity(buf)).toThrow(/no integrity/);
  });
});

describe('installRelevanceModule', () => {
  it('installs from a registry tarball and the seam then loads it', async () => {
    const gz = makeTarball(PROVIDER_JS);
    const result = await installRelevanceModule({ fetchImpl: registryFetch(gz) });
    expect(result).toMatchObject({ status: 'installed', version: '1.2.3' });
    expect(moduleInstalled()).toMatchObject({ installed: true, version: '1.2.3' });
    expect(fs.existsSync(path.join(relevanceModuleDir(), 'index.js'))).toBe(true);

    resetRelevanceProviderCache();
    const provider = await loadRelevanceProvider();
    expect(provider?.version()).toBe('tarball-relevance@1');

    removeRelevanceModule();
    expect(moduleInstalled().installed).toBe(false);
  });

  it('refuses a tarball that fails the integrity check, leaving nothing behind', async () => {
    const gz = makeTarball(PROVIDER_JS);
    const result = await installRelevanceModule({ fetchImpl: registryFetch(gz, { integrity: 'sha512-BAD' }) });
    expect(result.status).toBe('unavailable');
    expect(result.detail).toMatch(/integrity/);
    expect(moduleInstalled().installed).toBe(false);
  });

  it('is disabled by VIBGRATE_NO_KERNEL and degrades on registry failure', async () => {
    process.env.VIBGRATE_NO_KERNEL = '1';
    expect((await installRelevanceModule()).status).toBe('disabled');
    delete process.env.VIBGRATE_NO_KERNEL;
    const offline = (async () => {
      throw new Error('network unreachable');
    }) as unknown as typeof fetch;
    const result = await installRelevanceModule({ fetchImpl: offline });
    expect(result.status).toBe('unavailable');
  });
});

describe('ensureRelevanceModule (vg code auto-provision — silent)', () => {
  it('installs silently when absent, then no-ops when installed', async () => {
    const gz = makeTarball(PROVIDER_JS);
    // A version at/above the ranking-API floor: ensure treats it as current.
    const io = { fetchImpl: registryFetch(gz, { version: '2026.823.0' }) };
    expect((await ensureRelevanceModule(io)).status).toBe('installed');
    expect((await ensureRelevanceModule(io)).status).toBe('already-installed');
  });

  it('force-upgrades an install that predates the ranking API', async () => {
    const gz = makeTarball(PROVIDER_JS);
    // First install lands a pre-relocation version…
    expect((await ensureRelevanceModule({ fetchImpl: registryFetch(gz, { version: '1.2.3' }) })).status).toBe('installed');
    // …which ensure refuses to treat as current: the next call reinstalls in
    // place at the registry's latest (the module IS the relevance engine now).
    const upgraded = await ensureRelevanceModule({ fetchImpl: registryFetch(gz, { version: '2026.823.0' }) });
    expect(upgraded).toMatchObject({ status: 'installed', version: '2026.823.0' });
    expect((await ensureRelevanceModule({ fetchImpl: registryFetch(gz, { version: '2026.823.0' }) })).status).toBe(
      'already-installed',
    );
  });

  it('respects an explicit recorded decline and the kill switch', async () => {
    writeConsent({ relevance: 'denied' });
    expect((await ensureRelevanceModule()).status).toBe('declined');
    writeConsent({});
    process.env.VIBGRATE_NO_KERNEL = '1';
    expect((await ensureRelevanceModule()).status).toBe('disabled');
  });

  it('an offline registry degrades silently — unavailable, never a throw', async () => {
    const offline = (async () => {
      throw new Error('ENETUNREACH');
    }) as unknown as typeof fetch;
    const result = await ensureRelevanceModule({ fetchImpl: offline });
    expect(result.status).toBe('unavailable');
    expect(readConsent().relevance).toBeUndefined(); // silent path records nothing
  });
});
