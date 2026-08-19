import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import * as semver from 'semver';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { VERSION } from '../version.js';
import { startVgdServer, vgdIsRunning, vgdPidPath, vgdRequest, vgdSocketPath, VGD_PROTOCOL_VERSION } from '../runtime/vgd/index.js';
import { rootOf } from './util.js';
import { CliError, ExitCode } from '../util/exit.js';
import { reinvokeCli } from '../util/cli-invocation.js';
import { c, info, json } from '../util/output.js';

/**
 * `vg daemon` — lightweight local Fusion Runtime daemon (`vgd`) prototype.
 *
 * Phase 2 slice: local socket + workspace registry. Interactive `vg code`
 * attaches via `startCodeRuntimeSession` (ensures this standalone daemon).
 * No overlays yet. Safe to start/stop; does not mutate repos.
 */
export function registerDaemon(program: Command): void {
  const cmd = program
    .command('daemon')
    .description('local Fusion Runtime daemon (vgd) — workspace registry prototype')
    .option('--socket <path>', 'override the daemon socket path');

  const status = cmd
    .command('status')
    .description('show whether vgd is running and how many workspaces it tracks')
    .action(async function (this: Command) {
      const global = readGlobal(this);
      const socketPath = socketOf(this);
      const running = await vgdIsRunning({ socketPath });
      if (!running) {
        if (global.json) {
          json({ running: false, socketPath, version: VGD_PROTOCOL_VERSION });
        } else {
          info(c.dim(`vgd · not running (${socketPath})`));
        }
        process.exitCode = ExitCode.NOT_FOUND;
        return;
      }
      const res = await vgdRequest({ op: 'status' }, { socketPath });
      if (!res.ok) throw new CliError(res.error, ExitCode.ERROR);
      // "Warm" used to mean the code map only, while every client still loaded
      // its own embedder — so the semantic state is reported next to the graph
      // slots rather than left to be inferred.
      const semantic = await vgdRequest({ op: 'embed-status' }, { socketPath }).catch(() => null);
      const semanticPayload = semantic && semantic.ok && 'semantic' in semantic ? semantic.semantic : undefined;
      const skew = await vgdVersionSkew(socketPath);
      if (global.json) json({ running: true, ...res, semantic: semanticPayload, skew });
      else if ('pid' in res) {
        const slots = typeof res.graphSlots === 'number' ? ` · ${res.graphSlots} graph slot(s)` : '';
        // Always print the build, even when the daemon is too old to report one
        // — a blank where the version should be is what made this skew
        // invisible in the first place.
        const cli = ` · cli ${describeVersion(res.cliVersion ?? null)}`;
        info(
          `vgd · running pid ${res.pid}${cli} · ${res.workspaces} workspace(s)${slots} · ${res.uptimeMs}ms up · ${c.dim(res.socketPath)}`,
        );
        if (skew.running && skew.state !== 'match') {
          const verb = skew.state === 'older' ? 'older than' : 'newer than';
          info(
            c.dim(
              `  ⚠ this daemon is ${verb} the CLI you just ran (${VERSION})` +
                (skew.state === 'older' ? ' — run "vg daemon restart --force" to bring it up to date' : ''),
            ),
          );
        }
        const fresh = 'freshness' in res && Array.isArray(res.freshness) ? res.freshness : [];
        if (fresh.length) {
          const watching = fresh.filter((f) => f.watching).length;
          const building = fresh.filter((f) => f.building);
          const pending = fresh.reduce((n, f) => n + f.pending, 0);
          const detail = [
            `${watching}/${fresh.length} watched`,
            building.length ? `${building.length} rebuilding` : '',
            pending ? `${pending} change(s) pending` : '',
          ]
            .filter(Boolean)
            .join(' · ');
          info(`  freshness · ${detail}`);
          for (const f of fresh) {
            if (f.watching && !f.building && !f.pending) continue;
            const state = f.building ? 'rebuilding' : f.watching ? `${f.pending} pending` : 'not watched (no recursive fs.watch here)';
            info(c.dim(`    ${f.repositoryId}@${f.gitRef} · ${state}`));
          }
        }
        if (semanticPayload) {
          const ready = semanticPayload.slots.filter((sl) => sl.state === 'ready');
          const vectors = ready.reduce((n, sl) => n + sl.vectors, 0);
          // "worker stopped · 0/0 index(es)" reads like a broken daemon when
          // it usually means nobody has published a map yet — the index is
          // slot-scoped, so no graph slot means there is nothing to index.
          const detail =
            semanticPayload.worker === 'unavailable'
              ? c.dim(semanticPayload.reason ?? 'semantic off — lexical only')
              : semanticPayload.slots.length === 0
                ? c.dim('no map published yet — run `vg build` in a repo (the index follows the graph slot)')
                : `${ready.length}/${semanticPayload.slots.length} index(es) ready · ${vectors} vector(s)` +
                  (semanticPayload.model ? ` · ${semanticPayload.model}` : '');
          info(`  semantic · worker ${semanticPayload.worker} · ${detail}`);
          for (const sl of semanticPayload.slots) {
            if (sl.state === 'ready') continue;
            const pending = typeof sl.pending === 'number' && sl.pending > 0 ? ` · ${sl.pending} pending` : '';
            info(
              c.dim(`    ${sl.repositoryId}@${sl.gitRef} · ${sl.state}${pending}${sl.error ? ` — ${sl.error}` : ''}`),
            );
          }
        }
      }
    });
  applyGlobalOptions(status);

  const start = cmd
    .command('start')
    .description('run vgd in the foreground (Ctrl-C to stop)')
    .action(async function (this: Command) {
      const global = readGlobal(this);
      const socketPath = socketOf(this);
      if (await vgdIsRunning({ socketPath })) {
        throw new CliError(`vgd is already running at ${socketPath}`, ExitCode.ERROR);
      }
      // The shutdown closure needs the server; the server needs the hook.
      // Bridge with a mutable ref so `vg daemon stop` can reach us.
      let requestShutdown: () => void = () => {};
      const server = await startVgdServer({
        socketPath,
        onShutdownRequest: () => requestShutdown(),
        // Show the daemon working: graph publishes, branch switches, new repos,
        // and every semantic index build. Silent under --quiet/--json.
        log: global.quiet || global.json ? undefined : (message) => info(c.dim(`vgd · ${message}`)),
      });
      if (!global.quiet) {
        info(`vgd · listening on ${c.dim(server.socketPath)} (${VGD_PROTOCOL_VERSION})`);
        info(c.dim('  register a workspace: vg daemon register'));
        info(c.dim('  status: vg daemon status'));
      }

      const shutdown = async (): Promise<void> => {
        await server.close();
        if (!global.quiet) info(c.dim('vgd · stopped'));
        process.exit(0);
      };
      requestShutdown = () => void shutdown();
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
      // Keep the event loop alive until signal.
      await new Promise(() => {});
    });
  applyGlobalOptions(start);

  /**
   * Idempotent start for host UIs (VS Code) and agents: if vgd is already
   * listening, exit 0; otherwise spawn a detached background `daemon start`.
   */
  const ensure = cmd
    .command('ensure')
    .description('ensure vgd is running on this build (start or replace in background if needed)')
    .option('--allow-version-mismatch', 'attach to an older running vgd instead of replacing it')
    .action(async function (this: Command) {
      const global = readGlobal(this);
      const socketPath = socketOf(this);
      const opts = this.opts() as { allowVersionMismatch?: boolean };
      const ensured = await ensureVgd(socketPath, { allowVersionMismatch: opts.allowVersionMismatch });
      const res = await vgdRequest({ op: 'status' }, { socketPath });
      if (!res.ok) {
        throw new CliError(
          ensured.started
            ? `vgd started (pid ${ensured.pid ?? '?'}) but status failed: ${res.error} (${socketPath})`
            : `vgd is running but status failed: ${res.error} (${socketPath})`,
          ExitCode.ERROR,
        );
      }
      if (global.json) {
        json({ running: true, ensured: ensured.started, replaced: ensured.replaced ?? null, ...res });
      } else if (!global.quiet) {
        const pid = 'pid' in res ? res.pid : ensured.pid;
        if (ensured.replaced) {
          info(
            `vgd · replaced ${describeVersion(ensured.replaced.version)} daemon with ${VERSION} · pid ${pid} · ${c.dim(socketPath)}`,
          );
        } else {
          info(
            ensured.started
              ? `vgd · started in background pid ${pid} · ${c.dim(socketPath)}`
              : `vgd · already running pid ${pid} · ${c.dim(socketPath)}`,
          );
        }
      }
    });
  applyGlobalOptions(ensure);

  const stop = cmd
    .command('stop')
    .description('stop the running vgd (idempotent — succeeds if none is running)')
    .option('--force', 'escalate to SIGTERM/SIGKILL if it will not stop politely')
    .action(async function (this: Command) {
      const global = readGlobal(this);
      const socketPath = socketOf(this);
      const force = Boolean((this.opts() as { force?: boolean }).force);
      const result = await stopVgd(socketPath, { force });
      if (global.json) {
        json({ stopped: result === 'stopped', result, socketPath });
      } else if (!global.quiet) {
        if (result === 'stopped') info(`vgd · stopped ${c.dim(socketPath)}`);
        else if (result === 'not-running') info(c.dim(`vgd · not running (${socketPath})`));
      }
      if (result === 'refused') {
        throw new CliError(
          'this vgd cannot be stopped remotely — it is running inside another process; stop that process instead',
          ExitCode.ERROR,
        );
      }
      if (result === 'failed') {
        throw new CliError(
          `vgd did not stop within 5s (${socketPath}) — retry with \`vg daemon stop --force\` to escalate to a signal`,
          ExitCode.ERROR,
        );
      }
    });
  applyGlobalOptions(stop);

  const restart = cmd
    .command('restart')
    .description('restart vgd (stop if running, then start in the background)')
    .option('--force', 'escalate to SIGTERM/SIGKILL if it will not stop politely')
    .action(async function (this: Command) {
      const global = readGlobal(this);
      const socketPath = socketOf(this);
      const force = Boolean((this.opts() as { force?: boolean }).force);
      const stopResult = await stopVgd(socketPath, { force });
      if (stopResult === 'refused') {
        throw new CliError(
          'this vgd cannot be stopped remotely — it is running inside another process; stop that process instead',
          ExitCode.ERROR,
        );
      }
      if (stopResult === 'failed') {
        throw new CliError(
          `vgd did not stop within 5s (${socketPath}) — retry with \`vg daemon restart --force\` to escalate to a signal`,
          ExitCode.ERROR,
        );
      }
      await startDetachedVgd(socketPath);
      const res = await vgdRequest({ op: 'status' }, { socketPath });
      if (global.json) {
        json({ running: true, restarted: true, ...(res.ok ? res : { socketPath }) });
      } else if (!global.quiet) {
        const pid = res.ok && 'pid' in res ? res.pid : '?';
        info(`vgd · restarted pid ${pid} · ${c.dim(socketPath)}`);
      }
    });
  applyGlobalOptions(restart);

  const register = cmd
    .command('register')
    .description('register the current repository with a running vgd')
    .argument('[root]', 'repository root (default: cwd)')
    .action(async function (this: Command, rootArg?: string) {
      const global = readGlobal(this);
      const socketPath = socketOf(this);
      const root = path.resolve(rootArg ?? rootOf(global));
      if (!(await vgdIsRunning({ socketPath }))) {
        throw new CliError(`vgd is not running — start it with \`vg daemon start\` (${socketPath})`, ExitCode.NOT_FOUND);
      }
      const res = await vgdRequest({ op: 'register', root }, { socketPath });
      if (!res.ok) throw new CliError(res.error, ExitCode.ERROR);
      if (global.json) json(res);
      else if ('workspace' in res) {
        info(`vgd · registered ${res.workspace.root}`);
        info(c.dim(`  id ${res.workspace.id}`));
        info(c.dim(`  graph ${res.workspace.graphPath}`));
      }
    });
  applyGlobalOptions(register);

  const list = cmd
    .command('list')
    .description('list workspaces registered with the running vgd')
    .action(async function (this: Command) {
      const global = readGlobal(this);
      const socketPath = socketOf(this);
      if (!(await vgdIsRunning({ socketPath }))) {
        throw new CliError(`vgd is not running (${socketPath})`, ExitCode.NOT_FOUND);
      }
      const res = await vgdRequest({ op: 'list' }, { socketPath });
      if (!res.ok) throw new CliError(res.error, ExitCode.ERROR);
      if (global.json) json(res);
      else if ('workspaces' in res && Array.isArray(res.workspaces)) {
        if (res.workspaces.length === 0) info(c.dim('vgd · no workspaces registered'));
        for (const w of res.workspaces) {
          const tag = w.label ? ` (${w.label}${w.role ? `/${w.role}` : ''})` : '';
          info(`${w.root}${tag}`);
          info(c.dim(`  id ${w.id} · graph ${w.graphPath}`));
        }
      }
    });
  applyGlobalOptions(list);

  const federation = cmd
    .command('federation')
    .description('register a multi-root federation from .vibgrate/federation.json (or primary cwd)')
    .argument('[root]', 'primary repository root (default: cwd)')
    .action(async function (this: Command, rootArg?: string) {
      const global = readGlobal(this);
      const socketPath = socketOf(this);
      const primary = path.resolve(rootArg ?? rootOf(global));
      if (!(await vgdIsRunning({ socketPath }))) {
        throw new CliError(`vgd is not running — start it with \`vg daemon start\` (${socketPath})`, ExitCode.NOT_FOUND);
      }
      const { loadFederation } = await import('../runtime/federation.js');
      const fed = loadFederation(primary);
      if (!fed) throw new CliError(`could not load federation for ${primary}`, ExitCode.ERROR);
      const res = await vgdRequest(
        {
          op: 'register-federation',
          primaryRoot: fed.primaryRoot,
          members: fed.members.map((m) => ({ root: m.root, label: m.label, role: m.role })),
        },
        { socketPath },
      );
      if (!res.ok) throw new CliError(res.error, ExitCode.ERROR);
      if (global.json) json(res);
      else if ('workspaces' in res && Array.isArray(res.workspaces)) {
        info(`vgd · federation registered (${res.workspaces.length} workspace(s))`);
        for (const w of res.workspaces) {
          info(c.dim(`  ${w.label ?? w.root}${w.role ? ` [${w.role}]` : ''}`));
        }
      }
    });
  applyGlobalOptions(federation);

  /**
   * Load the on-disk code map for a workspace into vgd's ActiveGraph cache so
   * query/impact work without an agent put-graph first (VS Code / IDE path).
   */
  const publish = cmd
    .command('publish')
    .description('load the workspace code map into vgd ActiveGraph (from global/legacy store)')
    .argument('[root]', 'repository root (default: cwd)')
    .option('--git-ref <ref>', 'branch or SHA (default: detect HEAD)')
    .action(async function (this: Command, rootArg?: string) {
      const global = readGlobal(this);
      const socketPath = socketOf(this);
      const root = path.resolve(rootArg ?? rootOf(global));
      if (!(await vgdIsRunning({ socketPath }))) {
        throw new CliError(`vgd is not running — start it with \`vg daemon ensure\` (${socketPath})`, ExitCode.NOT_FOUND);
      }
      const opts = this.opts() as { gitRef?: string };
      // Fast path: the daemon loads the map from disk itself (binary snapshot
      // first) — nothing heavy crosses the socket.
      const loaded = await vgdRequest(
        { op: 'load-graph', root, gitRef: opts.gitRef?.trim() || undefined, graphPath: global.graph },
        { socketPath },
      );
      let put = loaded;
      if (!loaded.ok && loaded.code === 'no_map') {
        throw new CliError(loaded.error, ExitCode.NOT_FOUND);
      }
      if (!loaded.ok) {
        // Older daemon without load-graph — legacy path: load locally and ship
        // the graph over the socket with put-graph.
        const { loadGraph } = await import('../engine/load.js');
        const { detectGitRef } = await import('../runtime/git-ref.js');
        const { repositoryIdFromRoot } = await import('../runtime/paths.js');
        const graph = loadGraph(root, global.graph);
        if (!graph) {
          throw new CliError(
            `no code map found for ${root} — run \`vg build\` (or bare \`vg\`) first`,
            ExitCode.NOT_FOUND,
          );
        }
        // Ensure workspace is registered so list shows the root.
        const reg = await vgdRequest({ op: 'register', root }, { socketPath });
        if (!reg.ok) throw new CliError(reg.error, ExitCode.ERROR);
        const git = opts.gitRef?.trim() || detectGitRef(root).ref || 'HEAD';
        const repositoryId =
          reg.ok && 'workspace' in reg ? reg.workspace.id : repositoryIdFromRoot(root);
        put = await vgdRequest(
          { op: 'put-graph', repositoryId, gitRef: git, graph },
          { socketPath },
        );
        if (!put.ok) throw new CliError(put.error, ExitCode.ERROR);
      }
      if (global.json) json(put);
      else if (put.ok && 'stored' in put) {
        info(`vgd · published graph · ${put.nodeCount} node(s) · ref ${put.gitRef}`);
        info(c.dim(`  repositoryId ${put.repositoryId}`));
      }
    });
  applyGlobalOptions(publish);

  const query = cmd
    .command('query')
    .description('query the ActiveGraph held by vgd (lexical/structural)')
    .option('--repository-id <id>', 'repository id from `vg daemon list` (default: cwd workspace)')
    .argument('<query...>', 'what to find')
    .option('--limit <n>', 'max matches', '12')
    .option('--git-ref <ref>', 'branch or SHA (default: current slot)')
    .action(async function (this: Command, queryParts: string[]) {
      const global = readGlobal(this);
      const socketPath = socketOf(this);
      const opts = this.opts() as { repositoryId?: string; limit?: string; gitRef?: string };
      const q = (queryParts ?? []).join(' ').trim();
      if (!q) throw new CliError('say what to find', ExitCode.USAGE_ERROR);
      if (!(await vgdIsRunning({ socketPath }))) {
        throw new CliError(`vgd is not running (${socketPath})`, ExitCode.NOT_FOUND);
      }
      const repositoryId = opts.repositoryId?.trim() || (await repositoryIdForCwd(socketPath, rootOf(global)));
      const res = await vgdRequest(
        {
          op: 'query-graph',
          repositoryId,
          query: q,
          limit: opts.limit ? Number(opts.limit) : 12,
          gitRef: opts.gitRef,
        },
        { socketPath },
      );
      if (!res.ok) throw new CliError(res.error, ExitCode.ERROR);
      if (global.json) json(res);
      else if ('matches' in res) {
        info(`vgd query · ${res.matches.length} match(es) · ref ${res.gitRef}`);
        for (const m of res.matches) {
          info(`${m.qualifiedName} (${m.kind}) ${m.file}:${m.line}`);
          info(c.dim(`  score ${m.score} · ${m.why}`));
        }
      }
    });
  applyGlobalOptions(query);

  const impact = cmd
    .command('impact')
    .description('blast radius for a symbol in the vgd ActiveGraph')
    .option('--repository-id <id>', 'repository id (default: cwd workspace)')
    .argument('<symbol>', 'symbol id or qualified name')
    .option('--depth <n>', 'max dependency depth', '4')
    .option('--git-ref <ref>', 'branch or SHA')
    .action(async function (this: Command, symbol: string) {
      const global = readGlobal(this);
      const socketPath = socketOf(this);
      const opts = this.opts() as { repositoryId?: string; depth?: string; gitRef?: string };
      if (!(await vgdIsRunning({ socketPath }))) {
        throw new CliError(`vgd is not running (${socketPath})`, ExitCode.NOT_FOUND);
      }
      const repositoryId = opts.repositoryId?.trim() || (await repositoryIdForCwd(socketPath, rootOf(global)));
      const res = await vgdRequest(
        {
          op: 'impact-of',
          repositoryId,
          symbol: symbol.trim(),
          depth: opts.depth ? Number(opts.depth) : 4,
          gitRef: opts.gitRef,
        },
        { socketPath },
      );
      if (!res.ok) throw new CliError(res.error, ExitCode.ERROR);
      if (global.json) json(res);
      else if ('affected' in res) {
        info(`vgd impact · ${res.root.name} · depth ${res.depth} · ${res.affected.length} affected`);
        for (const a of res.affected.slice(0, 30)) {
          info(`- ${a.name} (${a.file}:${a.line}) d=${a.depth}`);
        }
      }
    });
  applyGlobalOptions(impact);

  const graphs = cmd
    .command('graphs')
    .description('list multi-branch ActiveGraph slots resident in the running vgd (Fusion §4.1.1)')
    .option('--repository-id <id>', 'filter slots to one repository id')
    .action(async function (this: Command) {
      const global = readGlobal(this);
      const socketPath = socketOf(this);
      const opts = this.opts() as { repositoryId?: string };
      if (!(await vgdIsRunning({ socketPath }))) {
        throw new CliError(`vgd is not running (${socketPath})`, ExitCode.NOT_FOUND);
      }
      const res = await vgdRequest(
        { op: 'list-graph-slots', repositoryId: opts.repositoryId },
        { socketPath },
      );
      if (!res.ok) throw new CliError(res.error, ExitCode.ERROR);
      if (global.json) json(res);
      else if ('slots' in res) {
        if (!res.slots.length) info(c.dim('vgd · no graph slots resident'));
        for (const s of res.slots) {
          const cur = s.current ? c.green(' current') : '';
          const idle = s.evictable ? c.yellow(' idle') : '';
          info(`${s.repositoryId.slice(0, 8)}…  ${s.gitRef}${cur}${idle}`);
          info(c.dim(`  nodes ${s.nodeCount} · idle ${Math.round(s.idleMs / 1000)}s · loaded ${new Date(s.loadedAt).toISOString()}`));
        }
      }
    });
  applyGlobalOptions(graphs);

  applyGlobalOptions(cmd);
}

