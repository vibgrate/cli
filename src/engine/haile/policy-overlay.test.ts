import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchitecturePolicyError, applyArchitectureOverlays, loadArchitecturePolicy, parseArchitecturePolicy } from './policy-overlay.js';
import { emptySidecar } from './sidecar.js';
import type { HaileSymbol } from './types.js';

type SymbolOver = Omit<Partial<HaileSymbol>, 'role' | 'purposes'> & { role?: string; purposes?: string[] };

function symbol(over: SymbolOver = {}): HaileSymbol {
  const { role = 'controller', purposes = ['persist', 'respond'], ...rest } = over;
  return {
    node_id: rest.qualified_name ?? 'n',
    file_path: 'src/Api/OrdersController.cs',
    name: 'Create',
    qualified_name: 'OrdersController.Create',
    symbol_kind: 'method',
    role: { primary: role, alternatives: [], confidence: 0.8, band: 'high' },
    purposes: purposes.map((purpose) => ({ purpose, confidence: 0.6 })),
    intent: { text: 'writes Order', verbs: ['writes'], objects: ['Order'] },
    evidence: [],
    ...rest,
  } as HaileSymbol;
}

const problemsOf = (text: string): string[] => {
  try {
    parseArchitecturePolicy(text, '.vibgrate/architecture.toml');
  } catch (err) {
    if (err instanceof ArchitecturePolicyError) return err.problems;
    throw err;
  }
  return [];
};

