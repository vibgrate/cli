import { describe, expect, it } from 'vitest';
import { compileCapsule, repoPseudonym, type CompileCapsuleInput } from './capsule.js';
import type { DeclaredIntent } from './intent.js';
import { CAPSULE_BUDGETS, MAX_ROLE_PEERS, digest } from './schemas.js';
import { changeSet, changed, config, edge, graph, node } from './test-fixtures.js';

// ── fixtures ────────────────────────────────────────────────────────────────

const ROUTE = 'src/routes/x.ts';
const REPO = 'src/repositories/r.ts';
const SERVICE = 'src/services/s.ts';

/** A route file that imports a repository and a service; six other route files as peers. */
function smallGraph() {
  const nodes = [
    node('rx', ROUTE, { span: { start: 1, end: 10 } }),
    node('ry', ROUTE, { name: 'ry', span: { start: 50, end: 60 } }),
    node('rr', REPO),
    node('rs', SERVICE),
    ...Array.from({ length: 6 }, (_, i) => node(`p${i}`, `src/routes/p${i}.ts`)),
  ];
  const edges = [edge('import', 'rx', 'rr'), edge('import', 'rx', 'rs')];
  return graph(nodes, edges, {
    areas: [{ id: 0, label: 'routes', size: 2, members: ['rx', 'p0'], cohesion: 0.9, externalEdges: 1 }],
  });
}

function input(overrides: Partial<CompileCapsuleInput> = {}): CompileCapsuleInput {
  return {
    root: '/repo',
    graph: smallGraph(),
    change: changeSet([changed(ROUTE, { op: 'added' })]),
    config: config(),
    profile: 'interactive-narrow',
    repoPseudonym: 'sha256:pseudo',
    ...overrides,
  };
}

const intent = (patterns: string[], overrides: Partial<DeclaredIntent> = {}): DeclaredIntent => ({
  patterns,
  sources: ['CLAUDE.md'],
  citations: [],
  ...overrides,
});

// ── changed symbols ─────────────────────────────────────────────────────────

describe('compileCapsule — changed symbols', () => {
  it('lists graph nodes intersecting a changed hunk and skips the rest of the file', () => {
    const { capsule } = compileCapsule(input({ change: changeSet([changed(ROUTE, { hunks: [{ start: 3, end: 5 }] })]) }));
    expect(capsule.change.symbols).toEqual([
      { node_id: 'rx', name: 'rx', kind: 'function', path: ROUTE, start_line: 1, end_line: 10 },
    ]);
  });

  it('treats a whole-file change as touching every symbol in it', () => {
    const { capsule } = compileCapsule(input());
    expect(capsule.change.symbols.map((s) => s.node_id).sort()).toEqual(['rx', 'ry']);
  });

  it('records the change set ops verbatim, with normalised paths', () => {
    const { capsule } = compileCapsule(
      input({ change: changeSet([changed('src\\routes\\x.ts', { op: 'modified', addedLines: 4, removedLines: 2 })]) }),
    );
    expect(capsule.change.ops).toEqual([{ path: ROUTE, op: 'modified', added_lines: 4, removed_lines: 2 }]);
  });
});

// ── added / removed edges ───────────────────────────────────────────────────

