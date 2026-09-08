import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { loadGraph } from '../engine/load.js';
import { displayGraphPath, resolveGraphPath } from '../engine/artifacts.js';
import { probeFreshness, driftCount } from '../engine/freshness.js';
import { loadCatalog, catalogPath } from '../engine/lib.js';
import { hostedBase } from '../engine/hosted.js';
import { telemetryOptOut, isCI, statsEndpoint } from '../engine/stats-share.js';
import { detectServeLaunch } from '../install/registry.js';
import {
  credentialsPath,
  readStoredCredentials,
  homeCredentialsPath,
  projectCredentialsPath,
} from '../reporting/credentials.js';
import { parseDsn } from '../reporting/commands/push.js';
import { gatherSystemMemory } from '../code/local-runtime.js';
import { buildLocalInferenceStatus, type LocalInferenceStatus } from '../runtime/local-inference-status.js';
import { VERSION } from '../version.js';
import { c, info, json } from '../util/output.js';
import { applyGlobalOptions, readGlobal, type GlobalOpts } from '../cli-options.js';
import { rootOf } from './util.js';
import { proxyDiagnostics, type ProxyDiagnosis } from '../proxy/index.js';
import { wrapDiagnostics, type WrapDiagnostic } from '../wrap/index.js';
import { memoryDiagnostics, type MemoryDiagnostics } from '../memory/index.js';
import { activeProfile, env as knobEnv, validateEnv } from '../compress/config.js';
import { defaultStore, type StoreStats } from '../compress/ccr/store.js';
import { contextDir } from '../compress/paths.js';

/**
 * `vg doctor` — one read-only diagnostic pass over everything a support thread
 * would otherwise ask for one item at a time: which config file won, which
 * credential source won, is there a map and is it fresh, can the hosted catalog
 * be reached, what would `vg install` register as the MCP launch, and what the
 * telemetry opt-outs currently say, and local inference (Code Mode fit, warm
 * host pool, weight catalog). Prints state; changes nothing.
 *
 * Secrets never appear in the output (GUARDRAILS §1.1): for a configured DSN we
 * show only its source, host, and workspace id — never the key id or secret.
 */
export function registerDoctor(program: Command): void {
  const cmd = program
    .command('doctor')
    .description(
      'diagnose your setup: config, credentials, map freshness, hosted reachability, MCP launch, local inference',
    )
    .action(async function (this: Command) {
      await runDoctor(readGlobal(this));
    });
  applyGlobalOptions(cmd);
}

/** How long the hosted reachability probe waits before reporting unreachable. */
const REACH_TIMEOUT_MS = 3000;

const CONFIG_BASENAMES = ['vibgrate.config.ts', 'vibgrate.config.js', 'vibgrate.config.json'];

interface Diagnosis {
  version: string;
  node: string;
  platform: string;
  root: string;
  configFile: string | null;
  map: {
    path: string;
    built: boolean;
    generatedAt: string | null;
    staleFiles: number | null;
  };
  libCatalog: { path: string; present: boolean; libraries: number };
  credentials: {
    source: 'env' | 'project' | 'home' | 'none';
    path: string | null;
    host: string | null;
    workspaceId: string | null;
  };
  hosted: { base: string; checked: boolean; reachable: boolean | null };
  mcpLaunch: { command: string; args: string[]; note: string | null };
  telemetry: { optOut: string | null; ci: boolean; endpoint: string };
  /** Approach B local inference snapshot (P4). */
  localInference: LocalInferenceStatus;
  /** Context compression: proxy, retrievable store, memory, wrapped agents, knob validation. */
  compression: CompressionDiagnosis;
}

interface CompressionDiagnosis {
  contextDir: string;
  profile: string;
  mode: string;
  proxy: ProxyDiagnosis[];
  store: StoreStats | null;
  memory: MemoryDiagnostics | null;
  wrap: WrapDiagnostic[];
  /** `VG_*` values that fail validation (never the values themselves). */
  problems: string[];
}

