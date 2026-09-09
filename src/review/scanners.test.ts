import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_REVIEW_CONFIG } from './config.js';
import type { DominanceVote } from './dominance.js';
import { runScanners, vulnerablePackagesFromScan, type ScanInput } from './scanners.js';
import { SimilarityIndex, type FunctionBody } from './similarity.js';
import type { AnalysisCapsule, CapsuleChangeEdge } from './schemas.js';
import { capsule, changeSet, config } from './test-fixtures.js';

// ── fixtures ────────────────────────────────────────────────────────────────

function input(overrides: Partial<ScanInput> = {}): ScanInput {
  return {
    root: '/repo',
    capsule: capsule(),
    change: changeSet([]),
    config: config(),
    removedLines: new Map(),
    fileText: new Map(),
    // "checked, none found" — so no rule below trips on the advisory unknown
    // unless a test asks for it with `null`.
    vulnerablePackages: [],
    ...overrides,
  };
}

function addedEdge(from: string, to: string, fromLayer: string, toLayer: string): CapsuleChangeEdge {
  return { evidence_id: 'edge:1', kind: 'import', from_path: from, to_path: to, from_layer: fromLayer, to_layer: toLayer };
}

/** A capsule carrying one added edge, with the evidence every finding must cite. */
function edgeCapsule(edge: CapsuleChangeEdge, overrides: Partial<AnalysisCapsule> = {}): AnalysisCapsule {
  return capsule({
    change: { ...capsule().change, added_edges: [edge], ops: [{ path: edge.from_path, op: 'modified', added_lines: 1, removed_lines: 0 }] },
    policies: [{ evidence_id: 'policy:layering:1', id: 'layering-1', rule: 'outer layers flow one way', source: 'review.toml' }],
    evidence: [
      { id: 'edge:1', kind: 'graph_edge', path: edge.from_path, protected_finding: false },
      { id: 'policy:layering:1', kind: 'policy', protected_finding: false },
    ],
    ...overrides,
  });
}

const patterns = (declared: string | null, observed: string | null, exceptions: string[] = []) => ({
  observed_dominant_pattern: observed,
  declared_target_pattern: declared,
  approved_exceptions: exceptions,
  legacy_pattern: null,
  unknown: declared === null && observed === null,
});

const protectedOff = (rule: keyof typeof DEFAULT_REVIEW_CONFIG.protected) =>
  config({ protected: { ...DEFAULT_REVIEW_CONFIG.protected, [rule]: false } });

// ── 1. boundary bypass ──────────────────────────────────────────────────────

