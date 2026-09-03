import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { updateLocalModules } from './update-modules.js';
import { readConsent, writeConsent } from './module-core.js';
import { installRelevanceModule, moduleInstalled } from './relevance-module.js';
import { haileModuleInstalled } from './haile-module.js';
import { hcsModuleInstalled } from './hcs-module.js';

let tmp: string;
let savedEnv: Record<string, string | undefined>;
const ENV = ['XDG_CACHE_HOME', 'VIBGRATE_MODULE_DIR', 'VIBGRATE_NO_KERNEL', 'VIBGRATE_MODULE_REGISTRY'] as const;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-update-modules-'));
  process.env.XDG_CACHE_HOME = tmp; // isolate module dirs + consent state
  delete process.env.VIBGRATE_MODULE_DIR;
  delete process.env.VIBGRATE_NO_KERNEL;
  delete process.env.VIBGRATE_MODULE_REGISTRY;
});

afterEach(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeTarball(): Buffer {
  const stage = fs.mkdtempSync(path.join(tmp, 'pkg-'));
  fs.mkdirSync(path.join(stage, 'package', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'package', 'dist', 'index.js'), 'export {};');
  const out = path.join(stage, 'pkg.tgz');
  execFileSync('tar', ['-czf', out, '-C', stage, 'package']);
  return fs.readFileSync(out);
}

/** One registry serving the same latest version for every package name. */
function registryFetch(version: string, tarball: Buffer): typeof fetch {
  const meta = {
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        dist: {
          tarball: 'https://registry.test/tarball.tgz',
          integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
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

const byId = (reports: Awaited<ReturnType<typeof updateLocalModules>>) =>
  Object.fromEntries(reports.map((r) => [r.id, r]));

describe('updateLocalModules (vg update)', () => {
  it('updates an installed module to the newer latest and default-installs the missing ones', async () => {
    const gz = makeTarball();
    expect((await installRelevanceModule({ fetchImpl: registryFetch('1.0.0', gz) })).status).toBe('installed');
    const r = byId(await updateLocalModules({ fetchImpl: registryFetch('1.1.0', gz) }));
    expect(r.relevance).toMatchObject({ status: 'updated', from: '1.0.0', to: '1.1.0' });
    expect(moduleInstalled()).toMatchObject({ installed: true, version: '1.1.0' });
    // haile is ON by default → installed even though it was absent.
    expect(r.haile).toMatchObject({ status: 'installed', to: '1.1.0' });
    expect(haileModuleInstalled().installed).toBe(true);
    // hcs provisions on use, not on update.
    expect(r.hcs).toMatchObject({ status: 'not-installed' });
    expect(hcsModuleInstalled().installed).toBe(false);
  });

  it('reports up-to-date without reinstalling when nothing newer is published', async () => {
    const gz = makeTarball();
    await installRelevanceModule({ fetchImpl: registryFetch('1.0.0', gz) });
    const r = byId(await updateLocalModules({ fetchImpl: registryFetch('1.0.0', gz) }));
    expect(r.relevance).toMatchObject({ status: 'up-to-date', to: '1.0.0' });
  });

  it('checkOnly reports availability without touching the disk', async () => {
    const gz = makeTarball();
    await installRelevanceModule({ fetchImpl: registryFetch('1.0.0', gz) });
    const r = byId(await updateLocalModules({ fetchImpl: registryFetch('1.1.0', gz), checkOnly: true }));
    expect(r.relevance).toMatchObject({ status: 'update-available', from: '1.0.0', to: '1.1.0' });
    expect(r.haile).toMatchObject({ status: 'install-available', to: '1.1.0' });
    expect(moduleInstalled().version).toBe('1.0.0');
    expect(haileModuleInstalled().installed).toBe(false);
  });

  it('honours VIBGRATE_NO_KERNEL and per-module denial, and never throws on registry failure', async () => {
    process.env.VIBGRATE_NO_KERNEL = '1';
    expect((await updateLocalModules({ fetchImpl: failingFetch })).every((r) => r.status === 'disabled')).toBe(true);
    delete process.env.VIBGRATE_NO_KERNEL;

    writeConsent({ ...readConsent(), haile: 'denied' });
    const r = byId(await updateLocalModules({ fetchImpl: failingFetch }));
    expect(r.haile.status).toBe('declined');
    // relevance is default-on but the registry is down → failed, not thrown.
    expect(r.relevance.status).toBe('failed');
  });
});