function socketOf(cmd: Command): string {
  // Walk parents for --socket on the daemon parent or the leaf.
  let c: Command | null = cmd;
  while (c) {
    const opts = c.opts() as { socket?: string };
    if (opts.socket) return path.resolve(opts.socket);
    c = c.parent;
  }
  return vgdSocketPath();
}

/**
 * Re-invoke this CLI as a detached background `daemon start`.
 * Handles `node dist/cli.js …`, a global `vg` symlink (npm bin), and a
 * packaged `vg` binary. The symlink case must realpath to cli.js — see
 * {@link reinvokeCli}.
 */
function spawnDetachedDaemonStart(socketPath: string): ReturnType<typeof spawn> {
  // On Windows, `detached` (DETACHED_PROCESS) is the wrong tool for a daemon
  // with descendants: it leaves the process with NO console, so every
  // console-subsystem child it later spawns (embed worker, rebuild `vg build`,
  // git) allocates a brand-new VISIBLE console window on the desktop — and a
  // user closing that stray window kills the child with STATUS_CONTROL_C_EXIT.
  // windowsHide (CREATE_NO_WINDOW, ignored when combined with detached) gives
  // the daemon a windowless console its whole subtree inherits instead.
  // Lifetime is unaffected: Windows never kills children on parent exit, and
  // the separate console keeps the terminal's Ctrl-C/close away from it. On
  // POSIX, detached (its own process group) is still what lets the daemon
  // outlive the terminal.
  const opts = {
    detached: process.platform !== 'win32',
    stdio: 'ignore' as const,
    env: process.env,
    windowsHide: true,
  };
  const { command, argv } = reinvokeCli(['daemon', 'start', '--socket', socketPath]);
  return spawn(command, argv, opts);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Start vgd in the background without making the caller wait for it.
 *
 * `ensureVgd` waits up to 30s and throws — right for `vg daemon ensure` and for
 * `vg code`, which cannot proceed without a runtime, and wrong for every
 * ordinary command. An auto-start must never put a cold-start on the front of
 * `vg ask`: we spawn, give the socket a short window in case it binds quickly,
 * and otherwise leave the child coming up on its own. The command runs its
 * in-process path this time and finds a warm daemon the next.
 *
 * Never throws — the caller has a working fallback by construction.
 */
export async function ensureVgdSoft(
  socketPath: string = vgdSocketPath(),
  readyBudgetMs = 1500,
): Promise<{ running: boolean; started: boolean }> {
  try {
    if (await vgdIsRunning({ socketPath })) return { running: true, started: false };
    const child = spawnDetachedDaemonStart(socketPath);
    child.unref();
    const deadline = Date.now() + Math.max(0, readyBudgetMs);
    while (Date.now() < deadline) {
      await sleep(100);
      if (await vgdIsRunning({ socketPath })) return { running: true, started: true };
      if (child.exitCode != null && child.exitCode !== 0) break;
    }
    return { running: false, started: true };
  } catch {
    return { running: false, started: false };
  }
}

/** Injectable internals of {@link startDetachedVgd} (tests). */
export interface StartVgdDeps {
  startOnce: (socketPath: string) => Promise<number | undefined>;
  skew: (socketPath: string) => Promise<VgdSkew>;
  stop: (socketPath: string, opts?: StopVgdOptions) => ReturnType<typeof stopVgd>;
}

/**
 * How many times a start will retire an older daemon that re-binds the socket
 * before conceding. Each round both stops the interloper and gives our own
 * child another chance to win the bind; a client that keeps spawning an old
 * build faster than we can retire it is a fight to report, not to keep having.
 */
const START_BIND_ATTEMPTS = 3;

/**
 * Start vgd in the background and hand back a daemon that is genuinely on this
 * build (or newer). Throws when it cannot.
 *
 * A socket that answers ping is NOT proof the start worked: while the socket
 * is free (mid-update, mid-restart) any other client's `daemon ensure` — a VS
 * Code extension bundling an older engine, a long-lived `vg serve` on an old
 * build — can bind ITS daemon first, and our child then exits "already
 * running". Reporting success against that daemon is exactly the "updated,
 * but the daemon is still stale" state `vg update` exists to end, so after
 * every ready signal the build on the socket is verified and an older
 * squatter is force-stopped and replaced, a bounded number of times. A newer
 * daemon is left alone (newest wins — see {@link compareDaemonVersion}).
 */
export async function startDetachedVgd(
  socketPath: string,
  deps: Partial<StartVgdDeps> = {},
): Promise<number | undefined> {
  const startOnce = deps.startOnce ?? startDetachedVgdOnce;
  const skewOf = deps.skew ?? vgdVersionSkew;
  const stop = deps.stop ?? stopVgd;
  let pid: number | undefined;
  for (let attempt = 1; attempt <= START_BIND_ATTEMPTS; attempt++) {
    pid = await startOnce(socketPath);
    const skew = await skewOf(socketPath);
    if (skew.running && skew.state !== 'older') return pid;
    if (!skew.running) continue; // gone between ready and the check — spawn again
    await stop(socketPath, { force: true });
  }
  throw new CliError(
    `an older vgd keeps re-binding ${socketPath} — another running client is starting it ` +
      '(commonly a VS Code extension bundling an older engine, or a long-lived `vg serve`). ' +
      'Update or restart that client, then run "vg daemon restart --force".',
    ExitCode.ERROR,
  );
}

/**
 * Spawn a detached background `daemon start` and wait for the socket to answer
 * ping. Returns the child pid; throws when the socket never becomes ready.
 * The listener is not necessarily our child — {@link startDetachedVgd} owns
 * that verification.
 *
 * Ready budget is long because the detached child pays a full Node + CLI cold
 * start of its own (often >8s under Windows AV). The previous 8s window made
 * `vg daemon ensure` report success only when ping raced ahead of the child
 * exiting, or fail right as the child was about to listen.
 */
async function startDetachedVgdOnce(socketPath: string): Promise<number | undefined> {
  const child = spawnDetachedDaemonStart(socketPath);
  child.unref();
  const readyMs = 30_000;
  const deadline = Date.now() + readyMs;
  while (Date.now() < deadline) {
    await sleep(150);
    if (await vgdIsRunning({ socketPath })) return child.pid;
    // If the child already exited without ever answering, fail fast rather
    // than waiting out the full budget for a dead process. Another client
    // (the VS Code extension's `daemon ensure`) may have bound in this
    // tick — treat that as ready rather than reporting a false failure.
    if (child.exitCode != null && child.exitCode !== 0) {
      if (await vgdIsRunning({ socketPath })) return child.pid;
      throw new CliError(
        `vgd child exited ${child.exitCode} before becoming ready at ${socketPath} — run "vg daemon start" in the foreground to see the error`,
        ExitCode.ERROR,
      );
    }
  }
  throw new CliError(
    `vgd failed to become ready within ${Math.round(readyMs / 1000)}s at ${socketPath}`,
    ExitCode.ERROR,
  );
}

/**
 * The build version of the daemon currently on the socket, or `null` when it
 * does not report one.
 *
 * `null` is not "unknown, leave it alone": `cliVersion` landed in the status
 * response in 2026.817.x, so its absence dates the process to a build older
 * than that just as surely as a version string would.
 */
export async function vgdCliVersion(socketPath: string = vgdSocketPath()): Promise<string | null> {
  try {
    const res = await vgdRequest({ op: 'status' }, { socketPath });
    if (!res.ok || !('cliVersion' in res)) return null;
    return typeof res.cliVersion === 'string' && res.cliVersion ? res.cliVersion : null;
  } catch {
    return null;
  }
}

export type VgdSkew =
  | { running: false }
  | { running: true; version: string | null; state: 'match' | 'older' | 'newer' };

/**
 * Compare the daemon holding the socket against this build.
 *
 * vgd owns one machine-wide socket, so whichever process binds it first serves
 * every client — the CLI, `vg serve`, and a VS Code extension running its own
 * bundled engine. Version skew is therefore the normal case, not an edge case,
 * and it is invisible: an old daemon answers every request happily, just with
 * old code.
 */
export async function vgdVersionSkew(socketPath: string = vgdSocketPath(), self: string = VERSION): Promise<VgdSkew> {
  if (!(await vgdIsRunning({ socketPath }))) return { running: false };
  const version = await vgdCliVersion(socketPath);
  return { running: true, version, state: compareDaemonVersion(version, self) };
}

/**
 * Resolution is deliberately monotonic — only a strictly newer daemon survives
 * a mismatch. Two clients on different builds both ensuring the socket would
 * otherwise restart each other forever; with "newest wins" they converge on the
 * highest version present and stay there.
 */
export function compareDaemonVersion(version: string | null, self: string): 'match' | 'older' | 'newer' {
  if (version === self) return 'match';
  // We cannot judge from an unparseable version of our own — never pick a fight
  // we have no way to win.
  if (!semver.valid(self)) return 'match';
  if (version === null || !semver.valid(version)) return 'older';
  return semver.gt(version, self) ? 'newer' : 'older';
}

/** Human label for a daemon build, including the pre-2026.817 "no version" case. */
function describeVersion(version: string | null): string {
  return version ?? 'unknown (pre-2026.817)';
}

export interface EnsureVgdResult {
  started: boolean;
  pid?: number;
  /** Set when an older daemon was retired to make room for this build. */
  replaced?: { version: string | null };
}

export interface EnsureVgdOptions {
  /** Attach to whatever is on the socket, even on an older build. */
  allowVersionMismatch?: boolean;
}

/**
 * Idempotent start used by `vg daemon ensure` and `vg code`: if vgd is already
 * listening on this build, do nothing; otherwise spawn a detached standalone
 * `daemon start`.
 *
 * An older daemon is replaced rather than attached to. Attaching is the quiet
 * failure this exists to prevent: the client reports success, then serves stale
 * answers from a process nobody remembers starting.
 */
export async function ensureVgd(
  socketPath: string = vgdSocketPath(),
  opts: EnsureVgdOptions = {},
): Promise<EnsureVgdResult> {
  const skew = await vgdVersionSkew(socketPath);
  if (!skew.running) return { started: true, pid: await startDetachedVgd(socketPath) };
  if (opts.allowVersionMismatch || skew.state !== 'older') return { started: false };
  await stopVgd(socketPath, { force: true });
  return { started: true, pid: await startDetachedVgd(socketPath), replaced: { version: skew.version } };
}

export interface StopVgdOptions {
  /**
   * Escalate past a daemon that will not leave politely: SIGTERM, then SIGKILL.
   *
   * Used wherever a surviving daemon is worse than a killed one — `vg update`
   * above all, where every client on the socket would otherwise keep being
   * served by the build that was just replaced. Safe to escalate because
   * `daemon start` is the only thing that ever hosts a vgd listener, so the pid
   * belongs to a daemon process and not to somebody's editor.
   */
  force?: boolean;
}

/**
 * Stop a running vgd: polite `shutdown` op first, SIGTERM via the pid for
 * daemons that predate the op, then wait (≤5s) for the socket to go quiet.
 *
 * `refused` means the daemon declined remote shutdown (a listener started
 * without a shutdown hook). Without `force` that is where it ends — the pid
 * file belongs to the owning process and is not ours to kill.
 */
export async function stopVgd(
  socketPath: string,
  opts: StopVgdOptions = {},
): Promise<'stopped' | 'not-running' | 'refused' | 'failed'> {
  if (!(await vgdIsRunning({ socketPath }))) return 'not-running';
  // Ask who is on the socket before shutting it down. The pid the daemon
  // reports is authoritative; the pid file can be left over from an earlier
  // process, and signalling that would kill a stranger.
  const livePid = opts.force ? await vgdReportedPid(socketPath) : null;
  let acknowledged = false;
  try {
    const res = await vgdRequest({ op: 'shutdown' }, { socketPath });
    if (res.ok) acknowledged = true;
    else if (res.code === 'shutdown_unsupported' && !opts.force) return 'refused';
    // Any other refusal (an older daemon answers `unknown op`) → pid fallback.
  } catch {
    /* connection dropped mid-shutdown or slow daemon — fall through to pid */
  }
  if (!acknowledged) {
    const pid = signalTarget(livePid);
    if (pid == null) return 'failed';
    if (!signalPid(pid, 'SIGTERM')) return 'failed';
  }
  if (await waitForVgdStop(socketPath, 5_000)) return 'stopped';
  if (!opts.force) return 'failed';

  // Wedged: it acknowledged, or took SIGTERM, and is still holding the socket.
  const pid = signalTarget(livePid);
  if (pid == null) return 'failed';
  if (!signalPid(pid, 'SIGKILL')) return 'failed';
  // A SIGKILLed daemon cannot unlink its own socket, but the next `daemon
  // start` clears a stale path before binding, so nothing is left to clean up.
  return (await waitForVgdStop(socketPath, 3_000)) ? 'stopped' : 'failed';
}

/**
 * The pid to signal, or null when there is nothing safe to signal.
 *
 * Never our own: a daemon hosted in *this* process (an in-process test server,
 * a future embedded listener) would otherwise be "stopped" by killing the
 * caller. Such a daemon has to be shut down through its own handle, so report
 * failure and let the caller say so.
 */
function signalTarget(livePid: number | null): number | null {
  const pid = livePid ?? readVgdPid();
  if (pid == null || pid === process.pid) return null;
  return pid;
}

function signalPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function waitForVgdStop(socketPath: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await sleep(100);
    if (!(await vgdIsRunning({ socketPath }))) return true;
  }
  return false;
}

