import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { provisionArchModule } from './provision.js';
import { runSecurityPacks } from './run-packs.js';
import { resetHaileProviderCache } from '../engine/haile/haile-provider.js';
import { writeConsent } from '../install/module-core.js';

/**
 * Provisioning for `vg scan --iac` (plan §2.8): a missing module is installed
 * on first use under the same rules as `vg build` — never under --offline,
 * never against VIBGRATE_NO_KERNEL or a recorded denial, never fatal — and an
 * installed-but-old module is only replaced when the registry has a newer
 * build. Every installer is injected, so nothing here touches the network.
 */

const ENV = ['XDG_CACHE_HOME', 'VIBGRATE_MODULE_DIR', 'VIBGRATE_NO_KERNEL', 'VIBGRATE_ARCH_PATH'] as const;
const saved: Partial<Record<(typeof ENV)[number], string | undefined>> = {};
let modulesDir: string;
let root: string;

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  modulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-provision-'));
  process.env.VIBGRATE_MODULE_DIR = modulesDir;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-provision-root-'));
  fs.mkdirSync(path.join(root, 'infra'));
  fs.writeFileSync(path.join(root, 'infra/s3.tf'), 'resource "aws_s3_bucket" "logs" {\n  acl = "public-read"\n}\n');
  resetHaileProviderCache();
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetHaileProviderCache();
  fs.rmSync(modulesDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

/** A fake installed module whose provider can (or cannot) evaluate facts. */
function writeFakeModule(version: string, withEvalFacts: boolean): void {
  const dir = path.join(modulesDir, 'haile');
  fs.mkdirSync(dir, { recursive: true });
  const evalFacts = withEvalFacts
    ? `evalFacts(doc) { return { schema: 'vg.security.v1', engine: 'fake/${version}', packs: { 'iac-cis-v1': '1' }, facts: { received: doc.facts.length, evaluated: doc.facts.length, rejected: 0 }, findings: [] }; },`
    : '';
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    `export function createHaileProvider() { return { version() { return '${version}'; }, classify() { return null; }, ${evalFacts} }; }\n`,
  );
  fs.writeFileSync(path.join(dir, '.module.json'), JSON.stringify({ name: '@vibgrate/haile', version }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
}

const failingLatest = async () => null;
const neverCalled = async () => {
  throw new Error('must not be called');
};

describe('provisionArchModule', () => {
  it('never touches the network under --offline', async () => {
    const out = await provisionArchModule({ offline: true, ensure: neverCalled });
    expect(out).toEqual({ action: 'skipped-offline' });
  });

  it('honours VIBGRATE_NO_KERNEL and a recorded denial before any attempt', async () => {
    process.env.VIBGRATE_NO_KERNEL = '1';
    expect(await provisionArchModule({ ensure: neverCalled })).toEqual({ action: 'disabled' });
    delete process.env.VIBGRATE_NO_KERNEL;
    writeConsent({ arch: 'denied' });
    expect(await provisionArchModule({ ensure: neverCalled })).toEqual({ action: 'declined' });
  });

  it('installs a missing module through the ensure path and reports the version', async () => {
    const ensure = async () => {
      writeFakeModule('2026.9.1', true);
      return { status: 'installed', version: '2026.9.1' };
    };
    expect(await provisionArchModule({ ensure })).toEqual({ action: 'installed', version: '2026.9.1' });
  });

  it('reports unavailable, never throws, when the install fails', async () => {
    const ensure = async () => ({ status: 'unavailable', detail: 'registry 503' });
    expect(await provisionArchModule({ ensure })).toEqual({ action: 'unavailable', detail: 'registry 503' });
    const throwing = async () => {
      throw new Error('boom');
    };
    expect((await provisionArchModule({ ensure: throwing })).action).toBe('unavailable');
  });

  it('leaves a present module alone unless told it is outdated', async () => {
    writeFakeModule('2026.9.1', true);
    expect(await provisionArchModule({ ensure: neverCalled })).toEqual({ action: 'present', version: '2026.9.1' });
  });

  it('updates an outdated module only when the registry has a newer build', async () => {
    writeFakeModule('2026.9.1', false);
    // Registry unreachable → unavailable, nothing reinstalled.
    expect(await provisionArchModule({ outdated: true, latest: failingLatest, reinstall: neverCalled })).toEqual({
      action: 'unavailable',
      detail: 'registry unreachable',
    });
    // Same version published → say so; never force-reinstall the same bytes.
    expect(await provisionArchModule({ outdated: true, latest: async () => '2026.9.1', reinstall: neverCalled })).toEqual({
      action: 'no-newer-version',
      version: '2026.9.1',
      latest: '2026.9.1',
    });
    // Newer version published → reinstall to it.
    const reinstall = async () => {
      writeFakeModule('2026.9.2', true);
      return { status: 'installed', version: '2026.9.2' };
    };
    expect(await provisionArchModule({ outdated: true, latest: async () => '2026.9.2', reinstall })).toEqual({
      action: 'updated',
      from: '2026.9.1',
      version: '2026.9.2',
    });
  });
});

describe('runSecurityPacks with provisioning', () => {
  it('installs a missing module, reloads it and evaluates in the same run', async () => {
    const ensure = async () => {
      writeFakeModule('2026.9.1', true);
      return { status: 'installed', version: '2026.9.1' };
    };
    const run = await runSecurityPacks({ root, packs: ['iac-cis-v1'], provision: { ensure } });
    expect(run.status).toBe('ok');
    expect(run.provision).toEqual({ action: 'installed', version: '2026.9.1' });
    if (run.status === 'ok') {
      expect(run.section.packs['iac-cis-v1']).toBe('1');
      expect(run.section.facts.received).toBeGreaterThan(0);
    }
  });

  it('reports module-missing with the offline reason when --offline skipped provisioning', async () => {
    const run = await runSecurityPacks({ root, packs: ['iac-cis-v1'], provision: { offline: true, ensure: neverCalled } });
    expect(run).toEqual({ status: 'module-missing', provision: { action: 'skipped-offline' } });
  });

  it('reports module-outdated when the update path finds nothing newer', async () => {
    writeFakeModule('2026.9.1', false);
    const run = await runSecurityPacks({
      root,
      packs: ['iac-cis-v1'],
      provision: { latest: async () => '2026.9.1', reinstall: neverCalled },
    });
    expect(run).toEqual({
      status: 'module-outdated',
      version: '2026.9.1',
      provision: { action: 'no-newer-version', version: '2026.9.1', latest: '2026.9.1' },
    });
  });

  it('updates an outdated module and evaluates with the new one', async () => {
    writeFakeModule('2026.9.1', false);
    const reinstall = async () => {
      writeFakeModule('2026.9.2', true);
      return { status: 'installed', version: '2026.9.2' };
    };
    const run = await runSecurityPacks({
      root,
      packs: ['iac-cis-v1'],
      provision: { latest: async () => '2026.9.2', reinstall },
    });
    expect(run.status).toBe('ok');
    expect(run.provision).toEqual({ action: 'updated', from: '2026.9.1', version: '2026.9.2' });
  });

  it('never provisions when a provider is injected', async () => {
    const run = await runSecurityPacks({ root, packs: ['iac-cis-v1'], provider: null, provision: { ensure: neverCalled } });
    expect(run).toEqual({ status: 'module-missing' });
  });
});
