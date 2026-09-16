/**
 * `projectOverview`/`projectSlice` are the fallback path used only when
 * `@vibgrate/haile` isn't installed or fails to load (see server.ts's
 * `overviewOf`/`sliceOf`). They must never classify — no role, no purpose,
 * no lane assignment — that's the module's job. These tests pin the fallback
 * to plain topology so a future edit doesn't quietly reintroduce
 * classification logic here. Classification behavior itself is tested in
 * `packages/vibgrate-haile/crate/src/map.rs`.
 */
import { describe, expect, it } from 'vitest';
import { fixtureGraph } from '../../code/graph-fixture.js';
import { monorepoGraph } from './arch-fixture.js';
import { locateInOverview, projectOverview } from './overview.js';
import { projectSlice } from './slice.js';

describe('workspace overview fallback', () => {
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

  it('never reports architecture loaded, even with a sidecar present', () => {
    // Sidecar role/purpose data belongs to the module. A sidecar being
    // present is not, by itself, a reason for this fallback to use it.
    const overview = projectOverview(monorepoGraph(), null);
    expect(overview.meta.architectureLoaded).toBe(false);
    expect(overview.meta.policy).toBeNull();
    expect(overview.packages.every((p) => p.policy === null)).toBe(true);
  });

  it('locates a symbol in its package', () => {
    const hit = locateInOverview(monorepoGraph(), 'CreateUser');
    expect(hit).toEqual({ nodeId: 'CreateUser', packageId: 'pkg-api' });
    expect(locateInOverview(monorepoGraph(), 'nope')).toBeNull();
  });
});

describe('project slice fallback', () => {
  it('hides tests and uses graph kinds, never role data', () => {
    const slice = projectSlice(monorepoGraph(), null, { packageId: 'pkg-api' });
    expect(slice.magic).toBe('vg.arch.slice.v1');
    expect(slice.policy).toBe('kind');
    const cards = slice.columns.flatMap((c) => c.cards);
    expect(cards.some((c) => c.title === 'makeUser')).toBe(false);
    expect(cards.every((c) => !c.classified)).toBe(true);
    expect(slice.columns.every((c) => c.id === 'unclassified' || c.cards.length === 0)).toBe(true);
    expect(slice.emptyHint).toMatch(/module not installed/);
  });

  it('does not hint at install when architecture is explicitly off', () => {
    const slice = projectSlice(monorepoGraph(), null, { packageId: 'pkg-api', architecture: false });
    expect(slice.emptyHint).toBeNull();
  });

  it('puts route/component nodes in the ui lane', () => {
    const slice = projectSlice(monorepoGraph(), null, { packageId: 'pkg-web' });
    expect(slice.columns[0]?.id).toBe('ui');
    expect(slice.columns[0]?.cards.some((c) => c.title === 'HomePage')).toBe(true);
  });

  it('keeps a focused symbol when capping', () => {
    const slice = projectSlice(monorepoGraph(), null, { packageId: 'pkg-api', focus: 'SaveUser', cap: 1 });
    expect(slice.focusCardId).toBeTruthy();
    const painted = slice.columns.flatMap((c) => c.cards);
    expect(painted.some((c) => c.symbolId === 'SaveUser' || c.id === slice.focusCardId)).toBe(true);
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
    const hidden = projectSlice(monorepoGraph(), null, { packageId: 'pkg-api' });
    expect(hidden.columns.flatMap((c) => c.cards).some((c) => c.title === 'makeUser')).toBe(false);
    const shown = projectSlice(monorepoGraph(), null, { packageId: 'pkg-api', tests: true });
    expect(shown.columns.flatMap((c) => c.cards).some((c) => c.symbolId === 'helperTest' || c.title === 'makeUser')).toBe(
      true,
    );
  });
});