describe('boundary_bypass', () => {
  it('flags a tier skip against a declared layered target as a high-confidence regression', () => {
    const c = edgeCapsule(addedEdge('src/routes/x.ts', 'src/repositories/r.ts', 'routing', 'data-access'));
    const out = runScanners(input({ capsule: c }));
    expect(out.architecture).toHaveLength(1);
    expect(out.architecture[0]).toMatchObject({
      id: 'arch-01',
      kind: 'boundary_bypass',
      severity: 'high',
      confidence: 0.93,
      target_alignment: 'regression',
      protected_finding: false,
      source: 'scanner',
      paths: ['src/routes/x.ts', 'src/repositories/r.ts'],
      evidence_ids: ['edge:1', 'policy:layering:1'],
    });
    expect(out.architecture[0].claim).toContain('skipping middleware, services');
    expect(out.architecture[0].remediation).toContain('application service');
    expect(out.security).toEqual([]);
  });

  it('leaves a hop to the adjacent tier alone', () => {
    // middleware → services is the next tier down on the layered stack.
    const c = edgeCapsule(addedEdge('src/middleware/m.ts', 'src/services/s.ts', 'middleware', 'services'));
    expect(runScanners(input({ capsule: c })).architecture).toEqual([]);
  });

  it('with only an observed pattern, reports an engine violation as a medium observation, never a regression', () => {
    // No declared target: a downward skip is not judged at all, and an upward
    // dependency the engine forbids is context about the repo's majority.
    const skip = edgeCapsule(addedEdge('src/routes/x.ts', 'src/repositories/r.ts', 'routing', 'data-access'), {
      patterns: patterns(null, 'layered'),
    });
    expect(runScanners(input({ capsule: skip })).architecture).toEqual([]);

    const upward = edgeCapsule(addedEdge('src/services/s.ts', 'src/routes/x.ts', 'services', 'routing'), {
      patterns: patterns(null, 'layered'),
    });
    const [f] = runScanners(input({ capsule: upward })).architecture;
    expect(f).toMatchObject({ severity: 'medium', confidence: 0.6, target_alignment: 'legacy_consistent' });
    expect(f.claim).toContain('layered:upward:services→routing');
  });

  it('records an approved exception as such rather than as a regression', () => {
    const c = edgeCapsule(addedEdge('src/routes/x.ts', 'src/repositories/r.ts', 'routing', 'data-access'), {
      patterns: patterns('layered', 'layered', ['routing->data-access']),
    });
    expect(runScanners(input({ capsule: c })).architecture[0].target_alignment).toBe('approved_exception');
  });

  it('ignores edges touching an exempt layer or one with no layer at all', () => {
    const shared = edgeCapsule(addedEdge('src/utils/u.ts', 'src/repositories/r.ts', 'shared', 'data-access'));
    expect(runScanners(input({ capsule: shared })).architecture).toEqual([]);
    const unlayered = edgeCapsule({ ...addedEdge('src/x.ts', 'src/repositories/r.ts', 'routing', 'data-access'), from_layer: undefined });
    expect(runScanners(input({ capsule: unlayered })).architecture).toEqual([]);
  });

  it('flags the domain reaching persistence under a clean profile with the engine rule', () => {
    const c = edgeCapsule(addedEdge('src/domain/d.ts', 'src/repositories/r.ts', 'domain', 'data-access'), {
      patterns: patterns('clean', 'clean'),
    });
    const [f] = runScanners(input({ capsule: c })).architecture;
    expect(f.kind).toBe('boundary_bypass');
    expect(f.claim).toContain('clean:domain→data-access');
    expect(f.remediation).toContain('application service');
  });

  it('does nothing when no pattern of any kind is known', () => {
    const c = edgeCapsule(addedEdge('src/routes/x.ts', 'src/repositories/r.ts', 'routing', 'data-access'), {
      patterns: patterns(null, null),
    });
    expect(runScanners(input({ capsule: c })).architecture).toEqual([]);
  });
});

// ── 2. guard removed (protected) ────────────────────────────────────────────

describe('guard_removed', () => {
  const removedGuard = new Map([['src/routes/x.ts', ['  requireAuth(req)', '  return next()']]]);

  it('is a protected finding when a removed guard has no replacement in the file', () => {
    const c = capsule({
      roles: [{ evidence_id: 'role:routing:1', path: 'src/routes/x.ts', role: 'routing', layer: 'routing', confidence: 0.8, changed: true }],
      evidence: [{ id: 'role:routing:1', kind: 'role', path: 'src/routes/x.ts', protected_finding: false }],
    });
    const out = runScanners(
      input({ capsule: c, removedLines: removedGuard, fileText: new Map([['src/routes/x.ts', 'export const h = (req) => ok(req)\n']]) }),
    );
    expect(out.security).toHaveLength(1);
    expect(out.security[0]).toMatchObject({
      id: 'sec-01',
      kind: 'guard_removed',
      severity: 'high',
      confidence: 0.9,
      protected_finding: true,
      target_alignment: 'regression',
      paths: ['src/routes/x.ts'],
      evidence_ids: ['role:routing:1'],
    });
  });

  it('does not fire when an equivalent guard is still present in the file', () => {
    const out = runScanners(
      input({ removedLines: removedGuard, fileText: new Map([['src/routes/x.ts', 'authorize(req)\nreturn h(req)\n']]) }),
    );
    expect(out.security).toEqual([]);
  });

  it('does not fire when the removed lines carry no guard', () => {
    const out = runScanners(input({ removedLines: new Map([['src/routes/x.ts', ['  // tidy up', '  const x = 1']]]) }));
    expect(out.security).toEqual([]);
  });

  it('cites the file itself when the capsule has no role for it — never an invented id', () => {
    const c = capsule();
    const out = runScanners(input({ capsule: c, removedLines: removedGuard }));
    expect(out.security[0].evidence_ids).toEqual(['source_span:1']);
    // The evidence was added to the capsule so the verifier can resolve it.
    expect(c.evidence).toContainEqual({ id: 'source_span:1', kind: 'source_span', path: 'src/routes/x.ts', protected_finding: true });
  });

  it('is switched off by the unguarded_entrypoint protected rule', () => {
    const out = runScanners(input({ config: protectedOff('unguarded_entrypoint'), removedLines: removedGuard }));
    expect(out.security).toEqual([]);
  });
});