describe('compileCapsule — dependency edges', () => {
  it('counts every current edge out of a newly added file as introduced', () => {
    const { capsule } = compileCapsule(input());
    expect(capsule.change.added_edges).toEqual([
      { evidence_id: 'edge:rx>rr:import', kind: 'import', from_path: ROUTE, to_path: REPO, from_layer: 'routing', to_layer: 'data-access' },
      { evidence_id: 'edge:rx>rs:import', kind: 'import', from_path: ROUTE, to_path: SERVICE, from_layer: 'routing', to_layer: 'services' },
    ]);
    expect(capsule.evidence.find((e) => e.id === 'edge:rx>rr:import')).toEqual({
      id: 'edge:rx>rr:import',
      kind: 'graph_edge',
      path: ROUTE,
      start_line: 1,
      end_line: 10,
      protected_finding: false,
      note: `import → ${REPO}`,
    });
  });

  it('filters occupancy: an import the base already had is not an added edge', () => {
    const { capsule } = compileCapsule(
      input({
        change: changeSet([changed(ROUTE, { op: 'modified' })]),
        baseFileText: new Map([[ROUTE, "import { r } from '../repositories/r.js';\n"]]),
      }),
    );
    expect(capsule.change.added_edges.map((e) => e.to_path)).toEqual([SERVICE]);
  });

  it('never manufactures an added edge for a modified file with no readable base', () => {
    const { capsule } = compileCapsule(input({ change: changeSet([changed(ROUTE, { op: 'modified' })]) }));
    expect(capsule.change.added_edges).toEqual([]);
    expect(capsule.paths).toEqual([]);
  });

  it('reports a dependency the base referenced and the head no longer does as removed', () => {
    const { capsule } = compileCapsule(
      input({
        change: changeSet([changed(ROUTE, { op: 'modified' })]),
        baseFileText: new Map([[ROUTE, "import { r } from '../repositories/r.js';\nimport { s } from '../services/s.js';\n"]]),
        headFileText: new Map([[ROUTE, "import { s } from '../services/s.js';\n"]]),
      }),
    );
    expect(capsule.change.removed_edges).toEqual([
      { evidence_id: 'edge:removed:1', kind: 'import', from_path: ROUTE, to_path: REPO, from_layer: 'routing', to_layer: 'data-access' },
    ]);
    expect(capsule.evidence).toContainEqual({ id: 'edge:removed:1', kind: 'graph_edge', path: ROUTE, protected_finding: false, note: `removed → ${REPO}` });
  });

  it('only keeps edges that leave the file — never intra-file calls', () => {
    const g = graph([node('a', ROUTE), node('b', ROUTE, { name: 'b' })], [edge('call', 'a', 'b')]);
    const { capsule } = compileCapsule(input({ graph: g }));
    expect(capsule.change.added_edges).toEqual([]);
  });
});

// ── paths, policies, unknowns ───────────────────────────────────────────────

describe('compileCapsule — cross-layer paths', () => {
  it('records a cross-layer traversal with guard presence unobserved, and says so', () => {
    const { capsule, unknowns } = compileCapsule(input());
    expect(capsule.paths).toEqual([
      expect.objectContaining({ from: ROUTE, to: REPO, hops: ['routing', 'data-access'], guarded: null }),
      expect.objectContaining({ from: ROUTE, to: SERVICE, hops: ['routing', 'services'], guarded: null }),
    ]);
    expect(unknowns.join(' ')).toContain('Guard presence along the changed call paths was not observed');
  });

  it('does not treat an edge into an exempt layer as a path', () => {
    const g = graph([node('rx', ROUTE), node('u', 'src/utils/u.ts')], [edge('import', 'rx', 'u')]);
    const { capsule, unknowns } = compileCapsule(input({ graph: g }));
    expect(capsule.paths).toEqual([]);
    expect(unknowns).toEqual([]);
  });
});

