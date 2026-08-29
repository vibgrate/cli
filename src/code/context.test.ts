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

  it('orders the block cache-stably: constraints before symbols before scope', () => {
    const ctx = buildCodeContext(fixtureGraph(), 'add a timeout to scanDir');
    const rendered = ctx.rendered;
    expect(rendered.indexOf('## Hard constraints')).toBeLessThan(rendered.indexOf('## Relevant symbols'));
    expect(rendered.indexOf('## Relevant symbols')).toBeLessThan(rendered.indexOf('## Files in scope'));
  });

  it('never echoes the instruction — the caller sends the ask as its own turn', () => {
    // buildAgentMessages appends a task turn of its own, so echoing the ask
    // here billed it twice on every step and let a long one crowd out symbols.
    const ask = 'add a timeout to scanDir';
    const ctx = buildCodeContext(fixtureGraph(), ask);
    expect(ctx.rendered).not.toContain('## Task');
    expect(ctx.rendered).not.toContain(ask);
    expect(ctx.instruction).toBe(ask);
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

  it('pins URL needles and does not invent unrelated symbol seeds for occurrence locates', () => {
    const ctx = buildCodeContext(
      fixtureGraph(),
      'https://dash.vibgrate.com/signup does not exist find occurrences',
    );
    expect(ctx.seeds).toHaveLength(0);
    expect(ctx.pinnedFacts.some((f) => f.includes('https://dash.vibgrate.com/signup'))).toBe(true);
    expect(ctx.pinnedFacts.some((f) => f.includes('literal-locate'))).toBe(true);
    expect(ctx.rendered).toContain('https://dash.vibgrate.com/signup');
  });

  it('does not pin host attachment basenames/paths as literal-locate hard constraints (field report)', () => {
    // VS Code packs screenshots after a --- / User attachments fence with
    // backticks around the filename and on-disk path. Those must never become
    // "0 hits → finish, do not invent an edit" pins that abort a coding task.
    const instruction = [
      'add a timeout to scanDir and show a green health check on the version badge',
      '',
      '---',
      '## User attachments (always include in your reasoning for this turn)',
      '',
      '### Attached image: `image.png`',
      'The image is attached to this message for vision-capable models, and saved at: `.vibgrate/code-attachments/msioq2sz-0.png`',
      'MIME: image/png · ~42 KiB',
    ].join('\n');
    const ctx = buildCodeContext(fixtureGraph(), instruction);
    expect(ctx.pinnedFacts.some((f) => f.includes('image.png'))).toBe(false);
    expect(ctx.pinnedFacts.some((f) => f.includes('code-attachments'))).toBe(false);
    expect(ctx.pinnedFacts.some((f) => f.includes('literal-locate') && f.includes('image.png'))).toBe(
      false,
    );
    // The full instruction — attachments included — still reaches the model:
    // it is carried on `instruction` and sent as the caller's own task turn,
    // rather than echoed into this block (which would bill it twice).
    expect(ctx.instruction).toContain('User attachments');
    expect(ctx.instruction).toContain('image.png');
    expect(ctx.rendered).not.toContain('image.png');
    // Seed ranking still follows the user ask.
    expect(ctx.seeds.some((s) => s.node.qualifiedName === 'scanDir')).toBe(true);
  });

  it('still pins user-quoted needles when an attachment appendix is also present', () => {
    const instruction = [
      'find every "scanDir" occurrence and document them',
      '',
      '---',
      '## User attachments (always include in your reasoning for this turn)',
      '',
      '### Attached image: `shot.png`',
      'saved at: `.vibgrate/code-attachments/x-0.png`',
    ].join('\n');
    const ctx = buildCodeContext(fixtureGraph(), instruction);
    expect(ctx.pinnedFacts.some((f) => f.includes('literal-locate') && f.includes('scanDir'))).toBe(
      true,
    );
    expect(ctx.pinnedFacts.some((f) => f.includes('shot.png'))).toBe(false);
  });
});

