import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { buildGraph } from '../engine/build.js';
import { ensureHaileModule } from '../install/haile-module.js';
import { verifyDeterminism } from '../engine/verify.js';
import { epistemicBreakdown } from '../engine/epistemic.js';
import { signGraphAttestation, verifyGraphAttestation, type SignSummary } from './attest-actions.js';
import { isModelReady, countPending, resolveEmbedModel } from '../engine/embeddings.js';
import { attachVgd } from '../runtime/vgd/attach.js';
import { resolveBuildAttach } from '../runtime/vgd/build-attach.js';
import { ActivityLog } from '../runtime/vgd/activity.js';
import type { VgGraph } from '../schema.js';
import { writeArtifacts } from '../engine/artifacts.js';
import { readHaileSidecar, seedArchitecturePolicy, type SeedArchitecturePolicyResult } from '../engine/haile/index.js';
import { writeSnapshot } from '../engine/freshness.js';
import { refreshInstalledInstructions, SMALL_REPO_FILES } from '../install/registry.js';
import { writeAreaSkills } from '../install/area-skills.js';
import { serializeGraph } from '../engine/serialize.js';
import { renderReport } from '../engine/report.js';
import { renderHtml } from '../engine/html.js';
import { UsageError, mergeExcludes } from '../engine/discover.js';
import { ResourceLimitError } from '../engine/limits.js';
import { CliError, ExitCode, usageError } from '../util/exit.js';
import { resolveSelfJsEntry } from '../util/cli-invocation.js';
import { c, info, out, json } from '../util/output.js';
import { printLogo } from '../util/logo.js';
import { ProgressBar } from '../util/progress.js';
import { applyGlobalOptions, readGlobal, type GlobalOpts } from '../cli-options.js';

