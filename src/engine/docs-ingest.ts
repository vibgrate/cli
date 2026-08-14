/**
 * Project-context ingest for semantic `vg ask` (Fusion robustness).
 *
 * Turns non-AST project files into graph nodes of kind `document` so agents can
 * answer the questions developers ask most often without grepping the tree:
 *
 *   - Human docs: README, AGENTS.md, markdown/txt
 *   - Env *examples* only (never live `.env`)
 *   - Package manifests (package.json, go.mod, Cargo.toml, …)
 *   - Docker / Compose
 *   - CI workflows
 *   - Build/tool config (tsconfig, turbo, vite, …)
 *   - API contracts (OpenAPI, GraphQL, protobuf)
 *   - Task runners (Makefile, Justfile)
 *
 * Bodies are secret-scrubbed and size-capped. Lockfiles and live secrets stay
 * out. Pure classification helpers are unit-tested; discovery respects the same
 * SKIP_DIRS / .gitignore rules as source discovery.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { redactSecrets } from '../core-open/utils/redact.js';
import { nodeId } from './ids.js';
import { isSkippedDirName, SKIP_FILES } from './discover.js';
import type { GraphNode } from '../schema.js';

/** Soft cap on characters stored/embedded per document (keeps index snappy). */
export const DOC_BODY_MAX_CHARS = 8_000;
/** Hard cap on bytes we will open for a context file. */
export const DOC_FILE_MAX_BYTES = 512 * 1024;
/** Soft cap on document nodes per build (large monorepos). */
export const DOC_MAX_FILES = 600;

// ── Document categories (signature / lang / importance) ────────────────────

export type DocCategory =
  | 'markdown'
  | 'text'
  | 'env-example'
  | 'manifest'
  | 'docker'
  | 'compose'
  | 'ci'
  | 'build-config'
  | 'api-contract'
  | 'task-runner'
  | 'workspace'
  | 'infra'
  | 'other-config';

export interface DiscoverDocsOptions {
  root: string;
  exclude?: string[];
  paths?: string[];
  maxFiles?: number;
}

export interface DiscoveredDoc {
  rel: string;
  abs: string;
  /** @deprecated use category — kept as alias of category for older tests */
  kind: DocCategory;
  category: DocCategory;
}

// Human documentation
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc']);

// Env *examples* only
const ENV_EXAMPLE_NAMES = new Set([
  'example.env',
  'env.example',
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.development.example',
  '.env.local.example',
  'dotenv.example',
]);