// ── 3. unguarded route (protected) ──────────────────────────────────────────

describe('unguarded_entrypoint', () => {
  const OPEN = "router.post('/purge', purgeEverything)\n";
  const GUARDED = "router.post('/x', requireAuth, handler)\n";
  const peers = (n: number, text = GUARDED): Map<string, string> =>
    new Map(Array.from({ length: n }, (_, i) => [`src/routes/peer${i}.ts`, text]));
  const changedAdmin = { fileText: new Map([['src/routes/admin.ts', OPEN]]), changedPaths: new Set(['src/routes/admin.ts']) };

  it('flags an open mutating route among dominantly guarded peers as a protected finding', () => {
    const out = runScanners(input({ ...changedAdmin, peerFileText: peers(4) }));
    expect(out.security).toHaveLength(1);
    expect(out.security[0]).toMatchObject({
      id: 'sec-01',
      kind: 'unguarded_entrypoint',
      severity: 'high',
      confidence: 0.8, // 4 of 5 guarded
      protected_finding: true,
      target_alignment: 'regression',
      paths: ['src/routes/admin.ts'],
    });
    expect(out.security[0].claim).toContain('POST /purge');
    expect(out.security[0].claim).toContain('4 of 5 mutating routes in src/routes');
    expect(out.requiredChecks).toEqual(['authz-test']);
    expect(out.unknowns).toEqual([]);
  });

  it('does not flag an open route where guarding is not the convention', () => {
    // One guarded peer among three open ones: five classified, one in five guarded.
    const mostlyOpen = new Map([
      ['src/routes/g.ts', GUARDED],
      ['src/routes/o1.ts', OPEN],
      ['src/routes/o2.ts', OPEN],
      ['src/routes/o3.ts', OPEN],
    ]);
    const out = runScanners(input({ ...changedAdmin, peerFileText: mostlyOpen }));
    expect(out.security).toEqual([]);
    expect(out.unknowns).toEqual([]);
    expect(out.requiredChecks).toEqual([]);
  });

  it('with too few peers reports an unknown, never a finding and never silence', () => {
    // Two guarded peers plus the open changed route: three classified, below
    // the floor. "Most routes here are guarded" is not a claim three routes
    // can support — but an open write endpoint is not therefore fine.
    const out = runScanners(input({ ...changedAdmin, peerFileText: peers(2) }));
    expect(out.security).toEqual([]);
    expect(out.requiredChecks).toEqual([]);
    expect(out.unknowns).toHaveLength(1);
    expect(out.unknowns[0]).toContain('POST /purge');
    expect(out.unknowns[0]).toContain('only 3 route(s) in src/routes could be classified');
    expect(out.unknowns[0]).toContain('neither confirmed nor excluded');
  });

  it('reports a route it could not parse as an unknown rather than a verdict', () => {
    // Talks about routing, declares nothing the extractor models: unreadable.
    const text = 'export const controller = buildController(routes);\n';
    const out = runScanners(
      input({ fileText: new Map([['src/routes/admin.ts', text]]), changedPaths: new Set(['src/routes/admin.ts']), peerFileText: peers(4) }),
    );
    expect(out.security).toEqual([]);
    expect(out.unknowns.join(' ')).toContain('could not be classified as guarded or open (unreadable)');
  });

  it('leaves a route that declared itself public alone, even below the peer floor', () => {
    const text = "router.post('/webhook', handleWebhook) // @public\n";
    const out = runScanners(
      input({ fileText: new Map([['src/routes/hooks.ts', text]]), changedPaths: new Set(['src/routes/hooks.ts']), peerFileText: peers(2) }),
    );
    expect(out.security).toEqual([]);
    expect(out.unknowns).toEqual([]);
  });

  it('only judges routes in the change set, and never counts a changed file twice', () => {
    // The same open file offered as a peer too must not become its own peer.
    const out = runScanners(
      input({ fileText: new Map([['src/routes/admin.ts', OPEN]]), changedPaths: new Set(), peerFileText: new Map([...peers(4), ['src/routes/admin.ts', OPEN]]) }),
    );
    expect(out.security).toEqual([]);
    expect(out.unknowns).toEqual([]);
  });

  it('is switched off by the unguarded_entrypoint protected rule', () => {
    const out = runScanners(input({ ...changedAdmin, peerFileText: peers(4), config: protectedOff('unguarded_entrypoint') }));
    expect(out.security).toEqual([]);
    expect(out.unknowns).toEqual([]);
  });
});

