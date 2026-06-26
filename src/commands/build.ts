import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { buildGraph } from '../engine/build.js';
import { isModelReady, countPending, resolveEmbedModel } from '../engine/embeddings.js';
import type { VgGraph } from '../schema.js';
import { writeArtifacts } from '../engine/artifacts.js';
import { serializeGraph } from '../engine/serialize.js';
import { renderReport } from '../engine/report.js';
import { renderHtml } from '../engine/html.js';
import { UsageError } from '../engine/discover.js';
import { CliError, ExitCode, usageError } from '../util/exit.js';
import { c, info, out, json } from '../util/output.js';
import { printLogo } from '../util/logo.js';
import { ProgressBar } from '../util/progress.js';
import { applyGlobalOptions, readGlobal, type GlobalOpts } from '../cli-options.js';

interface BuildCmdOpts {
  only?: string;
  exclude?: string[];
  html?: boolean;
  report?: boolean;
  ground?: boolean;
  jobs?: string;
  scip?: string | boolean;
  tsc?: boolean;
  export?: string;
  warm?: boolean;
  grammars?: string;
}

export function registerBuild(program: Command): void {
  const cmd = program
    .command('build')
    .description('build / update the code map (incremental, deterministic)')
    .argument('[paths...]', 'folders or files to map (default: current folder)')
    .option('--only <langs>', 'restrict to languages, e.g. ts,py,go')
    .option('--exclude <glob>', 'extra ignore glob (repeatable)', collect, [])
    .option('--no-html', 'do not write graph.html')
    .option('--no-report', 'do not write GRAPH_REPORT.md')
    .option('--no-ground', 'do not attach grounding (Phase 2)')
    .option('--jobs <n>', 'worker count (1 = single-threaded)')
    .option('--scip <file>', 'ingest a SCIP index for precise resolution (default: auto-detect index.scip)')
    .option('--no-scip', 'ignore any SCIP index')
    .option('--no-tsc', 'skip the in-process TypeScript resolver (heuristic floor only)')
    .option('--no-warm', 'do not warm the semantic index in the background after building')
    .option('--grammars <dir>', 'directory of grammar .wasm files (offline / air-gapped)')
    .option('-o, --export <file>', 'also write the map to a file (format inferred)')
    .action(async function (this: Command, paths: string[], opts: BuildCmdOpts) {
      await runBuild(paths, opts, readGlobal(this));
    });
  applyGlobalOptions(cmd);
}

