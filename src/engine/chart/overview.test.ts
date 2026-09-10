import { describe, expect, it } from 'vitest';
import { fixtureGraph } from '../../code/graph-fixture.js';
import { emptySidecar } from '../haile/sidecar.js';
import { HAILE_ENGINE_VERSION, HAILE_IR, HAILE_MAGIC, HAILE_TAXONOMY } from '../haile/types.js';
import type { HaileSidecar, HaileSymbol } from '../haile/types.js';
import { monorepoGraph } from './arch-fixture.js';
import { locateInOverview, projectOverview } from './overview.js';
import { projectSlice } from './slice.js';
import { SLICE_CARD_CAP } from './arch-types.js';

function sidecarWith(symbols: HaileSymbol[]): HaileSidecar {
  return {
    magic: HAILE_MAGIC,
    taxonomy: HAILE_TAXONOMY,
    ir: HAILE_IR,
    corpus_hash: 'arch-test',
    engine_version: HAILE_ENGINE_VERSION,
    profile: 'balanced',
    policy: 'layered-v1',
    symbols,
  };
}

describe('workspace overview', () => {
  it('rolls a graph without packages up to one repository card', () => {
    const overview = projectOverview(fixtureGraph(), null);
    expect(overview.magic).toBe('vg.arch.overview.v1');
    expect(overview.packages).toHaveLength(1);
    expect(overview.packages[0]?.kind).toMatch(/area|root/);
    expect(overview.meta.symbols).toBe(3);
    expect(overview.packages[0]?.symbols).toBe(3);
    expect(overview.meta.architectureLoaded).toBe(false);
  });

  it('emits one card per package and aggregate edges, never files', () => {
    const overview = projectOverview(monorepoGraph(), null);
    expect(overview.packages.map((p) => p.path).sort()).toEqual(['packages/api', 'packages/web']);
    expect(overview.packages.every((p) => p.kind === 'package')).toBe(true);
    const webToApi = overview.edges.find((e) => e.src === 'pkg-web' && e.dst === 'pkg-api');
    expect(webToApi).toBeTruthy();
    expect(webToApi?.weight).toBeGreaterThanOrEqual(1);
    expect(overview.meta.symbols).toBe(6);
  });

  it('counts sidecar findings per package', () => {
    const overview = projectOverview(
      monorepoGraph(),
      sidecarWith([
        {
          node_id: 'CreateUser',
          file_path: 'packages/api/src/UsersController.ts',
          name: 'CreateUser',
          qualified_name: 'UsersController.CreateUser',
          symbol_kind: 'method',
          role: { primary: 'controller', alternatives: [], confidence: 0.9, band: 'high' },
          purposes: [{ purpose: 'respond', confidence: 0.9 }],
          intent: { text: 'creates a user', verbs: ['create'], objects: ['user'] },
          evidence: [],
          findings: [{ rule: 'layered-v1/demo', severity: 'hard', message: 'handler writes', line: 12 }],
        },
      ]),
    );
    const api = overview.packages.find((p) => p.path === 'packages/api');
    expect(api?.findings).toBe(1);
    expect(overview.meta.findings).toBe(1);
    expect(overview.meta.architectureLoaded).toBe(true);
  });

  it('locates a symbol in its package', () => {
    const hit = locateInOverview(monorepoGraph(), 'CreateUser');
    expect(hit).toEqual({ nodeId: 'CreateUser', packageId: 'pkg-api' });
    expect(locateInOverview(monorepoGraph(), 'nope')).toBeNull();
  });
});

describe('project slice', () => {
  it('hides tests and collapses by file+role under the cap', () => {
    const slice = projectSlice(monorepoGraph(), null, { packageId: 'pkg-api' });
    expect(slice.magic).toBe('vg.arch.slice.v1');
    expect(slice.columns.length).toBeGreaterThanOrEqual(3);
    const titles = slice.columns.flatMap((c) => c.cards.map((card) => card.title));
    expect(titles).not.toContain('makeUser');
    expect(titles.join(' ')).toMatch(/CreateUser|UsersController/);
    const painted = slice.columns.reduce((n, c) => n + c.cards.length, 0) + slice.guards.length;
    expect(painted).toBeLessThanOrEqual(SLICE_CARD_CAP);
  });

  it('uses layered columns when the sidecar says so', () => {
    const slice = projectSlice(
      monorepoGraph(),
      sidecarWith([
        {
          node_id: 'CreateUser',
          file_path: 'packages/api/src/UsersController.ts',
          name: 'CreateUser',
          qualified_name: 'UsersController.CreateUser',
          symbol_kind: 'method',
          role: { primary: 'controller', alternatives: [], confidence: 0.9, band: 'high' },
          purposes: [{ purpose: 'respond', confidence: 0.9 }],
          intent: { text: 'creates a user', verbs: ['create'], objects: ['user'] },
          evidence: [],
        },
        {
          node_id: 'UserService',
          file_path: 'packages/api/src/UserService.ts',
          name: 'Create',
          qualified_name: 'UserService.Create',
          symbol_kind: 'method',
          role: { primary: 'application_service', alternatives: [], confidence: 0.9, band: 'high' },
          purposes: [{ purpose: 'orchestrate', confidence: 0.9 }],
          intent: { text: 'creates a user', verbs: ['create'], objects: ['user'] },
          evidence: [],
        },
        {
          node_id: 'SaveUser',
          file_path: 'packages/api/src/UserRepo.ts',
          name: 'Save',
          qualified_name: 'UserRepo.Save',
          symbol_kind: 'method',
          role: { primary: 'repository', alternatives: [], confidence: 0.9, band: 'high' },
          purposes: [{ purpose: 'persist', confidence: 0.9 }],
          intent: { text: 'saves a user', verbs: ['save'], objects: ['user'] },
          evidence: [],
        },
      ]),
      { packageId: 'pkg-api' },
    );
    expect(slice.policy).toBe('layered-v1');
    expect(slice.columns.map((c) => c.title)).toEqual(['UI / Endpoint', 'Application', 'Persistence / IO']);
    expect(slice.columns[0]?.cards.some((c) => c.symbolId === 'CreateUser')).toBe(true);
    expect(slice.columns[1]?.cards.some((c) => c.symbolId === 'UserService')).toBe(true);
    expect(slice.columns[2]?.cards.some((c) => c.symbolId === 'SaveUser')).toBe(true);
  });

  it('keeps a focused symbol when capping', () => {
    const slice = projectSlice(monorepoGraph(), null, { packageId: 'pkg-api', focus: 'SaveUser', cap: 1 });
    expect(slice.focusCardId).toBeTruthy();
    const painted = slice.columns.flatMap((c) => c.cards);
    expect(painted.some((c) => c.symbolId === 'SaveUser' || c.id === slice.focusCardId)).toBe(true);
  });

  it('does not paint tests unless asked', () => {
    const hidden = projectSlice(monorepoGraph(), emptySidecar('arch-test'), { packageId: 'pkg-api' });
    expect(hidden.columns.flatMap((c) => c.cards).some((c) => c.title === 'makeUser')).toBe(false);
    const shown = projectSlice(monorepoGraph(), emptySidecar('arch-test'), { packageId: 'pkg-api', tests: true });
    expect(shown.columns.flatMap((c) => c.cards).some((c) => c.symbolId === 'helperTest' || c.title === 'makeUser')).toBe(
      true,
    );
  });
});
