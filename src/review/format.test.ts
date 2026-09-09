import { beforeAll, describe, expect, it } from 'vitest';
import { disableColor } from '../util/output.js';
import { formatExplain, formatMarkdown, formatSarif, formatText } from './format.js';
import type { RunReviewResult } from './run.js';
import { CAPSULE_SCHEMA, RECEIPT_SCHEMA, REVIEW_POLICY_VERSION, type ReviewReceipt } from './schemas.js';
import { capsule, config, finding, findings } from './test-fixtures.js';

// Snapshots must not depend on whether the test runner's stdout is a TTY.
beforeAll(() => disableColor());

// ── one receipt, rendered four ways ─────────────────────────────────────────

const ARCH = finding({
  id: 'arch-01',
  kind: 'boundary_bypass',
  severity: 'high',
  confidence: 0.93,
  claim: 'A changed routing file depends directly on data-access, skipping middleware, services (src/routes/x.ts → src/repositories/r.ts).',
  evidence_ids: ['edge:1', 'policy:layering:1'],
  remediation: 'Route the operation through the application service layer instead of calling data-access directly.',
  paths: ['src/routes/x.ts', 'src/repositories/r.ts'],
  protected_finding: false,
});
const DUP = finding({
  id: 'arch-02',
  kind: 'duplicate_implementation',
  severity: 'medium',
  confidence: 0.81,
  claim: 'computeBillSum in src/orders.ts is structurally 81% the same as calculateTotal in src/billing.ts:10 | see both.',
  evidence_ids: ['duplicate:src/orders.ts:computeBillSum'],
  target_alignment: 'unknown',
  remediation: 'Call calculateTotal instead, or extract the shared behaviour if the two genuinely differ.',
  paths: ['src/orders.ts', 'src/billing.ts'],
});
const GUARD = finding({
  id: 'sec-01',
  kind: 'guard_removed',
  severity: 'high',
  confidence: 0.9,
  claim: 'An authorization or validation guard was removed from src/routes/x.ts and no equivalent guard remains in the file.',
  evidence_ids: ['role:routing:1'],
  remediation: 'Restore the guard, or move it to a middleware the changed path provably passes through.',
  paths: ['src/routes/x.ts'],
  protected_finding: true,
});
const LOW = finding({
  id: 'sec-02',
  kind: 'unguarded_entrypoint',
  severity: 'low',
  confidence: 0.5,
  claim: 'POST /ping has no authorization guard in scope, while 2 of 3 mutating routes in src/routes do (no-guard-in-scope).',
  evidence_ids: ['missing:evidence'],
  remediation: 'Add an authorization check.',
  paths: ['src/routes/ping.ts'],
  protected_finding: false,
});

function receipt(overrides: Partial<ReviewReceipt> = {}): ReviewReceipt {
  return {
    schema_version: RECEIPT_SCHEMA,
    receipt_id: 'rvw_01J6C3Z0000ABCDEF0123456',
    created_at: '2026-08-27T10:00:00.000Z',
    workspace_id: null,
    repo: { name: 'acme/ledger', remote: 'github.com/acme/ledger', repo_key: 'sha256:' + 'k'.repeat(64) },
    git: {
      base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
      merge_base: 'a'.repeat(40),
      ref: 'refs/heads/feat/invoices',
      dirty: false,
      dirty_tree_hash: null,
    },
    decision: 'fail',
    enforcement: 'advisory',
    quick_path: false,
    change_class: ['architecture', 'security'],
    counts: { architecture: 2, security: 2, protected: 1, unknowns: 1 },
    findings: findings({
      change_class: ['architecture', 'security'],
      architecture_findings: [ARCH, DUP],
      security_findings: [GUARD, LOW],
      unknowns: ['Guard presence along the changed call paths was not observed — no runtime authorization test was supplied.'],
      required_checks: ['authz-test', 'changed-call-path-test'],
    }),
    versions: {
      cli: '2026.1.0-test',
      graph_schema: 'vg-graph/1.1',
      policy: REVIEW_POLICY_VERSION,
      model: 'none',
      quantization: null,
      capsule_schema: CAPSULE_SCHEMA,
    },
    digests: {
      capsule: 'sha256:' + 'c'.repeat(64),
      findings: 'sha256:' + 'f'.repeat(64),
      evidence: 'sha256:' + 'e'.repeat(64),
      receipt: 'sha256:' + 'd'.repeat(64),
    },
    verification: { protected_false_bless: false, schema_valid: true, evidence_ids_valid: true },
    signature: null,
    ...overrides,
  };
}