describe('compileCapsule — patterns and policies', () => {
  it('lets review.toml declare the target, and marks the observed shape legacy when it differs', () => {
    const change = changeSet([
      changed(ROUTE, { op: 'added' }),
      changed(SERVICE, { op: 'added' }),
      changed('src/middleware/m.ts', { op: 'added' }),
    ]);
    const { capsule } = compileCapsule(input({ change, config: config({ target_pattern: 'clean' }), intent: intent(['layered']) }));
    expect(capsule.patterns).toEqual({
      observed_dominant_pattern: 'layered',
      declared_target_pattern: 'clean',
      approved_exceptions: [],
      legacy_pattern: 'layered',
      unknown: false,
    });
    expect(capsule.policies.map((p) => p.source)).toEqual(['review.toml', 'review.toml']);
    expect(capsule.policies[0].rule).toBe('domain must not depend on data-access');
  });

  it('falls back to declared intent from CLAUDE.md, labelling the policies as intent', () => {
    const { capsule } = compileCapsule(input({ intent: intent(['layered']) }));
    expect(capsule.patterns.declared_target_pattern).toBe('layered');
    expect(capsule.policies).toHaveLength(5);
    // Not `review.toml`: that file does not exist here, and saying so would
    // send a reader looking for a setting that was never written.
    expect(capsule.policies.every((p) => p.source === 'intent')).toBe(true);
    expect(capsule.policies.map((p) => p.evidence_id)).toEqual(['policy:layering:1', 'policy:layering:2', 'policy:layering:3', 'policy:layering:4', 'policy:layering:5']);
    expect(capsule.evidence.filter((e) => e.id.startsWith('policy:layering:')).every((e) => e.kind === 'policy')).toBe(true);
  });

  it('derives policies from the observed shape when nothing was declared', () => {
    const change = changeSet([changed(ROUTE, { op: 'added' }), changed(SERVICE, { op: 'added' }), changed('src/middleware/m.ts', { op: 'added' })]);
    const { capsule } = compileCapsule(input({ change }));
    expect(capsule.patterns).toMatchObject({ observed_dominant_pattern: 'layered', declared_target_pattern: null, unknown: false });
    expect(capsule.policies).toHaveLength(5);
    expect(capsule.policies.every((p) => p.source === 'derived')).toBe(true);
  });

  it('observes clean when the change spans domain, services and persistence', () => {
    const change = changeSet([changed('src/domain/d.ts', { op: 'added' }), changed(SERVICE, { op: 'added' }), changed(REPO, { op: 'added' })]);
    const { capsule } = compileCapsule(input({ change, graph: null }));
    expect(capsule.patterns.observed_dominant_pattern).toBe('clean');
  });

  it('sorts approved exceptions so the capsule digest is order-independent', () => {
    const { capsule } = compileCapsule(input({ config: config({ approved_exceptions: ['routing->data-access', 'domain->infrastructure'] }) }));
    expect(capsule.patterns.approved_exceptions).toEqual(['domain->infrastructure', 'routing->data-access']);
  });

  it('reports unknowns when a change crosses layers and no pattern or rule exists', () => {
    const { capsule, unknowns } = compileCapsule(input());
    expect(capsule.patterns.unknown).toBe(true);
    expect(capsule.policies).toEqual([]);
    expect(unknowns.join('\n')).toContain('no layering rules are enforced');
    expect(unknowns.join('\n')).toContain('neither a declared target pattern nor an observed dominant pattern');
  });

  it('stays quiet about missing rules when the change never crosses a layer', () => {
    const g = graph([node('rx', ROUTE), node('ry', 'src/routes/y.ts')], [edge('import', 'rx', 'ry')]);
    const { capsule, unknowns } = compileCapsule(input({ graph: g }));
    expect(capsule.patterns.unknown).toBe(true);
    expect(unknowns).toEqual([]);
  });

  it('turns intent citations into policy evidence', () => {
    const cited = intent(['layered'], { citations: [{ file: 'CLAUDE.md', line: 3, text: 'We use a layered architecture.' }] });
    const { capsule } = compileCapsule(input({ intent: cited }));
    expect(capsule.evidence).toContainEqual({
      id: 'intent:CLAUDE.md:3',
      kind: 'policy',
      path: 'CLAUDE.md',
      start_line: 3,
      end_line: 3,
      protected_finding: false,
      note: 'We use a layered architecture.',
    });
  });
});

// ── roles ───────────────────────────────────────────────────────────────────

describe('compileCapsule — roles', () => {
  it('emits the changed file first, then at most MAX_ROLE_PEERS same-role peers', () => {
    const { capsule } = compileCapsule(input());
    const routing = capsule.roles.filter((r) => r.role === 'routing');
    expect(routing[0]).toMatchObject({ path: ROUTE, changed: true, layer: 'routing', evidence_id: 'role:routing:1' });
    expect(routing.filter((r) => !r.changed)).toHaveLength(MAX_ROLE_PEERS);
    expect(routing.map((r) => r.evidence_id)).toEqual(['role:routing:1', 'role:routing:2', 'role:routing:3', 'role:routing:4', 'role:routing:5', 'role:routing:6']);
    // Peers are context for the changed role only — no repository peers appear.
    expect(capsule.roles.some((r) => r.role === 'data-access')).toBe(false);
  });

  it('skips a changed file the classifier cannot place, rather than inventing a role', () => {
    const { capsule } = compileCapsule(input({ change: changeSet([changed('src/foo.ts', { op: 'added' })]) }));
    expect(capsule.roles).toEqual([]);
  });
});

