import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ingestCycloneDx, ingestSpdx } from './sbom-ingest.js';
import type { FrozenComponent } from './types.js';

const DEEP = 400;
const WIDE = 2000;
const BULK = 2000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixtureDir = path.join(repoRoot, 'test/fixtures/sbom');
const cdxPath = path.join(fixtureDir, 'cyclonedx-no-identifier.json');
const spdxPath = path.join(fixtureDir, 'spdx-no-identifier.json');

function pad(n: number): string {
  return String(n).padStart(4, '0');
}

function load(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

function skipOne(file: string): string {
  return `Skipped 1 component in ${file} because it has no name, no purl, and no CPE. Add a name, and a version and a type when the component has them, or add a purl or a CPE to include it.`;
}

function expectedCdxNames(): string[] {
  return [
    'acme-device',
    'bootloader',
    'both-ids',
    ...Array.from({ length: DEEP }, (_, i) => `deep-${pad(i)}`),
    'detector',
    'left-pad',
    'musl',
    'nested-parent',
    'notes',
    'openssl',
    'shared',
    'shared',
    'vendor/blob.bin',
    'vendor/nested.bin',
    ...Array.from({ length: WIDE }, (_, i) => `wide-${pad(i)}`),
    'wide-root',
  ];
}

function expectedSpdxNames(): string[] {
  return [
    'bootloader',
    'both-ids',
    ...Array.from({ length: BULK }, (_, i) => `bulk-${pad(i)}`),
    'detector',
    'left-pad',
    'musl',
    'notes',
    'openssl',
    'shared',
    'shared',
    'vendor-blob',
  ];
}

function plain(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('identifier-less SBOM input', () => {
  const cdx = load(cdxPath);
  const spdx = load(spdxPath);

  it('keeps CycloneDX components with no purl and no CPE, in a stable order', () => {
    const first = ingestCycloneDx(cdx, 'cyclonedx-no-identifier.json');
    const second = ingestCycloneDx(cdx, 'cyclonedx-no-identifier.json');
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.warning).toBe(skipOne('cyclonedx-no-identifier.json'));
    expect(first.components.map((c) => c.name)).toEqual(expectedCdxNames());

    const by = (name: string, type?: string): FrozenComponent => {
      const found = first.components.find((c) => c.name === name && (type === undefined || c.type === type));
      if (!found) throw new Error(`missing ${name}`);
      return found;
    };

    expect(by('left-pad')).toEqual({ name: 'left-pad', version: '1.3.0', purl: 'pkg:npm/left-pad@1.3.0', ecosystem: 'npm' });
    expect(by('musl')).toEqual({ name: 'musl', version: '1.2.4-r2', purl: 'pkg:apk/alpine/musl@1.2.4-r2', ecosystem: 'Alpine' });
    expect(by('openssl')).toEqual({ name: 'openssl', version: '3.0.0', cpe: 'cpe:2.3:a:openssl:openssl:3.0.0:*:*:*:*:*:*:*' });
    expect(by('both-ids')).toEqual({ name: 'both-ids', version: '1.0.0', purl: 'pkg:npm/both-ids@1.0.0', ecosystem: 'npm' });
    expect(by('acme-device')).toEqual({ name: 'acme-device', version: '1.2.3', type: 'application' });
    expect(by('notes')).toEqual({ name: 'notes', version: '', type: 'file' });
    expect(by('vendor/nested.bin')).toEqual({ name: 'vendor/nested.bin', version: '', type: 'file' });
    expect(first.components.filter((c) => c.name === 'shared').map((c) => c.type)).toEqual(['file', 'firmware']);
    expect(by('deep-0000').type).toBe('file');
    expect(by('deep-0399').version).toBe('1');
    expect(by('wide-0000').name).toBe('wide-0000');
    expect(by('wide-1999').name).toBe('wide-1999');
    expect(first.components.filter((c) => c.name === 'vendor/blob.bin')).toHaveLength(1);
    expect(first.components.some((c) => c.name === 'ghcr.io/acme/device')).toBe(false);
  });

  it('keeps SPDX packages with no purl and no CPE, in a stable order', () => {
    const first = ingestSpdx(spdx, 'spdx-no-identifier.json');
    const second = ingestSpdx(spdx, 'spdx-no-identifier.json');
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.warning).toBe(skipOne('spdx-no-identifier.json'));
    expect(first.components.map((c) => c.name)).toEqual(expectedSpdxNames());

    const by = (name: string, type?: string): FrozenComponent => {
      const found = first.components.find((c) => c.name === name && (type === undefined || c.type === type));
      if (!found) throw new Error(`missing ${name}`);
      return found;
    };

    expect(by('left-pad')).toEqual({ name: 'left-pad', version: '1.3.0', purl: 'pkg:npm/left-pad@1.3.0', ecosystem: 'npm' });
    expect(by('openssl')).toEqual({ name: 'openssl', version: '3.0.0', cpe: 'cpe:2.3:a:openssl:openssl:3.0.0:*:*:*:*:*:*:*' });
    expect(by('both-ids').purl).toBe('pkg:npm/both-ids@1.0.0');
    expect(by('both-ids').cpe).toBeUndefined();
    expect(by('both-ids').type).toBeUndefined();
    expect(by('notes')).toEqual({ name: 'notes', version: '', type: 'FILE' });
    expect(first.components.filter((c) => c.name === 'shared').map((c) => c.type)).toEqual(['FILE', 'FIRMWARE']);
    expect(by('detector').type).toBe('MACHINE-LEARNING-MODEL');
    expect(first.components.filter((c) => c.name === 'vendor-blob')).toHaveLength(1);
    expect(first.components.some((c) => c.name === 'ghcr.io/acme/device' || c.name === 'base-image')).toBe(false);
  });

  it('does not crash or loop on a cycle, a non-string purl, or a deep tree', () => {
    const loop: Record<string, unknown> = { type: 'file', name: 'loop', version: '1' };
    loop.components = [loop, { type: 'file', name: 'child', version: '2' }];
    const cycled = ingestCycloneDx({ components: [loop] }, 'cycle.json');
    expect(cycled.warning).toBeUndefined();
    expect(cycled.components).toEqual([
      { name: 'child', version: '2', type: 'file' },
      { name: 'loop', version: '1', type: 'file' },
    ]);

    const badPurl = ingestCycloneDx(
      { components: [{ type: 'library', name: 'bad-purl', version: '1.2.3', purl: { no: true }, cpe: 5 }] },
      'bad.json',
    );
    expect(badPurl.warning).toBeUndefined();
    expect(badPurl.components).toEqual([{ name: 'bad-purl', version: '1.2.3', type: 'library' }]);

    const wrapped = ingestCycloneDx(
      { components: [{ type: 'application', components: [{ type: 'file', name: 'inside', version: '1' }] }, null] },
      'wrap.json',
    );
    expect(wrapped.components).toEqual([{ name: 'inside', version: '1', type: 'file' }]);
    expect(wrapped.warning).toBe(
      'Skipped 2 components in wrap.json because they have no name, no purl, and no CPE. Add a name, and a version and a type when the component has them, or add a purl or a CPE to include them.',
    );

    let node: Record<string, unknown> = { type: 'file', name: 'n-7999', version: '1' };
    for (let i = 7998; i >= 0; i--) node = { type: 'file', name: `n-${i}`, version: '1', components: [node] };
    const deep = ingestCycloneDx({ components: [node] }, 'deep.json');
    const deepNames = Array.from({ length: 8000 }, (_, i) => `n-${i}`).sort((a, b) => a.localeCompare(b, 'en'));
    expect(deep.warning).toBeUndefined();
    expect(deep.components.map((c) => c.name)).toEqual(deepNames);
  });

  it('sorts by identity, not input order, and stops at the walk limit with one warning', () => {
    const firmware = { type: 'firmware', name: 'shared', version: '1' };
    const file = { type: 'file', name: 'shared', version: '1' };
    const forward = ingestCycloneDx({ components: [firmware, file] }, 'order.json');
    const backward = ingestCycloneDx({ components: [file, firmware] }, 'order.json');
    expect(forward).toEqual(backward);
    expect(forward.components.map((c) => c.type)).toEqual(['file', 'firmware']);

    const limited = ingestCycloneDx(
      {
        components: [
          null,
          { type: 'file', name: 'kept', version: '1' },
          { type: 'file', name: 'dropped', version: '1' },
        ],
      },
      'sample.json',
      2,
    );
    expect(limited.components).toEqual([{ name: 'kept', version: '1', type: 'file' }]);
    expect(limited.warning).toBe(
      'Skipped 1 component in sample.json because it has no name, no purl, and no CPE. Add a name, and a version and a type when the component has them, or add a purl or a CPE to include it. Skipped 1 component in sample.json because the walk stopped at 2 components. Split the document so each file stays within 2 components.',
    );

    const weird = ingestSpdx(
      {
        spdxVersion: 'SPDX-2.3',
        packages: [{ name: 'plain', versionInfo: '1', externalRefs: 'nope', primaryPackagePurpose: 'FILE' }],
      },
      'weird.json',
    );
    expect(weird.warning).toBeUndefined();
    expect(weird.components).toEqual([{ name: 'plain', version: '1', type: 'FILE' }]);
  });

  it('vg evidence release succeeds on both fixtures', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-sbom-id-'));
    const cli = path.join(repoRoot, 'src/cli.ts');
    const run = (args: string[]) => {
      const res = spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', VIBGRATE_NO_KERNEL: '1', VIBGRATE_DSN: '' },
      });
      return { status: res.status, stdout: plain(res.stdout ?? ''), stderr: plain(res.stderr ?? ''), error: res.error };
    };

    const added = run(['evidence', 'product', 'add', 'fixture', '-C', root]);
    expect(added.error).toBeUndefined();
    expect(added.status).toBe(0);

    const cdxRun = run(['evidence', 'release', 'fixture', '1.0.0', '--from', cdxPath, '-C', root]);
    expect(cdxRun.error).toBeUndefined();
    expect(cdxRun.status).toBe(0);
    expect(cdxRun.stdout).toContain('2414 components');
    expect(cdxRun.stderr).toContain('VG_WARN_SBOM_COMPONENT_SKIPPED');
    expect(cdxRun.stderr).toContain(skipOne('cyclonedx-no-identifier.json'));
    expect(cdxRun.stderr).not.toContain('deep-0000');
    expect(cdxRun.stderr).not.toMatch(/\bat (?:readFile|JSON\.parse|node:fs)/);

    const spdxRun = run(['evidence', 'release', 'fixture', '1.0.1', '--from', spdxPath, '-C', root]);
    expect(spdxRun.error).toBeUndefined();
    expect(spdxRun.status).toBe(0);
    expect(spdxRun.stdout).toContain('2010 components');
    expect(spdxRun.stderr).toContain(skipOne('spdx-no-identifier.json'));
    expect(spdxRun.stderr).not.toContain('bulk-0000');

    const cdxManifest = JSON.parse(fs.readFileSync(path.join(root, '.vibgrate/evidence/releases/fixture@1.0.0.json'), 'utf8')) as {
      components: FrozenComponent[];
    };
    const spdxManifest = JSON.parse(fs.readFileSync(path.join(root, '.vibgrate/evidence/releases/fixture@1.0.1.json'), 'utf8')) as {
      components: FrozenComponent[];
    };
    expect(cdxManifest.components).toEqual(ingestCycloneDx(cdx, 'cyclonedx-no-identifier.json').components);
    expect(spdxManifest.components).toEqual(ingestSpdx(spdx, 'spdx-no-identifier.json').components);
  }, 60_000);
});
