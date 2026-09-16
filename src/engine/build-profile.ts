import * as os from 'node:os';

/**
 * Compose discover/parse limits for a build without starting work.
 *
 * Profiles are additive with explicit flags: a caller who already passed
 * `--only ts` or `--jobs 4` keeps those. The profile only fills gaps and
 * appends exclude globs.
 */

export const BUILD_PROFILES = ['lean', 'map', 'full'] as const;
export type BuildProfileName = (typeof BUILD_PROFILES)[number];

/** Languages that carry application structure. Markup/templating stays off
 * `--code-only` unless the caller named them in `--only`. */
export const CODE_ONLY_LANGS = [
  'ts',
  'tsx',
  'js',
  'py',
  'go',
  'java',
  'rust',
  'cs',
  'rb',
  'php',
  'kotlin',
  'swift',
  'scala',
  'dart',
  'lua',
  'ex',
  'sh',
  'zig',
  'c',
  'cpp',
  'objc',
  'ocaml',
  'rescript',
  'solidity',
  'vue',
  'svelte',
  'astro',
] as const;

export const TEST_EXCLUDE_GLOBS = [
  '**/*.{test,spec}.*',
  '**/__tests__/**',
  '**/__mocks__/**',
  'test/**',
  'tests/**',
  'runtime-tests/**',
  'integration/**',
] as const;

export const LEAN_EXCLUDE_GLOBS = [
  ...TEST_EXCLUDE_GLOBS,
  'docs/**',
  'examples/**',
  'example/**',
  'benchmarks/**',
  'benchmark/**',
  'fixtures/**',
] as const;

export interface BuildProfileInput {
  profile?: string;
  noTests?: boolean;
  codeOnly?: boolean;
  only?: string[];
  exclude?: string[];
  jobs?: number;
  analysisTier?: 'full' | 'large' | 'xl';
  /** Host facts; injected in tests. */
  totalmemBytes?: number;
  freememBytes?: number;
  /** When true, never auto-pick lean (user passed `--profile full`). */
  forceFull?: boolean;
}

export interface BuildProfilePlan {
  profile: BuildProfileName;
  only?: string[];
  exclude: string[];
  jobs?: number;
  analysisTier?: 'full' | 'large' | 'xl';
  fast: boolean;
  /** Auto-start vgd after the map is on disk. */
  autoStartDaemon: boolean;
  /** Publish the new map into a slot when attached. */
  publish: boolean;
  degradedFrom?: BuildProfileName;
  notice?: string;
}

const LOW_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
const LOW_FREE_BYTES = 1 * 1024 * 1024 * 1024;

export function parseBuildProfile(raw: string | undefined): BuildProfileName | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  return (BUILD_PROFILES as readonly string[]).includes(v) ? (v as BuildProfileName) : undefined;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Resolve the effective build plan. Pure: no I/O, no process mutation.
 */
export function resolveBuildProfile(input: BuildProfileInput = {}): BuildProfilePlan {
  const requested = parseBuildProfile(input.profile) ?? 'full';
  const total = input.totalmemBytes ?? os.totalmem();
  const free = input.freememBytes ?? os.freemem();
  const lowRam = total < LOW_TOTAL_BYTES || free < LOW_FREE_BYTES;

  let profile: BuildProfileName = requested;
  let degradedFrom: BuildProfileName | undefined;
  let notice: string | undefined;

  if (lowRam && requested === 'full' && !input.forceFull && !input.profile) {
    profile = 'lean';
    degradedFrom = 'full';
    notice = 'low memory: using lean profile (override with --profile full)';
  }

  const exclude = [...(input.exclude ?? [])];
  if (profile === 'lean' || profile === 'map' || input.noTests) {
    exclude.push(...(profile === 'full' && input.noTests ? TEST_EXCLUDE_GLOBS : profile === 'full' ? [] : LEAN_EXCLUDE_GLOBS));
  }
  if (profile === 'full' && input.noTests) {
    exclude.push(...TEST_EXCLUDE_GLOBS);
  }

  let only = input.only ? [...input.only] : undefined;
  if ((profile === 'lean' || input.codeOnly) && !only) {
    only = [...CODE_ONLY_LANGS];
  }

  let jobs = input.jobs;
  if (profile === 'lean') {
    jobs = 1;
  } else if (profile === 'map' && jobs == null) {
    jobs = Math.max(1, Math.min(2, Math.max(1, os.availableParallelism() - 1)));
  }
  if (lowRam && (jobs == null || jobs > 1) && profile !== 'full') {
    jobs = 1;
  }

  let analysisTier = input.analysisTier;
  if (!analysisTier && profile === 'lean') analysisTier = 'xl';
  if (!analysisTier && profile === 'map') analysisTier = 'large';

  const autoStartDaemon = profile === 'full';
  const publish = profile !== 'lean';

  return {
    profile,
    only,
    exclude: unique(exclude),
    jobs,
    analysisTier,
    fast: profile === 'lean',
    autoStartDaemon,
    publish,
    degradedFrom,
    notice,
  };
}