/** Everything about context compression, gathered without changing anything. Never throws. */
async function diagnoseCompression(root: string, local: boolean): Promise<CompressionDiagnosis> {
  const env = process.env;
  let proxy: ProxyDiagnosis[] = [];
  try {
    proxy = await proxyDiagnostics(env, { probe: !local });
  } catch (err) {
    proxy = [{ name: 'proxy', status: 'warn', summary: `diagnostics failed: ${(err as Error).message}` }];
  }
  let store: StoreStats | null = null;
  try {
    store = defaultStore(env).stats();
  } catch {
    store = null;
  }
  let memory: MemoryDiagnostics | null = null;
  try {
    memory = memoryDiagnostics(env, { cwd: root });
  } catch {
    memory = null;
  }
  let wrap: WrapDiagnostic[] = [];
  try {
    wrap = wrapDiagnostics(env, { cwd: root });
  } catch {
    wrap = [];
  }
  return {
    contextDir: contextDir(env),
    profile: activeProfile(undefined, env).name,
    mode: knobEnv.enum<string>('VG_COMPRESS_MODE', env),
    proxy,
    store,
    memory,
    wrap,
    problems: validateEnv(env),
  };
}

async function runDoctor(global: GlobalOpts): Promise<void> {
  const root = rootOf(global);
  const local = global.offline === true;
  const graphPath = resolveGraphPath(root, global.graph);

  const configFile = CONFIG_BASENAMES.find((f) => fs.existsSync(path.join(root, f))) ?? null;

  const graph = loadGraph(root, graphPath);
  let staleFiles: number | null = null;
  if (graph) {
    // Exact when the freshness snapshot exists (written by every build);
    // otherwise unknown — doctor stays cheap and never walks the whole tree.
    const probe = probeFreshness(root);
    if (probe) staleFiles = driftCount(probe.drift);
  }

  const catalog = loadCatalog(root);
  const libCount = Object.keys(catalog.libraries).length;

  const creds = diagnoseCredentials(root);
  const base = hostedBase();
  const reachable = local ? null : await probeReachable(base);
  const launch = detectServeLaunch();
  const optOut = telemetryOptOut();
  const sys = await gatherSystemMemory();
  const localInference = buildLocalInferenceStatus({
    system: sys,
    repo: graph ? { fileCount: graph.nodes?.length ?? 0 } : undefined,
  });
  const compression = await diagnoseCompression(root, local);

  const d: Diagnosis = {
    version: VERSION,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    root,
    configFile,
    map: {
      path: displayGraphPath(root, graphPath),
      built: graph !== null,
      generatedAt: graph?.generatedAt ?? null,
      staleFiles,
    },
    libCatalog: {
      path: path.relative(root, catalogPath(root)),
      present: fs.existsSync(catalogPath(root)),
      libraries: libCount,
    },
    credentials: creds,
    hosted: { base, checked: !local, reachable },
    mcpLaunch: { command: launch.command, args: launch.args, note: launch.note ?? null },
    telemetry: { optOut, ci: isCI(), endpoint: statsEndpoint() },
    localInference,
    compression,
  };

  if (global.json) {
    json(d);
    return;
  }

  info(`${c.cyan('vg')} doctor · v${d.version} · node ${d.node} · ${d.platform}`);
  info(`  root       ${d.root}`);
  info(`  config     ${d.configFile ? c.green(d.configFile) : c.dim('none (defaults) — `vg init` writes one')}`);

  if (!d.map.built) {
    info(`  map        ${c.yellow('none')} — run ${c.bold('vg')} to build ${c.dim(d.map.path)}`);
  } else {
    const fresh =
      d.map.staleFiles == null
        ? c.dim('freshness unknown (no snapshot)')
        : d.map.staleFiles === 0
          ? c.green('up to date')
          : c.yellow(`${d.map.staleFiles} file(s) stale — auto-refreshes on next query`);
    info(`  map        ${c.green('built')} ${c.dim(d.map.generatedAt ?? '')} · ${fresh}`);
  }

  info(
    `  lib        ${
      d.libCatalog.present
        ? `${c.green(String(d.libCatalog.libraries))} librar${d.libCatalog.libraries === 1 ? 'y' : 'ies'} in ${d.libCatalog.path}`
        : c.dim('no catalog — `vg lib add <source>` starts one; `vg lib <name>` works without it')
    }`,
  );

  if (d.credentials.source === 'none') {
    info(`  auth       ${c.dim('anonymous — fine for everything local; `vg login` enables push/publish')}`);
  } else {
    info(
      `  auth       ${c.green(d.credentials.source)} ${c.dim(d.credentials.path ?? '')} · workspace ${d.credentials.workspaceId ?? '?'} · ${d.credentials.host ?? '?'}`,
    );
  }

  if (!d.hosted.checked) {
    info(`  hosted     ${c.dim(`skipped under --local (${d.hosted.base})`)}`);
  } else {
    info(
      `  hosted     ${d.hosted.base} · ${d.hosted.reachable ? c.green('reachable') : c.yellow('unreachable — local answers still work')}`,
    );
  }

  info(
    `  mcp        ${c.bold(`${d.mcpLaunch.command} ${d.mcpLaunch.args.join(' ')}`)}${d.mcpLaunch.note ? c.dim(` (${d.mcpLaunch.note})`) : ''}`,
  );

  const tel = d.telemetry.optOut
    ? c.green(`opted out via ${d.telemetry.optOut}`)
    : 'off by default — only `vg serve --share-stats` ever uploads';
  info(`  telemetry  ${tel}${d.telemetry.ci ? c.dim(' · CI detected') : ''}`);

  // Local inference (Approach B) — warm host, pack fit, weight catalog.
  const li = d.localInference;
  const ramGiB = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GiB`;
  info(
    `  inference  isolation ${c.bold(li.isolation)} ${c.dim(`(${li.isolationSource})`)} · recommend ${c.bold(li.recommendedMode)}` +
      (li.preferOllama ? c.dim(' · prefer Ollama') : ''),
  );
  info(
    `  memory     free RAM ${ramGiB(li.memory.freeRamBytes)} / ${ramGiB(li.memory.totalRamBytes)}` +
      (typeof li.memory.vramFreeBytes === 'number'
        ? ` · VRAM free ${ramGiB(li.memory.vramFreeBytes)}`
        : c.dim(' · VRAM n/a')) +
      (li.memory.loadedModels ? c.dim(` · ${li.memory.loadedModels} ollama loaded`) : ''),
  );
  info(
    `  weights    catalog ${li.weightCatalog.pinned}/${li.weightCatalog.total} pinned` +
      (li.weightCatalog.complete ? c.green(' ✓') : c.yellow(` · unpinned: ${li.weightCatalog.unpinned.join(', ')}`)) +
      ` · cache ${li.weightStore.cachedGgufs} gguf`,
  );
  info(
    `  host pool  ${li.hostPool.size} warm session(s)` +
      (li.hostPool.sessions[0]
        ? c.dim(
            ` · last ${path.basename(li.hostPool.sessions[0].modelPath)} kv=${li.hostPool.sessions[0].kvBlocks}`,
          )
        : c.dim(' · none (load via vg code / vgd host-load)')),
  );
  if (li.dynamicOnToken || li.dynamicCustomSampler) {
    info(
      `  sampler    dynamic ${li.dynamicOnToken ? 'onToken' : ''}${li.dynamicOnToken && li.dynamicCustomSampler ? '+' : ''}${li.dynamicCustomSampler ? 'customSampler' : ''}`,
    );
  }
  for (const h of li.hints.slice(0, 4)) {
    info(c.dim(`  hint       ${h}`));
  }
  info(c.dim('  tip        `vg models mode --apply-recommend` pins the recommended Code Mode'));

  printCompression(d.compression);
}

function printCompression(x: CompressionDiagnosis): void {
  const paint = (status: string, text: string): string =>
    status === 'ok' || status === 'pass' ? c.green(text) : status === 'fail' ? c.red(text) : status === 'warn' ? c.yellow(text) : c.dim(text);
  info('');
  info(`  compress   profile ${c.bold(x.profile)} · mode ${c.bold(x.mode)} ${c.dim(`· state in ${x.contextDir}`)}`);
  for (const p of x.proxy) {
    info(`  ${p.name.padEnd(10)} ${paint(p.status, p.summary)}${p.hint ? c.dim(` — ${p.hint}`) : ''}`);
  }
  if (x.store) {
    info(
      `  store      ${x.store.entries} retrievable entr${x.store.entries === 1 ? 'y' : 'ies'} ${c.dim(`· ${x.store.backend} · ttl ${x.store.ttlSeconds}s · cap ${x.store.maxEntries}`)}` +
        (x.store.redacted ? c.dim(` · ${x.store.redacted} redacted at ingest`) : ''),
    );
  }
  if (x.memory) {
    const m = x.memory;
    info(
      `  memory     ${m.enabled ? c.green('on') : c.dim('off')} · ${m.counts.total} memor${m.counts.total === 1 ? 'y' : 'ies'} ${c.dim(`(project ${m.counts.project} · user ${m.counts.user} · global ${m.counts.global})`)} · project ${m.project.resolved ? c.green(m.project.key) : c.dim('none (not a git checkout — nothing injected)')}`,
    );
    for (const p of m.problems.slice(0, 3)) info(c.yellow(`             ${p}`));
  }
  for (const w of x.wrap) {
    info(`  ${w.name.padEnd(10)} ${paint(w.status, w.summary)}${w.hint ? c.dim(` — ${w.hint}`) : ''}`);
  }
  for (const p of x.problems) info(`  config     ${c.yellow(p)}`);
  if (!x.proxy.some((p) => p.status === 'ok')) info(c.dim('  tip        `vg serve --compress` starts the listener; `vg install <agent> --compress` points an agent at it; `vg savings` shows what it saved'));
}

function diagnoseCredentials(root: string): Diagnosis['credentials'] {
  const none = { source: 'none' as const, path: null, host: null, workspaceId: null };
  // Mirror resolveDsn()'s precedence (env → store), reporting the source instead
  // of the value. The secret itself is never read into the output.
  if (process.env.VIBGRATE_DSN) {
    const parsed = parseDsn(process.env.VIBGRATE_DSN);
    return { source: 'env', path: null, host: parsed?.host ?? null, workspaceId: parsed?.workspaceId ?? null };
  }
  const stored = readStoredCredentials({ cwd: root });
  if (!stored) return none;
  const file = credentialsPath({ cwd: root });
  const source =
    process.env.VIBGRATE_CREDENTIALS ? 'env' : file === projectCredentialsPath(root) ? 'project' : 'home';
  const parsed = parseDsn(stored.dsn);
  return {
    source,
    path: shortenHome(file),
    host: stored.ingestHost ?? parsed?.host ?? null,
    workspaceId: stored.workspaceId ?? parsed?.workspaceId ?? null,
  };
}

/** ~-abbreviate a path under the home dir for display. */
function shortenHome(p: string): string {
  const home = homeCredentialsPath().slice(0, -'/.vibgrate/credentials.json'.length);
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * Reachability = "we got ANY HTTP response from the host" — a 404 proves the
 * network path works just as well as a 200 does. Only a transport-level failure
 * (DNS, TLS, timeout) reports unreachable. Never throws.
 */
async function probeReachable(base: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REACH_TIMEOUT_MS);
  timer.unref?.();
  try {
    await fetch(base, { method: 'HEAD', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