/** The pid the live daemon reports for itself — trusted over the pid file. */
async function vgdReportedPid(socketPath: string): Promise<number | null> {
  try {
    const res = await vgdRequest({ op: 'status' }, { socketPath });
    if (!res.ok || !('pid' in res)) return null;
    return Number.isInteger(res.pid) && res.pid > 0 ? res.pid : null;
  } catch {
    return null;
  }
}

export interface RestartVgdOptions extends StopVgdOptions {
  /**
   * Start a daemon even when none is running. `vg update` on Windows stops
   * vgd *before* the install so its files can be replaced; afterwards there is
   * nothing to "re"-start, but leaving the socket empty both makes the rewarm
   * a no-op and leaves a window for another client to bind an old build.
   */
  startIfNotRunning?: boolean;
}

/**
 * Restart the local vgd if one is running — used by `vg update` so a freshly
 * installed CLI does not keep serving from a daemon still running the old
 * build. `restarted`/`started` mean a daemon on this build (or newer) was
 * verified on the socket, not merely that something answered ping.
 * Best-effort: never throws.
 */
export async function restartVgdIfRunning(
  socketPath: string = vgdSocketPath(),
  opts: RestartVgdOptions = {},
): Promise<'restarted' | 'started' | 'not-running' | 'refused' | 'failed'> {
  try {
    const stopResult = await stopVgd(socketPath, opts);
    if (stopResult === 'not-running' && !opts.startIfNotRunning) return 'not-running';
    if (stopResult === 'refused') return 'refused';
    if (stopResult === 'failed') return 'failed';
    await startDetachedVgd(socketPath);
    return stopResult === 'not-running' ? 'started' : 'restarted';
  } catch {
    return 'failed';
  }
}

function readVgdPid(): number | null {
  try {
    const raw = fs.readFileSync(vgdPidPath(), 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Resolve repository id for cwd: register if needed, return workspace id. */
async function repositoryIdForCwd(socketPath: string, root: string): Promise<string> {
  const { repositoryIdFromRoot } = await import('../runtime/paths.js');
  const reg = await vgdRequest({ op: 'register', root }, { socketPath });
  if (reg.ok && 'workspace' in reg) return reg.workspace.id;
  return repositoryIdFromRoot(root);
}
