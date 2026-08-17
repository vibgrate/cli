import type { GraphNode } from '../../schema.js';
import { toPosix } from './util.js';
import type { ToolchainFormat } from './types.js';

/**
 * `ProjectProfile` — Phase 2.2.
 *
 * A first-class, deterministic answer to *"what kind of project is this?"*.
 *
 * This is **not** `core-open/scanners/project-classification.ts`, despite the
 * similar name: that module sizes a package into a billing tier
 * (nano/micro/small/standard) and has nothing to say about what the project
 * *is*. Identity signals were previously scattered across `platform-matrix.ts`,
 * `tooling-inventory.ts` and `build-deploy.ts`, each computing a slice for its
 * own report section and none of them addressable as a whole. This type is the
 * whole.
 *
 * Everything here is derived from evidence already in the graph — declared
 * manifests, discovered toolchain files, extracted structure. Nothing is
 * guessed, and every field is reproducible from the same corpus.
 */

export interface ProjectProfile {
  /** Source languages present, by node count, most-used first. */
  languages: { id: string; nodes: number }[];
  /** Package managers with a manifest in the tree, sorted. */
  packageManagers: string[];
  /** CI systems with a configuration file present, sorted. */
  ciSystems: string[];
  /** Infrastructure-as-code tooling in use, sorted. */
  iac: string[];
  /** Container/orchestration surfaces in use, sorted. */
  containers: string[];
  /** Monorepo tool, when one is declared. */
  monorepo?: string;
  /** Deploy targets named by a platform config file, sorted. */
  deployTargets: string[];
  /** Service topology extracted from Compose/Kubernetes. */
  services: { name: string; source: ToolchainFormat; file: string }[];
  /** Structural counts, for a one-line summary. */
  counts: {
    workloads: number;
    resources: number;
    ciJobs: number;
    images: number;
    charts: number;
  };
  /**
   * A short deterministic description, e.g.
   * `"TypeScript + Python monorepo (pnpm, turbo) with GitHub Actions,
   *   Terraform, and 4 Kubernetes workloads"`. Template-rendered from the
   * fields above — no model involved, so it is reproducible and offline.
   */
  summary: string;
}

/** Manifest basename → package manager. */
const PACKAGE_MANAGER_FILES: Record<string, string> = {
  'package.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'bun.lockb': 'bun',
  'package-lock.json': 'npm',
  'requirements.txt': 'pip',
  'pyproject.toml': 'python',
  pipfile: 'pipenv',
  'poetry.lock': 'poetry',
  'go.mod': 'go modules',
  'cargo.toml': 'cargo',
  gemfile: 'bundler',
  'composer.json': 'composer',
  'pom.xml': 'maven',
  'build.gradle': 'gradle',
  'build.gradle.kts': 'gradle',
  'pubspec.yaml': 'pub',
  'mix.exs': 'hex',
  'package.swift': 'swiftpm',
};

