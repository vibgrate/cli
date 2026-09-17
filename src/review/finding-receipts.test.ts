/**
 * Offline gold: verification-receipt attach + architecture-policy findings.
 * Fixture capsules only — no git, no model, no network.
 */

import { describe, expect, it } from 'vitest';
import { fixtureGraph } from '../code/graph-fixture.js';
import { collectBlastRadiusFindings, CORRECTNESS_KIND } from './impact-findings.js';
import {
  ARCH_PRODUCER,
  archFindingKey,
  attachVerificationReceipts,
  collectVerificationReceiptIds,
} from './finding-receipts.js';
import { ARCH_SCANNER_KIND, BLAST_SCANNER_KIND, exportCorrectnessPublishRows } from './finding-publish.js';
import { FINDINGS_SCHEMA } from './schemas.js';
import { runScanners, type ScanInput } from './scanners.js';
import { capsule, changeSet, config } from './test-fixtures.js';
import { verifyFindings } from './verify.js';

function scanInput(overrides: Partial<ScanInput> = {}): ScanInput {
  return {
    root: '/repo',
    capsule: capsule(),
    change: changeSet([]),
    config: config(),
    removedLines: new Map(),
    fileText: new Map(),
    vulnerablePackages: [],
    ...overrides,
  };
}

function verifiedCapsule() {
  return capsule({
    change: {
      ...capsule().change,
      head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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
      ops: [
        { path: 'src/scan.ts', op: 'modified', added_lines: 1, removed_lines: 0 },
        { path: 'src/routes/x.ts', op: 'modified', added_lines: 1, removed_lines: 0 },
      ],
      added_edges: [
        {
          evidence_id: 'edge:1',
          kind: 'import',
          from_path: 'src/routes/x.ts',
          to_path: 'src/repositories/r.ts',
          from_layer: 'routing',
          to_layer: 'data-access',
        },
      ],
    },
    policies: [
      { evidence_id: 'policy:layering:1', id: 'layering-1', rule: 'outer layers flow one way', source: 'review.toml' },
    ],
    verification: [
      {
        evidence_id: 'verify:no_test_covering_change:1',
        kind: 'no_test_covering_change',
        path: 'src/routes/x.ts',
        detail: 'no test edge reaches this file in the map',
      },
      {
        evidence_id: 'verify:test_covering_change:2',
        kind: 'test_covering_change',
        path: 'src/scan.ts',
        detail: 'covered',
      },
    ],
    evidence: [
      { id: 'edge:1', kind: 'graph_edge', path: 'src/routes/x.ts', protected_finding: false },
      { id: 'policy:layering:1', kind: 'policy', protected_finding: false },
      {
        id: 'verify:no_test_covering_change:1',
        kind: 'graph_node',
        path: 'src/routes/x.ts',
        protected_finding: false,
        note: 'no test edge reaches this file in the map',
      },
      {
        id: 'verify:test_covering_change:2',
        kind: 'graph_node',
        path: 'src/scan.ts',
        protected_finding: false,
        note: 'covered',
      },
    ],
  });
}

describe('archFindingKey', () => {
  it('uses the pack rule + repo-relative path and strips spaces', () => {
    expect(archFindingKey('layered:skip:routing→data-access', 'src/routes/x.ts', 'src/repositories/r.ts')).toBe(
      'arch:layered:skip:routing→data-access:src/routes/x.ts:src/repositories/r.ts',
    );
    expect(archFindingKey('peer_deviation', './src/my file.ts')).toBe('arch:peer_deviation:src/myfile.ts');
    expect(archFindingKey('peer_deviation', 'src/my file.ts')).not.toMatch(/\s/);
  });

  it('is stable across head SHAs — the key never contains a commit', () => {
    const sha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const key = archFindingKey('unverified_change', 'src/a.ts');
    expect(key).toBe('arch:unverified_change:src/a.ts');
    expect(key).not.toContain(sha);
    expect(archFindingKey('unverified_change', 'src/a.ts')).toBe(key);
  });
});

describe('attachVerificationReceipts', () => {
  it('cites existing capsule verification facts for overlapping paths', () => {
    const c = verifiedCapsule();
    const attached = attachVerificationReceipts(
      {
        id: 'arch:peer_deviation:src/routes/x.ts',
        kind: CORRECTNESS_KIND,
        producer: ARCH_PRODUCER,
        severity: 'medium',
        confidence: 0.6,
        claim: 'peers differ',
        evidence_ids: ['vote:role:routing'],
        target_alignment: 'unknown',
        remediation: 'follow peers',
        paths: ['src/routes/x.ts'],
        source: 'scanner',
      },
      c,
    );
    expect(attached.receipts).toEqual(['verify:no_test_covering_change:1']);
    expect(attached.evidence_ids).toContain('verify:no_test_covering_change:1');
    expect(attached.evidence_ids).not.toContain('verify:test_covering_change:2');
  });

  it('does not invent a receipt when the capsule has no verification for that path', () => {
    const c = capsule();
    const attached = attachVerificationReceipts(
      {
        id: 'arch:peer_deviation:src/z.ts',
        kind: CORRECTNESS_KIND,
        producer: ARCH_PRODUCER,
        severity: 'low',
        confidence: 0.5,
        claim: 'observation',
        evidence_ids: ['e'],
        target_alignment: 'unknown',
        remediation: 'review',
        paths: ['src/z.ts'],
        source: 'scanner',
      },
      c,
    );
    expect(attached.receipts).toEqual([]);
    expect(attached.evidence_ids).toEqual(['e']);
    expect(collectVerificationReceiptIds(c, ['src/z.ts'])).toEqual([]);
  });
});

