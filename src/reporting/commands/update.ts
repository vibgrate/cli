import { execSync } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as readline from 'node:readline';
import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { VERSION } from '../version.js';
import { fetchLatestVersion } from '../utils/update-check.js';
import { pathExists } from '../utils/fs.js';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

const PACKAGE_NAME = '@vibgrate/cli';

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

function getGlobalUpdateCommand(pm: PackageManager, pkg: string, version: string): string {
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
      return `npm install -g ${spec}`;
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
    default:
      return isDev ? `npm install --save-dev ${spec}` : `npm install ${spec}`;
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
  if (!(process.stdin.isTTY && process.stdout.isTTY)) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(chalk.yellow(`Update the ${pm} workspace root with -w? [y/N]: `), (ans) => {
      rl.close();
      const t = ans.trim().toLowerCase();
      resolve(t === 'y' || t === 'yes');
    });
  });
}

export const updateCommand = new Command('update')
  .description('Update vibgrate to the latest version')
  .option('--check', 'Only check for updates, do not install')
  .option('--pm <manager>', 'Package manager to use (npm, pnpm, yarn, bun)')
  .option('--global', 'Update global installation')
  .option('-y, --yes', 'Skip confirmation prompts (e.g. installing at a workspace root)')
  .option('-w, --workspace-root', 'Allow updating the pnpm workspace root (implies --yes for that prompt)')
  .action(
    async (opts: {
      check?: boolean;
      pm?: string;
      global?: boolean;
      yes?: boolean;
      workspaceRoot?: boolean;
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
        return;
      }

      console.log(chalk.yellow(`Update available: ${VERSION} → ${latest}`));

      if (opts.check) {
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

      try {
        execSync(cmd, { cwd, stdio: 'inherit' });
        console.log(chalk.green('✔') + ` Updated to ${PACKAGE_NAME}@${latest}`);
      } catch {
        console.error(chalk.red(`Update failed. Run manually: ${cmd}`));
        process.exit(1);
      }
    },
  );
