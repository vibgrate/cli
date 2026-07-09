import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import type { PlannedUpgrade } from './types.js';

/**
 * Applies a chosen plan by running each ecosystem's native package manager to
 * pin the target version — which edits the manifest AND installs in one step.
 * `--dry-run` prints the commands without executing. Ecosystems without a clean
 * one-shot pin command are reported as "manual", never silently skipped.
 *
 * In a monorepo, a dependency lives in a specific workspace package's manifest,
 * not necessarily the repo root. Running the pin command at the root would edit
 * the wrong `package.json` (and pnpm refuses a bare `pnpm add` at a workspace
 * root: ERR_PNPM_ADDING_TO_ROOT). So callers resolve each upgrade to the
 * workspace package(s) that own it and we run the command in that package's
 * directory. Only when a dependency is declared in the root manifest of a pnpm
 * workspace do we add `-w`.
 */

/** The npm-family package manager detected for a project. */
export type NpmPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface UpgradeCommand {
  cmd: string;
  args: string[];
}

/**
 * A manifest that owns an upgrade, as a directory relative to the repo root
 * (`'.'` or `''` = the root manifest).
 */
export interface WorkspaceTarget {
  /** Directory of the owning manifest, relative to the repo root. */
  dir: string;
  /**
   * True only when `dir` is the root of a pnpm workspace — the one case where
   * `pnpm add` needs `-w`. Workspace *members* never need it.
   */
  isWorkspaceRoot: boolean;
}

/** A `dir` referring to the repo root rather than a nested workspace package. */
function isRootDir(dir: string): boolean {
  return dir === '' || dir === '.';
}

export interface PmCommandOptions {
  /** When true and the package manager is pnpm, add the `-w` workspace-root flag. */
  workspaceRoot?: boolean;
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
  opts: PmCommandOptions = {},
): UpgradeCommand | null {
  // Only pnpm needs an explicit flag to write the workspace-root manifest.
  const ws = opts.workspaceRoot && pm === 'pnpm' ? ['-w'] : [];
  switch (ecosystem) {
    case 'npm':
      if (pm === 'pnpm') return { cmd: 'pnpm', args: ['add', ...ws, `${pkg}@${version}`] };
      if (pm === 'yarn') return { cmd: 'yarn', args: ['add', `${pkg}@${version}`] };
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
  /**
   * Resolve which workspace manifest(s) own an upgrade, so the pin command runs
   * in the right directory instead of blindly at the repo root. Returns the
   * owning targets; an empty array falls back to the root manifest. Defaults to
   * a single root target (repo-root install, no `-w`).
   */
  resolveTargets?: (upgrade: PlannedUpgrade) => WorkspaceTarget[];
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

const ROOT_TARGET: WorkspaceTarget[] = [{ dir: '.', isWorkspaceRoot: false }];

/** Apply a plan's upgrades. Returns per-package outcomes (nothing is silently dropped). */
export function applyPlan(rootDir: string, upgrades: PlannedUpgrade[], opts: ApplyOptions = {}): AppliedUpgrade[] {
  const run = opts.run ?? defaultRun;
  const resolveTargets = opts.resolveTargets ?? (() => ROOT_TARGET);
  const results: AppliedUpgrade[] = [];
  for (const u of upgrades) {
    if (!u.to) {
      results.push({ package: u.package, to: u.to, status: 'skipped', detail: 'no target version' });
      continue;
    }
    // Probe ecosystem support once (it never varies by target directory).
    if (!pmCommandFor(u.ecosystem, u.package, u.to, opts.packageManager)) {
      results.push({ package: u.package, to: u.to, status: 'manual', detail: `${u.ecosystem}: update the manifest to ${u.to} manually` });
      continue;
    }
    const targets = resolveTargets(u);
    const effective = targets.length > 0 ? targets : ROOT_TARGET;
    // Only tag a directory when disambiguation matters (a nested package, or
    // more than one owner) so single-root results read cleanly.
    const labelled = effective.length > 1;
    const where = (t: WorkspaceTarget) => (labelled || !isRootDir(t.dir) ? `${t.dir || '.'}: ` : '');

    if (opts.dryRun) {
      const detail = effective
        .map((t) => {
          const c = pmCommandFor(u.ecosystem, u.package, u.to as string, opts.packageManager, { workspaceRoot: t.isWorkspaceRoot });
          return `would run: ${c!.cmd} ${c!.args.join(' ')}${labelled || !isRootDir(t.dir) ? ` (in ${t.dir || '.'})` : ''}`;
        })
        .join('; ');
      results.push({ package: u.package, to: u.to, status: 'skipped', detail });
      continue;
    }
    const outcomes = effective.map((t) => {
      const c = pmCommandFor(u.ecosystem, u.package, u.to as string, opts.packageManager, { workspaceRoot: t.isWorkspaceRoot });
      return { t, res: run(c!, path.join(rootDir, t.dir)) };
    });
    const failures = outcomes.filter((o) => !o.res.ok);
    if (failures.length === 0) {
      results.push({
        package: u.package,
        to: u.to,
        status: 'applied',
        detail: labelled ? `applied in ${effective.map((t) => t.dir || '.').join(', ')}` : undefined,
      });
    } else if (failures.every((o) => o.res.toolMissing)) {
      // The toolchain (cargo, pip, go, …) isn't installed here — an environment
      // gap for the user to resolve, not an upgrade that "failed". Report manual.
      results.push({
        package: u.package,
        to: u.to,
        status: 'manual',
        detail: failures.map((o) => `${where(o.t)}${o.res.detail ?? 'tool missing'} — upgrade manually`).join('; '),
      });
    } else {
      results.push({
        package: u.package,
        to: u.to,
        status: 'failed',
        detail: failures.map((o) => `${where(o.t)}${o.res.detail ?? 'failed'}`).join('; '),
      });
    }
  }
  return results;
}
