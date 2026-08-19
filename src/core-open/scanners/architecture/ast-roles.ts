// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import type {
  ArchitectureFileRole,
  ArchitectureLayer,
  ArchitectureResult,
  FolderClassification,
  LayerClassification,
  LayerSummary,
} from '../../types.js';
import {
  AST_ROLE_CATALOG,
  catalogForLanguage,
  sourceHasRoleNeedle,
  type AstRoleCatalogEntry,
} from './packs/ast-role-catalog.js';
import {
  capUnclassifiedFiles,
  FOLDER_INHERIT_MIN_CONFIDENCE,
  folderInheritSignal,
} from './folders.js';
import { CLASSIFIED_ROLE_CAP } from './types.js';
import { mermaidFromArchitecture } from './mermaid.js';
import { classifyFile } from './classify.js';

export type { AstRoleCatalogEntry };
export { AST_ROLE_CATALOG, CLASSIFIED_ROLE_CAP };

const LAYER_FILES_CAP = 40;
/** Path prior when the file is in the layer sample and no folder disagrees. */
const DEFAULT_PATH_CONFIDENCE = 0.75;
/** File-level path/suffix win over a disagreeing folder (same as graph refine). */
const FILE_LEVEL_PATH_CONFIDENCE = 0.85;

const LAYER_ORDER: Record<ArchitectureLayer, number> = {
  presentation: 0,
  routing: 1,
  middleware: 2,
  services: 3,
  domain: 4,
  'data-access': 5,
  infrastructure: 6,
  config: 7,
  shared: 8,
  testing: 9,
};

export const AST_ROLE_SIGNAL_PREFIX = 'ast-role:';
export const AST_CONFIRM_SIGNAL_PREFIX = 'ast-confirm:';
export const AST_CONFLICT_SIGNAL_PREFIX = 'ast-conflict:';

export interface AstRoleHit {
  filePath: string;
  role: ArchitectureFileRole;
  layer: ArchitectureLayer;
  confidence: number;
  signal: string;
  packId: string;
}

export interface ArchitectureAstRefineProject {
  path: string;
  name: string;
}

const FILE_ROLES = new Set<ArchitectureFileRole>([
  'controller', 'service', 'repository', 'entity', 'handler', 'router',
]);

function normalizeRelPath(p: string): string {
  return (p || '.').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '') || '.';
}

function compareRelPath(a: string, b: string): number {
  return normalizeRelPath(a).localeCompare(normalizeRelPath(b));
}

function sortedSignals(signals: readonly string[]): string[] {
  return [...new Set(signals)].sort((a, b) => a.localeCompare(b));
}

function parentDir(filePath: string): string {
  const n = normalizeRelPath(filePath);
  if (n === '.') return '.';
  const i = n.lastIndexOf('/');
  return i <= 0 ? '.' : n.slice(0, i);
}

function ancestorDirs(filePath: string): string[] {
  const dirs: string[] = [];
  let d = parentDir(filePath);
  while (d !== '.') {
    dirs.push(d);
    d = parentDir(d);
  }
  return dirs;
}

function pathOwnsFile(projectPath: string, file: string): boolean {
  const prefix = normalizeRelPath(projectPath);
  const f = normalizeRelPath(file);
  if (prefix === '.') return true;
  return f === prefix || f.startsWith(`${prefix}/`);
}

function isLayerSkipped(result: ArchitectureResult): boolean {
  return result.projectKind === 'iac'
    || result.projectKind === 'contract'
    || result.artifactKind === 'infrastructure-definition'
    || result.artifactKind === 'contract';
}

export { sourceHasRoleNeedle, catalogForLanguage as queriesForLanguage };

/**
 * Tree-sitter-free matcher used by core-open tests and as the parse-time
 * fallback when a query fails to compile. Same needles the tree-sitter
 * queries confirm.
 */