function result(overrides: Partial<RunReviewResult> = {}): RunReviewResult {
  return {
    receipt: receipt(),
    capsule: capsule({
      evidence: [
        { id: 'edge:1', kind: 'graph_edge', path: 'src/routes/x.ts', start_line: 12, end_line: 20, protected_finding: false, note: 'import → src/repositories/r.ts' },
        { id: 'policy:layering:1', kind: 'policy', protected_finding: false, note: 'outer layers flow one way' },
        { id: 'role:routing:1', kind: 'role', path: 'src/routes/x.ts', protected_finding: false, note: 'routing (routing, confidence 0.80)' },
        { id: 'duplicate:src/orders.ts:computeBillSum', kind: 'graph_node', path: 'src/billing.ts', start_line: 10, end_line: 10, protected_finding: false },
      ],
    }),
    config: config(),
    verification: { schema_valid: true, evidence_ids_valid: true, errors: [] },
    reasons: ['1 protected finding(s) are unresolved: guard_removed'],
    budget: { estimatedTokens: 1234, median: 3000, cap: 16000, trimmed: false },
    votes: [],
    intent: { target: null, sources: [] },
    repoRoot: '/repo',
    ...overrides,
  };
}

const empty = (): RunReviewResult =>
  result({
    receipt: receipt({
      decision: 'pass',
      quick_path: true,
      change_class: ['none'],
      counts: { architecture: 0, security: 0, protected: 0, unknowns: 0 },
      findings: findings({ change_class: ['none'] }),
      git: { ...receipt().git, dirty: true, merge_base: null },
    }),
    reasons: ['no material architectural or security-control delta in this change set'],
  });

// ── text ────────────────────────────────────────────────────────────────────

describe('formatText', () => {
  it('renders the human report', () => {
    expect(formatText(result())).toMatchSnapshot();
  });

  it('leads with the decision, marks protected findings, and never certifies', () => {
    const text = formatText(result());
    expect(text.split('\n')[0]).toBe('vg review · fail · advisory');
    expect(text).toContain('bbbbbbbb vs aaaaaaaa (merge-base) · architecture, security');
    expect(text).toContain('sec-01 protected guard_removed');
    expect(text).toContain('arch-01 high boundary_bypass');
    expect(text).toContain('arch-02 medium duplicate_implementation');
    expect(text).toContain('unknowns');
    expect(text).toContain('required checks: authz-test, changed-call-path-test');
    expect(text).toContain('policy: 1 protected finding(s) are unresolved: guard_removed');
    expect(text).toContain('capsule ~1234 tokens (median target 3000, cap 16000)');
    expect(text).toContain('absence of findings is not a certification');
  });

  it('says so plainly when there is nothing to report, and names the working tree', () => {
    const text = formatText(empty());
    expect(text).toContain('vg review · pass · advisory');
    expect(text).toContain('working tree vs aaaaaaaa · none');
    expect(text).toContain('no architecture or security-control findings');
    expect(text).not.toContain('unknowns');
    expect(text).not.toContain('required checks');
  });

  it('flags a trimmed capsule', () => {
    expect(formatText(result({ budget: { estimatedTokens: 17000, median: 3000, cap: 16000, trimmed: true } }))).toContain(', trimmed)');
  });
});

// ── markdown ────────────────────────────────────────────────────────────────

