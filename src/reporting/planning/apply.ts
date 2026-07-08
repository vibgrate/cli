import { spawnSync } from 'node:child_process';
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
): UpgradeCommand | null {
  switch (ecosystem) {
    case 'npm':
      if (pm === 'pnpm') return { cmd: 'pnpm', args: ['add', `${pkg}@${version}`] };
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

export interface ApplyOptions {
  dryRun?: boolean;
  /** npm-family package manager for npm upgrades (from the scan). */
  packageManager?: NpmPackageManager;
  /** Runner override for tests. */
  run?: (cmd: UpgradeCommand, cwd: string) => { ok: boolean; detail?: string };
}

function defaultRun(cmd: UpgradeCommand, cwd: string): { ok: boolean; detail?: string } {
  const res = spawnSync(cmd.cmd, cmd.args, { cwd, stdio: 'inherit', shell: false });
  if (res.error) return { ok: false, detail: res.error.message };
  if (res.status !== 0) return { ok: false, detail: `exit ${res.status ?? 'signal'}` };
  return { ok: true };
}

/** Apply a plan's upgrades. Returns per-package outcomes (nothing is silently dropped). */
export function applyPlan(rootDir: string, upgrades: PlannedUpgrade[], opts: ApplyOptions = {}): AppliedUpgrade[] {
  const run = opts.run ?? defaultRun;
  const results: AppliedUpgrade[] = [];
  for (const u of upgrades) {
    if (!u.to) {
      results.push({ package: u.package, to: u.to, status: 'skipped', detail: 'no target version' });
      continue;
    }
    const command = pmCommandFor(u.ecosystem, u.package, u.to, opts.packageManager);
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
      status: outcome.ok ? 'applied' : 'failed',
      detail: outcome.detail,
    });
  }
  return results;
}