// ── peer vote ───────────────────────────────────────────────────────────────

describe('compileCapsule — peer vote', () => {
  it('labels every placed file and votes the changed file against its role peers', () => {
    // Three routing peers go through a service; the changed route reaches the repository.
    const nodes = [
      node('rx', ROUTE),
      node('rr', REPO),
      node('rs', SERVICE),
      ...[1, 2, 3].map((i) => node(`p${i}`, `src/routes/p${i}.ts`)),
    ];
    const edges = [edge('import', 'rx', 'rr'), ...[1, 2, 3].map((i) => edge('import', `p${i}`, 'rs'))];
    const { capsule, votes, dataAccess } = compileCapsule(input({ graph: graph(nodes, edges) }));

    expect(dataAccess.get(ROUTE)).toBe('direct-persistence');
    expect(dataAccess.get('src/routes/p1.ts')).toBe('via-service');
    expect(dataAccess.has(REPO)).toBe(false); // persistence cannot bypass itself
    const vote = votes.find((v) => v.group === 'role:routing')!;
    expect(vote).toMatchObject({ dominant: 'via-service', reason: 'dominant', size: 4, deviators: [ROUTE] });
    expect(capsule.evidence).toContainEqual(expect.objectContaining({ id: 'vote:role:routing', kind: 'policy' }));
  });

  it('only emits vote evidence for groups a changed file belongs to', () => {
    const { capsule, votes } = compileCapsule(input({ change: changeSet([changed(SERVICE, { op: 'added' })]) }));
    expect(votes.some((v) => v.group === 'role:routing')).toBe(true);
    expect(capsule.evidence.some((e) => e.id === 'vote:role:routing')).toBe(false);
  });

  it('feeds recency into the vote so the exemplars are the live files', () => {
    const nodes = [node('rx', ROUTE), node('rs', SERVICE), ...[1, 2, 3].map((i) => node(`p${i}`, `src/routes/p${i}.ts`))];
    const edges = [1, 2, 3].map((i) => edge('import', `p${i}`, 'rs'));
    const recencyDays = new Map([['src/routes/p3.ts', 1], ['src/routes/p1.ts', 400], ['src/routes/p2.ts', 100]]);
    const { votes } = compileCapsule(input({ graph: graph(nodes, edges), recencyDays }));
    expect(votes.find((v) => v.group === 'role:routing')!.exemplars).toEqual(['src/routes/p3.ts', 'src/routes/p2.ts', 'src/routes/p1.ts']);
  });
});

// ── verification + areas + identity ─────────────────────────────────────────

describe('compileCapsule — verification', () => {
  it('records whether a test edge reaches each changed file, skipping test files themselves', () => {
    const nodes = [node('rx', ROUTE), node('ry', 'src/routes/y.ts'), node('tx', 'src/routes/x.test.ts', { kind: 'test' })];
    const edges = [edge('test', 'tx', 'rx')];
    const change = changeSet([changed(ROUTE), changed('src/routes/y.ts'), changed('src/routes/x.test.ts')]);
    const { capsule } = compileCapsule(input({ graph: graph(nodes, edges), change }));
    expect(capsule.verification.map((v) => [v.path, v.kind])).toEqual([
      [ROUTE, 'test_covering_change'],
      ['src/routes/y.ts', 'no_test_covering_change'],
    ]);
    expect(capsule.verification.map((v) => v.evidence_id)).toEqual(['verify:test_covering_change:1', 'verify:no_test_covering_change:2']);
  });

  it('gives prose, assets and manifests no coverage verdict — they have no call path', () => {
    const change = changeSet([changed('README.md'), changed('docs/guide.md'), changed('package.json'), changed('assets/logo.png'), changed(ROUTE)]);
    const { capsule } = compileCapsule(input({ change }));
    expect(capsule.verification.map((v) => v.path)).toEqual([ROUTE]);
  });

  it('has nothing to say about coverage without a graph', () => {
    expect(compileCapsule(input({ graph: null })).capsule.verification).toEqual([]);
  });
});

