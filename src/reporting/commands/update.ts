import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { VERSION } from '../version.js';
import { fetchLatestVersion } from '../utils/update-check.js';
import { pathExists } from '../utils/fs.js';

type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

/**
 * Check if the CLI is installed globally by examining where it's running from.
 * Returns the package manager if global, null if local.
 */
function detectGlobalInstall(): PackageManager | null {
  const execPath = process.argv[1] || '';
  // Global npm installs are typically in /usr/local/lib/node_modules or similar
  // Global pnpm installs are in ~/.local/share/pnpm or similar
  if (execPath.includes('/lib/node_modules/') || execPath.includes('\\node_modules\\')) {
    // Could be local or global node_modules - check for project markers
    if (!execPath.includes(process.cwd())) {
      // Not in current directory - likely global
      if (execPath.includes('pnpm')) return 'pnpm';
      if (execPath.includes('yarn')) return 'yarn';
      if (execPath.includes('bun')) return 'bun';
      return 'npm';
    }
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
async function detectPackageManager(cwd: string): Promise<PackageManager> {
  if (await pathExists(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await pathExists(path.join(cwd, 'bun.lockb'))) return 'bun';
  if (await pathExists(path.join(cwd, 'yarn.lock'))) return 'yarn';
  return 'npm'; // default
}

function getInstallCommand(pm: PackageManager, pkg: string, version: string, isDev: boolean): string {
  const spec = `${pkg}@${version}`;
  switch (pm) {
    case 'pnpm':
      return isDev ? `pnpm add -D ${spec}` : `pnpm add ${spec}`;
    case 'yarn':
      return isDev ? `yarn add --dev ${spec}` : `yarn add ${spec}`;
    case 'bun':
      return isDev ? `bun add -d ${spec}` : `bun add ${spec}`;
    case 'npm':
    default:
      return isDev ? `npm install --save-dev ${spec}` : `npm install ${spec}`;
  }
}

/**
 * Check if vibgrate is a devDependency (vs dependency) in the project's package.json.
 */
async function isDevDependency(cwd: string): Promise<boolean> {
  try {
    const pkgPath = path.join(cwd, 'package.json');
    const raw = await (await import('node:fs/promises')).readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as Record<string, Record<string, string>>;
    return Boolean(pkg.devDependencies?.['@vibgrate/cli']);
  } catch {
    return true; // default to devDep for CLI tools
  }
}

export const updateCommand = new Command('update')
  .description('Update vibgrate to the latest version')
  .option('--check', 'Only check for updates, do not install')
  .option('--pm <manager>', 'Package manager to use (npm, pnpm, yarn, bun)')
  .option('--global', 'Update global installation')
  .action(async (opts: { check?: boolean; pm?: string; global?: boolean }) => {
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
      console.log(chalk.dim('Run "vibgrate update" to install.'));
      return;
    }

    const cwd = process.cwd();
    
    // Detect if running from a global install or explicitly requested global update
    const globalPm = detectGlobalInstall();
    const isGlobal = opts.global || globalPm !== null;
    
    const pm: PackageManager = (opts.pm as PackageManager) || (globalPm ?? await detectPackageManager(cwd));
    
    let cmd: string;
    if (isGlobal) {
      cmd = getGlobalUpdateCommand(pm, '@vibgrate/cli', latest);
      console.log(chalk.dim(`Updating global installation with ${pm}: ${cmd}`));
    } else {
      const isDev = await isDevDependency(cwd);
      cmd = getInstallCommand(pm, '@vibgrate/cli', latest, isDev);
      console.log(chalk.dim(`Using ${pm}: ${cmd}`));
    }

    try {
      execSync(cmd, { cwd, stdio: 'inherit' });
      console.log(chalk.green('✔') + ` Updated to @vibgrate/cli@${latest}`);
    } catch {
      console.error(chalk.red(`Update failed. Run manually: ${cmd}`));
      process.exit(1);
    }
  });
