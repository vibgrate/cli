import { buildGraph } from './build.js';
import { serializeGraph } from './serialize.js';
import { hashString } from './hash.js';

/**
 * Determinism self-check (`vg verify`, exit 4 on failure).
 *
 * Proves the two load-bearing guarantees:
 *   1. Run-to-run determinism — two full rebuilds are byte-identical.
 *   2. Cache safety — an incremental (cache-warm) build equals a full rebuild.
 *
 * `generatedAt` is pinned to a constant for the comparison so the only legitimate
 * source of variation is removed and any real nondeterminism surfaces.
 */

const PINNED = '1970-01-01T00:00:00.000Z';

export interface VerifyResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
  digest: string;
}

export async function verifyDeterminism(opts: {
  root: string;
  only?: string[];
  exclude?: string[];
  jobs?: number;
}): Promise<VerifyResult> {
  const base = { root: opts.root, only: opts.only, exclude: opts.exclude, generatedAt: PINNED };

  const a = serializeGraph((await buildGraph({ ...base, noCache: true, jobs: opts.jobs })).graph);
  const b = serializeGraph((await buildGraph({ ...base, noCache: true, jobs: 1 })).graph);
  const cached = serializeGraph((await buildGraph({ ...base, noCache: false })).graph);

  const checks = [
    { name: 'run-to-run determinism', ok: a === b, detail: diffHint(a, b) },
    { name: 'cache safety (incremental == full)', ok: a === cached, detail: diffHint(a, cached) },
  ];

  return {
    ok: checks.every((c) => c.ok),
    checks,
    digest: hashString(a),
  };
}

function diffHint(x: string, y: string): string | undefined {
  if (x === y) return undefined;
  // Find the first differing line for an actionable message (no internals leak).
  const xl = x.split('\n');
  const yl = y.split('\n');
  const n = Math.max(xl.length, yl.length);
  for (let i = 0; i < n; i++) {
    if (xl[i] !== yl[i]) {
      return `first divergence at line ${i + 1}`;
    }
  }
  return 'outputs differ in length';
}
