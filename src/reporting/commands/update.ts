import { execSync } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as readline from 'node:readline';
import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { VERSION } from '../version.js';
import { clearEmbedderHealth } from '../../engine/embed-health.js';
import { fetchLatestVersion } from '../utils/update-check.js';
import { pathExists } from '../utils/fs.js';
import { liveStatsDir, reapOtherVersionServers, type ReapedServer } from '../../mcp/live-stats.js';
import { restartVgdIfRunning, stopVgd, vgdVersionSkew } from '../../commands/daemon.js';
import { isFileLockError, scheduleDeferredUpdate } from './update-windows.js';
import { updateLocalModules } from '../../install/update-modules.js';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

const PACKAGE_NAME = '@vibgrate/cli';

/**
 * The packages whose install scripts the CLI actually needs, in the form npm's
 * `allow-scripts` policy expects.
 *
 * npm (12+) blocks install scripts by default and lists the skipped ones as a
 * warning. Three of ours matter: `@vibgrate/cli`'s own postinstall (which
 * clears the stale embedder verdict), `msgpackr-extract`'s (a native build),
 * and `onnxruntime-node`'s — allowed so it runs and exits cleanly under the
 * skip flag below instead of showing up in the skipped-scripts warning every
 * update. (Its CPU binaries ship inside the npm package; the script itself
 * only fetches CUDA GPU extras the embedder never loads.) When our own
 * postinstall is skipped, semantic search can stay degraded with a stale
 * "backend crashed" verdict — see crashedMessage() in engine/embed-health.ts,
 * which tells users to reinstall with exactly this flag. An update that doesn't
 * pass it re-creates that state every single time, so the advice can never
 * stick.
 *
 * Scoped deliberately: this permits our three packages, not every dependency.
 * Older npm (≤11) has no such config and ignores the flag, so passing it
 * unconditionally is safe.
 */
const SCRIPT_PACKAGES = [PACKAGE_NAME, 'onnxruntime-node', 'msgpackr-extract'];

/** `--allow-scripts=a,b,c` — npm only; other managers gate scripts differently. */
export function allowScriptsFlag(pm: PackageManager): string {
  return pm === 'npm' ? ` --allow-scripts=${SCRIPT_PACKAGES.join(',')}` : '';
}

/**
 * Environment that tells onnxruntime-node's postinstall to skip its optional
 * download. That script's default on linux/x64 is to fetch the CUDA GPU
 * provider binaries from nuget.org — hundreds of MB that the CPU-only embedder
 * never loads (the binding links no CUDA library; it would dlopen them only if
 * the CUDA execution provider were requested, and the vendored backend pins
 * CPU). A blocked NuGet feed also can't slow or break an update once nothing
 * is downloaded.
 *
 * An env var, NOT the `--onnxruntime-node-install=skip` flag the package's
 * README suggests: npm 12 rejects unknown config flags outright ("Run `npm
 * help config` for supported options"), so putting the flag in the command
 * would fail every install. The installer checks this env var first, and it
 * rides through every package manager unchanged.
 */
export const ORT_INSTALL_SKIP_ENV = { ONNXRUNTIME_NODE_INSTALL: 'skip' } as const;

/**
 * Check if the CLI is running from a global install by examining where it's
 * running from. Returns the package manager if global, null if local.
 *
 * Global bins are usually symlinks (`/usr/local/bin/vg` →
 * `../lib/node_modules/@vibgrate/cli/…`), so the launch path must be
 * realpath-resolved before inspecting it — the symlink itself contains no
 * `node_modules` segment and would defeat the check.
 */
export function detectGlobalInstall(
  execPath: string = process.argv[1] || '',
  cwd: string = process.cwd(),
): PackageManager | null {
  if (!execPath) return null;
  let resolved = execPath;
  try {
    resolved = fsSync.realpathSync(execPath);
  } catch {
    // Path may not exist (tests, unusual launchers) — inspect it as given.
  }
  const p = resolved.replace(/\\/g, '/');
  if (!p.includes('/node_modules/')) return null;
  // One-off runner caches (npx / pnpm dlx / bunx) live outside the project but
  // are not installs — nothing to update there.
  if (p.includes('/_npx/') || p.includes('/dlx-') || p.includes('/.bunx/')) return null;
  // Inside the current project's own node_modules → a local install.
  const workdir = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  if (workdir && (p === workdir || p.startsWith(workdir + '/'))) return null;
  if (p.includes('/pnpm/')) return 'pnpm';
  if (p.includes('/yarn/') || p.includes('/.yarn/')) return 'yarn';
  if (p.includes('/.bun/')) return 'bun';
  return 'npm';
}