// ── 4. known-vulnerable dependency (protected) ──────────────────────────────

describe('known_vulnerable_dependency', () => {
  const manifestChange = capsule({
    change: { ...capsule().change, ops: [{ path: 'package.json', op: 'modified', added_lines: 1, removed_lines: 1 }] },
  });
  const manifestText = new Map([['package.json', '{ "dependencies": { "lodash": "4.17.20" } }']]);
  const lodash = [{ package: 'lodash', detail: 'CVE-2021-23337 prototype pollution' }];

  it('is a protected finding when a changed manifest declares an advised package', () => {
    const c = manifestChange;
    const out = runScanners(input({ capsule: c, fileText: manifestText, vulnerablePackages: lodash }));
    expect(out.security).toHaveLength(1);
    expect(out.security[0]).toMatchObject({
      id: 'sec-01',
      kind: 'known_vulnerable_dependency',
      severity: 'high',
      confidence: 1,
      protected_finding: true,
      paths: ['package.json'],
      evidence_ids: ['dependency:package.json'],
    });
    expect(out.security[0].claim).toContain('lodash');
    expect(out.security[0].claim).toContain('CVE-2021-23337');
    expect(c.evidence).toContainEqual({ id: 'dependency:package.json', kind: 'dependency', path: 'package.json', protected_finding: true });
  });

  it('ignores an advised package the changed manifest does not declare', () => {
    const out = runScanners(
      input({ capsule: manifestChange, fileText: manifestText, vulnerablePackages: [{ package: 'left-pad', detail: 'x' }] }),
    );
    expect(out.security).toEqual([]);
    expect(out.unknowns).toEqual([]);
  });

  it('treats "checked, none" as clean but "not checked" as an unknown — absent is not zero', () => {
    const clean = runScanners(input({ capsule: manifestChange, fileText: manifestText, vulnerablePackages: [] }));
    expect(clean.unknowns).toEqual([]);
    expect(clean.requiredChecks).toEqual([]);

    const unchecked = runScanners(input({ capsule: manifestChange, fileText: manifestText, vulnerablePackages: null }));
    expect(unchecked.security).toEqual([]);
    expect(unchecked.unknowns.join(' ')).toContain('no advisory data was available');
    expect(unchecked.unknowns.join(' ')).toContain('vg scan --vulns');
    expect(unchecked.requiredChecks).toEqual(['dependency-advisory-check']);
  });

  it('says nothing when no dependency manifest changed, even with no advisory data', () => {
    const out = runScanners(input({ vulnerablePackages: null }));
    expect(out.unknowns).toEqual([]);
    expect(out.requiredChecks).toEqual([]);
  });

  it('is switched off by the known_vulnerable_dependency protected rule', () => {
    const out = runScanners(
      input({ capsule: manifestChange, fileText: manifestText, vulnerablePackages: lodash, config: protectedOff('known_vulnerable_dependency') }),
    );
    expect(out.security).toEqual([]);
    expect(runScanners(input({ capsule: manifestChange, vulnerablePackages: null, config: protectedOff('known_vulnerable_dependency') })).unknowns).toEqual([]);
  });

  it.each(['pnpm-lock.yaml', 'go.mod', 'Cargo.toml', 'requirements-dev.txt', 'src/App/App.csproj', 'Gemfile.lock'])(
    'recognises %s as a dependency manifest',
    (manifest) => {
      const c = capsule({ change: { ...capsule().change, ops: [{ path: manifest, op: 'modified', added_lines: 1, removed_lines: 0 }] } });
      expect(runScanners(input({ capsule: c, vulnerablePackages: null })).requiredChecks).toEqual(['dependency-advisory-check']);
    },
  );
});