describe('architecture-policy findings (offline gold)', () => {
  it('emits kind:correctness architecture rows with stable ids and attached receipts', () => {
    const c = verifiedCapsule();
    const out = runScanners(scanInput({ capsule: c, graph: fixtureGraph() }));
    const arch = out.architecture.filter((f) => f.producer === ARCH_PRODUCER);
    const blast = out.architecture.filter((f) => f.producer === 'blast_radius');
    expect(arch.length).toBeGreaterThan(0);
    expect(blast).toHaveLength(1);
    expect(arch.every((f) => f.kind === CORRECTNESS_KIND)).toBe(true);
    expect(arch.every((f) => f.id.startsWith('arch:'))).toBe(true);
    expect(arch.every((f) => f.finding_key === f.id)).toBe(true);
    expect(arch.every((f) => !/\s/.test(f.id))).toBe(true);
    expect(arch.every((f) => f.severity !== 'critical')).toBe(true);

    const skip = arch.find((f) => f.id.includes('layered:skip'));
    expect(skip).toBeDefined();
    expect(skip!.receipts).toEqual(['verify:no_test_covering_change:1']);
    expect(skip!.evidence_ids).toContain('verify:no_test_covering_change:1');

    const uncovered = arch.find((f) => f.id === 'arch:unverified_change:src/routes/x.ts');
    expect(uncovered).toBeDefined();
    expect(uncovered!.receipts).toEqual(['verify:no_test_covering_change:1']);

    const verified = verifyFindings(
      {
        schema_version: FINDINGS_SCHEMA,
        change_class: ['architecture'],
        architecture_findings: out.architecture,
        security_findings: [],
        unknowns: [],
        required_checks: [],
      },
      c,
    );
    expect(verified.errors).toEqual([]);
    expect(verified.evidence_ids_valid).toBe(true);
  });

  it('keeps architecture ids identical across different head SHAs', () => {
    const base = verifiedCapsule();
    const shaB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const a = runScanners(scanInput({ capsule: base })).architecture.filter((f) => f.producer === ARCH_PRODUCER);
    const b = runScanners(
      scanInput({
        capsule: { ...base, change: { ...base.change, head_sha: shaB } },
      }),
    ).architecture.filter((f) => f.producer === ARCH_PRODUCER);
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
    expect(JSON.stringify(a.map((f) => f.id))).not.toContain(base.change.head_sha);
    expect(JSON.stringify(b.map((f) => f.id))).not.toContain(shaB);
  });

  it('exports blast + architecture publishable rows with receipts when the capsule has them', () => {
    const c = verifiedCapsule();
    const architecture = [
      ...runScanners(scanInput({ capsule: c })).architecture,
      ...collectBlastRadiusFindings({ graph: fixtureGraph(), capsule: structuredClone(c) }),
    ];
    const rows = exportCorrectnessPublishRows({
      schema_version: FINDINGS_SCHEMA,
      change_class: ['architecture'],
      architecture_findings: architecture,
      security_findings: [],
      unknowns: [],
      required_checks: [],
    });
    const kinds = [...new Set(rows.map((r) => r.scanner_kind))].sort();
    expect(kinds).toEqual([ARCH_SCANNER_KIND, BLAST_SCANNER_KIND].sort());
    expect(rows.every((r) => r.kind === CORRECTNESS_KIND)).toBe(true);
    expect(rows.some((r) => r.scanner_kind === BLAST_SCANNER_KIND && r.severity !== 'high')).toBe(true);
    const archRow = rows.find((r) => r.scanner_kind === ARCH_SCANNER_KIND && r.id.includes('layered:skip'));
    expect(archRow?.receipts).toEqual(['verify:no_test_covering_change:1']);
    expect(archRow?.severity).toBe('high');
    const blastRow = rows.find((r) => r.scanner_kind === BLAST_SCANNER_KIND);
    expect(blastRow?.id).toBe('blast:scanDir');
    expect(blastRow?.receipts).toEqual(['verify:test_covering_change:2']);
    expect(JSON.stringify(rows)).not.toMatch(/cursor|copilot|codeql|semgrep/i);
  });
});