describe('compileCapsule — areas and identity', () => {
  it('lists only areas with a changed member, counting them', () => {
    const { capsule } = compileCapsule(input());
    expect(capsule.areas).toEqual([{ id: 0, label: 'routes', size: 2, changed_members: 1 }]);
  });

  it('stamps identity from the graph, and falls back to the change set without one', () => {
    const withGraph = compileCapsule(input({ profile: 'ci-wide' })).capsule.identity;
    expect(withGraph).toMatchObject({ repo_pseudonym: 'sha256:pseudo', language: 'typescript', graph_schema: 'vg-graph/1.1', profile: 'ci-wide' });
    expect(withGraph.analyzer_versions.graph).toBe('test');

    const change = changeSet([changed('a.py'), changed('b.py'), changed('c.ts')]);
    const without = compileCapsule(input({ graph: null, change })).capsule.identity;
    expect(without.language).toBe('py');
    expect(without.graph_schema).toBe('none');
  });

  it('copies the change identity into the capsule', () => {
    const change = changeSet([changed(ROUTE)], { dirty: true, dirtyTreeHash: 'sha256:tree' });
    const { capsule } = compileCapsule(input({ change }));
    expect(capsule.change).toMatchObject({ base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), dirty: true, dirty_tree_hash: 'sha256:tree' });
    expect(capsule.security).toEqual([]);
    expect(capsule.change.contract_changes).toEqual([]);
  });
});

// ── budget and determinism ──────────────────────────────────────────────────

describe('compileCapsule — budget', () => {
  it('reports the profile budget and an estimate, untrimmed for a small change', () => {
    const out = compileCapsule(input());
    expect(out.budget).toEqual(CAPSULE_BUDGETS['interactive-narrow']);
    expect(out.trimmed).toBe(false);
    expect(out.estimatedTokens).toBeGreaterThan(0);
    expect(out.estimatedTokens).toBeLessThan(out.budget.cap);
  });

  it('trims peers, then areas — never the change set — when over the hard cap', () => {
    const many = Array.from({ length: 1200 }, (_, i) => changed(`src/routes/deep/nested/feature-${i}/handler-${i}.ts`, { op: 'added' }));
    const out = compileCapsule(input({ change: changeSet([changed(ROUTE, { op: 'added' }), ...many]) }));
    expect(out.trimmed).toBe(true);
    expect(out.capsule.roles.every((r) => r.changed)).toBe(true);
    expect(out.capsule.areas).toEqual([]);
    expect(out.capsule.change.ops).toHaveLength(1201);
    // Evidence for dropped peers goes with them; changed-file roles stay citable.
    expect(out.capsule.evidence.some((e) => e.id === 'role:routing:1')).toBe(true);
    expect(out.capsule.evidence.some((e) => e.id === 'role:routing:1300')).toBe(false);
  });

  it('is byte-deterministic for the same input', () => {
    const a = compileCapsule(input({ intent: intent(['layered']), recencyDays: new Map([[ROUTE, 3]]) }));
    const b = compileCapsule(input({ intent: intent(['layered']), recencyDays: new Map([[ROUTE, 3]]) }));
    expect(digest(a.capsule)).toBe(digest(b.capsule));
    expect(JSON.stringify(a.votes)).toBe(JSON.stringify(b.votes));
  });
});

describe('repoPseudonym', () => {
  it('is stable, non-reversible, and never carries the remote', () => {
    const a = repoPseudonym('github.com/acme/ledger', '/one');
    expect(a).toBe(repoPseudonym('github.com/acme/ledger', '/two'));
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a).not.toContain('acme');
    expect(repoPseudonym(null, '/one')).not.toBe(repoPseudonym(null, '/two'));
  });
});
