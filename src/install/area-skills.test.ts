import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AREA_SKILL_PREFIX, areaSkillFiles, writeAreaSkills } from './area-skills.js';
import type { Area, GraphNode, VgGraph } from '../schema.js';

/**
 * Per-area generated skills: deterministic content, reserved-namespace
 * lifecycle, and the marker-removal ownership contract shared with every
 * other installed instruction file.
 */

function node(id: string, name: string, file: string, area: number, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: `${file}:${name}`,
    file,
    span: { start: 3, end: 20 },
    lang: 'typescript',
    importance: 0.5,
    centrality: { degree: 1, betweenness: 0, pagerank: 0.1 },
    area,
    isHub: false,
    tested: true,
    ...over,
  } as GraphNode;
}

function makeGraph(): VgGraph {
  const payments: GraphNode[] = [
    node('p1', 'collectMandate', 'src/payments/mandate.ts', 0, { importance: 0.9, isHub: true, doc: 'Collects a direct debit mandate.' }),
    node('p2', 'chargeCard', 'src/payments/charge.ts', 0, { importance: 0.8 }),
    node('p3', 'refund', 'src/payments/refund.ts', 0, { importance: 0.4, tested: false }),
    node('p4', 'invoiceOf', 'src/payments/invoice.ts', 0, { importance: 0.3 }),
    node('p5', 'payout', 'src/payments/payout.ts', 0, { importance: 0.2 }),
  ];
  const i18n: GraphNode[] = [
    node('i1', 'localize', 'src/i18n/localize.ts', 1, { importance: 0.7 }),
    node('i2', 'plural', 'src/i18n/plural.ts', 1, { importance: 0.6 }),
    node('i3', 'formatDate', 'src/i18n/format.ts', 1, { importance: 0.5 }),
    node('i4', 'catalogOf', 'src/i18n/catalog.ts', 1, { importance: 0.4 }),
  ];
  const tiny: GraphNode[] = [node('t1', 'main', 'src/main.ts', 2)];
  const areas: Area[] = [
    { id: 0, label: 'payments', size: 5, members: payments.map((n) => n.id), cohesion: 0.8, externalEdges: 3 },
    { id: 1, label: 'i18n', size: 4, members: i18n.map((n) => n.id), cohesion: 0.7, externalEdges: 1 },
    { id: 2, label: 'tiny', size: 1, members: ['t1'], cohesion: 1, externalEdges: 0 },
  ];
  return {
    schemaVersion: 1,
    generatedAt: 'x',
    provenance: {},
    meta: { root: '.', languages: ['typescript'], counts: { nodes: 10, edges: 0, areas: 3, tests: 0, untested: 0 }, cluster: 'leiden' },
    nodes: [...payments, ...i18n, ...tiny],
    edges: [],
    areas,
  } as unknown as VgGraph;
}

describe('areaSkillFiles', () => {
  it('emits one skill per qualifying area (size floor), deterministically', () => {
    const g = makeGraph();
    const files = areaSkillFiles(g);
    expect([...files.keys()]).toEqual([`${AREA_SKILL_PREFIX}payments`, `${AREA_SKILL_PREFIX}i18n`]);
    // Byte-identical on regeneration — the zero-churn contract.
    expect(areaSkillFiles(makeGraph())).toEqual(files);
  });

  it('content carries frontmatter, version marker, entry points with file:line, hubs, and test posture', () => {
    const text = areaSkillFiles(makeGraph()).get(`${AREA_SKILL_PREFIX}payments`)!;
    expect(text).toMatch(/^---\nname: vg-area-payments\n/);
    expect(text).toContain('<!-- vg:v');
    expect(text).toContain('`src/payments/mandate.ts:collectMandate` — src/payments/mandate.ts:3 — Collects a direct debit mandate.');
    expect(text).toContain('## Hubs');
    expect(text).toContain('4/5 analyzable symbols tested');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no timestamps anywhere
  });
});