describe('formatMarkdown', () => {
  it('renders the PR summary', () => {
    expect(formatMarkdown(result())).toMatchSnapshot();
  });

  it('carries the counts table, marks protected rows, and escapes table cells', () => {
    const md = formatMarkdown(result());
    expect(md.startsWith('## Vibgrate Review — `fail`')).toBe(true);
    expect(md).toContain('`aaaaaaaa` → `bbbbbbbb` · enforcement `advisory`');
    expect(md).toContain('| architecture | security | protected | unknowns |');
    expect(md).toContain('| 2 | 2 | 1 | 1 |');
    expect(md).toContain('| `sec-01` | guard_removed **(protected)** | high | regression |');
    // A pipe inside a claim must not break the table.
    expect(md).toContain('src/billing.ts:10 \\| see both.');
    expect(md).toContain('**Unknowns**');
    expect(md).toContain('- Guard presence along the changed call paths');
    expect(md).toContain('does not prove code is secure');
  });

  it('reports an empty review without a findings table', () => {
    const md = formatMarkdown(empty());
    expect(md).toContain('## Vibgrate Review — `pass`');
    expect(md).toContain('(working tree)');
    expect(md).toContain('No architecture or security-control findings.');
    expect(md).not.toContain('| id | kind |');
    expect(md).not.toContain('**Unknowns**');
  });

  it('spells decisions the way a human reads them', () => {
    expect(formatMarkdown(result({ receipt: receipt({ decision: 'needs_review' }) }))).toContain('`needs review`');
    expect(formatMarkdown(result({ receipt: receipt({ decision: 'undetermined' }) }))).toContain('`undetermined`');
  });
});

// ── SARIF ───────────────────────────────────────────────────────────────────

interface Sarif {
  $schema: string;
  version: string;
  runs: {
    tool: { driver: { name: string; version: string; informationUri: string; rules: { id: string; name: string; shortDescription: { text: string }; fullDescription: { text: string }; defaultConfiguration: { level: string }; properties: { tags: string[] } }[] } };
    automationDetails: { id: string };
    results: { ruleId: string; level: string; message: { text: string }; locations: { physicalLocation: { artifactLocation: { uri: string } } }[]; properties: Record<string, unknown> }[];
  }[];
}