export async function runBuild(
  paths: string[],
  opts: BuildCmdOpts,
  global: GlobalOpts,
): Promise<void> {
  const root = path.resolve(global.cwd ?? '.');
  // Brand banner + live parse progress for an interactive human while the index
  // builds (TTY only; both are no-ops under --json/--quiet/pipe so machine output
  // stays clean).
  const interactive = !global.json && !global.quiet;
  if (interactive) printLogo(path.basename(root) || root);
  const bar = interactive ? new ProgressBar(c.dim('parsing')) : undefined;
  const jobs = opts.jobs ? Number(opts.jobs) : undefined;
  if (jobs !== undefined && (!Number.isInteger(jobs) || jobs < 1)) {
    throw usageError(`--jobs must be a positive integer (got "${opts.jobs}")`);
  }

  let result;
  try {
    result = await buildGraph({
      root,
      paths: paths.length ? paths : undefined,
      only: opts.only ? opts.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      exclude: opts.exclude,
      jobs,
      noCache: global.noCache,
      deep: global.deep,
      noGround: opts.ground === false,
      scip: typeof opts.scip === 'string' ? opts.scip : undefined,
      noScip: opts.scip === false,
      noTsc: opts.tsc === false,
      generatedAt: global.generatedAt,
      onParseProgress: bar ? (done, total) => bar.update(done, total) : undefined,
      grammarsDir: opts.grammars,
    });
  } catch (err) {
    bar?.done();
    if (err instanceof UsageError) throw usageError(err.message);
    throw err;
  }
  bar?.done();

  const written = writeArtifacts(result.graph, {
    root,
    html: opts.html,
    report: opts.report,
    graphPath: global.graph,
  });

  if (opts.export) writeExport(result.graph, opts.export);

  if (global.json) {
    json({
      ok: true,
      counts: result.graph.meta.counts,
      languages: result.graph.meta.languages,
      reparsed: result.reparsed,
      reused: result.reused,
      totalFiles: result.totalFiles,
      resolve: result.resolveStats,
      tsc: result.tsc,
      scip: result.scip,
      artifacts: written,
      corpusHash: result.graph.provenance.corpusHash,
      timingMs: result.timing.totalMs,
    });
    return;
  }

  const { counts } = result.graph.meta;
  const incremental =
    result.reused > 0
      ? `incremental: ${result.reparsed} of ${result.totalFiles} files re-parsed`
      : `${result.totalFiles} files parsed`;
  const seconds = (result.timing.totalMs / 1000).toFixed(2);
  info(`${c.cyan('vg')} · mapped ${rel(root)} in ${seconds}s (${incremental})`);
  info(
    `  nodes ${c.bold(String(counts.nodes))}   edges ${c.bold(String(counts.edges))}   ` +
      `areas ${counts.areas}   langs ${result.graph.meta.languages.join(',') || '—'}`,
  );
  const callPct =
    result.resolveStats.callsResolved + result.resolveStats.callsUnresolved > 0
      ? Math.round(
          (100 * result.resolveStats.callsResolved) /
            (result.resolveStats.callsResolved + result.resolveStats.callsUnresolved),
        )
      : 100;
  // When a precise rung ran it is authoritative; callPct is only the heuristic
  // floor (label it so, to avoid understating the precise result below).
  const precise = result.tsc || result.scip;
  const callLabel = precise ? `heuristic floor ${callPct}%` : `calls resolved ${callPct}%`;
  info(c.dim(`  ${callLabel} · resolver ${result.graph.provenance.resolver.join(',')}`));
  if (result.tsc) {
    const jsx = result.tsc.jsx > 0 ? `, ${result.tsc.jsx} JSX` : '';
    info(c.dim(`  tsc: ${result.tsc.resolved} precise edges across ${result.tsc.files} TS/JS files (${result.tsc.calls} calls${jsx})`));
  }
  if (result.scip) {
    info(c.dim(`  scip: ${result.scip.resolved} precise edges from ${result.scip.tool ?? 'index'} (${result.scip.documents} docs)`));
  }
  const artifactList = [written.graphPath, written.htmlPath, written.reportPath]
    .filter(Boolean)
    .map((p) => path.relative(root, p as string))
    .join('  ');
  info(`  → ${artifactList}`);
  if (result.warnings.length) {
    info(c.yellow(`  ${result.warnings.length} parse warning(s) — run with --json for detail`));
  }

  maybeWarmEmbeddings(root, result.graph, global, opts.warm !== false);
}

/**
 * After an interactive build, warm the semantic index in the background so the
 * first `vg ask` is instant — but only when it won't surprise-download: the model
 * must already be cached on this machine (downloaded once, centrally, by an
 * earlier `vg ask`/`vg embed`). Disabled with `--no-warm`; skipped under
 * --json/--quiet/--local and when not at a TTY (so CI, which has no TTY, never
 * warms). The detached child runs `vg embed --bg` (no download, silent) and a
 * lock prevents it racing a foreground `ask`.
 */
function maybeWarmEmbeddings(root: string, graph: VgGraph, global: GlobalOpts, warm: boolean): void {
  if (!warm || global.json || global.quiet || global.local) return;
  if (!process.stdout.isTTY && !process.stderr.isTTY) return;
  const modelId = resolveEmbedModel();
  if (!isModelReady(modelId)) return; // model not downloaded yet → leave it to the first `ask`
  if (countPending(graph, root, modelId) === 0) return; // already warm
  const cli = process.argv[1];
  if (!cli) return;
  try {
    const child = spawn(process.execPath, [cli, 'embed', '-C', root, '--bg'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    info(c.dim('  warming the semantic index in the background — `vg ask` will be instant'));
  } catch {
    /* warm-up is best-effort */
  }
}

function writeExport(graph: Parameters<typeof serializeGraph>[0], target: string): void {
  if (target === '-') {
    out(serializeGraph(graph).trimEnd());
    return;
  }
  const ext = path.extname(target).toLowerCase();
  let content: string;
  switch (ext) {
    case '.json':
      content = serializeGraph(graph);
      break;
    case '.md':
      content = renderReport(graph);
      break;
    case '.html':
      content = renderHtml(graph);
      break;
    default:
      throw new CliError(
        `cannot export to "${ext || target}" yet — supported in Phase 0: .json, .md, .html, "-" (stdout). ` +
          `More formats (graphml, dot, cypher) arrive with \`vg export\` in Phase 1.`,
        ExitCode.USAGE_ERROR,
      );
  }
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, content);
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

function rel(root: string): string {
  const r = path.relative(process.cwd(), root);
  return r === '' ? '.' : r;
}