export function matchAstRolesFromSource(
  filePath: string,
  lang: string,
  source: string,
): AstRoleHit[] {
  const hits: AstRoleHit[] = [];
  for (const query of catalogForLanguage(lang)) {
    if (!sourceHasRoleNeedle(source, query.needle)) continue;
    hits.push({
      filePath: normalizeRelPath(filePath),
      role: query.role,
      layer: query.layer,
      confidence: query.confidence,
      signal: query.signal,
      packId: query.packId,
    });
  }
  // All matching catalog rows — applyAstRoles filters by packIds then picks.
  return hits.sort((a, b) => compareHits(a, b) || compareRelPath(a.filePath, b.filePath));
}

function compareHits(a: AstRoleHit, b: AstRoleHit): number {
  return b.confidence - a.confidence
    || a.packId.localeCompare(b.packId)
    || a.role.localeCompare(b.role)
    || a.signal.localeCompare(b.signal);
}

/** One winning hit per file. Ties: confidence desc, then packId, role. */
export function pickBestHits(hits: readonly AstRoleHit[]): AstRoleHit[] {
  const byFile = new Map<string, AstRoleHit>();
  for (const hit of hits) {
    if (!FILE_ROLES.has(hit.role)) continue;
    const key = normalizeRelPath(hit.filePath);
    const normalized = { ...hit, filePath: key };
    const existing = byFile.get(key);
    if (!existing || compareHits(normalized, existing) < 0) {
      byFile.set(key, normalized);
    }
  }
  return [...byFile.values()].sort((a, b) => compareRelPath(a.filePath, b.filePath));
}

function nearestFolder(filePath: string, folders: readonly FolderClassification[]): FolderClassification | undefined {
  for (const ancestor of ancestorDirs(filePath)) {
    const folder = folders.find((f) => normalizeRelPath(f.path) === ancestor);
    if (folder) return folder;
  }
  return undefined;
}

function fileInLayerSample(result: ArchitectureResult, filePath: string): ArchitectureLayer | undefined {
  const n = normalizeRelPath(filePath);
  for (const layer of result.layers) {
    if (layer.files.some((f) => normalizeRelPath(f) === n)) return layer.layer;
  }
  return undefined;
}

interface FileState {
  filePath: string;
  layer?: ArchitectureLayer;
  confidence: number;
  signals: string[];
  role?: ArchitectureFileRole;
}

function existingRole(result: ArchitectureResult, filePath: string): ArchitectureFileRole | undefined {
  const n = normalizeRelPath(filePath);
  return result.classified?.find((c) => normalizeRelPath(c.filePath) === n)?.role;
}

function pathPriorConfidence(
  folder: FolderClassification | undefined,
  pathLayer: ArchitectureLayer,
  fallback: number,
): number {
  if (folder && folder.layer === pathLayer) return folder.confidence;
  if (folder && folder.layer !== pathLayer) return FILE_LEVEL_PATH_CONFIDENCE;
  return fallback;
}

function buildFileState(filePath: string, result: ArchitectureResult): FileState {
  const n = normalizeRelPath(filePath);
  const sampleLayer = fileInLayerSample(result, n);
  const folder = nearestFolder(n, result.folders ?? []);
  const role = existingRole(result, n);
  if (sampleLayer) {
    return {
      filePath: n,
      layer: sampleLayer,
      confidence: pathPriorConfidence(folder, sampleLayer, DEFAULT_PATH_CONFIDENCE),
      signals: [],
      role,
    };
  }
  // Off-sample files still have a path prior (suffix / path rules). Re-consult
  // the same classifier the scan used so we confirm/conflict instead of
  // inventing a layer and incrementing totalClassified.
  const pathClass = classifyFile(n, result.archetype, { projectKind: result.projectKind });
  if (pathClass) {
    return {
      filePath: n,
      layer: pathClass.layer,
      confidence: pathPriorConfidence(folder, pathClass.layer, pathClass.confidence),
      signals: [...pathClass.signals],
      role,
    };
  }
  if (folder && folder.confidence >= FOLDER_INHERIT_MIN_CONFIDENCE) {
    return {
      filePath: n,
      layer: folder.layer,
      confidence: folder.confidence,
      signals: [folderInheritSignal(folder.layer)],
      role,
    };
  }
  return { filePath: n, layer: undefined, confidence: 0, signals: [], role };
}

