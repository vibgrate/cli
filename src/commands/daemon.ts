import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { startVgdServer, vgdIsRunning, vgdPidPath, vgdRequest, vgdSocketPath, VGD_PROTOCOL_VERSION } from '../runtime/vgd/index.js';
import { rootOf } from './util.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info, json } from '../util/output.js';

/**
 * `vg daemon` — lightweight local Fusion Runtime daemon (`vgd`) prototype.
 *
 * Phase 2 slice: local socket + workspace registry. Interactive `vg code`
 * attaches via `startCodeRuntimeSession` (or owns an in-process vgd).
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
      if (global.json) json({ running: true, ...res, semantic: semanticPayload });
      else if ('pid' in res) {
        const slots = typeof res.graphSlots === 'number' ? ` · ${res.graphSlots} graph slot(s)` : '';
        info(
          `vgd · running pid ${res.pid} · ${res.workspaces} workspace(s)${slots} · ${res.uptimeMs}ms up · ${c.dim(res.socketPath)}`,
        );
        if (semanticPayload) {
          const ready = semanticPayload.slots.filter((sl) => sl.state === 'ready');
          const vectors = ready.reduce((n, sl) => n + sl.vectors, 0);
          const detail =
            semanticPayload.worker === 'unavailable'
              ? c.dim(semanticPayload.reason ?? 'semantic off — lexical only')
              : `${ready.length}/${semanticPayload.slots.length} index(es) ready · ${vectors} vector(s)` +
                (semanticPayload.model ? ` · ${semanticPayload.model}` : '');
          info(`  semantic · worker ${semanticPayload.worker} · ${detail}`);
          for (const sl of semanticPayload.slots) {
            if (sl.state === 'ready') continue;
            info(c.dim(`    ${sl.repositoryId}@${sl.gitRef} · ${sl.state}${sl.error ? ` — ${sl.error}` : ''}`));
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
    .description('ensure vgd is running (start in background if needed)')
    .action(async function (this: Command) {
      const global = readGlobal(this);
      const socketPath = socketOf(this);
      if (await vgdIsRunning({ socketPath })) {
        const res = await vgdRequest({ op: 'status' }, { socketPath });
        if (global.json) {
          json({ running: true, ensured: false, ...(res.ok ? res : { socketPath }) });
        } else if (!global.quiet) {
          const pid = res.ok && 'pid' in res ? res.pid : '?';
          info(`vgd · already running pid ${pid} · ${c.dim(socketPath)}`);
        }
        return;
      }

      const child = await startDetachedVgd(socketPath);
      const res = await vgdRequest({ op: 'status' }, { socketPath });
      if (!res.ok) {
        throw new CliError(
          `vgd started (pid ${child ?? '?'}) but status failed: ${res.error} (${socketPath})`,
          ExitCode.ERROR,
        );
      }
      if (global.json) {
        json({ running: true, ensured: true, ...res });
      } else if (!global.quiet) {
        const pid = 'pid' in res ? res.pid : child;
        info(`vgd · started in background pid ${pid} · ${c.dim(socketPath)}`);
      }
    });
  applyGlobalOptions(ensure);

  const stop = cmd
    .command('stop')
    .description('stop the running vgd (idempotent — succeeds if none is running)')
    .action(async function (this: Command) {
      const global = readGlobal(this);
      const socketPath = socketOf(this);
      const result = await stopVgd(socketPath);
      if (global.json) {
        json({ stopped: result === 'stopped', result, socketPath });
      } else if (!global.quiet) {
        if (result === 'stopped') info(`vgd · stopped ${c.dim(socketPath)}`);
        else if (result === 'not-running') info(c.dim(`vgd · not running (${socketPath})`));
      }
      if (result === 'refused') {
        throw new CliError(
          'this vgd is embedded in another process (e.g. vg code) — stop that process instead',
          ExitCode.ERROR,
        );
      }
      if (result === 'failed') {
        throw new CliError(
          `vgd did not stop within 5s (${socketPath}) — check \`vg daemon status\` and stop the process manually`,
          ExitCode.ERROR,
        );
      }
    });
  applyGlobalOptions(stop);

  const restart = cmd
    .command('restart')
    .description('restart vgd (stop if running, then start in the background)')
    .action(async function (this: Command) {
      const global = readGlobal(this);
      const socketPath = socketOf(this);
      const stopResult = await stopVgd(socketPath);
      if (stopResult === 'refused') {
        throw new CliError(
          'this vgd is embedded in another process (e.g. vg code) — stop that process instead',
          ExitCode.ERROR,
        );
      }
      if (stopResult === 'failed') {
        throw new CliError(
          `vgd did not stop within 5s (${socketPath}) — check \`vg daemon status\` and stop the process manually`,
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
 * Handles both `node dist/cli.js …` and a packaged `vg` binary.
 */
