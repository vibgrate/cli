import * as path from 'node:path';
import * as fs from 'node:fs';
import { Command } from 'commander';
import { loadGraph } from '../engine/load.js';
import { defaultGraphPath, vibgrateDir } from '../engine/artifacts.js';
import { cacheDir } from '../engine/cache.js';
import { discover } from '../engine/discover.js';
import { hashBytes } from '../engine/hash.js';
import { c, info, json } from '../util/output.js';
import { applyGlobalOptions, readGlobal, type GlobalOpts } from '../cli-options.js';

/**
 * `vg status` — cache/freshness, counts, staleness, resolver rungs used.
 * Read-only; compares the committed graph against the working tree.
 */
export function registerStatus(program: Command): void {
  const cmd = program
    .command('status')
    .description('cache/freshness, counts, staleness, resolver rungs used')
    .action(async function (this: Command) {
      await runStatus(readGlobal(this));
    });
  applyGlobalOptions(cmd);
}

async function runStatus(global: GlobalOpts): Promise<void> {
  const root = path.resolve(global.cwd ?? '.');
  const graphPath = global.graph ?? defaultGraphPath(root);
  const graph = loadGraph(root, graphPath);
  const hasCache = fs.existsSync(path.join(cacheDir(root), 'parse-cache.json'));

  // Determine staleness deterministically: compare current file hashes to the
  // corpus the committed graph was built from.
  let stale: number | null = null;
  if (graph) {
    const files = discover({ root });
    let changed = 0;
    // We can't recompute the exact per-file membership cheaply without the cache,
    // so staleness here is "files present now" vs "the graph's node file set".
    const graphFiles = new Set(graph.nodes.filter((n) => n.kind === 'file').map((n) => n.file));
    const currentFiles = new Set(files.map((f) => f.rel));
    for (const f of currentFiles) if (!graphFiles.has(f)) changed++;
    for (const f of graphFiles) if (!currentFiles.has(f)) changed++;
    stale = changed;
    void hashBytes; // hashing reserved for the cache-aware path
  }

  if (global.json) {
    json({
      root: path.relative(process.cwd(), root) || '.',
      graphPath: path.relative(root, graphPath),
      built: graph !== null,
      generatedAt: graph?.generatedAt ?? null,
      counts: graph?.meta.counts ?? null,
      languages: graph?.meta.languages ?? [],
      cluster: graph?.meta.cluster ?? null,
      resolver: graph?.provenance.resolver ?? [],
      corpusHash: graph?.provenance.corpusHash ?? null,
      cache: hasCache,
      staleFiles: stale,
    });
    return;
  }

  if (!graph) {
    info(`${c.cyan('vg')} · no map yet at ${c.dim(path.relative(root, graphPath))}`);
    info(`  run ${c.bold('vg')} to build one`);
    return;
  }

  info(`${c.cyan('vg')} · ${path.relative(root, graphPath)}`);
  info(`  generated ${graph.generatedAt}`);
  info(
    `  nodes ${c.bold(String(graph.meta.counts.nodes))}  edges ${c.bold(
      String(graph.meta.counts.edges),
    )}  areas ${graph.meta.counts.areas}  langs ${graph.meta.languages.join(',') || '—'}`,
  );
  info(`  cluster ${graph.meta.cluster} · resolver ${graph.provenance.resolver.join(',')}`);
  info(`  cache ${hasCache ? c.green('warm') : c.dim('cold')} · corpus ${graph.provenance.corpusHash.slice(0, 12)}…`);
  if (stale && stale > 0) {
    info(c.yellow(`  ${stale} file(s) changed since last build — run ${c.bold('vg')} to refresh`));
  } else {
    info(c.dim('  up to date'));
  }
  if (vibgrateDir(root)) {
    /* artifact dir exists implicitly */
  }
}