interface BuildCmdOpts {
  policy?: string;
  initPolicy?: boolean;
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
  fast?: boolean;
  index?: boolean;
  analysisTier?: string;
  attest?: boolean;
  verify?: boolean;
  attestKey?: string;
  attestation?: string;
  pub?: string;
  /** Commander `--no-publish` arrives as `publish: false`. */
  publish?: boolean;
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
    .option('--policy <pack>', 'boundary policy pack for the architecture module: hexagonal-v1 | layered-v1 | vertical-v1 (default: .vibgrate/architecture.toml, else hexagonal-v1)')
    .option('--init-policy', 'write a starter .vibgrate/architecture.toml (vg.arch.policy.v1: pack inferred from what this build classified, overlay stubs); never overwrites')
    .option('--no-tsc', 'skip the in-process TypeScript resolver (heuristic floor only)')
    .option('--fast', 'skip precise tsc resolve (heuristic only — faster XL cold builds)')
    .option('--no-index', 'do not write the SQLite serve index under .vibgrate/cache/')
    .option('--analysis-tier <tier>', 'force analysis tier: full | large | xl (default: auto)')
    .option('--no-warm', 'do not warm the semantic index (no-daemon disk fallback only; vgd warms its own worker)')
    .option('--no-publish', 'do not start vgd or load the new map into a slot (batch compares)')
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

export interface RunBuildHooks {
  onParseProgress?: (done: number, total: number) => void;
}

export async function runBuild(
  paths: string[],
  opts: BuildCmdOpts,
  global: GlobalOpts,
  hooks?: RunBuildHooks,
): Promise<void> {
  const root = path.resolve(global.cwd ?? '.');

  if (opts.verify) {
    await verifyGraph(root, opts, global);
    return;
  }

  const interactive = !global.json && !global.quiet;
  if (interactive) printLogo(path.basename(root) || root);
  const bar = interactive ? new ProgressBar(c.dim('parsing')) : undefined;
  const jobs = opts.jobs ? Number(opts.jobs) : undefined;
  if (jobs !== undefined && (!Number.isInteger(jobs) || jobs < 1)) {
    throw usageError(`--jobs must be a positive integer (got "${opts.jobs}")`);
  }

  const only = opts.only ? opts.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const tierRaw = opts.analysisTier?.toLowerCase();
  const analysisTier =
    tierRaw === 'full' || tierRaw === 'large' || tierRaw === 'xl' ? tierRaw : undefined;
  if (opts.analysisTier && !analysisTier) {
    throw usageError(`--analysis-tier must be full, large, or xl (got "${opts.analysisTier}")`);
  }
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
      fast: opts.fast === true,
      noIndex: opts.index === false,
      analysisTier,
      generatedAt: global.generatedAt,
      onParseProgress: (done, total) => {
        bar?.update(done, total);
        hooks?.onParseProgress?.(done, total);
      },
      grammarsDir: opts.grammars,
    });
  } catch (err) {
    bar?.done();
    if (err instanceof UsageError) throw usageError(err.message);
    if (err instanceof ResourceLimitError) throw new CliError(err.message, ExitCode.ERROR);
    throw err;
  }
  bar?.done();

  const haile = global.offline ? null : await ensureHaileModule().catch(() => null);

  const written = writeArtifacts(result.graph, {
    root,
    html: opts.html,
    report: opts.report,
    graphPath: global.graph,
    ...(opts.policy ? { policy: opts.policy } : {}),
  });

  if (written.architecturePolicyError) {
    throw new CliError(`architecture policy: ${written.architecturePolicyError}`, ExitCode.ERROR);
  }

  let initPolicy: (SeedArchitecturePolicyResult & { stamped: string | null }) | undefined;
  if (opts.initPolicy) {
    const sidecar = readHaileSidecar(written.graphPath);
    initPolicy = { ...seedArchitecturePolicy({ root, sidecar }), stamped: sidecar?.policy ?? null };
  }

  if (haile?.status === 'unavailable' && !global.json && !global.quiet) {
    info(
      c.yellow(
        '  architecture module could not be installed — role/purpose lines are omitted; '
        + 'vg retries automatically (disable with VIBGRATE_NO_KERNEL=1)',
      ),
    );
  }

  if (!global.graph) {
    writeSnapshot(root, result.graph.provenance.corpusHash, result.fileStats, {
      only,
      exclude: mergeExcludes(root, opts.exclude),
      paths: paths.length ? paths : undefined,
      deep: global.deep,
      noGround: opts.ground === false,
      scip: typeof opts.scip === 'string' ? opts.scip : undefined,
      noScip: opts.scip === false,
      noTsc: opts.tsc === false,
      grammarsDir: opts.grammars,
    });
  }

  const attach = resolveBuildAttach({
    daemon: global.daemon,
    publish: opts.publish,
    fast: opts.fast,
    warm: opts.warm,
    index: opts.index,
  });
  const activity = new ActivityLog();
  await activity.time(
    'attach',
    () =>
      attachVgd(root, {
        graphPath: global.graph,
        disabled: attach.disabled,
        autoStart: attach.autoStart,
        publish: attach.publish,
      }),
    (a) => {
      if (a.status !== 'attached') return { outcome: 'skip' as const, detail: `${a.reason} — the map stays on disk only` };
      const started = a.started ? 'started vgd' : 'attached to vgd';
      if (a.published?.status === 'published') {
        return { outcome: 'ok' as const, detail: `${started} · map published ${a.published.gitRef} · ${a.published.nodeCount} nodes · semantic index warming in vgd` };
      }
      if (a.published?.status === 'failed') {
        return { outcome: 'warn' as const, detail: `${started} · map not published (${a.published.error})` };
      }
      return { outcome: 'ok' as const, detail: started };
    },
  );

  if (opts.export) writeExport(result.graph, opts.export);

  if (!global.graph) {
    const fileCount = result.graph.nodes.filter((n) => n.kind === 'file').length;
    const refreshed = refreshInstalledInstructions(root, fileCount > 0 && fileCount < SMALL_REPO_FILES);
    if (interactive) {
      for (const r of refreshed) {
        info(c.dim(`vg · refreshed assistant instructions ${r.file} (v${r.from} → v${r.to})`));
      }
    }
    const areaChanges = writeAreaSkills(root, result.graph);
    if (interactive && (areaChanges.written.length || areaChanges.removed.length)) {
      const parts = [
        areaChanges.written.length ? `${areaChanges.written.length} area skill(s) updated` : '',
        areaChanges.removed.length ? `${areaChanges.removed.length} stale removed` : '',
      ].filter(Boolean);
      info(c.dim(`vg · ${parts.join(', ')}`));
    }
  }

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
      cas: result.cas
        ? { parseHits: result.cas.parseHits, parseWrites: result.cas.parseWrites, dir: result.cas.dir }
        : undefined,
      totalFiles: result.totalFiles,
      resolve: result.resolveStats,
      tsc: result.tsc,
      scip: result.scip,
      epistemic: epistemicBreakdown(result.graph.edges),
      artifacts: written,
      ...(initPolicy ? { initPolicy } : {}),
      corpusHash: result.graph.provenance.corpusHash,
      toolchain: result.graph.provenance.toolchain,
      attestation,
      timingMs: result.timing.totalMs,
      warnings: result.warnings,
      activity: activity.toJSON(),
    });
    return;
  }

  if (initPolicy) {
    if (initPolicy.written) {
      const from = initPolicy.observed ? `inferred from ${initPolicy.observed} classified symbols` : 'default pack; nothing classified yet';
      info(`  wrote ${initPolicy.path} · policy ${c.bold(initPolicy.policy)} (${from})`);
      if (initPolicy.stamped && initPolicy.stamped !== initPolicy.policy) {
        info(c.dim(`  this map was judged under ${initPolicy.stamped} — run vg build again to judge it under ${initPolicy.policy}`));
      }
    } else {
      info(c.dim(`  ${initPolicy.path} already exists (policy ${initPolicy.policy}) — left untouched`));
    }
  }

  const { counts } = result.graph.meta;
  const shared = result.cas && result.cas.parseHits > 0 ? `, ${result.cas.parseHits} shared` : '';
  const incremental =
    result.reused > 0
      ? `incremental: ${result.reparsed} of ${result.totalFiles} files re-parsed${shared}`
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

  for (const line of activity.render()) info(line);

  maybeWarmEmbeddings(root, result.graph, global, attach.diskEmbedFallback);
}

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
      info(c.dim('  attestation: none (sign one with `vg build --attest`)'));
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

/** `--no-daemon` fallback only. Interactive builds let vgd's embed-worker own the index. */
function maybeWarmEmbeddings(root: string, graph: VgGraph, global: GlobalOpts, warm: boolean): void {
  if (!warm || global.json || global.quiet || global.offline) return;
  if (!process.stdout.isTTY && !process.stderr.isTTY) return;
  const cli = resolveSelfJsEntry() ?? process.argv[1];
  if (!cli) return;
  const modelId = resolveEmbedModel();
  const ready = isModelReady(modelId);
  if (ready && countPending(graph, root, modelId) === 0) return;
  const args = ready
    ? [cli, 'embed', '-C', root, '--bg']
    : [cli, 'embed', '-C', root, '--bg', '--download'];
  try {
    const child = spawn(process.execPath, args, {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    info(
      c.dim(
        ready
          ? '  writing on-disk vectors (--no-daemon fallback) — vgd is not running'
          : '  downloading the semantic model for the --no-daemon disk fallback; disable with --no-warm',
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
          'More formats (graphml, dot, cypher) arrive with `vg export` in Phase 1.',
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