function ensureLayer(result: ArchitectureResult, layer: ArchitectureLayer): LayerSummary {
  let summary = result.layers.find((l) => l.layer === layer);
  if (summary) return summary;
  summary = {
    layer,
    fileCount: 0,
    driftScore: 0,
    riskLevel: 'none',
    techStack: [],
    services: [],
    packages: [],
    files: [],
  };
  result.layers.push(summary);
  result.layers.sort((a, b) => (LAYER_ORDER[a.layer] ?? 99) - (LAYER_ORDER[b.layer] ?? 99));
  return summary;
}

function addFileToLayer(summary: LayerSummary, filePath: string): void {
  const n = normalizeRelPath(filePath);
  if (summary.files.some((f) => normalizeRelPath(f) === n)) return;
  if (summary.files.length < LAYER_FILES_CAP) {
    summary.files.push(n);
    summary.files.sort(compareRelPath);
  }
  summary.fileCount += 1;
}

function addFolderSignal(result: ArchitectureResult, filePath: string, signal: string): void {
  const folder = nearestFolder(filePath, result.folders ?? []);
  if (!folder) return;
  folder.signals = sortedSignals([...folder.signals, signal]);
}

function raiseSupportLevel(result: ArchitectureResult): void {
  if ((result.supportLevel ?? 0) < 3) result.supportLevel = 3;
}

function persistClassified(result: ArchitectureResult, classified: LayerClassification[]): void {
  const sorted = [...classified].sort((a, b) =>
    compareRelPath(a.filePath, b.filePath) || a.role!.localeCompare(b.role!),
  );
  if (sorted.length <= CLASSIFIED_ROLE_CAP) {
    if (sorted.length > 0) result.classified = sorted;
    else delete result.classified;
    return;
  }
  const ranked = [...sorted].sort((a, b) =>
    b.confidence - a.confidence
    || compareRelPath(a.filePath, b.filePath)
    || (a.role ?? '').localeCompare(b.role ?? ''),
  );
  result.classified = ranked.slice(0, CLASSIFIED_ROLE_CAP).sort((a, b) => compareRelPath(a.filePath, b.filePath));
}

/**
 * Apply pack-scoped AST role hits. Path is the prior; syntax confirms.
 * A miss is not a failure — confidence stays at the path prior.
 * Does not invent layers for IaC / contract projects.
 */