// ── 5. validated taint (not run in this slice) ──────────────────────────────

describe('validated_taint', () => {
  const handler = capsule({
    roles: [{ evidence_id: 'role:handler:1', path: 'src/handlers/h.ts', role: 'handler', layer: 'services', confidence: 0.8, changed: true }],
  });

  it('reports an unknown when the change touches an entrypoint', () => {
    expect(runScanners(input({ capsule: handler })).unknowns.join(' ')).toContain('taint validation was not run');
  });

  it('reports an unknown when the change introduces a cross-layer path', () => {
    const c = capsule({ paths: [{ evidence_id: 'edge:1', from: 'src/routes/x.ts', to: 'src/repositories/r.ts', hops: ['routing', 'data-access'], guarded: null }] });
    expect(runScanners(input({ capsule: c })).unknowns.join(' ')).toContain('taint validation was not run');
  });

  it('stays quiet for a change with no tainted-input surface, so pass stays reachable', () => {
    const c = capsule({
      roles: [{ evidence_id: 'role:services:1', path: 'src/services/s.ts', role: 'services', layer: 'services', confidence: 0.8, changed: true }],
    });
    expect(runScanners(input({ capsule: c })).unknowns).toEqual([]);
  });

  it('is switched off by the validated_taint protected rule', () => {
    expect(runScanners(input({ capsule: handler, config: protectedOff('validated_taint') })).unknowns).toEqual([]);
  });
});

// ── 6. peer deviation ───────────────────────────────────────────────────────

describe('peer_deviation', () => {
  const vote = (o: Partial<DominanceVote> = {}): DominanceVote => ({
    group: 'role:routing',
    groupKind: 'role',
    dominant: 'via-service',
    share: 0.9,
    entropy: 0.2,
    size: 8,
    reason: 'dominant',
    tally: {},
    deviators: ['src/routes/x.ts'],
    exemplars: ['src/routes/a.ts', 'src/routes/b.ts', 'src/routes/c.ts'],
    ...o,
  });
  const withVoteEvidence = capsule({ evidence: [{ id: 'vote:role:routing', kind: 'policy', protected_finding: false }] });
  const deviating = {
    capsule: withVoteEvidence,
    votes: [vote()],
    dataAccess: new Map([['src/routes/x.ts', 'direct-persistence' as const]]),
    changedPaths: new Set(['src/routes/x.ts']),
  };

  it('flags a changed file that steps away from its peers, citing the vote', () => {
    const out = runScanners(input(deviating));
    expect(out.architecture).toHaveLength(1);
    expect(out.architecture[0]).toMatchObject({
      id: 'arch-01',
      kind: 'peer_deviation',
      severity: 'high',
      confidence: 0.9,
      target_alignment: 'regression',
      evidence_ids: ['vote:role:routing'],
      paths: ['src/routes/x.ts'],
      protected_finding: false,
    });
    expect(out.architecture[0].claim).toContain('src/routes/x.ts reaches persistence directly');
    expect(out.architecture[0].claim).toContain('90% of its 8 role peers');
    expect(out.architecture[0].claim).toContain('through the service layer');
    expect(out.architecture[0].remediation).toContain('src/routes/a.ts, src/routes/b.ts');
  });

  it('never punishes the first file to modernise past a bypassing majority', () => {
    const out = runScanners(
      input({ ...deviating, votes: [vote({ dominant: 'direct-persistence' })], dataAccess: new Map([['src/routes/x.ts', 'via-service']]) }),
    );
    expect(out.architecture).toEqual([]);
  });

  it('is medium severity without a declared target', () => {
    const c = capsule({ patterns: patterns(null, 'layered'), evidence: withVoteEvidence.evidence });
    const [f] = runScanners(input({ ...deviating, capsule: c })).architecture;
    expect(f.severity).toBe('medium');
    expect(f.target_alignment).toBe('legacy_consistent');
  });

  it('scales confidence by the size of the group, not just its share', () => {
    const [f] = runScanners(input({ ...deviating, votes: [vote({ share: 0.8, size: 4 })] })).architecture;
    expect(f.confidence).toBeCloseTo(0.4, 5);
  });

  it('ignores votes with no convention, deviators outside the change, and files with no label', () => {
    expect(runScanners(input({ ...deviating, votes: [vote({ reason: 'no_clear_leader', dominant: null })] })).architecture).toEqual([]);
    expect(runScanners(input({ ...deviating, changedPaths: new Set(['src/routes/other.ts']) })).architecture).toEqual([]);
    expect(runScanners(input({ ...deviating, dataAccess: new Map() })).architecture).toEqual([]);
  });

  it('cites only evidence the capsule actually holds', () => {
    const [f] = runScanners(input({ ...deviating, capsule: capsule() })).architecture;
    expect(f.evidence_ids).toEqual([]);
  });
});

