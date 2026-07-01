import { describe, it, expect } from 'vitest';
import { prepareArtifactForUpload } from './compact-artifact.js';
import type { ScanArtifact } from '../types.js';

/**
 * Regression: the vulnerability scan the CLI performs (`vg scan --full` / `--vulns`)
 * lives in `extended.vulnerabilities`. Upload compaction must NOT drop it — it is the
 * payload the server-side SCA pipeline reuses instead of re-querying OSV. If a future
 * compaction rule starts pruning `extended`, this guards the manifest→push path.
 */
describe('prepareArtifactForUpload — vulnerability payload survives compaction', () => {
  function artifactWithVulns(): ScanArtifact {
    return {
      schemaVersion: '1.0',
      timestamp: '2026-06-30T00:00:00.000Z',
      vibgrateVersion: 'test',
      rootPath: 'app',
      projects: [],
      drift: { score: 0, riskLevel: 'none', components: {}, measured: true },
      findings: [],
      extended: {
        vulnerabilities: {
          source: 'osv',
          totalAdvisories: 1,
          severityCounts: { low: 0, moderate: 0, high: 1, critical: 0, unknown: 0 },
          packages: [
            {
              ecosystem: 'npm',
              package: 'lodash',
              version: '4.17.20',
              advisories: [
                {
                  id: 'GHSA-x',
                  aliases: ['CVE-2021-1'],
                  summary: 'Prototype pollution',
                  severity: 'high',
                  cvss: 7.5,
                  cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
                  fixedVersions: ['4.17.21'],
                  published: '2021-01-01T00:00:00Z',
                  withdrawn: null,
                  references: ['https://example.com/advisory'],
                },
              ],
            },
          ],
        },
      },
    } as unknown as ScanArtifact;
  }

  it('preserves extended.vulnerabilities byte-for-byte through prepareArtifactForUpload', () => {
    const input = artifactWithVulns();
    const compacted = prepareArtifactForUpload(input);
    const vulnsOf = (a: ScanArtifact): unknown => (a.extended as { vulnerabilities?: unknown } | undefined)?.vulnerabilities;
    expect(vulnsOf(compacted)).toEqual(vulnsOf(input));
    expect(vulnsOf(compacted)).toBeDefined();
  });
});
