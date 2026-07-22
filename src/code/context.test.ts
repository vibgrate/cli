import { describe, it, expect } from 'vitest';
import { buildCodeContext } from './context.js';
import { fixtureGraph } from './graph-fixture.js';

describe('buildCodeContext', () => {
  it('surfaces the relevant symbol as a seed and its file as a target', () => {
    const ctx = buildCodeContext(fixtureGraph(), 'add a timeout to scanDir');
    expect(ctx.seeds.some((s) => s.node.qualifiedName === 'scanDir')).toBe(true);
    expect(ctx.targetFiles).toContain('src/scan.ts');
  });

  it('pins declared hard-constraint facts touching a seed', () => {
    const ctx = buildCodeContext(fixtureGraph(), 'change scanDir');
    expect(ctx.pinnedFacts.join('\n')).toContain('never follow symlinks');
    expect(ctx.rendered).toContain('Hard constraints');
  });

  it('includes the blast radius (a caller of the seed)', () => {
    const ctx = buildCodeContext(fixtureGraph(), 'scanDir');
    // formatReport calls scanDir, so it is impacted by a change to scanDir.
    expect(ctx.impacted.some((i) => i.node.qualifiedName === 'formatReport')).toBe(true);
  });

  it('orders the block cache-stably: constraints/context first, the task last', () => {
    const ctx = buildCodeContext(fixtureGraph(), 'add a timeout to scanDir');
    const rendered = ctx.rendered;
    expect(rendered.indexOf('## Hard constraints')).toBeLessThan(rendered.indexOf('## Task'));
    expect(rendered.indexOf('## Relevant symbols')).toBeLessThan(rendered.indexOf('## Task'));
    expect(rendered.trimEnd().endsWith('add a timeout to scanDir')).toBe(true);
  });

  it('restricts target files when --file scoping is given', () => {
    const ctx = buildCodeContext(fixtureGraph(), 'scanDir', { files: ['src/report.ts'] });
    expect(ctx.targetFiles).toEqual(['src/report.ts']);
  });

  it('is deterministic', () => {
    const a = buildCodeContext(fixtureGraph(), 'add a timeout to scanDir').rendered;
    const b = buildCodeContext(fixtureGraph(), 'add a timeout to scanDir').rendered;
    expect(a).toBe(b);
  });
});
