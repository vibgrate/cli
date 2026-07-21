import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildGraph } from '../src/engine/build.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS fixture module, no types needed
import { DI_LANGS, DI_SIGNALS, scoreDi } from './di-fixtures.mjs';

/**
 * The published cross-language DI-resolution benchmark: builds each language's
 * dependency-injection fixture and reports how many of the four DI signals the
 * graph recovers — the "interface-injected services aren't orphans" metric,
 * tracked release-over-release. Run:
 *
 *   pnpm --filter @vibgrate/cli-public bench:di
 *
 * The same corpus is enforced in CI by src/engine/di-quality.test.ts (per-lang
 * floor); this is the numbers half, printing the full signal matrix.
 */

interface Scored {
  resolved: number;
  applicable: number;
  signals: Record<string, boolean | null>;
}

async function main(): Promise<void> {
  const cell = (v: boolean | null): string => (v === null ? ' ·  ' : v ? ' ✓  ' : ' ✗  ');
  console.log(`\nCross-language DI resolution — interface→implementation, ${DI_LANGS.length} languages\n`);
  console.log(`  ${'language'.padEnd(14)} ${DI_SIGNALS.map((s: string) => s.padEnd(4)).join(' ')}  score`);
  let resolved = 0;
  let applicable = 0;
  for (const entry of DI_LANGS) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `di-${entry.lang}-`));
    for (const [rel, content] of Object.entries(entry.files as Record<string, string>)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    let scored: Scored = { resolved: 0, applicable: 0, signals: {} };
    let err = '';
    try {
      const { graph } = await buildGraph({ root, generatedAt: '2020-01-01T00:00:00.000Z', inline: true });
      scored = scoreDi(entry, graph) as Scored;
    } catch (e) {
      err = String((e as Error).message).slice(0, 50);
    }
    const cells = DI_SIGNALS.map((s: string) => cell(scored.signals[s] ?? null)).join(' ');
    console.log(`  ${entry.label.padEnd(14)} ${cells}  ${scored.resolved}/${scored.applicable}${entry.note ? `  (${entry.note.slice(0, 60)})` : ''}${err ? '  ERR ' + err : ''}`);
    resolved += scored.resolved;
    applicable += scored.applicable;
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`\n  overall ${resolved}/${applicable} (${Math.round((resolved / applicable) * 100)}%) DI signals resolved\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
