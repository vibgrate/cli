import * as path from 'node:path';
import type {
  CoreScanContext,
  AdvancedScanHook,
  ProjectScan,
  ArchitectureResult,
} from '../core-open/index.js';
import { compactUiPurpose } from '../core-open/index.js';

import { scanPlatformMatrix } from './scanners/platform-matrix.js';
import { scanDependencyRisk } from './scanners/dependency-risk.js';
import { scanDependencyGraph } from './scanners/dependency-graph.js';
import { scanToolingInventory } from './scanners/tooling-inventory.js';
import { scanBuildDeploy } from './scanners/build-deploy.js';
import { scanTsModernity } from './scanners/ts-modernity.js';
import { scanBreakingChangeExposure } from './scanners/breaking-change.js';
import { scanFileHotspots } from './scanners/file-hotspots.js';
import { scanSecurityPosture } from './scanners/security-posture.js';
import { scanServiceDependencies } from './scanners/service-dependencies.js';
import {
  scanArchitecture,
  buildProjectArchitectureMermaid,
  scanProjectArchitecture,
  aggregateSolutionArchitecture,
} from './scanners/architecture.js';
import { scanCodeQuality } from './scanners/code-quality.js';
import { scanUiPurpose } from './scanners/ui-purpose.js';
import { recommendStandards } from './scanners/standards-mapper.js';

/**
 * Advanced-analysis pass layered on top of the open base scan.
 *
 * Runs the structured, deterministic scanners (tech-stack tooling, service
 * integrations, build/deploy, security posture, dependency graph/risk,
 * TypeScript modernity, file hotspots, breaking-change exposure, architecture,
 * code quality, UI purpose) and writes their typed results back through the
 * {@link CoreScanContext} so {@link runCoreScan} folds them into the artifact's
 * `extended` block.
 *
 * Every scanner here emits structured facts — package names, versions, counts,
 * booleans, file paths — and never uploads raw source-line text. The former
 * `requirements-scanners` family (runtimeConfiguration / dataStores / apiSurface
 * / operationalResilience / ossGovernance / assetBranding) is deliberately
 * excluded: it regex-scraped whole source lines (auth hints, tokens, connection
 * strings, license text) into the artifact, a data-quality and secret-exposure
 * risk. Do not re-introduce raw-line `extract()` scanning here.
 */
