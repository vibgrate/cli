import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { resolvedGrammarFiles, grammarSetVersion } from '../engine/grammars.js';
import {
  TOOLCHAIN_GRAMMARS,
  resolveToolchainGrammar,
} from '../engine/toolchain/grammars.js';
import { resolveGraphPath } from '../engine/artifacts.js';
import { catalogPath, libDir } from '../engine/lib.js';
import { serializeGraph, stableStringify } from '../engine/serialize.js';
import { loadGraphFileWithSnapshot } from '../engine/snapshot.js';
import { VERSION } from '../version.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { rootOf } from './util.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info, json } from '../util/output.js';

/**
 * `vg bundle --offline -o <dir>` (VG-INSTALL-MATRIX §9) — assemble an air-gapped
 * bundle: the grammar .wasm set, the current graph, and the library catalog,
 * plus a manifest. Point an offline machine at it with `vg build --grammars`.
 * Deterministic; no network.
 */
export function registerBundle(program: Command): void {
  const cmd = program
    .command('bundle')
    .description('build an air-gapped bundle (grammars + graph + library catalog)')
    .option('--offline', 'offline bundle (default; present for clarity)')
    .option('-o, --out <dir>', 'output directory', 'vg-bundle')
    .action(function (this: Command, opts: { out?: string }) {
      const global = readGlobal(this);
      const root = rootOf(global);
      const outDir = path.resolve(root, opts.out ?? 'vg-bundle');

      // Per-language resolution (not a directory copy) so the bundle carries
      // the exact grammar files a scan would load — including any vendored
      // overlay that replaces a defective prebuilt.
      let grammarFiles;
      try {
        grammarFiles = resolvedGrammarFiles();
      } catch {
        throw new CliError('no grammars found to bundle (run a build first)', ExitCode.ERROR);
      }
      fs.mkdirSync(path.join(outDir, 'grammars'), { recursive: true });
      let grammarCount = 0;
      for (const { fileName, absPath } of grammarFiles) {
        fs.copyFileSync(absPath, path.join(outDir, 'grammars', fileName));
        grammarCount++;
      }
      // Toolchain grammars (infrastructure/CI corpus) resolve through their own
      // registry — without them an air-gapped bundle would silently lose
      // structural IaC extraction. A missing one is not fatal: extraction for
      // that format degrades, exactly as it does outside a bundle.
      for (const id of Object.keys(TOOLCHAIN_GRAMMARS).sort()) {
        const absPath = resolveToolchainGrammar(id);
        if (!absPath) continue;
        fs.copyFileSync(absPath, path.join(outDir, 'grammars', path.basename(absPath)));
        grammarCount++;
      }

      const included: string[] = [`grammars/ (${grammarCount} .wasm)`];

      // Bundles are an interchange surface, so the graph always ships as
      // canonical JSON — materialized from the binary snapshot when the
      // global store holds only that (store-mode builds skip the JSON write).
      const graphSrc = resolveGraphPath(root, global.graph);
      if (fs.existsSync(graphSrc)) {
        fs.copyFileSync(graphSrc, path.join(outDir, 'graph.json'));
        included.push('graph.json');
      } else {
        const graph = loadGraphFileWithSnapshot(graphSrc);
        if (graph) {
          fs.writeFileSync(path.join(outDir, 'graph.json'), serializeGraph(graph));
          included.push('graph.json');
        }
      }

      const cat = catalogPath(root);
      if (fs.existsSync(cat)) {
        fs.copyFileSync(cat, path.join(outDir, 'vibgrate.lib.json'));
        included.push('vibgrate.lib.json');
        if (fs.existsSync(libDir(root))) {
          fs.cpSync(libDir(root), path.join(outDir, 'lib'), { recursive: true });
          included.push('lib/');
        }
      }

      const manifest = {
        tool: 'vg',
        version: VERSION,
        grammars: grammarSetVersion(),
        grammarCount,
        included,
        usage: 'Run `vg build --grammars <this dir>/grammars` to build fully offline.',
      };
      fs.writeFileSync(path.join(outDir, 'MANIFEST.json'), `${stableStringify(manifest, 2)}\n`);

      if (global.json) {
        json({ out: path.relative(root, outDir), ...manifest });
        return;
      }
      info(`${c.cyan('vg bundle')} · wrote ${path.relative(root, outDir)}/`);
      for (const i of included) info(`  ${c.green('✔')} ${i}`);
      info(c.dim(`  offline: vg build --grammars "${path.relative(root, outDir)}/grammars"`));
    });
  applyGlobalOptions(cmd);
}