// Exact basenames → category (lowercase)
const EXACT_BASENAME: Record<string, DocCategory> = {
  // Manifests / package managers
  'package.json': 'manifest',
  'package.yaml': 'manifest',
  'package.yml': 'manifest',
  'pyproject.toml': 'manifest',
  'setup.cfg': 'manifest',
  'requirements.txt': 'manifest',
  'requirements-dev.txt': 'manifest',
  'pipfile': 'manifest',
  'go.mod': 'manifest',
  'go.work': 'manifest',
  'cargo.toml': 'manifest',
  'composer.json': 'manifest',
  'gemfile': 'manifest',
  'podfile': 'manifest',
  'pubspec.yaml': 'manifest',
  'mix.exs': 'manifest',
  'build.gradle': 'manifest',
  'build.gradle.kts': 'manifest',
  'settings.gradle': 'manifest',
  'settings.gradle.kts': 'manifest',
  'pom.xml': 'manifest',
  'project.clj': 'manifest',
  'stack.yaml': 'manifest',
  'package.swift': 'manifest',
  // Workspace / monorepo
  'pnpm-workspace.yaml': 'workspace',
  'pnpm-workspace.yml': 'workspace',
  'lerna.json': 'workspace',
  'nx.json': 'workspace',
  'turbo.json': 'workspace',
  'rush.json': 'workspace',
  'workspace.json': 'workspace',
  // Docker
  dockerfile: 'docker',
  'dockerfile.dev': 'docker',
  'dockerfile.prod': 'docker',
  'dockerfile.local': 'docker',
  containerfile: 'docker',
  // Compose
  'docker-compose.yml': 'compose',
  'docker-compose.yaml': 'compose',
  'compose.yml': 'compose',
  'compose.yaml': 'compose',
  'docker-compose.dev.yml': 'compose',
  'docker-compose.prod.yml': 'compose',
  'docker-compose.override.yml': 'compose',
  // Task runners
  makefile: 'task-runner',
  gnumakefile: 'task-runner',
  justfile: 'task-runner',
  'taskfile.yml': 'task-runner',
  'taskfile.yaml': 'task-runner',
  rakefile: 'task-runner',
  // Build / tool config (exact)
  'tsconfig.json': 'build-config',
  'jsconfig.json': 'build-config',
  'vite.config.ts': 'build-config',
  'vite.config.js': 'build-config',
  'vite.config.mjs': 'build-config',
  'vitest.config.ts': 'build-config',
  'vitest.config.js': 'build-config',
  'jest.config.js': 'build-config',
  'jest.config.ts': 'build-config',
  'jest.config.cjs': 'build-config',
  'webpack.config.js': 'build-config',
  'webpack.config.ts': 'build-config',
  'rollup.config.js': 'build-config',
  'esbuild.config.js': 'build-config',
  'next.config.js': 'build-config',
  'next.config.mjs': 'build-config',
  'next.config.ts': 'build-config',
  'nuxt.config.ts': 'build-config',
  'nuxt.config.js': 'build-config',
  'astro.config.mjs': 'build-config',
  'svelte.config.js': 'build-config',
  'remix.config.js': 'build-config',
  'angular.json': 'build-config',
  'babel.config.js': 'build-config',
  'babel.config.json': 'build-config',
  '.babelrc': 'build-config',
  '.babelrc.js': 'build-config',
  '.babelrc.json': 'build-config',
  'eslint.config.js': 'build-config',
  'eslint.config.mjs': 'build-config',
  'eslint.config.cjs': 'build-config',
  'eslint.config.ts': 'build-config',
  '.eslintrc': 'build-config',
  '.eslintrc.js': 'build-config',
  '.eslintrc.cjs': 'build-config',
  '.eslintrc.json': 'build-config',
  '.eslintrc.yml': 'build-config',
  '.prettierrc': 'build-config',
  '.prettierrc.js': 'build-config',
  '.prettierrc.json': 'build-config',
  '.prettierrc.yml': 'build-config',
  'prettier.config.js': 'build-config',
  'prettier.config.cjs': 'build-config',
  'ruff.toml': 'build-config',
  '.ruff.toml': 'build-config',
  'pytest.ini': 'build-config',
  'tox.ini': 'build-config',
  'mypy.ini': 'build-config',
  '.mypy.ini': 'build-config',
  'phpunit.xml': 'build-config',
  'phpunit.xml.dist': 'build-config',
  // CI exact
  'jenkinsfile': 'ci',
  '.gitlab-ci.yml': 'ci',
  '.travis.yml': 'ci',
  'azure-pipelines.yml': 'ci',
  'buildkite.yml': 'ci',
  'cloudbuild.yaml': 'ci',
  'appveyor.yml': 'ci',
  'circle.yml': 'ci',
  // Deploy / infra (root-level common names)
  'vercel.json': 'infra',
  'netlify.toml': 'infra',
  'wrangler.toml': 'infra',
  'wrangler.json': 'infra',
  'wrangler.jsonc': 'infra',
  'fly.toml': 'infra',
  'railway.toml': 'infra',
  'render.yaml': 'infra',
  'app.yaml': 'infra',
  'Procfile': 'infra',
  'procfile': 'infra',
  'heroku.yml': 'infra',
  'serverless.yml': 'infra',
  'serverless.yaml': 'infra',
  'sam.yaml': 'infra',
  'samconfig.toml': 'infra',
  'cdk.json': 'infra',
  'pulumi.yaml': 'infra',
  'terraform.tf': 'infra',
  // Agent / project meta (also covered by .md extension)
  'agents.md': 'markdown',
  'claude.md': 'markdown',
  'codeowners': 'other-config',
  '.nvmrc': 'other-config',
  '.node-version': 'other-config',
  '.python-version': 'other-config',
  'runtime.txt': 'other-config',
  '.tool-versions': 'other-config',
  'editorconfig': 'other-config',
  '.editorconfig': 'other-config',
};

