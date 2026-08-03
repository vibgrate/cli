import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TOOLS, type ToolContext } from './tools.js';
import { serializeGraph } from '../engine/serialize.js';
import { repositoryIdFromRoot } from '../runtime/paths.js';
import type { GraphNode, VgGraph } from '../schema.js';

/**
 * cross_impact_of — federated blast radius: home impact + which member repos
 * consume this repo over high-confidence bridges, every hop carrying
 * confidence, evidence, and the member graph's identity (corpusHash).
 */

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

function node(id: string, name: string, file: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: `${file}:${name}`,
    file,
    span: { start: 5, end: 25 },
    lang: 'typescript',
    importance: 0.6,
    centrality: { degree: 1, betweenness: 0, pagerank: 0.1 },
    area: 0,
    isHub: false,
    tested: true,
    ...over,
  } as GraphNode;
}

function graphWith(nodes: GraphNode[], corpusHash: string): VgGraph {
  return {
    schemaVersion: 1,
    generatedAt: 'x',
    provenance: { corpusHash },
    meta: { root: '.', languages: ['typescript'], counts: { nodes: nodes.length, edges: 0, areas: 1, tests: 0, untested: 0 }, cluster: 'none' },
    nodes,
    edges: [],
    areas: [],
  } as unknown as VgGraph;
}

describe('cross_impact_of', () => {
  it('single-repo workspace reports home impact and says so honestly', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ximpact-single-'));
    const g = graphWith([node('a', 'collectMandate', 'src/pay.ts')], 'hash-a');
    const r = (await tool('cross_impact_of').handler(g, { name: 'collectMandate' }, { root } as ToolContext)) as Record<string, unknown>;
    expect(r.root).toBe('collectMandate');
    expect(String(r.federation)).toContain('single-repo');
    expect(String(r.summary)).toContain('no federated members');
  });

  it('reports consuming members over high-confidence bridges with matches and graph identity', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ximpact-fed-'));
    const home = path.join(base, 'home');
    const memberB = path.join(base, 'member-b');
    fs.mkdirSync(path.join(home, '.vibgrate'), { recursive: true });
    fs.mkdirSync(path.join(memberB, '.vibgrate'), { recursive: true });

    // Member B's built map contains a same-name consumer symbol.
    const bGraph = graphWith(
      [node('b1', 'collectMandate', 'src/billing/wrapper.ts'), node('b2', 'unrelated', 'src/other.ts')],
      'hash-b',
    );
    fs.writeFileSync(path.join(memberB, '.vibgrate', 'graph.json'), serializeGraph(bGraph));

    const homeId = repositoryIdFromRoot(home);
    const bId = repositoryIdFromRoot(memberB);
    fs.writeFileSync(
      path.join(home, '.vibgrate', 'federation.json'),
      JSON.stringify({
        schemaVersion: 'federation/0',
        members: [{ root: '.', role: 'primary' }, { root: '../member-b', label: 'member-b' }],
        bridges: [
          {
            schemaVersion: 'bridge-edge/0',
            fromRepositoryId: bId,
            toRepositoryId: homeId,
            fromRoot: memberB,
            toRoot: home,
            kind: 'package-dependency',
            confidence: 0.9,
            evidence: 'member-b depends on home@workspace:*',
            packageName: 'home',
          },
          // Low-confidence bridge must be ignored (capsule rule applies to MCP).
          {
            schemaVersion: 'bridge-edge/0',
            fromRepositoryId: bId,
            toRepositoryId: homeId,
            fromRoot: memberB,
            toRoot: home,
            kind: 'openapi-ref',
            confidence: 0.3,
            evidence: 'weak guess',
          },
        ],
      }),
    );

    const g = graphWith([node('a', 'collectMandate', 'src/pay.ts')], 'hash-a');
    const r = (await tool('cross_impact_of').handler(g, { name: 'collectMandate' }, { root: home } as ToolContext)) as {
      federation: { consumingMembers: number; bridgesConsidered: number };
      crossRepo: { member: string; via: { kind: string; confidence: number; evidence: string }[]; graph: { corpusHash: string } | null; matches?: { qualifiedName: string; file: string; line: number }[] }[];
      summary: string;
    };
    expect(r.federation.consumingMembers).toBe(1);
    expect(r.federation.bridgesConsidered).toBe(1); // the 0.3 bridge is dropped
    const b = r.crossRepo[0]!;
    expect(b.member).toBe('member-b');
    expect(b.via[0]).toMatchObject({ kind: 'package-dependency', confidence: 0.9, evidence: 'member-b depends on home@workspace:*' });
    expect(b.graph).toEqual({ corpusHash: 'hash-b' });
    expect(b.matches).toEqual([{ qualifiedName: 'src/billing/wrapper.ts:collectMandate', file: 'src/billing/wrapper.ts', line: 5 }]);
    expect(r.summary).toContain('1 member repo(s) consume this repo');
  });

  it('a consuming member without a built map is reported with guidance, not dropped', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ximpact-nomap-'));
    const home = path.join(base, 'home');
    const memberB = path.join(base, 'member-b');
    fs.mkdirSync(path.join(home, '.vibgrate'), { recursive: true });
    fs.mkdirSync(memberB, { recursive: true });
    fs.writeFileSync(
      path.join(home, '.vibgrate', 'federation.json'),
      JSON.stringify({
        schemaVersion: 'federation/0',
        members: [{ root: '.', role: 'primary' }, { root: '../member-b' }],
        bridges: [
          {
            schemaVersion: 'bridge-edge/0',
            fromRepositoryId: repositoryIdFromRoot(memberB),
            toRepositoryId: repositoryIdFromRoot(home),
            fromRoot: memberB,
            toRoot: home,
            kind: 'package-dependency',
            confidence: 1,
            evidence: 'workspace link',
          },
        ],
      }),
    );
    const g = graphWith([node('a', 'collectMandate', 'src/pay.ts')], 'hash-a');
    const r = (await tool('cross_impact_of').handler(g, { name: 'collectMandate' }, { root: home } as ToolContext)) as {
      crossRepo: { graph: unknown; note?: string }[];
    };
    expect(r.crossRepo).toHaveLength(1);
    expect(r.crossRepo[0]!.graph).toBeNull();
    expect(r.crossRepo[0]!.note).toContain('no code map built');
  });
});
