import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isVersionAffected } from '../../core-open/scanners/vulnerability-scanner.js';
import { resolveAdvisoryPlan, type AdvisoryResolutionReport } from './advisory-resolution.js';

function fixture(manifest: Record<string, unknown>, packages: Record<string, Record<string, unknown>>, dependencies: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-adv-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'unit', version: '1.0.0', dependencies }));
  const lockPackages: Record<string, unknown> = { '': { dependencies } };
  for (const [name, entry] of Object.entries(packages)) lockPackages[`node_modules/${name}`] = entry;
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: lockPackages }));
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ npm: manifest }));
  return root;
}

function row(report: AdvisoryResolutionReport, id: string) {
  const found = report.plans[0]?.advisories.find((item) => item.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

describe('resolveAdvisoryPlan', () => {
  it('blocks a peer range and names the peer package and range', () => {
    const root = fixture(
      {
        react: {
          versions: ['18.2.0', '18.3.0'],
          vulns: [{ id: 'GHSA-react-peer', severity: 'moderate', ranges: [{ introduced: '0', fixed: '18.3.0' }] }],
        },
        'react-dom': {
          versions: ['18.2.0'],
          peers: { '18.2.0': { react: '>=18.2.0 <18.3.0' } },
        },
      },
      {
        react: { version: '18.2.0' },
        'react-dom': { version: '18.2.0', peerDependencies: { react: '>=18.2.0 <18.3.0' } },
      },
      { react: '18.2.0', 'react-dom': '18.2.0' },
    );
    try {
      const report = resolveAdvisoryPlan({ rootDir: root, manifest: JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) });
      const peer = row(report, 'GHSA-react-peer');
      expect(peer.status).toBe('blocked');
      expect(peer.plannedVersion).toBeNull();
      expect(peer.reason).toContain('react-dom@18.2.0');
      expect(peer.reason).toContain('react@>=18.2.0 <18.3.0');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not mark an advisory resolved when the merged target is still affected', () => {
    const root = fixture(
      {
        shared: {
          versions: ['1.0.0', '1.0.1', '1.0.2'],
          vulns: [
            { id: 'GHSA-exact', severity: 'low', versions: ['1.0.0', '1.0.2'] },
            { id: 'GHSA-floor', severity: 'high', ranges: [{ introduced: '0', fixed: '1.0.2' }] },
          ],
        },
      },
      { shared: { version: '1.0.0' } },
      { shared: '1.0.0' },
    );
    try {
      const report = resolveAdvisoryPlan({ rootDir: root, manifest: JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) });
      const exact = row(report, 'GHSA-exact');
      const floor = row(report, 'GHSA-floor');
      expect(floor.status).toBe('resolved');
      expect(floor.plannedVersion).toBe('1.0.2');
      expect(exact.status).not.toBe('resolved');
      expect(isVersionAffected('1.0.2', undefined, ['1.0.0', '1.0.2'])).toBe(true);
      expect(exact.reason).toContain('shared');
      expect(exact.reason).toContain('1.0.0, 1.0.2');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks a two-major jump on the balanced policy and allows it on aggressive', () => {
    const manifest = {
      npm: {
        leap: {
          versions: ['1.0.0', '3.0.0'],
          vulns: [{ id: 'GHSA-leap', severity: 'high', ranges: [{ introduced: '0', fixed: '3.0.0' }] }],
        },
      },
    };
    const root = fixture(manifest.npm, { leap: { version: '1.0.0' } }, { leap: '1.0.0' });
    try {
      const balanced = resolveAdvisoryPlan({ rootDir: root, manifest, policy: 'balanced' });
      const aggressive = resolveAdvisoryPlan({ rootDir: root, manifest, policy: 'aggressive' });
      expect(row(balanced, 'GHSA-leap').status).toBe('blocked');
      expect(row(balanced, 'GHSA-leap').reason).toContain('>=1.0.0 <3.0.0');
      expect(row(aggressive, 'GHSA-leap').status).toBe('resolved');
      expect(row(aggressive, 'GHSA-leap').plannedVersion).toBe('3.0.0');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