/** Runs a shell command and returns trimmed stdout; used by the global-root probe. */
export type CommandRunner = (cmd: string) => string;

const defaultRunner: CommandRunner = (cmd) =>
  execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 });

/**
 * Check whether the package is installed globally under any known package
 * manager, even when the current process wasn't launched from that install
 * (e.g. `vg` run via a local dependency while a global copy also exists).
 * Probes each manager's global root and returns the first that contains the
 * package, or null when none does. Managers that aren't installed just fail
 * their probe and are skipped.
 */
export async function findGlobalInstall(
  pkg: string = PACKAGE_NAME,
  run: CommandRunner = defaultRunner,
): Promise<PackageManager | null> {
  const tryRun = (cmd: string): string | null => {
    try {
      const out = run(cmd).trim().split('\n')[0]?.trim();
      return out || null;
    } catch {
      return null;
    }
  };

  const probes: Array<{ pm: PackageManager; root: () => string | null }> = [
    { pm: 'npm', root: () => tryRun('npm root -g') },
    { pm: 'pnpm', root: () => tryRun('pnpm root -g') },
    {
      pm: 'yarn',
      root: () => {
        const dir = tryRun('yarn global dir');
        return dir ? path.join(dir, 'node_modules') : null;
      },
    },
    { pm: 'bun', root: () => path.join(os.homedir(), '.bun', 'install', 'global', 'node_modules') },
  ];

  for (const probe of probes) {
    const root = probe.root();
    if (root && (await pathExists(path.join(root, pkg)))) return probe.pm;
  }
  return null;
}

export function getGlobalUpdateCommand(pm: PackageManager, pkg: string, version: string): string {
  const spec = `${pkg}@${version}`;
  switch (pm) {
    case 'pnpm':
      return `pnpm add -g ${spec}`;
    case 'yarn':
      return `yarn global add ${spec}`;
    case 'bun':
      return `bun add -g ${spec}`;
    case 'npm':
    default:
      return `npm install -g --no-fund${allowScriptsFlag('npm')} ${spec}`;
  }
}

/**
 * Detect which package manager is being used in the current project
 * by checking for lockfiles in the working directory.
 */
