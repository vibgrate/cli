/**
 * Blast-radius Review findings — offline, fixture graph only.
 *
 * These are the first deterministic graph findings a PR diff can produce
 * for `proposeFindingFix`. No git, no model, no network.
 */

import { describe, expect, it } from 'vitest';
import { fixtureGraph } from '../code/graph-fixture.js';
import { proposeFindingFix } from './propose.js';
import { MockProvider } from '../code/providers.js';
import type { CodeFs } from '../code/session.js';
import {
  BLAST_PRODUCER,
  CORRECTNESS_KIND,
  blastFindingKey,
  collectBlastRadiusFindings,
  MAX_IMPACT_FINDINGS,
} from './impact-findings.js';
import { capsule, edge, graph, node } from './test-fixtures.js';
import { verifyFindings } from './verify.js';
import { FINDINGS_SCHEMA } from './schemas.js';
import { PATCH_IR_SCHEMA_VERSION, validatePatchIR } from '../code/patch-ir.js';

function memFs(seed: Record<string, string> = {}): CodeFs & { files: Record<string, string | null> } {
  const files: Record<string, string | null> = { ...seed };
  return {
    files,
    read: (f) => (f in files ? files[f] : null),
    write: (f, c) => {
      files[f] = c;
    },
    remove: (f) => {
      files[f] = null;
    },
    appendAudit: () => undefined,
  };
}

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
    verification: [
      {
        evidence_id: 'verify:no_test_covering_change:1',
        kind: 'no_test_covering_change',
        path: 'src/scan.ts',
        detail: 'no test edge reaches this file in the map',
      },
    ],
    evidence: [
      {
        id: 'verify:no_test_covering_change:1',
        kind: 'graph_node',
        path: 'src/scan.ts',
        protected_finding: false,
        note: 'no test edge reaches this file in the map',
      },
    ],
  });
}

describe('collectBlastRadiusFindings', () => {
  it('emits a Review-shaped finding for a changed symbol with a cross-file caller', () => {
    const c = scanCapsule();
    const findings = collectBlastRadiusFindings({ graph: fixtureGraph(), capsule: c });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: 'blast:scanDir',
      kind: CORRECTNESS_KIND,
      finding_key: 'blast:scanDir',
      producer: BLAST_PRODUCER,
      severity: 'low',
      source: 'scanner',
      protected_finding: false,
      target_alignment: 'unknown',
    });
    expect(findings[0]).not.toHaveProperty('review_check_kind');
    expect(findings[0].paths).toContain('src/scan.ts');
    expect(findings[0].paths).toContain('src/report.ts');
    expect(findings[0].claim).toContain('scanDir');
    expect(findings[0].claim).toContain('formatReport');
    expect(findings[0].claim).toMatch(/1 direct/);
    expect(findings[0].remediation).toMatch(/formatReport|exported contract/);
    expect(findings[0].evidence_ids.length).toBeGreaterThan(0);
    expect(findings[0].evidence_ids).toContain('verify:no_test_covering_change:1');
    expect(findings[0].receipts).toEqual(['verify:no_test_covering_change:1']);
    expect(findings[0].confidence).toBeLessThan(0.8);
  });

  it('cites capsule evidence so the findings verifier accepts the document', () => {
    const c = scanCapsule();
    const architecture = collectBlastRadiusFindings({ graph: fixtureGraph(), capsule: c });
    const verified = verifyFindings(
      {
        schema_version: FINDINGS_SCHEMA,
        change_class: ['architecture'],
        architecture_findings: architecture,
        security_findings: [],
        unknowns: [],
        required_checks: [],
      },
      c,
    );
    expect(verified.errors).toEqual([]);
    expect(verified.schema_valid).toBe(true);
    expect(verified.evidence_ids_valid).toBe(true);
  });

  it('skips same-file-only dependents — that is not a blast radius a reviewer can act on', () => {
    const g = graph(
      [node('hub', 'src/a.ts', { name: 'hub' }), node('local', 'src/a.ts', { name: 'local' })],
      [edge('call', 'local', 'hub')],
    );
    const c = capsule({
      change: {
        ...capsule().change,
        symbols: [{ node_id: 'hub', name: 'hub', kind: 'function', path: 'src/a.ts', start_line: 1, end_line: 4 }],
        ops: [{ path: 'src/a.ts', op: 'modified', added_lines: 1, removed_lines: 0 }],
      },
    });
    expect(collectBlastRadiusFindings({ graph: g, capsule: c })).toEqual([]);
  });

  it('skips a changed symbol with no dependents rather than inventing a zero-radius finding', () => {
    const g = graph([node('lonely', 'src/z.ts', { name: 'lonely' })]);
    const c = capsule({
      change: {
        ...capsule().change,
        symbols: [
          { node_id: 'lonely', name: 'lonely', kind: 'function', path: 'src/z.ts', start_line: 1, end_line: 2 },
        ],
        ops: [{ path: 'src/z.ts', op: 'modified', added_lines: 1, removed_lines: 0 }],
      },
    });
    expect(collectBlastRadiusFindings({ graph: g, capsule: c })).toEqual([]);
  });

  it('is deterministic: same graph + symbols yields the same ids and claim text', () => {
    const c = scanCapsule();
    const a = collectBlastRadiusFindings({ graph: fixtureGraph(), capsule: c });
    const b = collectBlastRadiusFindings({ graph: fixtureGraph(), capsule: structuredClone(c) });
    expect(a).toEqual(b);
  });

  it('keeps the same id across different head SHAs for the same symbol/node', () => {
    const shaA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const shaB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const base = scanCapsule();
    const withSha = (head: string): typeof base => ({
      ...base,
      change: { ...base.change, head_sha: head, base_sha: head === shaA ? '1'.repeat(40) : '2'.repeat(40) },
    });
    const a = collectBlastRadiusFindings({ graph: fixtureGraph(), capsule: withSha(shaA) });
    const b = collectBlastRadiusFindings({ graph: fixtureGraph(), capsule: withSha(shaB) });
    expect(a).toHaveLength(1);
    expect(a[0].id).toBe('blast:scanDir');
    expect(a[0].id).toBe(b[0].id);
    expect(a[0].finding_key).toBe(a[0].id);
    expect(a[0].id).not.toMatch(/\s/);
    expect(a[0].id).not.toContain(shaA);
    expect(a[0].id).not.toContain(shaB);
    expect(JSON.stringify(a[0])).not.toContain(shaA);
    expect(JSON.stringify(a[0])).not.toContain(shaB);
    expect(a[0].kind).toBe(CORRECTNESS_KIND);
    expect(Object.keys(a[0]).filter((k) => k === 'kind')).toHaveLength(1);
  });

  it('caps fan-out so a wide change cannot flood the receipt', () => {
    const nodes = [node('hub', 'src/hub.ts', { name: 'hub' })];
    const edges = [];
    for (let i = 0; i < MAX_IMPACT_FINDINGS + 3; i++) {
      const id = `fn${String(i).padStart(2, '0')}`;
      nodes.push(node(id, `src/${id}.ts`, { name: id }));
      // Each extra function is itself a changed symbol with hub as a dependent? 
      // Rank by hub's callers: many files call hub.
      edges.push(edge('call', id, 'hub'));
    }
    const g = graph(nodes, edges);
    const c = capsule({
      change: {
        ...capsule().change,
        symbols: [
          { node_id: 'hub', name: 'hub', kind: 'function', path: 'src/hub.ts', start_line: 1, end_line: 8 },
        ],
        ops: [{ path: 'src/hub.ts', op: 'modified', added_lines: 2, removed_lines: 0 }],
      },
    });
    const findings = collectBlastRadiusFindings({ graph: g, capsule: c });
    expect(findings).toHaveLength(1);
    expect(findings[0].claim).toMatch(/direct/);
    expect(findings[0].severity).toBe('medium');
  });

  it('does not treat an unknown node_id as a zero-radius hit', () => {
    const c = capsule({
      change: {
        ...capsule().change,
        symbols: [
          { node_id: 'missing', name: 'ghost', kind: 'function', path: 'src/x.ts', start_line: 1, end_line: 2 },
        ],
        ops: [{ path: 'src/x.ts', op: 'modified', added_lines: 1, removed_lines: 0 }],
      },
    });
    expect(collectBlastRadiusFindings({ graph: fixtureGraph(), capsule: c })).toEqual([]);
  });
});

