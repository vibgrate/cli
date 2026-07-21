import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildGraph } from './build.js';
// @ts-ignore — plain-JS fixture module, no types needed
import { DI_LANGS, DI_SIGNALS, scoreDi } from '../../bench/di-fixtures.mjs';

/** Write a fixture's files under a fresh temp dir; caller removes it. */
function makeProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-di-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}
const cleanup = (root: string): void => fs.rmSync(root, { recursive: true, force: true });

/**
 * Cross-language dependency-injection resolution gate. Builds a real graph from
 * each language's DI fixture and scores the four DI signals (interface-injected
 * call → implementation, test link, injected-interface reference, conformance
 * edge). This is the enforcement half of the published `bench:di` benchmark:
 * the bench reports the numbers per release; this gate locks in the languages
 * that work and guards against regressions.
 *
 * It asserts a per-language FLOOR (the current resolved count), so improving a
 * language is free but regressing one fails CI. C# is pinned at a full 4/4 — it
 * is the reference implementation of the fix and must never regress.
 */

interface LangEntry {
  lang: string;
  label: string;
  files: Record<string, string>;
  expect: Record<string, unknown>;
  note?: string;
}

const PIN = '2020-01-01T00:00:00.000Z';

// Current resolved-signal floor per language (see bench/di-fixtures.mjs). Raise
// a number here when a fix improves that language; never lower it.
const FLOOR: Record<string, number> = {
  cs: 4,
  java: 4,
  kotlin: 4,
  scala: 4,
  dart: 4,
  php: 4,
  ts: 4,
  go: 0,
  rust: 0,
  swift: 4,
  objc: 0,
};

describe('cross-language DI resolution gate', () => {
  for (const entry of DI_LANGS as LangEntry[]) {
    it(`${entry.label}: resolves at least ${FLOOR[entry.lang]}/${(DI_SIGNALS as string[]).filter((s) => entry.expect[s]).length} DI signals`, async () => {
      const root = makeProject(entry.files);
      try {
        const { graph } = await buildGraph({ root, generatedAt: PIN, inline: true });
        const scored = scoreDi(entry, graph) as { resolved: number; applicable: number; signals: Record<string, boolean | null> };
        expect(scored.resolved, `${entry.label} DI signals: ${JSON.stringify(scored.signals)}`).toBeGreaterThanOrEqual(FLOOR[entry.lang]!);
      } finally {
        cleanup(root);
      }
    }, 60_000);
  }

  it('C# resolves the full DI chain (the reference fix must not regress)', async () => {
    const cs = (DI_LANGS as LangEntry[]).find((l) => l.lang === 'cs')!;
    const root = makeProject(cs.files);
    try {
      const { graph } = await buildGraph({ root, generatedAt: PIN, inline: true });
      const scored = scoreDi(cs, graph) as { resolved: number; applicable: number };
      expect(scored.resolved).toBe(scored.applicable); // 4/4
    } finally {
      cleanup(root);
    }
  }, 60_000);
});