// ── 7. duplicate implementation ─────────────────────────────────────────────

describe('duplicate_implementation', () => {
  const ORIGINAL = `
function calculateInvoiceTotal(items, taxRate) {
  let total = 0;
  for (const item of items) {
    total = total + item.price * item.quantity;
  }
  const tax = total * taxRate;
  return round(total + tax, 2);
}`;
  const RENAMED_COPY = `
function computeBillSum(lines, vatPercent) {
  let sum = 0;
  for (const line of lines) {
    sum = sum + line.price * line.quantity;
  }
  const vat = sum * vatPercent;
  return round(sum + vat, 2);
}`;
  const DIFFERENT = `
function sendWelcomeEmail(user, template) {
  if (!user.email) {
    throw new Error("no address");
  }
  const rendered = renderTemplate(template, user);
  return mailer.deliver(user.email, rendered);
}`;

  const body = (id: string, name: string, file: string, text: string, startLine = 10): FunctionBody => ({
    id, name, file, startLine, endLine: startLine + 8, text,
  });
  const indexOf = (...bodies: FunctionBody[]): SimilarityIndex => {
    const index = new SimilarityIndex();
    for (const b of bodies) index.add(b);
    return index;
  };
  const original = body('orig', 'calculateInvoiceTotal', 'src/billing.ts', ORIGINAL);
  const copy = body('copy', 'computeBillSum', 'src/orders.ts', RENAMED_COPY, 40);

  it('flags a renamed re-implementation and records both spans as evidence', () => {
    const c = capsule();
    const out = runScanners(input({ capsule: c, similarity: indexOf(original), changedBodies: [copy] }));
    expect(out.architecture).toHaveLength(1);
    const [f] = out.architecture;
    expect(f).toMatchObject({
      id: 'arch-01',
      kind: 'duplicate_implementation',
      severity: 'medium',
      target_alignment: 'regression',
      paths: ['src/orders.ts', 'src/billing.ts'],
      evidence_ids: ['duplicate:src/orders.ts:computeBillSum'],
      protected_finding: false,
    });
    expect(f.claim).toMatch(/^computeBillSum in src\/orders\.ts is structurally \d+% the same as calculateInvoiceTotal in src\/billing\.ts:10\.$/);
    expect(f.remediation).toContain('Call calculateInvoiceTotal instead');
    expect(c.evidence).toContainEqual(
      expect.objectContaining({ id: 'duplicate:src/orders.ts:computeBillSum', kind: 'graph_node', path: 'src/billing.ts', start_line: 10, end_line: 18 }),
    );
  });

  it('does not flag genuinely different logic', () => {
    const out = runScanners(input({ similarity: indexOf(body('mail', 'sendWelcomeEmail', 'src/mail.ts', DIFFERENT)), changedBodies: [copy] }));
    expect(out.architecture).toEqual([]);
  });

  it('is an unknown alignment, not a regression, when nothing was declared', () => {
    const c = capsule({ patterns: patterns(null, 'layered') });
    const [f] = runScanners(input({ capsule: c, similarity: indexOf(original), changedBodies: [copy] })).architecture;
    expect(f.target_alignment).toBe('unknown');
  });

  it('never compares test, fixture, or generated files on either side', () => {
    const testCopy = { ...copy, file: 'src/orders.test.ts' };
    expect(runScanners(input({ similarity: indexOf(original), changedBodies: [testCopy] })).architecture).toEqual([]);
    const fixtureOriginal = { ...original, file: 'src/__tests__/billing.ts' };
    expect(runScanners(input({ similarity: indexOf(fixtureOriginal), changedBodies: [copy] })).architecture).toEqual([]);
  });

  it('reports one finding per changed function however many near-matches it has', () => {
    const second = body('orig2', 'sumInvoice', 'src/legacy/billing.ts', ORIGINAL);
    const out = runScanners(input({ similarity: indexOf(original, second), changedBodies: [copy] }));
    expect(out.architecture).toHaveLength(1);
    expect(out.architecture[0].claim).toContain('(and 1 other near-match(es))');
  });

  it('never matches a changed body against another changed body', () => {
    // Both are the query, neither is the corpus — an agent that writes two
    // similar functions in one change is a different problem.
    const out = runScanners(input({ similarity: indexOf(), changedBodies: [copy, { ...original, id: 'also-changed' }] }));
    expect(out.architecture).toEqual([]);
  });
});