// Prefix / pattern basenames
const BASENAME_PREFIX: Array<{ re: RegExp; category: DocCategory }> = [
  { re: /^dockerfile(\.|$)/i, category: 'docker' },
  { re: /^docker-compose(\.|$)/i, category: 'compose' },
  { re: /^compose\.(ya?ml)$/i, category: 'compose' },
  { re: /^tsconfig(\..+)?\.json$/i, category: 'build-config' },
  { re: /^jsconfig(\..+)?\.json$/i, category: 'build-config' },
  { re: /^vite\.config\./i, category: 'build-config' },
  { re: /^vitest\.config\./i, category: 'build-config' },
  { re: /^jest\.config\./i, category: 'build-config' },
  { re: /^webpack\.config\./i, category: 'build-config' },
  { re: /^rollup\.config\./i, category: 'build-config' },
  { re: /^next\.config\./i, category: 'build-config' },
  { re: /^nuxt\.config\./i, category: 'build-config' },
  { re: /^astro\.config\./i, category: 'build-config' },
  { re: /^eslint\.config\./i, category: 'build-config' },
  { re: /^\.eslintrc/i, category: 'build-config' },
  { re: /^openapi\./i, category: 'api-contract' },
  { re: /^swagger\./i, category: 'api-contract' },
  { re: /^requirements(-\w+)?\.txt$/i, category: 'manifest' },
  { re: /^dockerfile/i, category: 'docker' },
];

