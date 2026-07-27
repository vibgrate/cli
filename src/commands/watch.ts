import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { buildGraph } from '../engine/build.js';
import { writeArtifacts } from '../engine/artifacts.js';
import { writeSnapshot } from '../engine/freshness.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { rootOf } from './util.js';
import { c, info } from '../util/output.js';
import { CliError, ExitCode } from '../util/exit.js';

/**
 * `vg watch` — rebuild the map when source files change.
 * Uses Node's recursive `fs.watch` (no extra dependency). Debounced so a
 * multi-file save doesn't trigger N rebuilds.
 */

const DEFAULT_DEBOUNCE_MS = 400;
const SKIP_NAME = new Set([
  '.git',
  'node_modules',
  '.vibgrate',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  'target',
  '__pycache__',
  '.venv',
  'venv',
]);

export function registerWatch(program: Command): void {
  const cmd = program
    .command('watch')
    .description('rebuild the code map when files change (debounced)')
    .argument('[paths...]', 'folders to watch (default: current folder)')
    .option('--debounce <ms>', 'settle time after a change before rebuild', String(DEFAULT_DEBOUNCE_MS))
    .option('--no-html', 'do not write graph.html on each rebuild')
    .option('--no-report', 'do not write GRAPH_REPORT.md on each rebuild')
    .option('--fast', 'skip precise tsc resolve on rebuilds (heuristic only)')
    .action(async function (
      this: Command,
      paths: string[],
      opts: { debounce?: string; html?: boolean; report?: boolean; fast?: boolean },
    ) {
      const global = readGlobal(this);
      const root = rootOf(global);
      const debounceMs = Math.max(50, Number(opts.debounce) || DEFAULT_DEBOUNCE_MS);
      const watchRoots = (paths.length ? paths : ['.']).map((p) => path.resolve(root, p));

      for (const w of watchRoots) {
        if (!fs.existsSync(w)) {
          throw new CliError(`watch path not found: ${w}`, ExitCode.USAGE_ERROR);
        }
      }

      let building = false;
      let pending = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const rebuild = async (reason: string) => {
        if (building) {
          pending = true;
          return;
        }
        building = true;
        try {
          info(c.dim(`vg watch · rebuild (${reason})`));
          const result = await buildGraph({
            root,
            paths: paths.length ? paths : undefined,
            fast: opts.fast === true,
            noGround: false,
          });
          writeArtifacts(result.graph, {
            root,
            html: opts.html !== false,
            report: opts.report !== false,
            graphPath: global.graph,
          });
          writeSnapshot(root, result.graph.provenance.corpusHash, result.fileStats);
          const { counts } = result.graph.meta;
          info(
            `${c.cyan('vg watch')} · ${counts.nodes} nodes · ${counts.edges} edges · ` +
              `${(result.timing.totalMs / 1000).toFixed(2)}s` +
              (result.statHits ? c.dim(` · ${result.statHits} mtime hits`) : ''),
          );
        } catch (err) {
          info(c.yellow(`vg watch · rebuild failed: ${(err as Error).message}`));
        } finally {
          building = false;
          if (pending) {
            pending = false;
            void rebuild('queued changes');
          }
        }
      };

      const schedule = (label: string) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void rebuild(label);
        }, debounceMs);
      };

      // Initial build.
      await rebuild('initial');

      const watchers: fs.FSWatcher[] = [];
      for (const w of watchRoots) {
        try {
          const watcher = fs.watch(w, { recursive: true }, (_event, filename) => {
            if (!filename) {
              schedule('change');
              return;
            }
            const parts = filename.split(path.sep);
            if (parts.some((p) => SKIP_NAME.has(p))) return;
            // Ignore our own artifacts.
            if (filename.includes(`${path.sep}.vibgrate${path.sep}`) || filename.startsWith('.vibgrate')) {
              return;
            }
            schedule(filename);
          });
          watchers.push(watcher);
        } catch (err) {
          throw new CliError(`cannot watch ${w}: ${(err as Error).message}`, ExitCode.ERROR);
        }
      }

      info(c.dim(`vg watch · watching ${watchRoots.map((p) => path.relative(root, p) || '.').join(', ')} (debounce ${debounceMs}ms) · Ctrl+C to stop`));

      await new Promise<void>((resolve) => {
        const stop = () => {
          for (const w of watchers) w.close();
          if (timer) clearTimeout(timer);
          resolve();
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });
  applyGlobalOptions(cmd);
}