// ── 8. unverified change ────────────────────────────────────────────────────

describe('unverified_change', () => {
  it('rolls every uncovered file into one finding and requires a call-path test', () => {
    const c = capsule({
      verification: [
        { evidence_id: 'verify:no_test_covering_change:1', kind: 'no_test_covering_change', path: 'src/a.ts', detail: 'no test edge' },
        { evidence_id: 'verify:test_covering_change:2', kind: 'test_covering_change', path: 'src/b.ts', detail: 'covered' },
        { evidence_id: 'verify:no_test_covering_change:3', kind: 'no_test_covering_change', path: 'src/c.ts', detail: 'no test edge' },
      ],
    });
    const out = runScanners(input({ capsule: c }));
    expect(out.architecture).toHaveLength(1);
    expect(out.architecture[0]).toMatchObject({
      kind: 'unverified_change',
      severity: 'medium',
      confidence: 0.7,
      target_alignment: 'unknown',
      paths: ['src/a.ts', 'src/c.ts'],
      evidence_ids: ['verify:no_test_covering_change:1', 'verify:no_test_covering_change:3'],
    });
    expect(out.architecture[0].claim).toContain('2 changed file(s)');
    expect(out.requiredChecks).toEqual(['changed-call-path-test']);
  });

  it('is silent when every changed file is reached by a test edge', () => {
    const c = capsule({
      verification: [{ evidence_id: 'verify:test_covering_change:1', kind: 'test_covering_change', path: 'src/a.ts', detail: 'covered' }],
    });
    const out = runScanners(input({ capsule: c }));
    expect(out.architecture).toEqual([]);
    expect(out.requiredChecks).toEqual([]);
  });
});

// ── cross-rule bookkeeping ──────────────────────────────────────────────────