describe('blastFindingKey', () => {
  it('prefers blast:{node_id} and never embeds a head SHA or spaces', () => {
    expect(blastFindingKey({ node_id: 'scanDir', path: 'src/scan.ts', name: 'scanDir' })).toBe(
      'blast:scanDir',
    );
    expect(blastFindingKey({ node_id: ' scan Dir ', path: 'src/scan.ts', name: 'scanDir' })).toBe(
      'blast:scanDir',
    );
    const sha = 'cccccccccccccccccccccccccccccccccccccccc';
    expect(blastFindingKey({ node_id: 'hub', path: 'src/hub.ts', name: 'hub' })).not.toContain(sha);
    expect(blastFindingKey({ node_id: 'hub', path: 'src/hub.ts', name: 'hub' })).not.toMatch(/\s/);
  });

  it('falls back to blast:{path}:{name} with a repo-relative path', () => {
    expect(blastFindingKey({ path: './src/scan.ts', name: 'scanDir' })).toBe('blast:src/scan.ts:scanDir');
    expect(blastFindingKey({ node_id: '  ', path: '/src/scan.ts', name: 'scanDir' })).toBe(
      'blast:src/scan.ts:scanDir',
    );
    expect(blastFindingKey({ path: 'src/my file.ts', name: 'my fn' })).toBe('blast:src/myfile.ts:myfn');
    expect(blastFindingKey({ path: 'src/my file.ts', name: 'my fn' })).not.toMatch(/\s/);
  });
});

describe('correctness finding → proposeFindingFix', () => {
  it('dry-run PatchIR from a graph finding without a second loop', async () => {
    const c = scanCapsule();
    const [finding] = collectBlastRadiusFindings({ graph: fixtureGraph(), capsule: c });
    expect(finding).toBeTruthy();
    const body = 'export function scanDir() {\n  const timeout = 0;\n  return timeout;\n}\n';
    const fsImpl = memFs({ 'src/scan.ts': body });
    const r = await proposeFindingFix({
      capsule: c,
      finding,
      policySnippet: finding.remediation,
      modelId: 'relay:hosted-coder',
      root: '/repo',
      graph: fixtureGraph(),
      fsImpl,
      loop: false,
      currentRef: 'refs/heads/feat/impact',
      noCheckpoint: true,
      correlationId: 'rp-impact-01',
      providers: [
        new MockProvider(
          'hosted-coder',
          ['src/scan.ts', '<<<<<<< SEARCH', 'const timeout = 0;', '=======', 'const timeout = 5000;', '>>>>>>> REPLACE'].join(
            '\n',
          ),
        ),
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(false);
    expect(r.stopReason).toBe('finished');
    expect(r.patch?.schemaVersion).toBe(PATCH_IR_SCHEMA_VERSION);
    expect(validatePatchIR(r.patch!).ok).toBe(true);
    expect(r.proposedDiff).toContain('const timeout = 5000');
    expect(fsImpl.files['src/scan.ts']).toBe(body);
  });
});