export async function detectPackageManager(cwd: string): Promise<PackageManager> {
  if (await pathExists(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await pathExists(path.join(cwd, 'bun.lockb'))) return 'bun';
  if (await pathExists(path.join(cwd, 'yarn.lock'))) return 'yarn';
  return 'npm'; // default
}

/**
 * Detect whether `cwd` is a monorepo/workspace root.
 *
 * pnpm refuses a plain `pnpm add` at a workspace root (ERR_PNPM_ADDING_TO_ROOT)
 * unless `-w`/`--workspace-root` is passed, because adding to the root touches the
 * root `package.json` rather than a package. A pnpm workspace is declared by a
 * `pnpm-workspace.yaml`; npm/yarn workspaces are declared by the `workspaces`
 * field in `package.json`. We treat any of these as a workspace root.
 */
export async function detectWorkspaceRoot(cwd: string): Promise<boolean> {
  if (await pathExists(path.join(cwd, 'pnpm-workspace.yaml'))) return true;
  try {
    const pkgPath = path.join(cwd, 'package.json');
    const raw = await (await import('node:fs/promises')).readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as { workspaces?: unknown };
    return pkg.workspaces != null;
  } catch {
    return false;
  }
}

export interface InstallCommandOptions {
  /** When true and the package manager is pnpm, add the `-w` workspace-root flag. */
  workspaceRoot?: boolean;
}

export function getInstallCommand(
  pm: PackageManager,
  pkg: string,
  version: string,
  isDev: boolean,
  opts: InstallCommandOptions = {},
): string {
  const spec = `${pkg}@${version}`;
  // Only pnpm needs an explicit workspace-root flag; npm/yarn/bun add to the
  // root package.json without complaint.
  const ws = opts.workspaceRoot && pm === 'pnpm' ? ' -w' : '';
  switch (pm) {
    case 'pnpm':
      return isDev ? `pnpm add${ws} -D ${spec}` : `pnpm add${ws} ${spec}`;
    case 'yarn':
      return isDev ? `yarn add --dev ${spec}` : `yarn add ${spec}`;
    case 'bun':
      return isDev ? `bun add -d ${spec}` : `bun add ${spec}`;
    case 'npm':
    default: {
      const allow = allowScriptsFlag('npm');
      // --no-fund drops the "N packages are looking for funding" notice — pure
      // noise in an update transcript. Warnings stay on: they carry signal
      // (skipped install scripts, engine mismatches).
      return isDev ? `npm install --no-fund${allow} --save-dev ${spec}` : `npm install --no-fund${allow} ${spec}`;
    }
  }
}

/** How the package is declared in the project's package.json, if at all. */
export type LocalDependencyState = 'dev' | 'prod' | null;

/**
 * Read how the package is declared in the project's package.json.
 * Returns null when there is no package.json or the package isn't declared.
 */
export async function getLocalDependencyState(
  cwd: string,
  pkg: string = PACKAGE_NAME,
): Promise<LocalDependencyState> {
  try {
    const pkgPath = path.join(cwd, 'package.json');
    const raw = await (await import('node:fs/promises')).readFile(pkgPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (parsed.devDependencies?.[pkg]) return 'dev';
    if (parsed.dependencies?.[pkg]) return 'prod';
  } catch {
    // No package.json / unreadable — not a declared dependency.
  }
  return null;
}

/**
 * Ask the user to confirm updating at a workspace root, which needs `-w` and
 * writes to the root package.json. Returns false when not attached to a TTY so
 * the aggressive add never runs unattended (e.g. in CI) without an explicit flag.
 */
async function confirmWorkspaceRoot(pm: PackageManager): Promise<boolean> {
  return confirm(`Update the ${pm} workspace root with -w? [y/N]: `);
}

/**
 * Ask a yes/no question. Returns false when not attached to a TTY so nothing
 * aggressive ever runs unattended (e.g. in CI) without an explicit flag.
 */
async function confirm(question: string): Promise<boolean> {
  if (!(process.stdin.isTTY && process.stdout.isTTY)) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(chalk.yellow(question), (ans) => {
      rl.close();
      const t = ans.trim().toLowerCase();
      resolve(t === 'y' || t === 'yes');
    });
  });
}

/**
 * Run the install command, streaming its output live while keeping a copy so a
 * failure can be classified (a locked file on Windows reads very differently
 * from a registry or packaging error). Only the tail is retained — npm can be
 * extremely chatty and we only ever inspect the error summary.
 */
const CAPTURED_OUTPUT_LIMIT = 64_000;

async function runInstall(cmd: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    // ORT_INSTALL_SKIP_ENV: no CUDA download during an update, ever — see the
    // constant's doc for why this is env, not a flag.
    const child = spawn(cmd, {
      cwd,
      shell: true,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...process.env, ...ORT_INSTALL_SKIP_ENV },
    });
    let output = '';
    const tee = (src: NodeJS.ReadableStream | null, dest: NodeJS.WriteStream): void => {
      if (!src) return;
      src.setEncoding('utf8');
      src.on('data', (chunk: string) => {
        dest.write(chunk);
        output += chunk;
        if (output.length > CAPTURED_OUTPUT_LIMIT) output = output.slice(-CAPTURED_OUTPUT_LIMIT);
      });
    };
    tee(child.stdout, process.stdout);
    tee(child.stderr, process.stderr);
    child.on('error', (err) => resolve({ ok: false, output: `${output}\n${String(err)}` }));
    child.on('close', (code) => resolve({ ok: code === 0, output }));
  });
}

