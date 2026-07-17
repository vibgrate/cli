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

/**
 * Regression: a large monorepo can surface hundreds of tables and thousands
 * of columns through the `databaseSchema` extended scanner. Upload
 * compaction must cap it the same way it caps every other unbounded scanner
 * result, or one schema-heavy repo can dominate the artifact payload.
 */
describe('prepareArtifactForUpload — databaseSchema is capped', () => {
  function artifactWithDatabaseSchema(modelCount: number, fieldsPerModel: number): ScanArtifact {
    return {
      schemaVersion: '1.0',
      timestamp: '2026-06-30T00:00:00.000Z',
      vibgrateVersion: 'test',
      rootPath: 'app',
      projects: [],
      drift: { score: 0, riskLevel: 'none', components: {}, measured: true },
      findings: [],
      extended: {
        databaseSchema: {
          providers: ['postgresql'],
          models: Array.from({ length: modelCount }, (_, i) => ({
            name: `Model${i}`,
            fields: Array.from({ length: fieldsPerModel }, (_, j) => ({
              name: `field${j}`,
              type: 'String',
              isList: false,
              isOptional: false,
              isRelation: false,
              isId: false,
              isUnique: false,
            })),
            source: 'sql-migration',
            files: ['a.sql', 'b.sql', 'c.sql', 'd.sql', 'e.sql', 'f.sql'],
          })),
          enums: [],
          filesScanned: Array.from({ length: 600 }, (_, i) => `migrations/${i}.sql`),
          projects: [],
        },
      },
    } as unknown as ScanArtifact;
  }

  it('caps models, fields-per-model, per-model files, and filesScanned', () => {
    const input = artifactWithDatabaseSchema(400, 150);
    const compacted = prepareArtifactForUpload(input);
    const dbOf = (a: ScanArtifact) => (a.extended as { databaseSchema?: { models: { fields: unknown[]; files: unknown[] }[]; filesScanned: unknown[] } } | undefined)?.databaseSchema;
    const db = dbOf(compacted);
    expect(db).toBeDefined();
    expect(db!.models.length).toBe(300);
    expect(db!.models[0].fields.length).toBe(100);
    expect(db!.models[0].files.length).toBe(5);
    expect(db!.filesScanned.length).toBe(500);
  });

  it('leaves a small schema untouched', () => {
    const input = artifactWithDatabaseSchema(2, 3);
    const compacted = prepareArtifactForUpload(input);
    const dbOf = (a: ScanArtifact) => (a.extended as { databaseSchema?: { models: unknown[] } } | undefined)?.databaseSchema;
    expect(dbOf(compacted)?.models.length).toBe(2);
  });

  it('honors a configured databaseSchemaCaps override (scanners.databaseSchema in vibgrate.config.ts)', () => {
    const input = artifactWithDatabaseSchema(400, 150);
    const compacted = prepareArtifactForUpload(input, { databaseSchemaCaps: { maxModels: 350, maxFieldsPerModel: 120 } });
    const dbOf = (a: ScanArtifact) => (a.extended as { databaseSchema?: { models: { fields: unknown[] }[] } } | undefined)?.databaseSchema;
    const db = dbOf(compacted);
    expect(db!.models.length).toBe(350);
    expect(db!.models[0].fields.length).toBe(120);
  });

  it('clamps a configured cap to the hard ceiling instead of honoring an unbounded override', () => {
    const input = artifactWithDatabaseSchema(2500, 3);
    const compacted = prepareArtifactForUpload(input, { databaseSchemaCaps: { maxModels: 1_000_000 } });
    const dbOf = (a: ScanArtifact) => (a.extended as { databaseSchema?: { models: unknown[] } } | undefined)?.databaseSchema;
    expect(dbOf(compacted)?.models.length).toBe(2000);
  });
});