// Path patterns (posix relative)
const PATH_PATTERNS: Array<{ re: RegExp; category: DocCategory }> = [
  // GitHub Actions / workflows
  { re: /^\.github\/workflows\/.+\.ya?ml$/i, category: 'ci' },
  { re: /^\.github\/actions\/.+/i, category: 'ci' },
  { re: /^\.circleci\/.+\.ya?ml$/i, category: 'ci' },
  { re: /^\.buildkite\/.+/i, category: 'ci' },
  // Helm / k8s (values + charts — not every template blob)
  { re: /^charts\/[^/]+\/(chart\.ya?ml|values.*\.ya?ml)$/i, category: 'infra' },
  { re: /^deploy\/.+\.ya?ml$/i, category: 'infra' },
  { re: /^k8s\/.+\.ya?ml$/i, category: 'infra' },
  { re: /^kubernetes\/.+\.ya?ml$/i, category: 'infra' },
  { re: /^infra\/.+\.ya?ml$/i, category: 'infra' },
  { re: /^terraform\/.+\.tf$/i, category: 'infra' },
  // API contracts by path
  { re: /(^|\/)(openapi|swagger)(\.|\/)/i, category: 'api-contract' },
  { re: /(^|\/)api(-)?(spec|schema|contracts?)\//i, category: 'api-contract' },
];

// Extensions for API / schema contracts
const API_EXTENSIONS = new Set(['.graphql', '.gql', '.proto', '.avsc', '.thrift']);

// Importance by category (feeds hubs/ranking lightly; embed text carries meaning)
const IMPORTANCE: Record<DocCategory, number> = {
  markdown: 0.1,
  text: 0.06,
  'env-example': 0.12,
  manifest: 0.16,
  docker: 0.14,
  compose: 0.15,
  ci: 0.14,
  'build-config': 0.11,
  'api-contract': 0.13,
  'task-runner': 0.13,
  workspace: 0.14,
  infra: 0.12,
  'other-config': 0.08,
};

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function buildRootIgnore(root: string, exclude: string[]): Ignore {
  const ig = ignore();
  const gitignorePath = path.join(root, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    try {
      ig.add(fs.readFileSync(gitignorePath, 'utf8'));
    } catch {
      /* ignore */
    }
  }
  if (exclude.length) ig.add(exclude);
  return ig;
}

/**
 * Classify a path as project-context (document) or not. Pure — no I/O.
 * Live secret env files return false.
 */
export function classifyProjectContext(relOrName: string): DocCategory | null {
  const rel = relOrName.replace(/\\/g, '/');
  const base = path.basename(rel);
  const baseLower = base.toLowerCase();

  // Never live secrets
  if (/^\.env($|\.)/i.test(base) && !isEnvExampleName(baseLower)) return null;
  // Never lockfiles / pnp (also in SKIP_FILES)
  if (SKIP_FILES.has(baseLower)) return null;

  if (isEnvExampleName(baseLower)) return 'env-example';

  const exact = EXACT_BASENAME[baseLower] ?? EXACT_BASENAME[base];
  if (exact) return exact;

  for (const { re, category } of BASENAME_PREFIX) {
    if (re.test(base)) return category;
  }

  for (const { re, category } of PATH_PATTERNS) {
    if (re.test(rel)) return category;
  }

  const ext = path.extname(baseLower);
  if (DOC_EXTENSIONS.has(ext)) return ext === '.txt' ? 'text' : 'markdown';
  if (API_EXTENSIONS.has(ext)) return 'api-contract';

  // OpenAPI/Swagger by extension + name
  if ((ext === '.yaml' || ext === '.yml' || ext === '.json') && /openapi|swagger|asyncapi/i.test(base)) {
    return 'api-contract';
  }

  // docker-compose variants with extra suffixes
  if (/^docker-compose\..+\.ya?ml$/i.test(base) || /^compose\..+\.ya?ml$/i.test(base)) {
    return 'compose';
  }

  return null;
}

/** @deprecated prefer classifyProjectContext — true when path is project context. */
export function isDocPath(relOrName: string): boolean {
  return classifyProjectContext(relOrName) !== null;
}

function isEnvExampleName(baseLower: string): boolean {
  if (ENV_EXAMPLE_NAMES.has(baseLower)) return true;
  if (/^(\.)?env\.(example|sample|template)(\.|$)/i.test(baseLower)) return true;
  if (/^example\.env/i.test(baseLower)) return true;
  return false;
}


/**
 * Discover project-context files under root. Deterministic order.
 * Never opens live secret env files or lockfiles.
 */
export function discoverDocs(options: DiscoverDocsOptions): DiscoveredDoc[] {
  const root = path.resolve(options.root);
  const maxFiles = options.maxFiles ?? DOC_MAX_FILES;
  const rootIg = buildRootIgnore(root, options.exclude ?? []);
  const scopeAbs = (options.paths?.length ? options.paths.map((p) => path.resolve(root, p)) : [root]).filter((p) =>
    fs.existsSync(p),
  );

  const found = new Map<string, DiscoveredDoc>();

  const consider = (abs: string): void => {
    if (found.size >= maxFiles) return;
    const rel = toPosix(path.relative(root, abs));
    if (!rel || rel.startsWith('..')) return;
    if (rootIg.ignores(rel)) return;
    const base = path.basename(abs);
    if (SKIP_FILES.has(base.toLowerCase())) return;
    const category = classifyProjectContext(rel);
    if (!category) return;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > DOC_FILE_MAX_BYTES) return;
      if (st.size === 0) return;
    } catch {
      return;
    }
    found.set(rel, { rel, abs, kind: category, category });
  };

  const walk = (dir: string, depth: number): void => {
    if (found.size >= maxFiles || depth > 12) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.size >= maxFiles) return;
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, abs));
      if (entry.isDirectory()) {
        if (isSkippedDirName(entry.name)) continue;
        // Workflows / .github must be walked even if other tools ignore them
        if (rel && rootIg.ignores(`${rel}/`) && !rel.startsWith('.github')) continue;
        walk(abs, depth + 1);
      } else if (entry.isFile()) {
        consider(abs);
      }
    }
  };

  for (const scope of scopeAbs) {
    try {
      const st = fs.statSync(scope);
      if (st.isDirectory()) walk(scope, 0);
      else if (st.isFile()) consider(scope);
    } catch {
      /* skip */
    }
  }

  return [...found.values()].sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Prepare a body optimized for retrieval: secret-scrub + optional smart trim
 * for huge manifests / OpenAPI so scripts & paths stay near the front.
 */
