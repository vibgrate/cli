import { buildGraph } from './build.js';
import { serializeGraph } from './serialize.js';
import { loadGraph } from './load.js';
import { hashString } from './hash.js';

/**
 * Determinism self-check (`vg verify`, exit 4 on failure).
 *
 * Proves the load-bearing guarantees:
 *   1. Run-to-run determinism — two full rebuilds are byte-identical.
 *   2. Cache safety — an incremental (cache-warm) build equals a full rebuild.
 *   3. Toolchain reproducibility — the toolchain that would build the graph here
 *      matches the one recorded in the committed `graph.json` (when present), so a
 *      CI run and a laptop run on different grammar/resolver versions are caught
 *      instead of silently producing a different graph.
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

  const buildA = await buildGraph({ ...base, noCache: true, jobs: opts.jobs });
  const a = serializeGraph(buildA.graph);
  const b = serializeGraph((await buildGraph({ ...base, noCache: true, jobs: 1 })).graph);
  const cached = serializeGraph((await buildGraph({ ...base, noCache: false })).graph);

  const checks = [
    { name: 'run-to-run determinism', ok: a === b, detail: diffHint(a, b) },
    { name: 'cache safety (incremental == full)', ok: a === cached, detail: diffHint(a, cached) },
  ];

  // Toolchain reproducibility: if a graph.json is committed, the toolchain that
  // would build it here must match the one it was built with. A mismatch is the
  // CI-vs-laptop divergence surfacing loudly instead of as a silent content diff.
  // Skip under --only/--exclude: a scoped rebuild's resolver set (e.g. no tsc for
  // a non-TS subtree) legitimately differs from the full-repo committed graph, so
  // comparing the two would be a false failure.
  const scoped = Boolean(opts.only?.length || opts.exclude?.length);
  const committed = scoped ? null : loadGraph(opts.root);
  const committedFp = committed?.provenance.toolchain?.fingerprint;
  const currentFp = buildA.graph.provenance.toolchain?.fingerprint;
  if (committedFp && currentFp) {
    const ok = committedFp === currentFp;
    checks.push({
      name: 'toolchain fingerprint matches committed graph',
      ok,
      detail: ok
        ? undefined
        : `committed toolchain ${committedFp} != current ${currentFp} ` +
          `(grammar/resolver versions differ — rebuild or align the toolchain)`,
    });
  }

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