function spawnDetachedDaemonStart(socketPath: string): ReturnType<typeof spawn> {
  // windowsHide: on Windows a detached console can flash and (with some AV /
  // job-object setups) keep the child tied to the parent session. Hide it.
  const opts = {
    detached: true,
    stdio: 'ignore' as const,
    env: process.env,
    windowsHide: true,
  };
  const entry = process.argv[1];
  if (entry && (entry.endsWith('.js') || entry.endsWith('.mjs') || entry.endsWith('.cjs'))) {
    return spawn(process.execPath, [entry, 'daemon', 'start', '--socket', socketPath], opts);
  }
  // Packaged binary: argv[0] is the executable.
  return spawn(process.argv[0] || 'vg', ['daemon', 'start', '--socket', socketPath], opts);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Spawn a detached background `daemon start` and wait for it to answer ping.
 * Returns the child pid; throws when the socket never becomes ready.
 *
 * Ready budget is long because the detached child pays a full Node + CLI cold
 * start of its own (often >8s under Windows AV). The previous 8s window made
 * `vg daemon ensure` report success only when ping raced ahead of the child
 * exiting, or fail right as the child was about to listen.
 */
async function startDetachedVgd(socketPath: string): Promise<number | undefined> {
  const child = spawnDetachedDaemonStart(socketPath);
  child.unref();
  const readyMs = 30_000;
  const deadline = Date.now() + readyMs;
  while (Date.now() < deadline) {
    await sleep(150);
    if (await vgdIsRunning({ socketPath })) return child.pid;
    // If the child already exited without ever answering, fail fast rather
    // than waiting out the full budget for a dead process.
    if (child.exitCode != null && child.exitCode !== 0) {
      throw new CliError(
        `vgd child exited ${child.exitCode} before becoming ready at ${socketPath}`,
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
 * Stop a running vgd: polite `shutdown` op first, SIGTERM via the pid file for
 * daemons that predate the op, then wait (≤5s) for the socket to go quiet.
 *
 * `refused` means the daemon is embedded in another process (`vg code`) that
 * declined remote shutdown — never escalate that to a pid-file kill, because
 * the pid file belongs to the owning process.
 */
export async function stopVgd(socketPath: string): Promise<'stopped' | 'not-running' | 'refused' | 'failed'> {
  if (!(await vgdIsRunning({ socketPath }))) return 'not-running';
  let acknowledged = false;
  try {
    const res = await vgdRequest({ op: 'shutdown' }, { socketPath });
    if (res.ok) acknowledged = true;
    else if (res.code === 'shutdown_unsupported') return 'refused';
    // Any other refusal (an older daemon answers `unknown op`) → pid fallback.
  } catch {
    /* connection dropped mid-shutdown or slow daemon — fall through to pid */
  }
  if (!acknowledged) {
    const pid = readVgdPid();
    if (pid == null) return 'failed';
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return 'failed';
    }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await sleep(100);
    if (!(await vgdIsRunning({ socketPath }))) return 'stopped';
  }
  return 'failed';
}

/**
 * Restart the local vgd if (and only if) one is running — used by `vg update`
 * so a freshly installed CLI does not keep serving from a daemon still running
 * the old build. Best-effort: never throws.
 */
export async function restartVgdIfRunning(
  socketPath: string = vgdSocketPath(),
): Promise<'restarted' | 'not-running' | 'refused' | 'failed'> {
  try {
    const stopResult = await stopVgd(socketPath);
    if (stopResult === 'not-running') return 'not-running';
    if (stopResult === 'refused') return 'refused';
    if (stopResult === 'failed') return 'failed';
    await startDetachedVgd(socketPath);
    return 'restarted';
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
