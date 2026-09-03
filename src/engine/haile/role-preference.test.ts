import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyRolePreference, loadRoleMap, type RoleMap } from './role-preference.js';
import { emptySidecar, writeSidecarDocument } from './sidecar.js';

function seed(id: string, name: string, why = 'name match'): { node: { id: string; name: string; qualifiedName: string }; why: string; score: number; role?: string } {
  return { node: { id, name, qualifiedName: `mod.${name}` }, why, score: 1 };
}

const roles: RoleMap = new Map([
  ['svc', { role: 'application_service', band: 'high' }],
  ['ctl', { role: 'controller', band: 'medium' }],
  ['fmt', { role: 'utility', band: 'high' }],
  ['repo', { role: 'repository', band: 'high' }],
]);

describe('applyRolePreference', () => {
  it('lifts a controller / application service by at most two places, keeps everything else in rank order, drops unnamed utilities', () => {
    const out = applyRolePreference(
      [seed('e', 'Product'), seed('fmt', 'formatMoney'), seed('repo', 'findOrder'), seed('x', 'unclassified'), seed('svc', 'placeOrder'), seed('ctl', 'ordersHandler')],
      roles,
      'how is an order placed',
    );
    // Once the utility is gone placeOrder is 4th → it rises two places, past
    // the unclassified row and level with the repository, where rank order
    // keeps the repository first; the top match is never displaced.
    expect(out.map((s) => s.node.id)).toEqual(['e', 'repo', 'svc', 'x', 'ctl']);
    // The role is a structured field; `why` (rendered into the context) is untouched.
    expect(out[2]!.role).toBe('application_service');
    expect(out[2]!.why).toBe('name match');
    expect(out[3]!.role).toBeUndefined(); // unclassified rows are untouched
    expect(out[3]!.why).toBe('name match');
  });

  it('never leapfrogs a clearly better match: the top hit stays on top', () => {
    const out = applyRolePreference(
      [seed('login', 'login'), seed('t', 'test_login'), seed('req', 'LoginRequest'), seed('h', 'hash'), seed('ctl', 'register')],
      new Map([['ctl', { role: 'controller', band: 'high' }], ['login', { role: 'cross_cutting', band: 'high' }]]),
      'how does user login work',
    );
    expect(out.map((s) => s.node.id)).toEqual(['login', 't', 'req', 'ctl', 'h']);
  });

  it('keeps a utility the ask names, or when the ask reaches for helpers', () => {
    const seeds = [seed('fmt', 'formatMoney'), seed('svc', 'placeOrder')];
    expect(applyRolePreference(seeds, roles, 'where is formatMoney used').map((s) => s.node.id)).toEqual(['svc', 'fmt']);
    expect(applyRolePreference(seeds, roles, 'list the formatting helpers').map((s) => s.node.id)).toEqual(['svc', 'fmt']);
    expect(applyRolePreference(seeds, roles, 'how do we charge a card').map((s) => s.node.id)).toEqual(['svc']);
  });

  it('is inert without a role map', () => {
    const seeds = [seed('fmt', 'formatMoney'), seed('svc', 'placeOrder')];
    expect(applyRolePreference(seeds, null, 'anything')).toBe(seeds);
    expect(applyRolePreference(seeds, new Map(), 'anything')).toBe(seeds);
  });
});

describe('loadRoleMap', () => {
  let root: string;
  let prev: string | undefined;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-role-map-'));
    prev = process.env.VIBGRATE_GRAPH_IN_REPO;
    process.env.VIBGRATE_GRAPH_IN_REPO = '1';
    fs.mkdirSync(path.join(root, '.vibgrate'), { recursive: true });
    fs.writeFileSync(path.join(root, '.vibgrate', 'graph.json'), '{}');
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.VIBGRATE_GRAPH_IN_REPO;
    else process.env.VIBGRATE_GRAPH_IN_REPO = prev;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads confident roles bound to the corpus, skips abstain, and is null when stale or missing', () => {
    expect(loadRoleMap(root, 'abc')).toBeNull();
    const doc = emptySidecar('abc');
    const base = { file_path: 'a.ts', qualified_name: 'a', symbol_kind: 'function', purposes: [], intent: { text: '', verbs: [], objects: [] }, evidence: [] };
    doc.symbols = [
      { ...base, node_id: 'n1', name: 'a', role: { primary: 'controller', alternatives: [], confidence: 0.8, band: 'high' } },
      { ...base, node_id: 'n2', name: 'b', role: { primary: 'unknown', alternatives: [], confidence: 0.1, band: 'abstain' } },
    ];
    writeSidecarDocument(doc, path.join(root, '.vibgrate', 'graph.json'));
    expect([...loadRoleMap(root, 'abc')!.entries()]).toEqual([['n1', { role: 'controller', band: 'high' }]]);
    expect(loadRoleMap(root, 'other')).toBeNull();
  });
});