/**
 * Windows cannot overwrite a loaded native addon, so every vg process holding
 * one blocks a global update (see update-windows.ts). Retire the ones we can
 * before installing: `vg serve` instances on an older build, and the vgd
 * daemon — which is deliberately left stopped rather than restarted, because a
 * restarted daemon re-locks the files we are about to replace. The update
 * starts it again on the new build once the install lands (see the
 * `startIfNotRunning` restart below). Returns true when a daemon was stopped.
 */
async function releaseWindowsFileLocks(cwd: string, keepVersion: string): Promise<boolean> {
  reapAndReport(cwd, keepVersion);
  try {
    const { vgdSocketPath } = await import('../../runtime/vgd/index.js');
    const result = await stopVgd(vgdSocketPath());
    if (result === 'stopped') {
      console.log(chalk.dim('Stopped the vgd daemon so its files can be replaced — it restarts on the new build after the install.'));
      return true;
    } else if (result === 'refused') {
      console.log(
        chalk.dim(
          'A vgd that cannot be stopped remotely is running — close the process holding the socket if the update reports a locked file.',
        ),
      );
    }
  } catch {
    /* best-effort: a daemon problem must not stop the update from being tried */
  }
  return false;
}

/**
 * Handle a Windows update that failed because a file was locked. Offers to run
 * the install from a detached script once this process exits and releases its
 * own locks. Returns true when a deferred update was scheduled (the caller must
 * then exit promptly so the script can proceed).
 */
async function offerDeferredWindowsUpdate(cmd: string, assumeYes: boolean): Promise<boolean> {
  console.error(
    chalk.yellow('\nWindows could not replace a file that is still in use.') +
      chalk.dim(
        '\nThis is the self-update case: vg loads native modules (.node), and Windows locks them' +
          '\nfor as long as a process has them open — including this one. Re-running the same' +
          '\ncommand by hand hits the identical lock.',
      ),
  );

  const proceed = assumeYes || (await confirm('Finish the update automatically after vg exits? [y/N]: '));
  if (!proceed) {
    console.error(
      chalk.dim(
        'Skipped. To update manually, close every terminal and editor running vg (including' +
          '\nMCP servers started by your AI client), then run:\n  ' +
          cmd,
      ),
    );
    return false;
  }

  const scheduled = scheduleDeferredUpdate(cmd);
  if (!scheduled) {
    console.error(chalk.red(`Could not schedule the deferred update. Run manually once vg is closed: ${cmd}`));
    return false;
  }
  console.log(
    chalk.green('✔') +
      ' Update scheduled — it runs as soon as this process exits.\n' +
      chalk.dim(`  Transcript: ${scheduled.logPath}\n`) +
      chalk.dim('  Check the new version with "vg --version" in a few seconds.'),
  );
  return true;
}

/**
 * Check the optional local modules (relevance, hcs, haile) against the
 * registry and, unless checkOnly, bring the eligible ones to latest. Modules
 * pin to `dist-tags.latest` at first provision and never refresh on their
 * own, so `vg update` is where they catch up. Explicit opt-outs (a recorded
 * denial, VIBGRATE_NO_KERNEL=1) and HCS-not-installed stay silent; a module
 * failure is a warning, never a failed update.
 */
async function refreshLocalModules(checkOnly: boolean): Promise<void> {
  for (const r of await updateLocalModules({ checkOnly })) {
    switch (r.status) {
      case 'updated':
        console.log(chalk.green('✔') + ` ${r.npmName} module updated ${r.from} → ${r.to}`);
        break;
      case 'installed':
        console.log(chalk.green('✔') + ` ${r.npmName} module installed (${r.to})`);
        break;
      case 'update-available':
        console.log(chalk.yellow(`Module update available: ${r.npmName} ${r.from} → ${r.to}`));
        break;
      case 'install-available':
        console.log(chalk.yellow(`Module not installed yet: ${r.npmName} (${r.to} available)`));
        break;
      case 'up-to-date':
        console.log(chalk.dim(`  ${r.npmName} module up to date (${r.to})`));
        break;
      case 'failed':
        console.log(chalk.yellow(`  ${r.npmName} module could not be updated — ${r.detail ?? 'unknown error'}`));
        break;
      default:
        // disabled / declined / hcs-not-installed: explicit opt-outs and
        // provision-on-use modules are not news during an update.
        break;
    }
  }
}

