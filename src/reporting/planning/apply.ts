import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlannedUpgrade } from './types.js';

/**
 * Applies a chosen plan by running each ecosystem's native package manager to
 * pin the target version — which edits the manifest AND installs in one step.
 * `--dry-run` prints the commands without executing. Ecosystems without a clean
 * one-shot pin command are reported as "manual", never silently skipped.
 */

/** The npm-family package manager detected for a project. */
export type NpmPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface UpgradeCommand {
  cmd: string;
  args: string[];
}

/**
 * Build the native command that pins `pkg` to `version` for an ecosystem. Pure
 * and exported for tests. Returns null for ecosystems with no clean one-shot pin
 * (java, hex) — those are reported as manual.
 */
export function pmCommandFor(
  ecosystem: string,
  pkg: string,
  version: string,
  pm: NpmPackageManager = 'npm',
  opts: { workspaceRoot?: boolean } = {},
): UpgradeCommand | null {
  switch (ecosystem) {
    case 'npm':
      // At a pnpm/yarn workspace ROOT the add must be explicit, or pnpm aborts
      // with ERR_PNPM_ADDING_TO_ROOT and yarn refuses the root add.
      if (pm === 'pnpm') return { cmd: 'pnpm', args: opts.workspaceRoot ? ['add', '-w', `${pkg}@${version}`] : ['add', `${pkg}@${version}`] };
      if (pm === 'yarn') return { cmd: 'yarn', args: opts.workspaceRoot ? ['add', '-W', `${pkg}@${version}`] : ['add', `${pkg}@${version}`] };
      if (pm === 'bun') return { cmd: 'bun', args: ['add', `${pkg}@${version}`] };
      return { cmd: 'npm', args: ['install', `${pkg}@${version}`] };
    case 'pypi':
      return { cmd: 'pip', args: ['install', `${pkg}==${version}`] };
    case 'cargo':
      return { cmd: 'cargo', args: ['add', `${pkg}@${version}`] };
    case 'go':
      return { cmd: 'go', args: ['get', `${pkg}@${version.startsWith('v') ? version : `v${version}`}`] };
    case 'composer':
      return { cmd: 'composer', args: ['require', `${pkg}:${version}`] };
    case 'nuget':
      return { cmd: 'dotnet', args: ['add', 'package', pkg, '--version', version] };
    case 'dotnet':
      return { cmd: 'dotnet', args: ['add', 'package', pkg, '--version', version] };
    case 'dart':
    case 'pub':
      return { cmd: 'dart', args: ['pub', 'add', `${pkg}:${version}`] };
    case 'rubygems':
    case 'ruby':
      // Bundler has no clean per-gem pin via CLI; update within the Gemfile's
      // constraint (best-effort). A hard pin needs a manual Gemfile edit.
      return { cmd: 'bundle', args: ['update', pkg] };
    default:
      return null; // java (maven/gradle), hex, swift → manual
  }
}

export interface AppliedUpgrade {
  package: string;
  to: string | null;
  status: 'applied' | 'failed' | 'manual' | 'skipped';
  detail?: string;
}

export interface RunResult {
  ok: boolean;
  detail?: string;
  /** The package-manager binary was not found on PATH (report as manual, not failed). */
  toolMissing?: boolean;
}

export interface ApplyOptions {
  dryRun?: boolean;
  /** npm-family package manager for npm upgrades (from the scan). */
  packageManager?: NpmPackageManager;
  /** Runner override for tests. */
  run?: (cmd: UpgradeCommand, cwd: string) => RunResult;
}

function defaultRun(cmd: UpgradeCommand, cwd: string): RunResult {
  const res = spawnSync(cmd.cmd, cmd.args, { cwd, stdio: 'inherit', shell: false });
  if (res.error) {
    // ENOENT = the toolchain (cargo, pip, go, …) isn't installed here. That's an
    // environment gap the user must resolve, not an upgrade that "failed".
    if ((res.error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, toolMissing: true, detail: `${cmd.cmd} is not installed or not on PATH` };
    }
    return { ok: false, detail: res.error.message };
  }
  if (res.status !== 0) return { ok: false, detail: `exit ${res.status ?? 'signal'}` };
  return { ok: true };
}

/** Is `dir` a package-manager workspace root (so an `add` there needs -w/-W)? */
function isWorkspaceRoot(dir: string): boolean {
  try {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return true;
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { workspaces?: unknown };
      if (pkg?.workspaces) return true;
    }
  } catch {
    /* best-effort: treat as non-workspace */
  }
  return false;
}

/** Apply a plan's upgrades. Returns per-package outcomes (nothing is silently dropped). */
export function applyPlan(rootDir: string, upgrades: PlannedUpgrade[], opts: ApplyOptions = {}): AppliedUpgrade[] {
  const run = opts.run ?? defaultRun;
  const workspaceRoot = isWorkspaceRoot(rootDir);
  const results: AppliedUpgrade[] = [];
  for (const u of upgrades) {
    if (!u.to) {
      results.push({ package: u.package, to: u.to, status: 'skipped', detail: 'no target version' });
      continue;
    }
    const command = pmCommandFor(u.ecosystem, u.package, u.to, opts.packageManager, { workspaceRoot });
    if (!command) {
      results.push({ package: u.package, to: u.to, status: 'manual', detail: `${u.ecosystem}: update the manifest to ${u.to} manually` });
      continue;
    }
    if (opts.dryRun) {
      results.push({ package: u.package, to: u.to, status: 'skipped', detail: `would run: ${command.cmd} ${command.args.join(' ')}` });
      continue;
    }
    const outcome = run(command, rootDir);
    results.push({
      package: u.package,
      to: u.to,
      status: outcome.ok ? 'applied' : outcome.toolMissing ? 'manual' : 'failed',
      detail: outcome.toolMissing && outcome.detail ? `${outcome.detail} — upgrade manually` : outcome.detail,
    });
  }
  return results;
}
