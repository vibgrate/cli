import { describe, expect, it } from 'vitest';
import { fixtureGraph } from '../../code/graph-fixture.js';
import { emptySidecar } from '../haile/sidecar.js';
import { HAILE_ENGINE_VERSION, HAILE_IR, HAILE_MAGIC, HAILE_TAXONOMY } from '../haile/types.js';
import type { HaileSidecar, HaileSymbol } from '../haile/types.js';
import { monorepoGraph } from './arch-fixture.js';
import { locateInOverview, projectOverview } from './overview.js';
import { projectSlice } from './slice.js';

function sidecarWith(symbols: HaileSymbol[], policy: HaileSidecar['policy'] = 'layered-v1'): HaileSidecar {
  return {
    magic: HAILE_MAGIC,
    taxonomy: HAILE_TAXONOMY,
    ir: HAILE_IR,
    corpus_hash: 'arch-test',
    engine_version: HAILE_ENGINE_VERSION,
    profile: 'balanced',
    policy,
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
    expect(api?.mix).toMatch(/finding/);
    expect(api?.job).not.toBe('package');
  });

  it('locates a symbol in its package', () => {
    const hit = locateInOverview(monorepoGraph(), 'CreateUser');
    expect(hit).toEqual({ nodeId: 'CreateUser', packageId: 'pkg-api' });
    expect(locateInOverview(monorepoGraph(), 'nope')).toBeNull();
  });
});

describe('project slice', () => {
  it('hides tests and uses graph kinds when the sidecar is absent', () => {
    const slice = projectSlice(monorepoGraph(), null, { packageId: 'pkg-api' });
    expect(slice.magic).toBe('vg.arch.slice.v1');
    const cards = slice.columns.flatMap((c) => c.cards);
    expect(cards.some((c) => c.title === 'makeUser')).toBe(false);
    expect(cards.every((c) => c.job === 'Method' || c.job === 'Type')).toBe(true);
    expect(cards.every((c) => !/Symbol · Symbol/.test(c.subtitle))).toBe(true);
    expect(slice.columns.every((c) => c.id === 'unclassified' || c.cards.length === 0)).toBe(true);
    expect(slice.emptyHint).toMatch(/catching up/);
  });

  it('does not hint catching up when architecture is off', () => {
    const slice = projectSlice(monorepoGraph(), null, { packageId: 'pkg-api', architecture: false });
    expect(slice.emptyHint).toBeNull();
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
    expect(slice.columns[0]?.cards[0]?.job).toBe('HTTP handler');
    expect(slice.columns[1]?.cards.some((c) => c.symbolId === 'UserService')).toBe(true);
    expect(slice.columns[2]?.cards.some((c) => c.symbolId === 'SaveUser')).toBe(true);
    expect(slice.columns.some((c) => c.title === 'Types / IO')).toBe(false);
  });

  it('puts UI roles in UI / Endpoint and lifts call edges onto the card', () => {
    const graph = monorepoGraph();
    const slice = projectSlice(
      graph,
      sidecarWith([
        {
          node_id: 'HomePage',
          file_path: 'packages/web/src/HomePage.tsx',
          name: 'HomePage',
          qualified_name: 'HomePage',
          symbol_kind: 'component',
          role: { primary: 'user_interface', alternatives: [], confidence: 0.9, band: 'high' },
          purposes: [{ purpose: 'render', confidence: 0.9 }],
          intent: { text: 'renders the product listing', verbs: ['render'], objects: ['listing'] },
          evidence: [],
        },
      ]),
      { packageId: 'pkg-web' },
    );
    expect(slice.columns[0]?.id).toBe('ui');
    const home = slice.columns[0]?.cards.find((c) => c.title === 'HomePage');
    expect(home?.job).toBe('Interface');
    expect(home?.subtitle).toMatch(/Draws the UI/);
    expect(home?.intent).toMatch(/product listing/);
    expect(home?.calls?.some((c) => c.name.includes('CreateUser'))).toBe(true);
    expect(slice.columns.some((c) => c.id === 'app' && c.cards.length > 0)).toBe(false);
  });

  it('names adapters and helpers instead of Unclassified', () => {
    const slice = projectSlice(
      monorepoGraph(),
      sidecarWith(
        [
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
            node_id: 'SaveUser',
            file_path: 'packages/api/src/UserRepo.ts',
            name: 'Save',
            qualified_name: 'UserRepo.Save',
            symbol_kind: 'method',
            role: { primary: 'adapter', alternatives: [], confidence: 0.8, band: 'high' },
            purposes: [{ purpose: 'persist', confidence: 0.8 }],
            intent: { text: 'saves a user', verbs: ['save'], objects: ['user'] },
            evidence: [],
          },
          {
            node_id: 'UserService',
            file_path: 'packages/api/src/UserService.ts',
            name: 'Create',
            qualified_name: 'UserService.Create',
            symbol_kind: 'method',
            role: { primary: 'utility', alternatives: [], confidence: 0.6, band: 'medium' },
            purposes: [],
            intent: { text: '', verbs: [], objects: [] },
            evidence: [],
          },
        ],
        'hexagonal-v1',
      ),
      { packageId: 'pkg-api' },
    );
    const jobs = slice.columns.flatMap((c) => c.cards.map((card) => card.job));
    expect(jobs).toContain('HTTP handler');
    expect(jobs).toContain('Adapter');
    expect(jobs).toContain('Helper');
    expect(jobs.filter((j) => j === 'Unclassified')).toHaveLength(0);
  });

  it('still paints jobs when the classify file is from the previous corpus', () => {
    const sidecar = sidecarWith(
      [
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
      ],
      'layered-v1',
    );
    sidecar.corpus_hash = 'from-the-last-rebuild';
    const slice = projectSlice(monorepoGraph(), sidecar, { packageId: 'pkg-api' });
    expect(slice.policy).toBe('layered-v1');
    expect(slice.columns[0]?.cards.some((c) => c.job === 'HTTP handler')).toBe(true);
  });

  it('keeps a focused symbol when capping', () => {
    const slice = projectSlice(monorepoGraph(), null, { packageId: 'pkg-api', focus: 'SaveUser', cap: 1 });
    expect(slice.focusCardId).toBeTruthy();
    const painted = slice.columns.flatMap((c) => c.cards);
    expect(painted.some((c) => c.symbolId === 'SaveUser' || c.id === slice.focusCardId)).toBe(true);
  });

  it('folds DTOs and never titles a card constructor', () => {
    const slice = projectSlice(monorepoGraph(), null, { packageId: 'pkg-api' });
    const titles = slice.columns.flatMap((c) => c.cards.map((card) => card.title));
    expect(titles).not.toContain('UserDto');
    expect(titles).not.toContain('constructor');
  });

  it('expand raises the per-lane cap so +N more can open the rest', () => {
    const tight = projectSlice(monorepoGraph(), null, { packageId: 'pkg-api', cap: 1 });
    const wide = projectSlice(monorepoGraph(), null, { packageId: 'pkg-api', expand: true });
    const tightN = tight.columns.flatMap((c) => c.cards).length;
    const wideN = wide.columns.flatMap((c) => c.cards).length;
    expect(tightN).toBeLessThanOrEqual(1 + (tight.focusCardId ? 1 : 0));
    expect(wideN).toBeGreaterThan(tightN);
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