describe('vg.arch.policy.v1 overlay loader', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('keeps the pack-only contract: no file, a plain policy, an unknown pack, a broken pack-only file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-overlay-'));
    dirs.push(root);
    expect(loadArchitecturePolicy(root)).toEqual({ policy: 'hexagonal-v1', overlays: [], file: null });
    fs.mkdirSync(path.join(root, '.vibgrate'));
    const file = path.join(root, '.vibgrate', 'architecture.toml');
    fs.writeFileSync(file, 'policy = "layered-v1"\n');
    expect(loadArchitecturePolicy(root)).toMatchObject({ policy: 'layered-v1', overlays: [] });
    fs.writeFileSync(file, 'policy = "onion-v9"\n');
    expect(loadArchitecturePolicy(root)).toMatchObject({ policy: 'hexagonal-v1', unknownPolicy: 'onion-v9' });
    fs.writeFileSync(file, 'policy = = broken');
    expect(loadArchitecturePolicy(root)).toMatchObject({ policy: 'hexagonal-v1', overlays: [] });
    fs.writeFileSync(file, 'schema = "vg.arch.policy.v1"\npolicy = "vertical-v1"\n');
    expect(loadArchitecturePolicy(root)).toMatchObject({ policy: 'vertical-v1', overlays: [] });
  });

  it('parses deny, allow and remap tables', () => {
    const doc = parseArchitecturePolicy(
      [
        'schema = "vg.arch.policy.v1"',
        'policy = "hexagonal-v1"',
        '[[overlay]]',
        'id = "team/handlers-may-not-persist"',
        'path = "./src/"',
        'when.role = "controller"',
        'when.purpose = "persist"',
        'action = "deny"',
        '[[overlay]]',
        'id = "org/legacy-may-persist"',
        'path = "src/Legacy/"',
        'rule = "controller-persists"',
        'action = "allow"',
        '[[overlay]]',
        'id = "team/calls-out-is-hard"',
        'rule = "hexagonal-v1/controller-calls-out"',
        'action = "remap"',
        'severity = "hard"',
      ].join('\n'),
      '.vibgrate/architecture.toml',
    );
    expect(doc.policy).toBe('hexagonal-v1');
    expect(doc.overlays).toEqual([
      { id: 'team/handlers-may-not-persist', action: 'deny', path: 'src/', role: 'controller', purpose: 'persist', severity: 'hard' },
      { id: 'org/legacy-may-persist', action: 'allow', path: 'src/Legacy/', rule: 'controller-persists' },
      { id: 'team/calls-out-is-hard', action: 'remap', rule: 'hexagonal-v1/controller-calls-out', severity: 'hard' },
    ]);
  });

  it('fails loud, listing every problem, on an overlay that does not validate', () => {
    const problems = problemsOf(
      [
        'schema = "haile.policy.v1"',
        '[[overlay]]',
        'id = "handlers"',
        'when.role = "handler"',
        'when.purpose = "write"',
        'when.rol = "x"',
        'action = "block"',
        'severity = "fatal"',
        'colour = "red"',
        '[[overlay]]',
        'id = "team/a"',
        'action = "deny"',
        '[[overlay]]',
        'id = "team/a"',
        'action = "allow"',
        '[[overlay]]',
        'id = "team/b"',
        'action = "remap"',
        'rule = "controller-persists"',
      ].join('\n'),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('schema must be "vg.arch.policy.v1"'),
        expect.stringContaining('id must be "team/<name>" or "org/<name>"'),
        expect.stringContaining('when.role must be one of the 20 roles'),
        expect.stringContaining('when.purpose must be one of the 26 purposes'),
        expect.stringContaining('unknown key when.rol'),
        expect.stringContaining('action must be one of deny | allow | remap'),
        expect.stringContaining('severity must be hard | warn'),
        expect.stringContaining('unknown key "colour"'),
        expect.stringContaining('team/a: deny needs when.role and/or when.purpose'),
        expect.stringContaining('team/a: duplicate id'),
        expect.stringContaining('team/b: remap needs severity'),
      ]),
    );
    // A syntax error in a file that declares overlays is a problem, not a silent fall-back.
    expect(problemsOf('[[overlay]]\nid = = "x"')).toEqual([expect.stringContaining('TOML syntax')]);
    expect(() => parseArchitecturePolicy('[[overlay]]\nid = "x"\naction = "deny"', 'f')).toThrow(ArchitecturePolicyError);
  });

  it('applies deny, allow and remap to the classify document and stamps the ids', () => {
    const sidecar = emptySidecar('h');
    sidecar.policy = 'hexagonal-v1';
    sidecar.symbols = [
      symbol({ node_id: 'a', qualified_name: 'OrdersController.Create', findings: [{ rule: 'hexagonal-v1/controller-persists', severity: 'hard', message: 'writes', line: 4 }, { rule: 'hexagonal-v1/controller-calls-out', severity: 'warn', message: 'calls', line: 9 }] }),
      symbol({ node_id: 'b', qualified_name: 'LegacyController.Archive', file_path: 'src/Legacy/LegacyController.cs', findings: [{ rule: 'hexagonal-v1/controller-persists', severity: 'hard', message: 'writes', line: 2 }] }),
      symbol({ node_id: 'c', qualified_name: 'OrderService.Place', role: 'application_service', purposes: ['persist'] }),
      symbol({ node_id: 'd', qualified_name: 'OrdersController.Show', purposes: ['query', 'respond'] }),
    ];
    const { applied } = applyArchitectureOverlays(sidecar, [
      { id: 'team/handlers-may-not-persist', action: 'deny', path: 'src/', role: 'controller', purpose: 'persist', severity: 'hard', message: 'hand writes to the service layer' },
      { id: 'team/services-persist-is-warn', action: 'deny', role: 'application_service', purpose: 'persist', severity: 'warn' },
      { id: 'org/legacy-may-persist', action: 'allow', path: 'src/Legacy/', rule: 'controller-persists' },
      { id: 'team/calls-out-is-hard', action: 'remap', rule: 'hexagonal-v1/controller-calls-out', severity: 'hard' },
      { id: 'team/nothing-matches', action: 'deny', role: 'worker' },
    ]);
    expect(applied).toEqual({
      'team/handlers-may-not-persist': 2,
      'team/services-persist-is-warn': 1,
      'org/legacy-may-persist': 1,
      'team/calls-out-is-hard': 1,
      'team/nothing-matches': 0,
    });
    const by = (id: string) => sidecar.symbols.find((s) => s.node_id === id)?.findings ?? [];
    expect(by('a')).toEqual([
      { rule: 'hexagonal-v1/controller-persists', severity: 'hard', message: 'writes', line: 4 },
      { rule: 'hexagonal-v1/controller-calls-out', severity: 'hard', message: 'calls', line: 9 },
      { rule: 'team/handlers-may-not-persist', severity: 'hard', message: 'hand writes to the service layer' },
    ]);
    // The legacy handler keeps the team deny (it is under src/) but loses the baked rule.
    expect(by('b').map((f) => f.rule)).toEqual(['team/handlers-may-not-persist']);
    expect(by('c')).toEqual([{ rule: 'team/services-persist-is-warn', severity: 'warn', message: 'application service with purpose persist is denied by team/services-persist-is-warn' }]);
    expect(by('d')).toEqual([]);
    expect(sidecar.overlays).toEqual(['team/handlers-may-not-persist', 'team/services-persist-is-warn', 'org/legacy-may-persist', 'team/calls-out-is-hard', 'team/nothing-matches']);
    // Roles and purposes are untouched.
    expect(sidecar.symbols[0].role.primary).toBe('controller');
    expect(sidecar.symbols[0].purposes.map((p) => p.purpose)).toEqual(['persist', 'respond']);
    // Idempotent: a second pass adds nothing.
    applyArchitectureOverlays(sidecar, [{ id: 'team/handlers-may-not-persist', action: 'deny', role: 'controller', purpose: 'persist' }]);
    expect(by('a').filter((f) => f.rule === 'team/handlers-may-not-persist')).toHaveLength(1);
  });
});