export function prepareDocBody(rel: string, raw: string, category: DocCategory): string {
  const scrubbed = redactSecrets(raw);
  if (scrubbed.length <= DOC_BODY_MAX_CHARS) return scrubbed;

  if (category === 'manifest' && path.basename(rel).toLowerCase() === 'package.json') {
    return summarizePackageJson(scrubbed);
  }
  if (category === 'api-contract' && /\.(ya?ml|json)$/i.test(rel)) {
    // Prefer head (usually openapi version + info + paths start)
    return scrubbed.slice(0, DOC_BODY_MAX_CHARS);
  }
  if (category === 'ci') {
    return scrubbed.slice(0, DOC_BODY_MAX_CHARS);
  }
  return scrubbed.slice(0, DOC_BODY_MAX_CHARS);
}

/** Keep name, scripts, dependencies* for package.json when truncated. */
function summarizePackageJson(raw: string): string {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const keep: Record<string, unknown> = {};
    for (const k of [
      'name',
      'version',
      'description',
      'private',
      'type',
      'packageManager',
      'engines',
      'workspaces',
      'scripts',
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
      'main',
      'bin',
      'exports',
    ]) {
      if (o[k] !== undefined) keep[k] = o[k];
    }
    const s = JSON.stringify(keep, null, 2);
    return s.length <= DOC_BODY_MAX_CHARS ? s : s.slice(0, DOC_BODY_MAX_CHARS);
  } catch {
    return raw.slice(0, DOC_BODY_MAX_CHARS);
  }
}

/**
 * Build `document` graph nodes from discovered project-context files.
 */
export function documentNodesFromDocs(docs: DiscoveredDoc[]): GraphNode[] {
  const nodes: GraphNode[] = [];
  for (const d of docs) {
    let raw = '';
    try {
      raw = fs.readFileSync(d.abs, 'utf8');
    } catch {
      continue;
    }
    const category = d.category ?? d.kind;
    const scrubbed = prepareDocBody(d.rel, raw, category);
    if (!scrubbed.trim()) continue;

    const name = path.basename(d.rel);
    const qualifiedName = d.rel.replace(/\\/g, '/');
    const id = nodeId({
      kind: 'document',
      qualifiedName,
      file: qualifiedName,
      signature: category,
    });
    const lineCount = Math.max(1, scrubbed.split('\n').length);
    const langTag =
      category === 'markdown'
        ? 'md'
        : category === 'env-example'
          ? 'env'
          : category === 'manifest'
            ? 'manifest'
            : category === 'docker' || category === 'compose'
              ? 'docker'
              : category === 'ci'
                ? 'ci'
                : category === 'api-contract'
                  ? 'api'
                  : category === 'build-config'
                    ? 'config'
                    : category === 'task-runner'
                      ? 'task'
                      : category === 'workspace'
                        ? 'workspace'
                        : category === 'infra'
                          ? 'infra'
                          : 'txt';

    nodes.push({
      id,
      kind: 'document',
      name,
      qualifiedName,
      file: qualifiedName,
      span: { start: 1, end: lineCount },
      lang: langTag,
      signature: `document:${category}`,
      doc: scrubbed,
      importance: IMPORTANCE[category] ?? 0.05,
      centrality: { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 },
      area: -1,
      isHub: false,
      tested: null,
    });
  }
  return nodes.sort((a, b) => a.file.localeCompare(b.file) || a.id.localeCompare(b.id));
}

/** Exported for tests / docs: all exact basenames we treat as project context. */
export function projectContextExactBasenames(): string[] {
  return Object.keys(EXACT_BASENAME).sort((a, b) => a.localeCompare(b));
}