describe('writeAreaSkills lifecycle', () => {
  const setup = (areaSkills?: boolean): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area-skills-'));
    fs.mkdirSync(path.join(root, '.claude/skills/vg'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude/skills/vg/SKILL.md'), '# vg — the code map\n');
    if (areaSkills !== undefined) {
      fs.writeFileSync(path.join(root, 'vibgrate.config.json'), JSON.stringify({ areaSkills }));
    }
    return root;
  };

  it('writes into installed skill roots only when areaSkills is true', () => {
    const root = setup(true);
    const changes = writeAreaSkills(root, makeGraph());
    expect(changes.written).toContain(path.join('.claude/skills', `${AREA_SKILL_PREFIX}payments`, 'SKILL.md'));
    // .agents/skills has no vg install → untouched.
    expect(fs.existsSync(path.join(root, '.agents'))).toBe(false);
    // Second run: deterministic content → nothing rewritten.
    expect(writeAreaSkills(root, makeGraph())).toEqual({ written: [], removed: [] });
  });

  it('repos without vg install get nothing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area-skills-'));
    expect(writeAreaSkills(root, makeGraph())).toEqual({ written: [], removed: [] });
    expect(fs.existsSync(path.join(root, '.claude'))).toBe(false);
  });

  it('removes stale vg-area-* dirs that carry our marker, keeps user-owned ones', () => {
    const root = setup(true);
    const base = path.join(root, '.claude/skills');
    fs.mkdirSync(path.join(base, `${AREA_SKILL_PREFIX}old-area`), { recursive: true });
    fs.writeFileSync(path.join(base, `${AREA_SKILL_PREFIX}old-area`, 'SKILL.md'), '<!-- vg:v2 -->\nold\n');
    fs.mkdirSync(path.join(base, `${AREA_SKILL_PREFIX}mine`), { recursive: true });
    fs.writeFileSync(path.join(base, `${AREA_SKILL_PREFIX}mine`, 'SKILL.md'), 'my own skill, marker removed\n');
    const changes = writeAreaSkills(root, makeGraph());
    expect(changes.removed).toEqual([path.join('.claude/skills', `${AREA_SKILL_PREFIX}old-area`)]);
    expect(fs.existsSync(path.join(base, `${AREA_SKILL_PREFIX}mine`, 'SKILL.md'))).toBe(true);
  });

  it('default (no config) writes nothing and removes leftover generated vg-area-* skills', () => {
    const root = setup(true);
    expect(writeAreaSkills(root, makeGraph()).written.length).toBeGreaterThan(0);
    fs.rmSync(path.join(root, 'vibgrate.config.json'));
    const changes = writeAreaSkills(root, makeGraph());
    expect(changes.written).toEqual([]);
    expect(changes.removed).toEqual(
      expect.arrayContaining([
        path.join('.claude/skills', `${AREA_SKILL_PREFIX}payments`),
        path.join('.claude/skills', `${AREA_SKILL_PREFIX}i18n`),
      ]),
    );
    expect(fs.existsSync(path.join(root, '.claude/skills', `${AREA_SKILL_PREFIX}payments`))).toBe(false);
    expect(fs.existsSync(path.join(root, '.claude/skills/vg/SKILL.md'))).toBe(true);
  });

  it('never rewrites a current-area file whose marker was removed (user ownership)', () => {
    const root = setup(true);
    const mine = path.join(root, '.claude/skills', `${AREA_SKILL_PREFIX}payments`, 'SKILL.md');
    fs.mkdirSync(path.dirname(mine), { recursive: true });
    fs.writeFileSync(mine, 'hand-tuned, no marker\n');
    const changes = writeAreaSkills(root, makeGraph());
    expect(changes.written.some((f) => f.includes('payments'))).toBe(false);
    expect(fs.readFileSync(mine, 'utf8')).toBe('hand-tuned, no marker\n');
  });
});