export function applyAstRoles(
  result: ArchitectureResult,
  hits: readonly AstRoleHit[],
  opts: { projectPath?: string } = {},
): void {
  if (isLayerSkipped(result)) return;

  const projectPath = opts.projectPath;
  const allowedPacks = result.packIds && result.packIds.length > 0
    ? new Set(result.packIds)
    : null;
  const scoped = allowedPacks
    ? hits.filter((hit) => allowedPacks.has(hit.packId))
    : hits;
  const best = pickBestHits(scoped).filter((hit) => {
    if (projectPath && !pathOwnsFile(projectPath, hit.filePath)) return false;
    return true;
  });
  if (best.length === 0) return;

  const unclassified = new Set((result.unclassifiedFiles ?? []).map(normalizeRelPath));
  const classified = new Map<string, LayerClassification>();
  for (const existing of result.classified ?? []) {
    classified.set(normalizeRelPath(existing.filePath), {
      ...existing,
      signals: [...existing.signals],
    });
  }

  let applied = false;
  for (const hit of best) {
    const state = buildFileState(hit.filePath, result);
    const already = classified.get(hit.filePath);
    if (already?.role === hit.role) {
      continue;
    }

    if (!state.layer) {
      const signals = sortedSignals([`${AST_ROLE_SIGNAL_PREFIX}${hit.role}`, hit.signal]);
      const entry: LayerClassification = {
        filePath: hit.filePath,
        layer: hit.layer,
        confidence: hit.confidence,
        signals,
        role: hit.role,
      };
      classified.set(hit.filePath, entry);
      addFileToLayer(ensureLayer(result, hit.layer), hit.filePath);
      result.totalClassified += 1;
      if (unclassified.delete(hit.filePath) && result.unclassified > 0) {
        result.unclassified -= 1;
      }
      addFolderSignal(result, hit.filePath, `${AST_ROLE_SIGNAL_PREFIX}${hit.role}`);
      applied = true;
      continue;
    }

    if (state.layer === hit.layer) {
      const signals = sortedSignals([
        ...state.signals,
        ...(already?.signals ?? []),
        `${AST_CONFIRM_SIGNAL_PREFIX}${hit.role}`,
        hit.signal,
      ]);
      const confidence = Math.min(1, Math.round((state.confidence + 0.1) * 100) / 100);
      classified.set(hit.filePath, {
        filePath: hit.filePath,
        layer: state.layer,
        confidence,
        signals,
        role: hit.role,
      });
      addFolderSignal(result, hit.filePath, `${AST_CONFIRM_SIGNAL_PREFIX}${hit.role}`);
      applied = true;
      continue;
    }

    // Path is the prior — except when a structural annotation contradicts a
    // filename suffix (`ApiGatewayController.java` that is a JPA @Entity).
    const astOverridesSuffix = hit.role === 'entity'
      && (state.layer === 'routing' || state.layer === 'presentation');
    if (astOverridesSuffix) {
      const previous = state.layer;
      const fromSummary = result.layers.find((l) => l.layer === previous);
      if (fromSummary) {
        const n = normalizeRelPath(hit.filePath);
        const next = fromSummary.files.filter((f) => normalizeRelPath(f) !== n);
        if (next.length !== fromSummary.files.length && fromSummary.fileCount > 0) {
          fromSummary.fileCount -= 1;
        }
        fromSummary.files = next;
      }
      state.layer = hit.layer;
      state.confidence = hit.confidence;
      const signals = sortedSignals([
        ...state.signals,
        ...(already?.signals ?? []),
        `${AST_ROLE_SIGNAL_PREFIX}${hit.role}`,
        'ast-overrides-suffix',
        hit.signal,
      ]);
      classified.set(hit.filePath, {
        filePath: hit.filePath,
        layer: hit.layer,
        confidence: hit.confidence,
        signals,
        role: hit.role,
      });
      addFileToLayer(ensureLayer(result, hit.layer), hit.filePath);
      addFolderSignal(result, hit.filePath, `${AST_ROLE_SIGNAL_PREFIX}${hit.role}`);
      applied = true;
      continue;
    }

    const keepConfidence = state.confidence;
    const signals = sortedSignals([
      ...state.signals,
      ...(already?.signals ?? []),
      `${AST_CONFLICT_SIGNAL_PREFIX}${hit.role}`,
      hit.signal,
    ]);
    classified.set(hit.filePath, {
      filePath: hit.filePath,
      layer: state.layer,
      confidence: keepConfidence,
      signals,
      role: hit.role,
    });
    addFolderSignal(result, hit.filePath, `${AST_CONFLICT_SIGNAL_PREFIX}${hit.role}`);
    applied = true;
  }

  if (!applied) return;

  const remaining = capUnclassifiedFiles([...unclassified]);
  if (remaining) result.unclassifiedFiles = remaining;
  else delete result.unclassifiedFiles;

  persistClassified(result, [...classified.values()].filter((c) => c.role));
  raiseSupportLevel(result);
}

/**
 * Handshake entry: mutate each architecture result from role hits extracted
 * during the graph parse. No-op when architecture was never produced.
 */
export function refineArchitectureWithAstRoles(
  artifact: {
    projects: Array<{
      path: string;
      name: string;
      architecture?: ArchitectureResult;
      architectureMermaid?: string;
    }>;
    solutions?: Array<{ architecture?: ArchitectureResult }>;
    extended?: { architecture?: ArchitectureResult };
  },
  hits: readonly AstRoleHit[],
): void {
  if (hits.length === 0) return;

  for (const project of artifact.projects) {
    if (!project.architecture) continue;
    applyAstRoles(project.architecture, hits, { projectPath: normalizeRelPath(project.path) });
    project.architectureMermaid = mermaidFromArchitecture(project.architecture);
  }

  if (artifact.extended?.architecture) {
    applyAstRoles(artifact.extended.architecture, hits, { projectPath: '.' });
  }

  for (const solution of artifact.solutions ?? []) {
    if (!solution.architecture) continue;
    applyAstRoles(solution.architecture, hits, { projectPath: '.' });
  }
}