describe('formatSarif', () => {
  it('renders the code-scanning document', () => {
    expect(formatSarif(receipt())).toMatchSnapshot();
  });

  it('has the SARIF 2.1.0 shape', () => {
    const doc = JSON.parse(formatSarif(receipt())) as Sarif;
    expect(doc.$schema).toBe('https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json');
    expect(doc.version).toBe('2.1.0');
    expect(doc.runs).toHaveLength(1);
    const [run] = doc.runs;
    expect(run.tool.driver).toMatchObject({ name: 'Vibgrate Review', version: '2026.1.0-test', informationUri: 'https://vibgrate.com/review' });
    expect(run.automationDetails.id).toBe(`vibgrate-review/${'b'.repeat(40)}`);
    const ruleIds = new Set(run.tool.driver.rules.map((r) => r.id));
    for (const rule of run.tool.driver.rules) {
      expect(rule).toMatchObject({ name: rule.id, shortDescription: { text: expect.any(String) }, fullDescription: { text: expect.any(String) } });
      expect(['error', 'warning', 'note', 'none']).toContain(rule.defaultConfiguration.level);
      expect(rule.properties.tags).toEqual(['security', 'vibgrate-review']);
    }
    for (const r of run.results) {
      expect(ruleIds.has(r.ruleId)).toBe(true);
      expect(['error', 'warning', 'note', 'none']).toContain(r.level);
      expect(typeof r.message.text).toBe('string');
      expect(r.locations.length).toBeGreaterThan(0);
      for (const loc of r.locations) expect(typeof loc.physicalLocation.artifactLocation.uri).toBe('string');
    }
  });

  it('contains security findings only — architecture stays on the receipt', () => {
    const doc = JSON.parse(formatSarif(receipt())) as Sarif;
    const [run] = doc.runs;
    expect(run.results.map((r) => r.properties.findingId)).toEqual(['sec-01', 'sec-02']);
    expect(run.results.map((r) => r.ruleId)).toEqual(['guard_removed', 'unguarded_entrypoint']);
    expect(run.tool.driver.rules.map((r) => r.id)).toEqual(['guard_removed', 'unguarded_entrypoint']);
    expect(formatSarif(receipt())).not.toContain('boundary_bypass');
    expect(formatSarif(receipt())).not.toContain('duplicate_implementation');
  });

  it('maps protected and high findings to error, medium to warning, low to note', () => {
    const r = receipt({
      findings: findings({
        security_findings: [
          GUARD,
          finding({ id: 'sec-02', kind: 'a', severity: 'medium', protected_finding: false }),
          finding({ id: 'sec-03', kind: 'b', severity: 'low', protected_finding: false }),
          finding({ id: 'sec-04', kind: 'c', severity: 'low', protected_finding: true }),
          finding({ id: 'sec-05', kind: 'd', severity: 'critical', protected_finding: false }),
        ],
      }),
    });
    const [run] = (JSON.parse(formatSarif(r)) as Sarif).runs;
    expect(run.results.map((x) => x.level)).toEqual(['error', 'warning', 'note', 'error', 'error']);
    expect(run.results.map((x) => x.properties.protectedFinding)).toEqual([true, false, false, true, false]);
  });

  it('points each result at every path the finding names and carries the review properties', () => {
    const [run] = (JSON.parse(formatSarif(receipt())) as Sarif).runs;
    expect(run.results[0].locations).toEqual([{ physicalLocation: { artifactLocation: { uri: 'src/routes/x.ts' } } }]);
    expect(run.results[0].properties).toEqual({
      findingId: 'sec-01',
      confidence: 0.9,
      targetAlignment: 'regression',
      protectedFinding: true,
      remediation: GUARD.remediation,
    });
  });

  it('dedupes rules by kind and produces an empty run for a clean receipt', () => {
    const two = receipt({ findings: findings({ security_findings: [GUARD, { ...GUARD, id: 'sec-09' }] }) });
    expect((JSON.parse(formatSarif(two)) as Sarif).runs[0].tool.driver.rules).toHaveLength(1);
    const [run] = (JSON.parse(formatSarif(empty().receipt)) as Sarif).runs;
    expect(run.results).toEqual([]);
    expect(run.tool.driver.rules).toEqual([]);
  });
});

// ── explain ─────────────────────────────────────────────────────────────────

describe('formatExplain', () => {
  it('renders the evidence behind one finding', () => {
    expect(formatExplain(result(), 'arch-01')).toMatchSnapshot();
  });

  it('returns null for a finding id that is not in the receipt', () => {
    expect(formatExplain(result(), 'arch-99')).toBeNull();
  });

  it('shows every evidence span with its note, and marks a protected finding as merge-blocking', () => {
    const text = formatExplain(result(), 'sec-01')!;
    expect(text).toContain('sec-01 high guard_removed');
    expect(text).toContain('protected:   yes — policy cannot pass while it is unresolved');
    expect(text).toContain('produced by: scanner');
    expect(text).toContain('role:routing:1 role src/routes/x.ts');
    expect(text).toContain('routing (routing, confidence 0.80)');

    const arch = formatExplain(result(), 'arch-01')!;
    expect(arch).toContain('edge:1 graph_edge src/routes/x.ts:12-20');
    expect(arch).toContain('policy:layering:1 policy ');
    expect(arch).toContain('protected:   no');
  });

  it('collapses a single-line span and finds security findings too', () => {
    expect(formatExplain(result(), 'arch-02')).toContain('src/billing.ts:10');
    expect(formatExplain(result(), 'arch-02')).not.toContain('src/billing.ts:10-10');
  });

  it('flags evidence the capsule does not hold instead of inventing it', () => {
    const text = formatExplain(result(), 'sec-02')!;
    expect(text).toContain('missing:evidence — not present in the capsule (this finding failed verification)');
  });
});
