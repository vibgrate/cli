// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import type { ArchitectureLayer, FolderClassification, LayerClassification } from '../../types.js';

/** Histogram share required before a directory itself is labelled. */
export const FOLDER_LAYER_MIN_SHARE = 0.6;
/** Minimum direct classified children of the winning layer. */
export const FOLDER_LAYER_MIN_COUNT = 2;
/** Unclassified source inherits only from a folder at or above this confidence. */
export const FOLDER_INHERIT_MIN_CONFIDENCE = 0.7;
/** Payload sample of remaining unclassified source paths. Absent ≠ []. */
export const UNCLASSIFIED_FILES_CAP = 40;

/**
 * §16.2 signal. Folder inheritance records `graph-conflict:<layer>` when a
 * file-level layer disagrees with its folder prior. Graph confirmation (PR 3)
 * emits the same prefix when a trusted path label disagrees with the neighbourhood.
 */
export const GRAPH_CONFLICT_SIGNAL_PREFIX = 'graph-conflict:';

export function folderConflictSignal(layer: ArchitectureLayer): string {
  return `folder-conflict:${layer}`;
}

export function folderInheritSignal(layer: ArchitectureLayer): string {
  return `folder-inherit:${layer}`;
}

function normalizeRelPath(p: string): string {
  return (p || '.').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '') || '.';
}

function compareRelPath(a: string, b: string): number {
  return normalizeRelPath(a).localeCompare(normalizeRelPath(b));
}

function parentDir(filePath: string): string {
  const n = normalizeRelPath(filePath);
  if (n === '.') return '.';
  const i = n.lastIndexOf('/');
  return i <= 0 ? '.' : n.slice(0, i);
}

/** Ancestors nearest-first. `.` is never an ancestor — a root majority must not stamp the tree. */
function ancestorDirs(filePath: string): string[] {
  const dirs: string[] = [];
  let d = parentDir(filePath);
  while (d !== '.') {
    dirs.push(d);
    d = parentDir(d);
  }
  return dirs;
}

function isUnderFolder(filePath: string, folderPath: string): boolean {
  const f = normalizeRelPath(filePath);
  const dir = normalizeRelPath(folderPath);
  if (dir === '.') return true;
  return f === dir || f.startsWith(`${dir}/`);
}

function sortedSignals(signals: readonly string[]): string[] {
  return [...new Set(signals)].sort((a, b) => a.localeCompare(b));
}

function cloneClassification(c: LayerClassification): LayerClassification {
  const next: LayerClassification = {
    filePath: c.filePath,
    layer: c.layer,
    confidence: c.confidence,
    signals: [...c.signals],
  };
  if (c.role) next.role = c.role;
  return next;
}

interface FolderVote {
  path: string;
  layer: ArchitectureLayer;
  confidence: number;
  signals: string[];
  inheritedFrom?: string;
}

/**
 * Classify directories from direct classified children, inherit labels
 * down the tree, then inherit into still-unclassified source files.
 * Stronger file-level signals always win; disagreements keep the file
 * layer and record `folder-conflict:<folder-layer>`.
 */