export async function runAdvancedAnalysis(ctx: CoreScanContext): Promise<void> {
  const { rootDir, opts, scanners, maxPrivacyMode, allProjects, solutions, projectsByPath, fileCache, progress, extended } = ctx;

  if (scanners === false) {
    // Scanners disabled wholesale: project categorisation + billing already ran
    // in the open base scan; only the standards recommendation remains.
    extended.standards = recommendStandards(allProjects, extended);
    return;
  }

  const scannerPolicy = {
    platformMatrix: !maxPrivacyMode,
    toolingInventory: true,
    serviceDependencies: !maxPrivacyMode,
    breakingChangeExposure: !maxPrivacyMode,
    securityPosture: true,
    buildDeploy: !maxPrivacyMode,
    tsModernity: !maxPrivacyMode,
    fileHotspots: !maxPrivacyMode,
    dependencyGraph: true,
    dependencyRisk: true,
    architecture: !maxPrivacyMode,
    codeQuality: !maxPrivacyMode,
    uiPurpose: !maxPrivacyMode,
  } as const;

  // Register advanced progress steps just-in-time before the drift step (the
  // same dynamic-insertion pattern the base runner uses for project steps).
  const advancedSteps: Array<{ id: string; label: string }> = [
    ...(scannerPolicy.platformMatrix && scanners?.platformMatrix?.enabled !== false ? [{ id: 'platform', label: 'Platform matrix' }] : []),
    ...(scannerPolicy.toolingInventory && scanners?.toolingInventory?.enabled !== false ? [{ id: 'tooling', label: 'Tooling inventory' }] : []),
    ...(scannerPolicy.serviceDependencies && scanners?.serviceDependencies?.enabled !== false ? [{ id: 'services', label: 'Service dependencies' }] : []),
    ...(scannerPolicy.breakingChangeExposure && scanners?.breakingChangeExposure?.enabled !== false ? [{ id: 'breaking', label: 'Breaking change exposure' }] : []),
    ...(scannerPolicy.securityPosture && scanners?.securityPosture?.enabled !== false ? [{ id: 'security', label: 'Security posture' }] : []),
    ...(scannerPolicy.buildDeploy && scanners?.buildDeploy?.enabled !== false ? [{ id: 'build', label: 'Build & deploy analysis' }] : []),
    ...(scannerPolicy.tsModernity && scanners?.tsModernity?.enabled !== false ? [{ id: 'ts', label: 'TypeScript modernity' }] : []),
    ...(scannerPolicy.fileHotspots && scanners?.fileHotspots?.enabled !== false ? [{ id: 'hotspots', label: 'File hotspots' }] : []),
    ...(scannerPolicy.dependencyGraph && scanners?.dependencyGraph?.enabled !== false ? [{ id: 'depgraph', label: 'Dependency graph' }] : []),
    ...(scannerPolicy.dependencyRisk && scanners?.dependencyRisk?.enabled !== false ? [{ id: 'deprisk', label: 'Dependency risk' }] : []),
    ...(scannerPolicy.architecture && scanners?.architecture?.enabled !== false ? [{ id: 'architecture', label: 'Architecture layers' }] : []),
    ...(scannerPolicy.codeQuality && scanners?.codeQuality?.enabled !== false ? [{ id: 'codequality', label: 'Code quality metrics' }] : []),
    ...((!maxPrivacyMode && (opts.uiPurpose || scanners?.uiPurpose?.enabled === true)) ? [{ id: 'uipurpose', label: 'UI purpose evidence' }] : []),
  ];
  for (const step of advancedSteps) {
    progress.insertStepBefore('drift', step);
  }

  // ── Extended scanners (run in parallel) ──
  const scannerTasks: Array<Promise<void>> = [];

  if (scannerPolicy.platformMatrix && scanners?.platformMatrix?.enabled !== false) {
    progress.startStep('platform');
    scannerTasks.push(
      scanPlatformMatrix(rootDir, fileCache).then((result) => {
        extended.platformMatrix = result;
        const nativeCount = result.nativeModules.length;
        const dockerCount = result.dockerBaseImages.length;
        const parts: string[] = [];
        if (nativeCount > 0) parts.push(`${nativeCount} native`);
        if (dockerCount > 0) parts.push(`${dockerCount} docker`);
        progress.completeStep('platform', parts.join(', ') || 'clean', nativeCount + dockerCount);
      }),
    );
  }

  if (scannerPolicy.toolingInventory && scanners?.toolingInventory?.enabled !== false) {
    progress.startStep('tooling');
    scannerTasks.push(
      Promise.resolve().then(() => {
        extended.toolingInventory = scanToolingInventory(allProjects);
        const toolCount = Object.values(extended.toolingInventory).reduce((sum, arr) => sum + arr.length, 0);
        progress.completeStep('tooling', `${toolCount} tool${toolCount !== 1 ? 's' : ''} mapped`, toolCount);
      }),
    );
  }

  if (scannerPolicy.serviceDependencies && scanners?.serviceDependencies?.enabled !== false) {
    progress.startStep('services');
    scannerTasks.push(
      Promise.resolve().then(() => {
        extended.serviceDependencies = scanServiceDependencies(allProjects);
        const svcCount = Object.values(extended.serviceDependencies).reduce((sum, arr) => sum + arr.length, 0);
        progress.completeStep('services', `${svcCount} service${svcCount !== 1 ? 's' : ''} detected`, svcCount);
      }),
    );
  }

  if (scannerPolicy.breakingChangeExposure && scanners?.breakingChangeExposure?.enabled !== false) {
    progress.startStep('breaking');
    scannerTasks.push(
      Promise.resolve().then(async () => {
        extended.breakingChangeExposure = await scanBreakingChangeExposure(allProjects, rootDir, fileCache);
        const bc = extended.breakingChangeExposure;
        const bcTotal = bc.deprecatedPackages.length + bc.legacyPolyfills.length;
        progress.completeStep(
          'breaking',
          bcTotal > 0 ? `${bc.deprecatedPackages.length} deprecated, ${bc.legacyPolyfills.length} polyfills` : 'none found',
          bcTotal,
        );
      }),
    );
  }

  if (scannerPolicy.securityPosture && scanners?.securityPosture?.enabled !== false) {
    progress.startStep('security');
    scannerTasks.push(
      scanSecurityPosture(rootDir, fileCache).then((result) => {
        extended.securityPosture = result;
        const secDetail = result.lockfilePresent
          ? `lockfile ✔${result.gitignoreCoversEnv ? ' · .env ✔' : ' · .env ✖'}`
          : 'no lockfile';
        progress.completeStep('security', secDetail);
      }),
    );
  }

  if (scannerPolicy.buildDeploy && scanners?.buildDeploy?.enabled !== false) {
    progress.startStep('build');
    scannerTasks.push(
      scanBuildDeploy(rootDir, fileCache).then((result) => {
        extended.buildDeploy = result;
        const bdParts: string[] = [];
        if (result.ci.length > 0) bdParts.push(result.ci.join(', '));
        if (result.docker.dockerfileCount > 0) bdParts.push(`${result.docker.dockerfileCount} Dockerfile${result.docker.dockerfileCount !== 1 ? 's' : ''}`);
        progress.completeStep('build', bdParts.join(' · ') || 'none detected');
      }),
    );
  }

  if (scannerPolicy.tsModernity && scanners?.tsModernity?.enabled !== false) {
    progress.startStep('ts');
    scannerTasks.push(
      scanTsModernity(rootDir, fileCache).then((result) => {
        extended.tsModernity = result;
        const tsParts: string[] = [];
        if (result.typescriptVersion) tsParts.push(`v${result.typescriptVersion}`);
        if (result.strict === true) tsParts.push('strict');
        if (result.moduleType) tsParts.push(result.moduleType.toUpperCase());
        progress.completeStep('ts', tsParts.join(' · ') || 'no tsconfig');
      }),
    );
  }

  if (scannerPolicy.fileHotspots && scanners?.fileHotspots?.enabled !== false) {
    progress.startStep('hotspots');
    scannerTasks.push(
      scanFileHotspots(rootDir, fileCache).then((result) => {
        extended.fileHotspots = result;
        progress.completeStep('hotspots', `${result.totalFiles} files`, result.totalFiles);
      }),
    );
  }

  if (scannerPolicy.dependencyGraph && scanners?.dependencyGraph?.enabled !== false) {
    progress.startStep('depgraph');
    scannerTasks.push(
      scanDependencyGraph(rootDir, fileCache).then((result) => {
        extended.dependencyGraph = result;
        const dgDetail = result.lockfileType
          ? `${result.lockfileType} · ${result.totalUnique} unique`
          : 'no lockfile';
        progress.completeStep('depgraph', dgDetail, result.totalUnique);
      }),
    );
  }

  if (scannerPolicy.codeQuality && scanners?.codeQuality?.enabled !== false) {
    progress.startStep('codequality');
    scannerTasks.push(
      scanCodeQuality(rootDir, fileCache).then((result) => {
        extended.codeQuality = result;
        const cqParts: string[] = [];
        cqParts.push(`${result.filesAnalyzed} files`);
        cqParts.push(`${result.functionsAnalyzed} functions`);
        if (result.circularDependencies > 0) cqParts.push(`${result.circularDependencies} cycles`);
        progress.completeStep('codequality', cqParts.join(' · '), result.functionsAnalyzed);
      }),
    );
  }

  if (scannerPolicy.dependencyRisk && scanners?.dependencyRisk?.enabled !== false) {
    progress.startStep('deprisk');
    scannerTasks.push(
      Promise.resolve().then(() => {
        extended.dependencyRisk = scanDependencyRisk(allProjects);
        const dr = extended.dependencyRisk;
        const drParts: string[] = [];
        if (dr.deprecatedPackages.length > 0) drParts.push(`${dr.deprecatedPackages.length} deprecated`);
        if (dr.nativeModulePackages.length > 0) drParts.push(`${dr.nativeModulePackages.length} native`);
        progress.completeStep('deprisk', drParts.join(', ') || 'low risk');
      }),
    );
  }

  await Promise.all(scannerTasks);

  if (!maxPrivacyMode && scanners?.uiPurpose?.enabled !== false) {
    progress.startStep('uipurpose');
    extended.uiPurpose = await scanUiPurpose(rootDir, fileCache);
    const up = extended.uiPurpose;
    const summary = [`${up.topEvidence.length} evidence`, ...(up.capped ? ['capped'] : [])].join(' · ');
    progress.completeStep('uipurpose', summary, up.topEvidence.length);

    await Promise.all(allProjects.map(async (project) => {
      const projectDir = path.join(rootDir, project.path);
      const projectResult = await scanUiPurpose(projectDir, fileCache, 150);
      if (projectResult.topEvidence.length > 0) {
        project.uiPurpose = compactUiPurpose(projectResult);
      }
    }));
  }

  if (scannerPolicy.architecture && scanners?.architecture?.enabled !== false) {
    progress.startStep('architecture');
    extended.architecture = await scanArchitecture(
      rootDir,
      allProjects,
      extended.toolingInventory,
      extended.serviceDependencies,
      fileCache,
    );
    const arch = extended.architecture;
    const layerCount = arch.layers.filter((l) => l.fileCount > 0).length;

    await Promise.all(allProjects.map(async (project) => {
      project.architectureMermaid = await buildProjectArchitectureMermaid(
        rootDir,
        project,
        arch.archetype,
        fileCache,
      );
      project.architecture = await scanProjectArchitecture(rootDir, project, fileCache);
    }));

    for (const solution of solutions) {
      const memberProjects = solution.projectPaths
        .map((pp) => projectsByPath.get(pp) ?? projectsByPath.get(path.dirname(pp).replace(/\\/g, '/')))
        .filter((p): p is ProjectScan => Boolean(p));
      const memberArchResults = memberProjects
        .map((p) => p.architecture)
        .filter((a): a is ArchitectureResult => Boolean(a));
      if (memberArchResults.length > 0) {
        solution.architecture = aggregateSolutionArchitecture(memberArchResults);
      }
    }

    progress.completeStep(
      'architecture',
      `${arch.archetype} · ${layerCount} layer${layerCount !== 1 ? 's' : ''} · ${arch.totalClassified} files`,
      layerCount,
    );
  }

  // ── Standards matching (offline): map detected purpose -> recommended standards ──
  extended.standards = recommendStandards(allProjects, extended);

  // ── filesScanned contributions from the advanced scanners ──
  let advancedFiles = 0;
  if (extended.fileHotspots) advancedFiles += extended.fileHotspots.totalFiles;
  if (extended.securityPosture) advancedFiles += 1;
  if (extended.tsModernity?.typescriptVersion) advancedFiles += 1;
  if (extended.dependencyGraph?.lockfileType) advancedFiles += 1;
  if (extended.buildDeploy) {
    advancedFiles += extended.buildDeploy.docker.dockerfileCount;
    advancedFiles += extended.buildDeploy.ci.length;
  }
  if (extended.codeQuality) advancedFiles += extended.codeQuality.filesAnalyzed;
  if (extended.uiPurpose) advancedFiles += extended.uiPurpose.topEvidence.length;
  if (advancedFiles > 0) ctx.addFilesScanned(advancedFiles);
}

/**
 * The advanced-analysis hook, exported so the reporting commands can inject it
 * into {@link runCoreScan}.
 */
export const advancedScanHook: AdvancedScanHook = runAdvancedAnalysis;
