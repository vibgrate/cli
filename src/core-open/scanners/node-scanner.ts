// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as os from 'node:os';
import * as path from 'node:path';
import * as semver from 'semver';
import { findPackageJsonFiles, readJsonFile, pathExists, FileCache } from '../utils/fs.js';
import { Semaphore } from '../utils/semaphore.js';
import { withTimeout } from '../utils/timeout.js';
import { NpmCache, isSemverSpec } from './npm-cache.js';
import { buildDependencyLicense } from '../licenses/dependency-license.js';
import { ageDaysBetween, daysToLibyears, aggregateLibyears } from '../scoring/libyear.js';
import { latestLts, runtimeEolStatus, extractCycle, eolDate } from '../runtimes/catalog.js';
import { BUNDLED_RUNTIME_CATALOG } from '../runtimes/snapshot.js';
import type { RuntimeCatalog } from '../runtimes/types.js';
import type {
  PackageJson,
  ProjectScan,
  DependencyRow,
  DepSection,
  DetectedFramework,
  ProjectReference,
} from '../types.js';

/** Well-known frameworks we detect and track */
const KNOWN_FRAMEWORKS: Record<string, string> = {
  // ── Frontend ──
  'react': 'React',
  'react-dom': 'React DOM',
  'vue': 'Vue',
  '@angular/core': 'Angular',
  'svelte': 'Svelte',
  'solid-js': 'Solid',
  'preact': 'Preact',
  'lit': 'Lit',
  'qwik': 'Qwik',
  'htmx.org': 'htmx',
  'alpinejs': 'Alpine.js',
  'stimulus': 'Stimulus',

  // ── Meta-frameworks ──
  'next': 'Next.js',
  'nuxt': 'Nuxt',
  '@remix-run/react': 'Remix',
  '@remix-run/node': 'Remix (Node)',
  'gatsby': 'Gatsby',
  'astro': 'Astro',
  '@sveltejs/kit': 'SvelteKit',
  '@analogjs/platform': 'Analog',
  '@tanstack/start': 'TanStack Start',

  // ── Backend ──
  'express': 'Express',
  'fastify': 'Fastify',
  '@nestjs/core': 'NestJS',
  'hono': 'Hono',
  'koa': 'Koa',
  '@hapi/hapi': 'Hapi',
  'restify': 'Restify',
  '@elysiajs/eden': 'Elysia',
  'elysia': 'Elysia',
  '@adonisjs/core': 'AdonisJS',
  'moleculer': 'Moleculer',
  '@feathersjs/feathers': 'Feathers',
  'sails': 'Sails',

  // ── Language & Runtime ──
  'typescript': 'TypeScript',

  // ── State Management ──
  'redux': 'Redux',
  '@reduxjs/toolkit': 'Redux Toolkit',
  'zustand': 'Zustand',
  'mobx': 'MobX',
  'jotai': 'Jotai',
  'recoil': 'Recoil',
  'pinia': 'Pinia',
  'vuex': 'Vuex',
  '@tanstack/react-query': 'TanStack Query',
  'swr': 'SWR',
  'xstate': 'XState',
  '@ngrx/store': 'NgRx',

  // ── ORM & Database ──
  'prisma': 'Prisma',
  'drizzle-orm': 'Drizzle',
  'typeorm': 'TypeORM',
  'sequelize': 'Sequelize',
  '@mikro-orm/core': 'MikroORM',
  'mongoose': 'Mongoose',
  'knex': 'Knex',
  'kysely': 'Kysely',
  'objection': 'Objection.js',

  // ── Bundlers ──
  'vite': 'Vite',
  'webpack': 'webpack',
  'rollup': 'Rollup',
  'esbuild': 'esbuild',
  'parcel': 'Parcel',
  'turbo': 'Turbo',
  'tsup': 'tsup',
  '@swc/core': 'SWC',
  'bun': 'Bun',

  // ── Testing ──
  'vitest': 'Vitest',
  'jest': 'Jest',
  '@playwright/test': 'Playwright',
  'cypress': 'Cypress',
  'mocha': 'Mocha',
  'ava': 'AVA',
  'storybook': 'Storybook',
  '@storybook/react': 'Storybook',
};