/** Path pattern → CI system. */
const CI_PATTERNS: [RegExp, string][] = [
  [/(^|\/)\.github\/workflows\//i, 'GitHub Actions'],
  [/(^|\/)\.gitlab-ci\.ya?ml$/i, 'GitLab CI'],
  [/(^|\/)azure-pipelines\.ya?ml$/i, 'Azure Pipelines'],
  [/(^|\/)bitbucket-pipelines\.ya?ml$/i, 'Bitbucket Pipelines'],
  [/(^|\/)Jenkinsfile$/i, 'Jenkins'],
  [/(^|\/)\.circleci\/config\.ya?ml$/i, 'CircleCI'],
  [/(^|\/)\.travis\.ya?ml$/i, 'Travis CI'],
  [/(^|\/)cloudbuild\.ya?ml$/i, 'Cloud Build'],
];

/** Path pattern → deploy target. */
const DEPLOY_TARGET_PATTERNS: [RegExp, string][] = [
  [/(^|\/)vercel\.json$/i, 'Vercel'],
  [/(^|\/)netlify\.toml$/i, 'Netlify'],
  [/(^|\/)wrangler\.(toml|jsonc?)$/i, 'Cloudflare Workers'],
  [/(^|\/)fly\.toml$/i, 'Fly.io'],
  [/(^|\/)railway\.toml$/i, 'Railway'],
  [/(^|\/)render\.ya?ml$/i, 'Render'],
  [/(^|\/)app\.yaml$/i, 'App Engine'],
  [/(^|\/)Procfile$/i, 'Heroku'],
  [/(^|\/)serverless\.ya?ml$/i, 'Serverless Framework'],
  [/(^|\/)sam\.ya?ml$/i, 'AWS SAM'],
  [/(^|\/)cdk\.json$/i, 'AWS CDK'],
  [/(^|\/)pulumi\.ya?ml$/i, 'Pulumi'],
];

/** Monorepo marker → tool. */
const MONOREPO_FILES: Record<string, string> = {
  'pnpm-workspace.yaml': 'pnpm workspaces',
  'lerna.json': 'Lerna',
  'nx.json': 'Nx',
  'turbo.json': 'Turborepo',
  'rush.json': 'Rush',
};

export interface ProfileInput {
  /** Every node in the graph — code and toolchain alike. */
  nodes: GraphNode[];
  /** Repo-relative paths of every discovered file (source + docs + toolchain). */
  files: string[];
}

/** Build the profile. Pure: same corpus in → identical profile out. */
export function buildProjectProfile(input: ProfileInput): ProjectProfile {
  const files = input.files.map(toPosix);
  const basenames = new Map<string, number>();
  for (const file of files) {
    const base = (file.split('/').pop() ?? '').toLowerCase();
    basenames.set(base, (basenames.get(base) ?? 0) + 1);
  }

  // ── Languages: node counts per source language ──────────────────────────
  const toolchainLangs = new Set<string>([
    'terraform',
    'kubernetes',
    'helm',
    'compose',
    'dockerfile',
    'github-actions',
    'gitlab-ci',
  ]);
  const languageCounts = new Map<string, number>();
  for (const node of input.nodes) {
    // Only real source languages count towards "what is this written in".
    if (!node.lang || toolchainLangs.has(node.lang)) continue;
    if (node.kind === 'document' || node.kind === 'external') continue;
    languageCounts.set(node.lang, (languageCounts.get(node.lang) ?? 0) + 1);
  }
  const languages = [...languageCounts.entries()]
    .map(([id, nodes]) => ({ id, nodes }))
    // Count descending, then id ascending so ties are stable.
    .sort((a, b) => b.nodes - a.nodes || a.id.localeCompare(b.id, 'en'));

  // ── Declared tooling, from file presence ────────────────────────────────
  const packageManagers = new Set<string>();
  for (const [file, manager] of Object.entries(PACKAGE_MANAGER_FILES)) {
    if (basenames.has(file)) packageManagers.add(manager);
  }

  const ciSystems = new Set<string>();
  const deployTargets = new Set<string>();
  for (const file of files) {
    for (const [pattern, system] of CI_PATTERNS) if (pattern.test(file)) ciSystems.add(system);
    for (const [pattern, target] of DEPLOY_TARGET_PATTERNS) {
      if (pattern.test(file)) deployTargets.add(target);
    }
  }

  let monorepo: string | undefined;
  for (const [file, tool] of Object.entries(MONOREPO_FILES)) {
    if (basenames.has(file)) {
      monorepo = tool;
      break;
    }
  }

  // ── Structure, from the extracted toolchain nodes ───────────────────────
  const iac = new Set<string>();
  const containers = new Set<string>();
  const services: ProjectProfile['services'] = [];
  const counts = { workloads: 0, resources: 0, ciJobs: 0, images: 0, charts: 0 };

  for (const node of input.nodes) {
    switch (node.lang) {
      case 'terraform':
        iac.add('Terraform');
        break;
      case 'helm':
        iac.add('Helm');
        containers.add('Kubernetes');
        break;
      case 'kubernetes':
        containers.add('Kubernetes');
        break;
      case 'compose':
        containers.add('Docker Compose');
        break;
      case 'dockerfile':
        containers.add('Docker');
        break;
      default:
        break;
    }

    switch (node.kind) {
      case 'workload':
        counts.workloads++;
        services.push({
          name: node.name,
          source: (node.lang as ToolchainFormat) ?? 'kubernetes',
          file: node.file,
        });
        break;
      case 'resource':
        counts.resources++;
        if (node.signature === 'compose.service') {
          services.push({ name: node.name, source: 'compose', file: node.file });
        }
        break;
      case 'job':
        counts.ciJobs++;
        break;
      case 'image':
        counts.images++;
        break;
      case 'chart':
        counts.charts++;
        break;
      default:
        break;
    }
  }

  const profile: ProjectProfile = {
    languages,
    packageManagers: [...packageManagers].sort(),
    ciSystems: [...ciSystems].sort(),
    iac: [...iac].sort(),
    containers: [...containers].sort(),
    monorepo,
    deployTargets: [...deployTargets].sort(),
    services: services.sort(
      (a, b) => a.file.localeCompare(b.file, 'en') || a.name.localeCompare(b.name, 'en'),
    ),
    counts,
    summary: '',
  };
  profile.summary = renderSummary(profile);
  return profile;
}

/**
 * Deterministic, template-rendered summary — the "human description" layer,
 * with no model involved. Reads as a sentence a maintainer would recognise.
 */
function renderSummary(profile: ProjectProfile): string {
  const parts: string[] = [];

  // "TypeScript + Python project" / "… monorepo (pnpm workspaces)"
  const topLanguages = profile.languages.slice(0, 3).map((l) => l.id);
  const noun = profile.monorepo ? 'monorepo' : 'project';
  const lead = topLanguages.length ? `${topLanguages.join(' + ')} ${noun}` : `${noun}`;
  parts.push(profile.monorepo ? `${lead} (${profile.monorepo})` : lead);

  if (profile.packageManagers.length) parts.push(`built with ${list(profile.packageManagers)}`);
  if (profile.ciSystems.length) parts.push(`CI on ${list(profile.ciSystems)}`);
  if (profile.iac.length) parts.push(`infrastructure in ${list(profile.iac)}`);

  if (profile.counts.workloads) {
    parts.push(
      `${profile.counts.workloads} Kubernetes workload${profile.counts.workloads === 1 ? '' : 's'}`,
    );
  } else if (profile.containers.length) {
    parts.push(list(profile.containers));
  }

  if (profile.deployTargets.length) parts.push(`deploying to ${list(profile.deployTargets)}`);

  return parts.join(', ');
}

/** `a`, `a and b`, `a, b and c`. */
function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