describe('runScanners bookkeeping', () => {
  it('numbers architecture and security findings sequentially across rules', () => {
    const c = edgeCapsule(addedEdge('src/routes/x.ts', 'src/repositories/r.ts', 'routing', 'data-access'), {
      verification: [{ evidence_id: 'verify:no_test_covering_change:1', kind: 'no_test_covering_change', path: 'src/routes/x.ts', detail: 'x' }],
    });
    c.change.ops.push({ path: 'package.json', op: 'modified', added_lines: 1, removed_lines: 0 });
    const out = runScanners(
      input({
        capsule: c,
        removedLines: new Map([['src/routes/y.ts', ['requireAuth(req)']]]),
        fileText: new Map([['package.json', '{"dependencies":{"lodash":"1"}}']]),
        vulnerablePackages: [{ package: 'lodash', detail: 'advisory' }],
      }),
    );
    expect(out.architecture.map((f) => f.id)).toEqual(['arch-01', 'arch-02']);
    expect(out.security.map((f) => [f.id, f.kind])).toEqual([
      ['sec-01', 'guard_removed'],
      ['sec-02', 'known_vulnerable_dependency'],
    ]);
  });

  it('returns required checks sorted and de-duplicated', () => {
    const c = capsule({
      change: { ...capsule().change, ops: [{ path: 'package.json', op: 'modified', added_lines: 1, removed_lines: 0 }] },
      verification: [{ evidence_id: 'v:1', kind: 'no_test_covering_change', path: 'src/x.ts', detail: 'x' }],
    });
    const guarded = "router.post('/x', requireAuth, h)\n";
    const out = runScanners(
      input({
        capsule: c,
        vulnerablePackages: null,
        fileText: new Map([
          ['src/routes/a.ts', "router.post('/a', h)\n"],
          ['src/routes/b.ts', "router.delete('/b', h)\n"],
        ]),
        changedPaths: new Set(['src/routes/a.ts', 'src/routes/b.ts']),
        peerFileText: new Map(Array.from({ length: 8 }, (_, i) => [`src/routes/p${i}.ts`, guarded])),
      }),
    );
    expect(out.security).toHaveLength(2);
    expect(out.requiredChecks).toEqual(['authz-test', 'changed-call-path-test', 'dependency-advisory-check']);
  });

  it('is deterministic for the same input', () => {
    const make = () =>
      runScanners(
        input({
          capsule: edgeCapsule(addedEdge('src/routes/x.ts', 'src/repositories/r.ts', 'routing', 'data-access')),
          removedLines: new Map([['src/routes/y.ts', ['requireAuth(req)']]]),
        }),
      );
    expect(JSON.stringify(make())).toBe(JSON.stringify(make()));
  });
});

// ── the scan artifact reader ────────────────────────────────────────────────

describe('vulnerablePackagesFromScan', () => {
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'vg-review-scan-'));
  const write = (root: string, body: string): void => {
    fs.mkdirSync(path.join(root, '.vibgrate'), { recursive: true });
    fs.writeFileSync(path.join(root, '.vibgrate', 'scan_result.json'), body);
  };

  it('returns null — not an empty list — when no artifact exists', () => {
    expect(vulnerablePackagesFromScan(tmp())).toBeNull();
  });

  it('returns null on an unreadable artifact rather than pretending it was checked', () => {
    const root = tmp();
    write(root, '{ not json');
    expect(vulnerablePackagesFromScan(root)).toBeNull();
  });

  it('returns an empty list for an artifact with no vulnerability findings', () => {
    const root = tmp();
    write(root, JSON.stringify({ findings: [{ ruleId: 'vibgrate/drift', message: 'old', location: 'package.json' }] }));
    expect(vulnerablePackagesFromScan(root)).toEqual([]);
    write(root, JSON.stringify({}));
    expect(vulnerablePackagesFromScan(root)).toEqual([]);
  });

  it('keeps only vulnerability findings, naming the package from details or the location', () => {
    const root = tmp();
    write(
      root,
      JSON.stringify({
        findings: [
          { ruleId: 'vibgrate/vulnerability', message: 'CVE-1 in lodash', location: 'package.json', details: { package: 'lodash' } },
          { ruleId: 'vibgrate/vulnerability', message: 'CVE-2', location: 'minimist' },
          { ruleId: 'vibgrate/drift', message: 'behind', location: 'package.json' },
        ],
      }),
    );
    expect(vulnerablePackagesFromScan(root)).toEqual([
      { package: 'lodash', detail: 'CVE-1 in lodash' },
      { package: 'minimist', detail: 'CVE-2' },
    ]);
  });
});