export async function scanNodeProjects(
  rootDir: string,
  npmCache: NpmCache,
  cache?: FileCache,
  projectScanTimeout?: number,
  catalog: RuntimeCatalog = BUNDLED_RUNTIME_CATALOG,
): Promise<ProjectScan[]> {
  const packageJsonFiles = cache
    ? await cache.findPackageJsonFiles(rootDir)
    : await findPackageJsonFiles(rootDir);
  const results: ProjectScan[] = [];

  // Build a map of package names to paths for workspace dependency resolution
  const packageNameToPath = new Map<string, string>();

  // ── Detect root-level package manager ──
  // Priority: 1) corepack `packageManager` field, 2) workspace config file, 3) lockfile
  let detectedPackageManager: string | undefined;
  try {
    const _pathExists = cache ? (p: string) => cache.pathExists(p) : pathExists;

    // 1. Check corepack field in root package.json
    const rootPkgPath = path.join(rootDir, 'package.json');
    if (await _pathExists(rootPkgPath)) {
      try {
        const rootPkg: PackageJson = cache
          ? await cache.readJsonFile<PackageJson>(rootPkgPath)
          : await readJsonFile<PackageJson>(rootPkgPath);
        if (rootPkg.packageManager) {
          const pm = rootPkg.packageManager.split('@')[0]?.toLowerCase();
          if (pm && ['pnpm', 'yarn', 'npm', 'bun'].includes(pm)) {
            detectedPackageManager = pm;
          }
        }
      } catch { /* ignore */ }
    }

    // 2. Workspace config file (pnpm-workspace.yaml → pnpm)
    if (!detectedPackageManager) {
      if (await _pathExists(path.join(rootDir, 'pnpm-workspace.yaml'))) {
        detectedPackageManager = 'pnpm';
      }
    }

    // 3. Lockfile presence
    if (!detectedPackageManager) {
      if (await _pathExists(path.join(rootDir, 'pnpm-lock.yaml'))) {
        detectedPackageManager = 'pnpm';
      } else if (await _pathExists(path.join(rootDir, 'yarn.lock'))) {
        detectedPackageManager = 'yarn';
      } else if (await _pathExists(path.join(rootDir, 'package-lock.json'))) {
        detectedPackageManager = 'npm';
      } else if (await _pathExists(path.join(rootDir, 'bun.lockb'))) {
        detectedPackageManager = 'bun';
      }
    }
  } catch { /* detection is best-effort */ }

  const STUCK_TIMEOUT_MS = projectScanTimeout ?? cache?.projectScanTimeout ?? 180_000;
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length || 4;
  const projectConcurrency = Math.max(2, Math.min(16, cores * 2));
  const projectSem = new Semaphore(projectConcurrency);

  // ── Pre-warm npm cache ──
  // Collect ALL npm package names across every package.json up-front and
  // prefetch their registry metadata in bulk *before* entering the
  // per-project timeout loop.  Without this, projects with many deps
  // (e.g. 70+ packages) can spend the entire timeout budget on `npm view`
  // network calls and get auto-excluded even though they aren't stuck.
  const allNpmPkgs = new Set<string>();
  await Promise.all(packageJsonFiles.map(async (pjPath) => {
    try {
      const pj: PackageJson = cache
        ? await cache.readJsonFile<PackageJson>(pjPath)
        : await readJsonFile<PackageJson>(pjPath);
      const depSections = [pj.dependencies, pj.devDependencies, pj.peerDependencies, pj.optionalDependencies];
      for (const deps of depSections) {
        if (!deps) continue;
        for (const [pkg, spec] of Object.entries(deps)) {
          if (isSemverSpec(spec)) allNpmPkgs.add(pkg);
        }
      }
    } catch {
      // Ignore unreadable package.json — scanOnePackageJson will handle errors
    }
  }));

  if (allNpmPkgs.size > 0) {
    try {
      await npmCache.prefetch([...allNpmPkgs]);
    } catch {
      // Best-effort — per-project scans will retry individually
    }
  }

  const scannedProjects = await Promise.all(packageJsonFiles.map(async (pjPath) => projectSem.run(async () => {
    try {
      const scanPromise = scanOnePackageJson(pjPath, rootDir, npmCache, cache, catalog);
      const result = await withTimeout(scanPromise, STUCK_TIMEOUT_MS);
      if (result.ok) {
        return result.value;
      }

      // Timed out — record stuck path for auto-exclude
      const relPath = path.relative(rootDir, path.dirname(pjPath));
      if (cache) {
        cache.addStuckPath(relPath || '.');
      }
      console.error(`Timeout scanning ${pjPath} (>${STUCK_TIMEOUT_MS / 1000}s) — skipped`);
      if (cache?.shouldShowTimeoutHint()) {
        console.error(`  Tip: increase projectScanTimeout in vibgrate.config.ts (or --project-scan-timeout <seconds>) for large projects`);
      }
      return null;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error scanning ${pjPath}: ${msg}`);
      return null;
    }
  })));

  for (const project of scannedProjects) {
    if (!project) continue;
    results.push(project);
    packageNameToPath.set(project.name, project.path);
  }

  // Resolve workspace dependencies: find dependencies that reference other local packages
  for (const project of results) {
    const workspaceRefs: ProjectReference[] = [];

    for (const dep of project.dependencies) {
      // Check if this dependency is another project in the workspace
      const depPath = packageNameToPath.get(dep.package);
      if (depPath && depPath !== project.path) {
        workspaceRefs.push({
          path: depPath,
          name: dep.package,
          refType: 'workspace',
        });
      }
    }

    if (workspaceRefs.length > 0) {
      project.projectReferences = workspaceRefs;
    }

    // Attach the detected root-level package manager to every project
    if (detectedPackageManager) {
      project.packageManager = detectedPackageManager;
    }
  }

  return results;
}

async function scanOnePackageJson(
  packageJsonPath: string,
  rootDir: string,
  npmCache: NpmCache,
  cache: FileCache | undefined,
  catalog: RuntimeCatalog,
): Promise<ProjectScan> {
  const pj = cache
    ? await cache.readJsonFile<PackageJson>(packageJsonPath)
    : await readJsonFile<PackageJson>(packageJsonPath);
  const absProjectPath = path.dirname(packageJsonPath);
  const projectPath = path.relative(rootDir, absProjectPath) || '.';

  // Detect Node runtime version
  const nodeEngine = pj.engines?.node ?? undefined;
  let runtimeLatest: string | undefined;
  let runtimeMajorsBehind: number | undefined;
  let runtimeEol: boolean | null | undefined;
  let runtimeEolDate: string | undefined;

  if (nodeEngine) {
    const latest = latestLts(catalog, 'nodejs');
    const parsed = semver.minVersion(nodeEngine);
    if (latest && parsed) {
      const currentMajor = semver.major(parsed);
      runtimeLatest = `${latest.major}.0.0`;
      runtimeMajorsBehind = Math.max(0, latest.major - currentMajor);
    }
    runtimeEol = runtimeEolStatus(catalog, 'node', nodeEngine);
    const cycle = extractCycle('node', nodeEngine);
    if (cycle) runtimeEolDate = eolDate(catalog, 'nodejs', cycle);
  }

  // Collect dependencies from all sections
  const sections: { name: DepSection; deps?: Record<string, string> }[] = [
    { name: 'dependencies', deps: pj.dependencies },
    { name: 'devDependencies', deps: pj.devDependencies },
    { name: 'peerDependencies', deps: pj.peerDependencies },
    { name: 'optionalDependencies', deps: pj.optionalDependencies },
  ];

  const dependencies: DependencyRow[] = [];
  const frameworks: DetectedFramework[] = [];
  const buckets = { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 };

  // Collect all dep promises first for parallel resolution
  const depEntries: { pkg: string; section: DepSection; spec: string }[] = [];
  for (const s of sections) {
    if (!s.deps) continue;
    for (const [pkg, spec] of Object.entries(s.deps)) {
      if (!isSemverSpec(spec)) continue;
      depEntries.push({ pkg, section: s.name, spec });
    }
  }

  // Warm cache in batch to reduce npm process/network overhead.
  await npmCache.prefetch(depEntries.map((entry) => entry.pkg));

  // Resolve metadata from cache (misses transparently fetch as needed).
  const metaPromises = depEntries.map(async (entry) => {
    const meta = await npmCache.get(entry.pkg);
    return { ...entry, meta };
  });

  const resolved = await Promise.all(metaPromises);

  for (const { pkg, section, spec, meta } of resolved) {
    // Find best version satisfying the spec
    const resolvedVersion = meta.stableVersions.length > 0
      ? semver.maxSatisfying(meta.stableVersions, spec) ?? null
      : null;

    const latestStable = meta.latestStableOverall;

    let majorsBehind: number | null = null;
    let drift: DependencyRow['drift'] = 'unknown';

    if (resolvedVersion && latestStable) {
      const currentMajor = semver.major(resolvedVersion);
      const latestMajor = semver.major(latestStable);
      majorsBehind = latestMajor - currentMajor;

      if (majorsBehind === 0) {
        drift = semver.eq(resolvedVersion, latestStable) ? 'current' : 'minor-behind';
      } else {
        drift = 'major-behind';
      }

      // Bucketise
      if (majorsBehind === 0) buckets.current++;
      else if (majorsBehind === 1) buckets.oneBehind++;
      else buckets.twoPlusBehind++;
    } else {
      buckets.unknown++;
    }

    const ageDays = ageDaysBetween(resolvedVersion, latestStable, meta.releaseDates);
    const libyears = daysToLibyears(ageDays);

    dependencies.push({
      package: pkg,
      section,
      currentSpec: spec,
      resolvedVersion,
      latestStable,
      majorsBehind,
      drift,
      license: buildDependencyLicense(meta.license, 'registry'),
      ageDays,
      libyears,
    });

    // Detect known frameworks
    if (pkg in KNOWN_FRAMEWORKS) {
      frameworks.push({
        name: KNOWN_FRAMEWORKS[pkg]!,
        currentVersion: resolvedVersion,
        latestVersion: latestStable,
        majorsBehind,
      });
    }
  }

  // Record workspace: protocol dependencies (not resolved via npm registry,
  // but needed so the workspace-reference resolution loop can discover edges)
  for (const s of sections) {
    if (!s.deps) continue;
    for (const [pkg, spec] of Object.entries(s.deps)) {
      if (!spec.trim().startsWith('workspace:')) continue;
      dependencies.push({
        package: pkg,
        section: s.name,
        currentSpec: spec,
        resolvedVersion: null,
        latestStable: null,
        majorsBehind: null,
        drift: 'unknown',
        license: { raw: null, spdxId: null, source: 'none', confidence: 0 },
      });
      buckets.unknown++;
    }
  }

  // Sort: worst drift first
  dependencies.sort((a, b) => {
    const order = { 'major-behind': 0, 'minor-behind': 1, 'current': 2, 'unknown': 3 };
    const diff = (order[a.drift] ?? 9) - (order[b.drift] ?? 9);
    if (diff !== 0) return diff;
    return a.package.localeCompare(b.package);
  });

  // Count files in project directory (use cached walk to avoid redundant I/O)
  let fileCount: number | undefined;
  try {
    fileCount = cache
      ? await cache.countFilesUnder(rootDir, absProjectPath)
      : undefined;
  } catch {
    // Ignore file count errors
  }

  return {
    type: 'node',
    path: projectPath,
    name: pj.name ?? path.basename(absProjectPath),
    runtime: nodeEngine,
    runtimeLatest,
    runtimeMajorsBehind,
    runtimeEol,
    runtimeEolDate,
    frameworks,
    dependencies,
    dependencyAgeBuckets: buckets,
    libyears: aggregateLibyears(dependencies.map((d) => d.libyears)) ?? undefined,
    fileCount,
  };
}