export const updateCommand = new Command('update')
  .description('Update vibgrate and its local modules to the latest versions')
  .option('--check', 'Only check for updates, do not install')
  .option('--pm <manager>', 'Package manager to use (npm, pnpm, yarn, bun)')
  .option('--global', 'Update global installation')
  .option('-y, --yes', 'Skip confirmation prompts (e.g. installing at a workspace root)')
  .option('-w, --workspace-root', 'Allow updating the pnpm workspace root (implies --yes for that prompt)')
  .option('--no-reap', 'Do not signal running vg serve processes on an older version to restart')
  .action(
    async (opts: {
      check?: boolean;
      pm?: string;
      global?: boolean;
      yes?: boolean;
      workspaceRoot?: boolean;
      reap?: boolean;
    }) => {
      console.log(chalk.dim(`Current version: ${VERSION}`));
      console.log(chalk.dim('Checking npm registry...'));

      const latest = await fetchLatestVersion();

      if (!latest) {
        console.error(chalk.red('Could not reach the npm registry. Check your network connection.'));
        process.exit(1);
      }

      const semver = await import('semver');
      if (!semver.gt(latest, VERSION)) {
        console.log(chalk.green('✔') + ` You are on the latest version (${VERSION}).`);
        // The CLI being current says nothing about the local modules — they
        // pin to the registry's latest at first install and only catch up
        // here. Refresh them (or just report, under --check) before the
        // process-hygiene steps below.
        await refreshLocalModules(Boolean(opts.check));
        // Even on the latest binary, an assistant-spawned `vg serve` started
        // before a prior update may still be executing an OLDER build (a
        // long-lived stdio child the client never restarted). Retire those so
        // the client respawns them on this version — the exact "stale spawned
        // server" case that makes fixes look absent until an editor restart.
        if (opts.reap !== false) reapAndReport(process.cwd(), VERSION);
        // The binary on disk being current says nothing about the process on
        // the socket. A vgd started by an older build — commonly the VS Code
        // extension's bundled engine, which never consults PATH — keeps serving
        // every client from that build until something replaces it, and reports
        // no error while doing so. Reconcile it here or "you are on the latest
        // version" is a half-truth.
        if (opts.reap !== false) await reconcileVgdAndReport(process.cwd());
        return;
      }

      console.log(chalk.yellow(`Update available: ${VERSION} → ${latest}`));

      if (opts.check) {
        await refreshLocalModules(true);
        console.log(chalk.dim('Run "vg update" to install.'));
        return;
      }

      const cwd = process.cwd();

      // Decide the update target. A global copy is updated in place — the
      // project's package.json is only touched when the package is actually
      // declared there (or when there is no global install to update).
      const runtimeGlobalPm = detectGlobalInstall();
      let globalPm: PackageManager | null = runtimeGlobalPm;
      let isGlobal = Boolean(opts.global) || runtimeGlobalPm !== null;
      let localState: LocalDependencyState = null;

      if (!isGlobal) {
        localState = await getLocalDependencyState(cwd);
        if (localState === null) {
          // Not declared in this project. If a global install exists, update
          // that instead of adding the CLI to this project's package.json.
          globalPm = await findGlobalInstall();
          if (globalPm) {
            isGlobal = true;
            console.log(
              chalk.dim(`Found a global ${globalPm} installation of ${PACKAGE_NAME} — updating it instead of this project.`),
            );
          }
        }
      }

      const pm: PackageManager = (opts.pm as PackageManager) || globalPm || (await detectPackageManager(cwd));

      let cmd: string;
      if (isGlobal) {
        cmd = getGlobalUpdateCommand(pm, PACKAGE_NAME, latest);
        console.log(chalk.dim(`Updating global installation with ${pm}: ${cmd}`));
      } else {
        // A CLI belongs in devDependencies: install as a dev dependency unless
        // the project has explicitly declared it under `dependencies`.
        const isDev = localState !== 'prod';

        // pnpm refuses `pnpm add` at a workspace root without -w. Detect that up
        // front so we can offer to run the workspace-root-aware command instead of
        // failing with ERR_PNPM_ADDING_TO_ROOT.
        let workspaceRoot = false;
        if (pm === 'pnpm' && (await detectWorkspaceRoot(cwd))) {
          console.log(
            chalk.yellow('Detected a pnpm workspace root.') +
              chalk.dim(' Installing here needs the -w flag and updates the root package.json.'),
          );
          const proceed = opts.yes || opts.workspaceRoot || (await confirmWorkspaceRoot(pm));
          if (!proceed) {
            const rootCmd = getInstallCommand(pm, PACKAGE_NAME, latest, isDev, { workspaceRoot: true });
            console.log(chalk.dim(`Skipped. To update the workspace root, run: ${rootCmd}`));
            console.log(chalk.dim('or re-run "vg update --yes" (or --workspace-root) to let vg do it.'));
            return;
          }
          workspaceRoot = true;
        }

        cmd = getInstallCommand(pm, PACKAGE_NAME, latest, isDev, { workspaceRoot });
        console.log(chalk.dim(`Using ${pm}: ${cmd}`));
      }

      // Windows locks loaded native addons, so retire the other vg processes
      // holding them before npm tries to move the install tree aside.
      let stoppedVgdForInstall = false;
      if (process.platform === 'win32' && isGlobal && opts.reap !== false) {
        stoppedVgdForInstall = await releaseWindowsFileLocks(cwd, latest);
      }

      const install = await runInstall(cmd, cwd);
      if (install.ok) {
        console.log(chalk.green('✔') + ` Updated to ${PACKAGE_NAME}@${latest}`);
        // The self-update carried the binary; the local modules update here,
        // in the same run, so one `vg update` leaves everything current.
        await refreshLocalModules(false);
      } else if (process.platform === 'win32' && isFileLockError(install.output)) {
        // Only this process's own locks are left. It cannot release them and
        // keep running, so hand the install to a script that waits for us.
        const scheduled = await offerDeferredWindowsUpdate(cmd, Boolean(opts.yes));
        // Exit either way: the post-update steps below assume the new build is
        // on disk, and when a deferred update is pending we must get out of its
        // way immediately.
        process.exit(scheduled ? 0 : 1);
      } else {
        console.error(chalk.red(`Update failed. Run manually: ${cmd}`));
        process.exit(1);
      }

      // Retire any running vg serve on the OLD build so the client respawns it
      // on the one just installed. Without this the update lands on disk but a
      // long-lived assistant-spawned server keeps answering from the old code.
      if (opts.reap !== false) reapAndReport(cwd, latest);

      // Same story for the Fusion Runtime daemon: a vgd started before the
      // update keeps running the old build until something restarts it. Forced,
      // because a daemon that outlives the build it was started from is exactly
      // the state this update exists to end — killing it is the lesser harm.
      // When *we* stopped the daemon to free its files, start it again even if
      // nothing rebound the socket meanwhile — otherwise the rewarm below has
      // nothing to warm and the socket sits free for another (possibly older)
      // client to claim.
      if (opts.reap !== false) {
        await restartVgdAndReport({ force: true, startIfNotRunning: stoppedVgdForInstall });
      }

      // An update is a chance for a broken native embedding backend to have
      // been fixed, so never let a stale "crashed" verdict outlive it. The
      // package's own postinstall clears this too, but only runs when install
      // scripts are permitted — and a blocked postinstall is the very thing
      // that causes the crash. Clearing here covers the update path
      // regardless.
      try {
        clearEmbedderHealth();
      } catch {
        /* best-effort: a cache problem must not fail a successful update */
      }

      // A restarted daemon is an empty daemon. Re-publish this repo's map and
      // rebuild its semantic index now, so the first command after an update
      // is fast instead of being the one that pays for the restart.
      if (opts.reap !== false) await rewarmVgdAndReport(cwd);
    },
  );

