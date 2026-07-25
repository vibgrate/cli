/**
 * Layer A — semantic / synonym ask quality (no model).
 *
 * Exercises hybrid lexical retrieval on a tiny built graph with intentional
 * naming asymmetry: the question shares no exact identifier with the target
 * so pure keyword search is weak and structural/morphological retrieval must
 * carry the hit. Full embedding hybrid runs when the local embedder is available.
 *
 *   pnpm --filter @vibgrate/cli-public exec tsx bench/semantic-ask.bench.ts
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildGraph } from '../src/engine/build.js';
import { queryGraph, queryGraphSemantic } from '../src/engine/query.js';
import { loadEmbedder, getNodeEmbeddings } from '../src/engine/embeddings.js';

interface Case {
  id: string;
  question: string;
  mustFile: string;
  /** Optional: at least one match qualifiedName contains this. */
  mustNamePart?: string;
}

const CASES: Case[] = [
  {
    id: 'auth-failure-synonym',
    question: 'where do we handle login failures and rejected credentials?',
    mustFile: 'src/security/credentials.ts',
    mustNamePart: 'reject',
  },
  {
    id: 'cart-total-synonym',
    question: 'code that computes the final price of a shopping cart',
    mustFile: 'src/checkout/totals.ts',
    mustNamePart: 'total',
  },
  {
    id: 'health-route',
    question: 'HTTP endpoint that reports process liveness',
    mustFile: 'src/http/health.ts',
    mustNamePart: 'health',
  },
];

function materializeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-semantic-ask-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'semantic-ask-fixture', type: 'module' }),
    'src/security/credentials.ts': `
export function rejectInvalidCredentials(reason: string): never {
  throw new Error(\`auth failed: \${reason}\`);
}
export function verifyPassword(hash: string, plain: string): boolean {
  return hash === plain;
}
`,
    'src/checkout/totals.ts': `
export function computeCartGrandTotal(lines: { price: number; qty: number }[]): number {
  return lines.reduce((s, l) => s + l.price * l.qty, 0);
}
`,
    'src/http/health.ts': `
export function healthHandler(): { status: string } {
  return { status: 'ok' };
}
`,
    'src/noise/unrelated.ts': `
export function formatBanner(title: string): string {
  return title.toUpperCase();
}
`,
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body.trimStart());
  }
  return root;
}

async function main(): Promise<void> {
  const root = materializeRepo();
  try {
    const built = await buildGraph({
      root,
      noGround: true,
      noTsc: true,
      noCoverage: true,
      noScip: true,
      generatedAt: '2026-01-01T00:00:00Z',
    });
    const graph = built.graph;
    let embedder = null as Awaited<ReturnType<typeof loadEmbedder>> | null;
    let nodeVectors: Map<string, number[]> | null = null;
    try {
      embedder = await loadEmbedder({ root });
      if (embedder) {
        nodeVectors = await getNodeEmbeddings(graph, embedder, root);
      } else {
        console.log('  (local embedder unavailable — lexical-only path)\n');
      }
    } catch {
      console.log('  (local embedder unavailable — lexical-only path)\n');
    }

    let failed = 0;
    console.log(`\nSemantic-ask quality — ${graph.nodes.length} nodes, ${CASES.length} cases\n`);
    for (const c of CASES) {
      const lexical = queryGraph(graph, c.question, { limit: 12 });
      let matches = lexical.matches;
      let mode = 'lexical';
      if (embedder && nodeVectors) {
        const hybrid = await queryGraphSemantic(graph, c.question, {
          limit: 12,
          embedder,
          nodeVectors,
        });
        matches = hybrid.matches;
        mode = 'hybrid';
      }
      const top = matches.slice(0, 5);
      const hit = top.some(
        (m) =>
          m.node.file.replace(/\\/g, '/').includes(c.mustFile.replace(/\\/g, '/')) ||
          m.node.file.replace(/\\/g, '/').endsWith(c.mustFile.replace(/^src\//, '')),
      );
      const nameHit = c.mustNamePart
        ? top.some((m) => m.node.qualifiedName.toLowerCase().includes(c.mustNamePart!.toLowerCase()))
        : true;
      const ok = hit || nameHit;
      if (!ok) failed += 1;
      const topNames = top.map((m) => `${m.node.qualifiedName}@${m.node.file}`).join(' | ') || '(none)';
      console.log(`  ${ok ? '✓' : '✗'} [${mode}] ${c.id}`);
      console.log(`      q: ${c.question}`);
      console.log(`      top: ${topNames}`);
    }
    console.log(`\n  ${CASES.length - failed}/${CASES.length} cases resolved\n`);
    if (failed) process.exit(2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
