/**
 * Publishable correctness rows — id / finding_key stability and App export shape.
 * Offline. Does not import the API package.
 */

import { describe, expect, it } from 'vitest';
import { fixtureGraph } from '../code/graph-fixture.js';
import { BLAST_PRODUCER, blastFindingKey, collectBlastRadiusFindings } from './impact-findings.js';
import {
  BLAST_SCANNER_KIND,
  CORRECTNESS_KIND,
  exportCorrectnessPublishRows,
  publishSeverity,
} from './finding-publish.js';
import { FINDINGS_SCHEMA } from './schemas.js';
import { capsule } from './test-fixtures.js';

function scanCapsule() {
  return capsule({
    change: {
      ...capsule().change,
      symbols: [
        {
          node_id: 'scanDir',
          name: 'scanDir',
          kind: 'function',
          path: 'src/scan.ts',
          start_line: 5,
          end_line: 20,
        },
      ],
      ops: [{ path: 'src/scan.ts', op: 'modified', added_lines: 1, removed_lines: 0 }],
    },
  });
}

describe('blastFindingKey', () => {
  it('prefers blast:{node_id} when the graph node is known', () => {
    expect(blastFindingKey({ node_id: 'scanDir', path: 'src/scan.ts', name: 'scanDir' })).toBe(
      'blast:scanDir',
    );
  });

  it('falls back to blast:{path}:{name} when node_id is absent', () => {
    expect(blastFindingKey({ path: 'src/scan.ts', name: 'scanDir' })).toBe('blast:src/scan.ts:scanDir');
    expect(blastFindingKey({ node_id: '  ', path: './src/scan.ts', name: 'scanDir' })).toBe(
      'blast:src/scan.ts:scanDir',
    );
  });

  it('is stable for the same symbol across calls and strips spaces', () => {
    const symbol = { node_id: 'hub', path: 'src/hub.ts', name: 'hub' };
    expect(blastFindingKey(symbol)).toBe(blastFindingKey({ ...symbol }));
    expect(blastFindingKey({ path: 'src/my file.ts', name: 'my fn' })).toBe('blast:src/myfile.ts:myfn');
    expect(blastFindingKey({ path: 'src/my file.ts', name: 'my fn' })).not.toMatch(/\s/);
  });
});