/**
 * Re-warm the daemon after it was restarted: publish this repo's map into the
 * fresh process and build its semantic index. Best-effort and never throws —
 * an unbuilt map or an unavailable embedding backend just means the next
 * command warms it instead, exactly as before.
 */
async function rewarmVgdAndReport(cwd: string): Promise<void> {
  try {
    const { vgdIsRunning, vgdRequest } = await import('../../runtime/vgd/index.js');
    if (!(await vgdIsRunning())) return;
    const loaded = await vgdRequest({ op: 'load-graph', root: cwd });
    // `stored`, not `repositoryId`: several response shapes carry an id, and
    // only the load-graph success shape means a map is now resident.
    if (!loaded.ok || !('stored' in loaded)) return; // no map built yet — nothing to warm
    console.log(chalk.dim('Re-published the code map into the restarted daemon.'));
    const indexed = await vgdRequest({ op: 'embed-index', repositoryId: loaded.repositoryId });
    if (indexed.ok && 'vectors' in indexed && indexed.state === 'ready') {
      console.log(chalk.dim(`Semantic index warm again (${indexed.vectors} vectors).`));
    }
  } catch {
    /* daemon busy, no map, semantic off — all fine, the next command warms */
  }
}

/**
 * Bring the daemon on the socket up to the build this CLI is running.
 *
 * Used on the "already on the latest version" path, where there is no install
 * to trigger a restart but the daemon can still be stale — it outlives every
 * update, and the process that started it may not even be this CLI. Only an
 * *older* daemon is replaced: a newer one is somebody else's upgrade in
 * progress, and restarting it here would start a fight over the socket that
 * neither side can win.
 */
