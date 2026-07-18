import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { loadGraph } from '../engine/load.js';
import { defaultGraphPath } from '../engine/artifacts.js';
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
import { VERSION } from '../version.js';
import { c, info, json } from '../util/output.js';
import { applyGlobalOptions, readGlobal, type GlobalOpts } from '../cli-options.js';
import { rootOf } from './util.js';

/**
 * `vg doctor` — one read-only diagnostic pass over everything a support thread
 * would otherwise ask for one item at a time: which config file won, which
 * credential source won, is there a map and is it fresh, can the hosted catalog
 * be reached, what would `vg install` register as the MCP launch, and what the
 * telemetry opt-outs currently say. Prints state; changes nothing.
 *
 * Secrets never appear in the output (GUARDRAILS §1.1): for a configured DSN we
 * show only its source, host, and workspace id — never the key id or secret.
 */
export function registerDoctor(program: Command): void {
  const cmd = program
    .command('doctor')
    .description('diagnose your setup: config, credentials, map freshness, hosted reachability, MCP launch')
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
}

async function runDoctor(global: GlobalOpts): Promise<void> {
  const root = rootOf(global);
  const local = global.local === true;
  const graphPath = global.graph ?? defaultGraphPath(root);

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

  const d: Diagnosis = {
    version: VERSION,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    root,
    configFile,
    map: {
      path: path.relative(root, graphPath),
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