describe('exportCorrectnessPublishRows', () => {
  it('maps blast-radius rows to kind:correctness with id used as finding_key', () => {
    const c = scanCapsule();
    const architecture = collectBlastRadiusFindings({ graph: fixtureGraph(), capsule: c });
    expect(architecture[0]?.id).toBe('blast:scanDir');
    expect(architecture[0]?.finding_key).toBe('blast:scanDir');
    expect(architecture[0]?.kind).toBe(CORRECTNESS_KIND);
    expect(architecture[0]?.producer).toBe(BLAST_PRODUCER);
    expect(architecture[0]).not.toHaveProperty('review_check_kind');

    const first = exportCorrectnessPublishRows({
      schema_version: FINDINGS_SCHEMA,
      change_class: ['architecture'],
      architecture_findings: architecture,
      security_findings: [],
      unknowns: [],
      required_checks: [],
    });
    const second = exportCorrectnessPublishRows(
      collectBlastRadiusFindings({ graph: fixtureGraph(), capsule: structuredClone(c) }),
    );
    expect(first).toHaveLength(1);
    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      id: 'blast:scanDir',
      finding_key: 'blast:scanDir',
      kind: CORRECTNESS_KIND,
      scanner_kind: BLAST_SCANNER_KIND,
      review_check: 'vibgrate/review',
      severity: 'low',
      source: 'scanner',
      receipts: [],
      suggested_fix: null,
      suggested_fix_status: 'skipped_no_patch',
    });
    expect(first[0]).not.toHaveProperty('review_check_kind');
    expect(first[0].suggested_fix_note).toMatch(/no computed edit/i);
    expect(first[0].paths).toContain('src/scan.ts');
    expect(JSON.stringify(first)).not.toMatch(/cursor|copilot|codeql|semgrep/i);
  });

  it('keeps id identical across different head SHAs for the same symbol/node', () => {
    const shaA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const shaB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const base = scanCapsule();
    const withSha = (head: string) => ({
      ...base,
      change: { ...base.change, head_sha: head },
    });
    const a = collectBlastRadiusFindings({ graph: fixtureGraph(), capsule: withSha(shaA) });
    const b = collectBlastRadiusFindings({ graph: fixtureGraph(), capsule: withSha(shaB) });
    expect(a.map((f) => f.id)).toEqual(['blast:scanDir']);
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
    expect(a[0].id).not.toContain(shaA);
    expect(a[0].id).not.toContain(shaB);
    expect(a[0].id).not.toMatch(/\s/);
    expect(exportCorrectnessPublishRows(a).map((r) => r.id)).toEqual(
      exportCorrectnessPublishRows(b).map((r) => r.id),
    );
    expect(exportCorrectnessPublishRows(a)[0]?.finding_key).toBe('blast:scanDir');
    expect(JSON.stringify(exportCorrectnessPublishRows(a))).not.toContain(shaA);
    expect(JSON.stringify(exportCorrectnessPublishRows(b))).not.toContain(shaB);
  });

  it('keeps id on the symbol when rank would move', () => {
    const c = scanCapsule();
    const a = collectBlastRadiusFindings({ graph: fixtureGraph(), capsule: c });
    const reversed = capsule({
      change: {
        ...c.change,
        symbols: [...c.change.symbols].reverse(),
      },
    });
    const b = collectBlastRadiusFindings({ graph: fixtureGraph(), capsule: reversed });
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
    expect(exportCorrectnessPublishRows(a).map((r) => r.finding_key)).toEqual(
      exportCorrectnessPublishRows(b).map((r) => r.finding_key),
    );
  });

  it('omits non-correctness findings and rows without a blast: or arch: id', () => {
    const rows = exportCorrectnessPublishRows({
      schema_version: FINDINGS_SCHEMA,
      change_class: ['architecture'],
      architecture_findings: [
        {
          id: 'arch-01',
          kind: 'boundary_bypass',
          severity: 'high',
          confidence: 0.9,
          claim: 'skip',
          evidence_ids: ['e'],
          target_alignment: 'regression',
          remediation: 'route',
          paths: ['src/a.ts'],
          source: 'scanner',
        },
        {
          id: 'legacy-impact-01',
          kind: 'blast_radius',
          severity: 'low',
          confidence: 0.6,
          claim: 'old second-kind row',
          evidence_ids: ['e'],
          target_alignment: 'unknown',
          remediation: 'review callers',
          paths: ['src/a.ts'],
          source: 'scanner',
        },
      ],
      security_findings: [],
      unknowns: [],
      required_checks: [],
    });
    expect(rows).toEqual([]);
  });

  it('never publishes high or critical severity', () => {
    expect(publishSeverity('critical')).toBe('low');
    expect(publishSeverity('high')).toBe('low');
    expect(publishSeverity('medium')).toBe('medium');
    expect(publishSeverity('low')).toBe('low');
    const rows = exportCorrectnessPublishRows([
      {
        id: 'blast:hub',
        kind: CORRECTNESS_KIND,
        finding_key: 'blast:hub',
        producer: BLAST_PRODUCER,
        severity: 'critical',
        confidence: 1,
        claim: 'wide fan-out',
        evidence_ids: ['e'],
        target_alignment: 'unknown',
        remediation: 'review callers',
        paths: ['src/hub.ts'],
        source: 'scanner',
      },
    ]);
    expect(rows[0]?.severity).toBe('low');
    expect(rows[0]?.kind).toBe(CORRECTNESS_KIND);
  });

  it('publishes architecture-policy rows as correctness with scanner_kind architecture', () => {
    const rows = exportCorrectnessPublishRows([
      {
        id: 'arch:layered:skip:routing→data-access:src/routes/x.ts:src/repositories/r.ts',
        kind: CORRECTNESS_KIND,
        finding_key: 'arch:layered:skip:routing→data-access:src/routes/x.ts:src/repositories/r.ts',
        producer: 'architecture',
        severity: 'high',
        confidence: 0.93,
        claim: 'A changed routing file depends directly on data-access.',
        evidence_ids: ['edge:1', 'verify:no_test_covering_change:1'],
        receipts: ['verify:no_test_covering_change:1'],
        target_alignment: 'regression',
        remediation: 'Route through the service.',
        paths: ['src/routes/x.ts', 'src/repositories/r.ts'],
        source: 'scanner',
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'arch:layered:skip:routing→data-access:src/routes/x.ts:src/repositories/r.ts',
      finding_key: 'arch:layered:skip:routing→data-access:src/routes/x.ts:src/repositories/r.ts',
      kind: CORRECTNESS_KIND,
      scanner_kind: 'architecture',
      severity: 'high',
      receipts: ['verify:no_test_covering_change:1'],
      suggested_fix: null,
      suggested_fix_status: 'skipped_no_patch',
    });
    expect(rows[0].id).not.toMatch(/\s/);
    expect(JSON.stringify(rows)).not.toMatch(/critical/);
  });

  it('clamps architecture critical to high, never invents critical on publish', () => {
    const rows = exportCorrectnessPublishRows([
      {
        id: 'arch:peer_deviation:src/a.ts',
        kind: CORRECTNESS_KIND,
        producer: 'architecture',
        severity: 'critical',
        confidence: 1,
        claim: 'peers differ',
        evidence_ids: ['e'],
        target_alignment: 'unknown',
        remediation: 'follow peers',
        paths: ['src/a.ts'],
        source: 'scanner',
      },
    ]);
    expect(rows[0]?.severity).toBe('low');
    expect(rows[0]?.scanner_kind).toBe('architecture');
  });
});