async function reconcileVgdAndReport(cwd: string): Promise<void> {
  let skew: Awaited<ReturnType<typeof vgdVersionSkew>>;
  try {
    skew = await vgdVersionSkew();
  } catch {
    return; // best-effort: a daemon problem must not fail an update check
  }
  if (!skew.running || skew.state === 'match') return;
  if (skew.state === 'newer') {
    console.log(chalk.dim(`A newer vgd (${skew.version}) is running — left alone.`));
    return;
  }
  console.log(
    chalk.yellow('Stale daemon: ') +
      chalk.dim(
        `vgd is running ${skew.version ?? 'a build older than 2026.817'}, not ${VERSION} — restarting it on this build.`,
      ),
  );
  await restartVgdAndReport({ force: true });
  await rewarmVgdAndReport(cwd);
}

/**
 * Restart a running vgd so it picks up the just-installed build. Best-effort
 * and never throws — a daemon problem must not fail a successful update.
 * "Restarted"/"Started" are only printed once the build on the socket has been
 * verified as current (see `startDetachedVgd`) — never for whatever process
 * happened to answer ping.
 */
async function restartVgdAndReport(opts: { force?: boolean; startIfNotRunning?: boolean } = {}): Promise<void> {
  let result: Awaited<ReturnType<typeof restartVgdIfRunning>>;
  try {
    result = await restartVgdIfRunning(undefined, opts);
  } catch {
    return;
  }
  if (result === 'not-running') return; // nothing to restart, say nothing
  if (result === 'restarted') {
    console.log(chalk.dim('Restarted the vgd daemon on the new version.'));
  } else if (result === 'started') {
    console.log(chalk.dim('Started the vgd daemon on the new version.'));
  } else if (result === 'refused') {
    console.log(
      chalk.dim('A vgd that cannot be stopped remotely is running — restart the process holding the socket to pick up the update.'),
    );
  } else {
    console.log(
      chalk.dim('Could not restart the vgd daemon automatically — run "vg daemon restart" to pick up the update.'),
    );
  }
}

/**
 * Signal every running vg serve in `cwd`'s repo that is NOT on `keepVersion`,
 * and tell the user what happened. Best-effort and never throws — a reap
 * problem must not fail an otherwise-successful update.
 */
function reapAndReport(cwd: string, keepVersion: string): void {
  let reaped: ReapedServer[] = [];
  try {
    reaped = reapOtherVersionServers(liveStatsDir(cwd), keepVersion);
  } catch {
    return; // registry unreadable / no permission to signal — nothing to report
  }
  if (reaped.length === 0) return;
  const list = reaped.map((r) => `pid ${r.pid} (v${r.version})`).join(', ');
  console.log(
    chalk.dim(
      `Signalled ${reaped.length} running vg serve process${reaped.length === 1 ? '' : 'es'} on an older version to restart: ${list}.`,
    ),
  );
  console.log(
    chalk.dim(
      'Your editor/agent will respawn them on the new version. Restart your AI session if a server does not reconnect.',
    ),
  );
}