export function applyFolderInheritance(input: {
  classified: readonly LayerClassification[];
  unclassifiedSource: readonly string[];
}): {
  classified: LayerClassification[];
  folders: FolderClassification[];
  unclassifiedSource: string[];
} {
  const classified = [...input.classified]
    .map(cloneClassification)
    .sort((a, b) => compareRelPath(a.filePath, b.filePath));
  const unclassified = [...input.unclassifiedSource]
    .map(normalizeRelPath)
    .sort(compareRelPath);

  const sourcePaths = [
    ...classified.map((c) => normalizeRelPath(c.filePath)),
    ...unclassified,
  ].sort(compareRelPath);

  const dirSet = new Set<string>();
  for (const p of sourcePaths) {
    for (const d of ancestorDirs(p)) dirSet.add(d);
  }

  const classifiedByParent = new Map<string, LayerClassification[]>();
  for (const c of classified) {
    const parent = parentDir(c.filePath);
    const list = classifiedByParent.get(parent);
    if (list) list.push(c);
    else classifiedByParent.set(parent, [c]);
  }

  const votes = new Map<string, FolderVote>();

  // Direct-child histogram. Only files that already have a layer vote.
  // Never majority-label `.` — two root files must not become a repo-wide prior.
  for (const dir of dirSet) {
    if (dir === '.') continue;
    const children = classifiedByParent.get(dir) ?? [];
    if (children.length === 0) continue;
    const counts = new Map<ArchitectureLayer, number>();
    for (const child of children) {
      counts.set(child.layer, (counts.get(child.layer) ?? 0) + 1);
    }
    let winner: ArchitectureLayer | undefined;
    let winnerCount = 0;
    for (const [layer, count] of counts) {
      if (
        count > winnerCount
        || (count === winnerCount && winner !== undefined && layer.localeCompare(winner) < 0)
      ) {
        winner = layer;
        winnerCount = count;
      }
    }
    if (!winner) continue;
    const share = winnerCount / children.length;
    if (share < FOLDER_LAYER_MIN_SHARE || winnerCount < FOLDER_LAYER_MIN_COUNT) continue;
    votes.set(dir, {
      path: dir,
      layer: winner,
      confidence: share,
      signals: [`majority:${winner}`],
    });
  }

  // Top-down: a feature folder inherits its ancestor's layer.
  const dirsByDepth = [...dirSet].sort((a, b) => {
    const da = a === '.' ? 0 : a.split('/').length;
    const db = b === '.' ? 0 : b.split('/').length;
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });
  for (const dir of dirsByDepth) {
    if (votes.has(dir)) continue;
    for (const ancestor of ancestorDirs(dir)) {
      if (ancestor === dir || ancestor === '.') continue;
      const parent = votes.get(ancestor);
      if (!parent) continue;
      votes.set(dir, {
        path: dir,
        layer: parent.layer,
        confidence: parent.confidence,
        signals: [`inherited:${parent.path}`],
        inheritedFrom: parent.path,
      });
      break;
    }
  }

  function nearestFolder(filePath: string): FolderVote | undefined {
    for (const ancestor of ancestorDirs(filePath)) {
      const folder = votes.get(ancestor);
      if (folder) return folder;
    }
    return undefined;
  }

  const stillUnclassified: string[] = [];
  for (const file of unclassified) {
    const folder = nearestFolder(file);
    if (folder && folder.confidence >= FOLDER_INHERIT_MIN_CONFIDENCE) {
      classified.push({
        filePath: file,
        layer: folder.layer,
        confidence: folder.confidence,
        signals: [folderInheritSignal(folder.layer)],
      });
    } else {
      stillUnclassified.push(file);
    }
  }
  classified.sort((a, b) => compareRelPath(a.filePath, b.filePath));

  for (const c of classified) {
    const folder = nearestFolder(c.filePath);
    if (!folder || folder.layer === c.layer) continue;
    // File-level signal wins. Record the folder layer it disagreed with.
    // `graph-conflict:` is the §16.2 placeholder until PR 3 has a neighbourhood.
    c.signals = sortedSignals([
      ...c.signals,
      folderConflictSignal(folder.layer),
      `${GRAPH_CONFLICT_SIGNAL_PREFIX}${folder.layer}`,
    ]);
    folder.signals = sortedSignals([...folder.signals, folderConflictSignal(folder.layer)]);
  }

  const folders: FolderClassification[] = [...votes.values()]
    .map((vote) => {
      const fileCount = classified.filter((c) => c.layer === vote.layer && isUnderFolder(c.filePath, vote.path)).length;
      return {
        path: vote.path,
        layer: vote.layer,
        confidence: vote.confidence,
        fileCount,
        signals: sortedSignals(vote.signals),
      };
    })
    .sort((a, b) => compareRelPath(a.path, b.path));

  return {
    classified,
    folders,
    unclassifiedSource: stillUnclassified.sort(compareRelPath),
  };
}

export function capUnclassifiedFiles(files: readonly string[]): string[] | undefined {
  if (files.length === 0) return undefined;
  const sorted = [...files].map(normalizeRelPath).sort(compareRelPath);
  return sorted.slice(0, UNCLASSIFIED_FILES_CAP);
}

export function mergeFolderClassifications(
  groups: readonly (readonly FolderClassification[] | undefined)[],
): FolderClassification[] | undefined {
  const byPath = new Map<string, FolderClassification>();
  for (const group of groups) {
    if (!group) continue;
    for (const folder of group) {
      const key = normalizeRelPath(folder.path);
      const existing = byPath.get(key);
      if (!existing) {
        byPath.set(key, {
          path: key,
          layer: folder.layer,
          confidence: folder.confidence,
          fileCount: folder.fileCount,
          signals: sortedSignals(folder.signals),
        });
        continue;
      }
      if (existing.layer === folder.layer) {
        existing.fileCount += folder.fileCount;
        if (folder.confidence > existing.confidence) existing.confidence = folder.confidence;
        existing.signals = sortedSignals([...existing.signals, ...folder.signals]);
        continue;
      }
      const takeIncoming =
        folder.confidence > existing.confidence
        || (folder.confidence === existing.confidence && folder.layer.localeCompare(existing.layer) < 0);
      if (takeIncoming) {
        byPath.set(key, {
          path: key,
          layer: folder.layer,
          confidence: folder.confidence,
          fileCount: folder.fileCount,
          signals: sortedSignals(folder.signals),
        });
      }
    }
  }
  if (byPath.size === 0) return undefined;
  return [...byPath.values()].sort((a, b) => compareRelPath(a.path, b.path));
}

export function mergeUnclassifiedFiles(
  groups: readonly (readonly string[] | undefined)[],
): string[] | undefined {
  const files = new Set<string>();
  for (const group of groups) {
    if (!group) continue;
    for (const f of group) files.add(normalizeRelPath(f));
  }
  return capUnclassifiedFiles([...files]);
}
