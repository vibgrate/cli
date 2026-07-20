import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { buildGraph } from '../engine/build.js';
import { verifyDeterminism } from '../engine/verify.js';
import { epistemicBreakdown } from '../engine/epistemic.js';
import { signGraphAttestation, verifyGraphAttestation, type SignSummary } from './attest-actions.js';
import { isModelReady, countPending, resolveEmbedModel } from '../engine/embeddings.js';
import type { VgGraph } from '../schema.js';
import { writeArtifacts } from '../engine/artifacts.js';
import { writeSnapshot } from '../engine/freshness.js';
import { refreshInstalledInstructions, SMALL_REPO_FILES } from '../install/registry.js';
import { serializeGraph } from '../engine/serialize.js';
import { renderReport } from '../engine/report.js';
import { renderHtml } from '../engine/html.js';
import { UsageError } from '../engine/discover.js';
import { ResourceLimitError } from '../engine/limits.js';
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
  attest?: boolean;
  verify?: boolean;
  attestKey?: string;
  attestation?: string;
  pub?: string;
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
    .option('--attest', 'sign the built graph → .vibgrate/attestation.intoto.jsonl')
    .option('--verify', 'verify a committed attestation against the graph (no rebuild)')
    .option('--attest-key <path>', 'signing key PEM (else $VG_ATTEST_KEY, else .vibgrate/attest-key.pem)')
    .option('--attestation <file>', 'attestation path (out for --attest, in for --verify)')
    .option('--pub <path>', 'public key PEM to pin the signer (with --verify)')
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

  // `vg build --verify`: the single verification entry point — determinism
  // self-check plus (if present) attestation verification.
  if (opts.verify) {
    await verifyGraph(root, opts, global);
    return;
  }

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

  const only = opts.only ? opts.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  let result;
  try {
    result = await buildGraph({
      root,
      paths: paths.length ? paths : undefined,
      only,
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
    // A resource safeguard fired (file-count cap, heap budget, worker OOM) —
    // the message already carries the remedy; surface it without a stack.
    if (err instanceof ResourceLimitError) throw new CliError(err.message, ExitCode.ERROR);
    throw err;
  }
  bar?.done();

  const written = writeArtifacts(result.graph, {
    root,
    html: opts.html,
    report: opts.report,
    graphPath: global.graph,
  });

  // Record the freshness snapshot (stat+hash per corpus file, plus this build's
  // scope) so `vg serve`/`vg ask` can auto-refresh the map when the tree drifts.
  // Skipped for a custom --graph target: that is an explicit artifact the
  // auto-refresh machinery must not manage.
  if (!global.graph) {
    writeSnapshot(root, result.graph.provenance.corpusHash, result.fileStats, {
      only,
      exclude: opts.exclude,
      paths: paths.length ? paths : undefined,
      deep: global.deep,
      noGround: opts.ground === false,
      scip: typeof opts.scip === 'string' ? opts.scip : undefined,
      noScip: opts.scip === false,
      noTsc: opts.tsc === false,
      grammarsDir: opts.grammars,
    });
  }

  if (opts.export) writeExport(result.graph, opts.export);

  // Bring previously-installed assistant instructions (skill/nudge files from
  // `vg install`) up to the current content version — so evolved instructions
  // reach this repo the first time a new CLI builds here. Only files carrying
  // vg's own version marker (or the exact legacy generated content) are
  // touched; a custom --graph build is an explicit artifact and skips this.
  if (!global.graph) {
    const fileCount = result.graph.nodes.filter((n) => n.kind === 'file').length;
    const refreshed = refreshInstalledInstructions(root, fileCount > 0 && fileCount < SMALL_REPO_FILES);
    if (interactive) {
      for (const r of refreshed) {
        info(c.dim(`vg · refreshed assistant instructions ${r.file} (v${r.from} → v${r.to})`));
      }
    }
  }

  // `--attest`: sign the freshly-built graph → .vibgrate/attestation.intoto.jsonl.
  let attestation: SignSummary | undefined;
  const attestNotices: string[] = [];
  if (opts.attest) {
    const signed = await signGraphAttestation(root, result.graph, {
      key: opts.attestKey,
      attestation: opts.attestation,
    });
    attestation = signed.summary;
    attestNotices.push(...signed.notices);
  }

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
      epistemic: epistemicBreakdown(result.graph.edges),
      artifacts: written,
      corpusHash: result.graph.provenance.corpusHash,
      toolchain: result.graph.provenance.toolchain,
      attestation,
      timingMs: result.timing.totalMs,
      warnings: result.warnings,
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
  const ep = epistemicBreakdown(result.graph.edges);
  info(
    c.dim(
      `  edges by evidence · observed ${ep.observed} · name-matched ${ep['name-matched']} · declared ${ep.declared}`,
    ),
  );
  const artifactList = [written.graphPath, written.htmlPath, written.reportPath]
    .filter(Boolean)
    .map((p) => path.relative(root, p as string))
    .join('  ');
  info(`  → ${artifactList}`);
  if (result.warnings.length) {
    info(c.yellow(`  ${result.warnings.length} parse warning(s) — run with --json for detail`));
  }
  if (attestation) {
    for (const n of attestNotices) info(c.yellow(`  ${n}`));
    info(
      c.dim(
        `  attested · keyid ${attestation.keyid} · digest ${attestation.graphDigest.slice(0, 16)}… → ${attestation.out}`,
      ),
    );
  }

  maybeWarmEmbeddings(root, result.graph, global, opts.warm !== false);
}

/**
 * `vg build --verify` — the single verification entry point. Runs the determinism
 * self-check (byte-identical rebuilds + toolchain fingerprint) and, when an
 * attestation is present, verifies it against the on-disk graph. Exit 4 on a
 * determinism failure, exit 2 on an attestation failure.
 */
async function verifyGraph(root: string, opts: BuildCmdOpts, global: GlobalOpts): Promise<void> {
  const only = opts.only ? opts.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const jobs = opts.jobs ? Number(opts.jobs) : undefined;
  const det = await verifyDeterminism({ root, only, exclude: opts.exclude, jobs });
  const attest = verifyGraphAttestation(root, { attestation: opts.attestation, pub: opts.pub });
  const attestFailed = !attest.missing && attest.result?.status === 'failed';

  if (global.json) {
    json({
      ok: det.ok && !attestFailed,
      determinism: { ok: det.ok, checks: det.checks, digest: det.digest },
      attestation: attest.missing
        ? null
        : {
            status: attest.result?.status,
            signatureValid: attest.result?.signatureValid,
            signerPinned: attest.result?.signerPinned,
            digestMatches: attest.result?.digestMatches,
            dirty: attest.result?.dirty,
            keyid: attest.result?.keyid,
            reason: attest.result?.reason,
          },
    });
  } else {
    info(`${c.cyan('vg build --verify')} · ${path.relative(process.cwd(), root) || '.'}`);
    for (const check of det.checks) {
      const mark = check.ok ? c.green('✔') : c.red('✘');
      const detail = check.detail ? c.dim(` (${check.detail})`) : '';
      info(`  ${mark} ${check.name}${detail}`);
    }
    info(det.ok ? c.green(`  deterministic · digest ${det.digest.slice(0, 16)}…`) : c.red('  NON-DETERMINISTIC'));
    if (attest.missing) {
      info(c.dim(`  attestation: none (sign one with \`vg build --attest\`)`));
    } else {
      const r = attest.result;
      const badge =
        r?.status === 'verified'
          ? c.green('✔ attestation verified')
          : r?.status === 'signature-valid'
            ? c.yellow('~ attestation signature valid')
            : c.red('✘ attestation failed');
      info(`  ${badge}${r?.keyid ? c.dim(` · keyid ${r.keyid}`) : ''}`);
      info(c.dim(`    ${r?.reason ?? ''}`));
    }
  }

  if (!det.ok) throw new CliError('determinism self-check failed', ExitCode.NON_DETERMINISTIC);
  if (attestFailed) throw new CliError('attestation verification failed', ExitCode.GATE_FAILED);
}

/**
 * After an interactive build we have just committed to a code graph, so the
 * user is likely to run `vg ask`/`vg serve` next — start warming the semantic
 * index in the background now so that first semantic call is instant instead of
 * paying a cold model load. If the model isn't downloaded yet, the background
 * warm fetches it (once, centrally) rather than deferring the whole cost to the
 * first `ask`. Disabled with `--no-warm`; skipped under --json/--quiet/--local
 * and when not at a TTY (so CI never auto-downloads). The detached child runs
 * `vg embed --bg [--download]`; a lock prevents it racing a foreground `ask`.
 */
function maybeWarmEmbeddings(root: string, graph: VgGraph, global: GlobalOpts, warm: boolean): void {
  if (!warm || global.json || global.quiet || global.local) return;
  if (!process.stdout.isTTY && !process.stderr.isTTY) return;
  const cli = process.argv[1];
  if (!cli) return;
  const modelId = resolveEmbedModel();
  const ready = isModelReady(modelId);
  // Already fully warm: model present and every node embedded → nothing to do.
  if (ready && countPending(graph, root, modelId) === 0) return;
  // When the model isn't on this machine yet, start the one-time download now
  // (the graph is built; the next semantic call shouldn't wait for it).
  const args = ready
    ? [cli, 'embed', '-C', root, '--bg']
    : [cli, 'embed', '-C', root, '--bg', '--download'];
  try {
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
    child.unref();
    info(
      c.dim(
        ready
          ? '  warming the semantic index in the background — `vg ask` will be instant'
          : '  downloading the semantic model in the background (once) — `vg ask`/`vg serve` will be instant; disable with --no-warm',
      ),
    );
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
