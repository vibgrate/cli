// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import type {
  ArchitectureLayer,
  ArchitectureResult,
  ArchitectureStructure,
  ArchitectureViolation,
  ArchitectureWorkspaceEdge,
  FolderClassification,
  LayerSummary,
} from '../../types.js';
import {
  capUnclassifiedFiles,
  FOLDER_INHERIT_MIN_CONFIDENCE,
  folderInheritSignal,
  GRAPH_CONFLICT_SIGNAL_PREFIX,
} from './folders.js';
import { capViolations, capWorkspaceEdges } from './fusion.js';
import { mermaidFromArchitecture } from './mermaid.js';

/** Narrow graph view so core-open does not import the engine schema. */
export interface ArchitectureGraphNode {
  id: string;
  file: string;
  kind?: string;
}

export interface ArchitectureGraphEdge {
  src: string;
  dst: string;
  kind: string;
  confidence: number;
  resolution?: string;
}

export interface ArchitectureGraphView {
  nodes: readonly ArchitectureGraphNode[];
  edges: readonly ArchitectureGraphEdge[];
}

export interface ArchitectureRefineProject {
  path: string;
  name: string;
}

const PATH_TRUST_MIN = 0.6;
const NEIGHBORHOOD_SHARE = 0.8;
const GRAPH_ASSIGN_CONFIDENCE = 0.65;
const DEFAULT_PATH_CONFIDENCE = 0.75;
const LAYER_FILES_CAP = 40;

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

const LAYERED_STACK: readonly ArchitectureLayer[] = [
  'presentation', 'routing', 'middleware', 'services', 'domain',
  'data-access', 'infrastructure',
];

const LAYERED_RANK = new Map<ArchitectureLayer, number>(
  LAYERED_STACK.map((layer, i) => [layer, i]),
);

const EXEMPT_LAYERS = new Set<ArchitectureLayer>(['config', 'shared', 'testing']);
const IGNORE_EDGE_KINDS = new Set(['contains', 'test', 'coverage']);
const WORKSPACE_EDGE_KINDS = new Set(['deploys', 'provisions']);
const BOUNDARY_EDGE_KINDS = new Set(['import', 'call']);

const CLEAN_PROFILES = new Set(['clean', 'hexagonal', 'onion']);

export const GRAPH_OVERRIDE_SIGNAL = 'graph-override';
export const GRAPH_NEIGHBORHOOD_SIGNAL = 'graph-neighborhood';
export const GRAPH_CONFIRM_SIGNAL = 'graph-confirm';

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

function owningProjectPath(file: string, projectPaths: readonly string[]): string {
  let best = '.';
  let bestLen = -1;
  for (const raw of projectPaths) {
    const p = normalizeRelPath(raw);
    if (!pathOwnsFile(p, file)) continue;
    const len = p === '.' ? 0 : p.length;
    if (len > bestLen) {
      best = p;
      bestLen = len;
    }
  }
  return best;
}

function sortedSignals(signals: readonly string[]): string[] {
  return [...new Set(signals)].sort((a, b) => a.localeCompare(b));
}

function isLayerSkipped(result: ArchitectureResult): boolean {
  return result.projectKind === 'iac'
    || result.projectKind === 'contract'
    || result.artifactKind === 'infrastructure-definition'
    || result.artifactKind === 'contract';
}

interface FileLayerState {
  filePath: string;
  layer?: ArchitectureLayer;
  confidence: number;
  signals: string[];
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

function buildFileState(
  filePath: string,
  result: ArchitectureResult,
): FileLayerState {
  const n = normalizeRelPath(filePath);
  const sampleLayer = fileInLayerSample(result, n);
  const folder = nearestFolder(n, result.folders ?? []);
  if (sampleLayer) {
    const confidence = folder && folder.layer === sampleLayer
      ? folder.confidence
      : folder && folder.layer !== sampleLayer
        ? Math.max(DEFAULT_PATH_CONFIDENCE, 0.85)
        : DEFAULT_PATH_CONFIDENCE;
    return { filePath: n, layer: sampleLayer, confidence, signals: [] };
  }
  // Same threshold as PR 2: a folder at 0.60–0.69 is labelled, not inherited.
  if (folder && folder.confidence >= FOLDER_INHERIT_MIN_CONFIDENCE) {
    return {
      filePath: n,
      layer: folder.layer,
      confidence: folder.confidence,
      signals: [folderInheritSignal(folder.layer)],
    };
  }
  return { filePath: n, layer: undefined, confidence: 0, signals: [] };
}

function collectKnownFiles(result: ArchitectureResult): string[] {
  const files = new Set<string>();
  for (const layer of result.layers) {
    for (const f of layer.files) files.add(normalizeRelPath(f));
  }
  for (const f of result.unclassifiedFiles ?? []) files.add(normalizeRelPath(f));
  return [...files];
}

interface GraphIndex {
  nodeFile: Map<string, string>;
  fileNodes: Map<string, string[]>;
  outboundImport: Map<string, ArchitectureGraphEdge[]>;
  inboundCall: Map<string, ArchitectureGraphEdge[]>;
}

function pushEdge(map: Map<string, ArchitectureGraphEdge[]>, key: string, edge: ArchitectureGraphEdge): void {
  const list = map.get(key);
  if (list) list.push(edge);
  else map.set(key, [edge]);
}

function indexGraph(graph: ArchitectureGraphView): GraphIndex {
  const nodeFile = new Map<string, string>();
  const fileNodes = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (!node.file) continue;
    const file = normalizeRelPath(node.file);
    nodeFile.set(node.id, file);
    const list = fileNodes.get(file);
    if (list) list.push(node.id);
    else fileNodes.set(file, [node.id]);
  }

  const outboundImport = new Map<string, ArchitectureGraphEdge[]>();
  const inboundCall = new Map<string, ArchitectureGraphEdge[]>();
  for (const edge of graph.edges) {
    if (IGNORE_EDGE_KINDS.has(edge.kind)) continue;
    if (edge.kind !== 'import' && edge.kind !== 'call') continue;
    const srcFile = nodeFile.get(edge.src);
    const dstFile = nodeFile.get(edge.dst);
    if (!srcFile || !dstFile || srcFile === dstFile) continue;
    if (edge.kind === 'import') pushEdge(outboundImport, srcFile, edge);
    else pushEdge(inboundCall, dstFile, edge);
  }
  return { nodeFile, fileNodes, outboundImport, inboundCall };
}

interface NeighbourVote {
  layer: ArchitectureLayer;
  file: string;
  kind: string;
  resolution: string;
}

function neighbourhoodVotes(
  filePath: string,
  index: GraphIndex,
  stateOf: (file: string) => FileLayerState,
): NeighbourVote[] {
  const votes: NeighbourVote[] = [];
  const seen = new Set<string>();

  const consider = (neighbour: string | undefined, edge: ArchitectureGraphEdge): void => {
    if (!neighbour || neighbour === filePath) return;
    const neighbourState = stateOf(neighbour);
    if (!neighbourState.layer) return;
    const key = `${edge.kind}|${neighbour}|${neighbourState.layer}`;
    if (seen.has(key)) return;
    seen.add(key);
    votes.push({
      layer: neighbourState.layer,
      file: neighbour,
      kind: edge.kind,
      resolution: edge.resolution ?? 'unknown',
    });
  };

  for (const edge of index.outboundImport.get(filePath) ?? []) {
    consider(index.nodeFile.get(edge.dst), edge);
  }
  for (const edge of index.inboundCall.get(filePath) ?? []) {
    consider(index.nodeFile.get(edge.src), edge);
  }
  return votes;
}

function majorityLayer(votes: readonly NeighbourVote[]): { layer: ArchitectureLayer; share: number; kind: string; neighbour: string } | undefined {
  if (votes.length === 0) return undefined;
  const counts = new Map<ArchitectureLayer, { count: number; kind: string; neighbour: string }>();
  for (const vote of votes) {
    const existing = counts.get(vote.layer);
    if (existing) {
      existing.count += 1;
      if (vote.file.localeCompare(existing.neighbour) < 0) existing.neighbour = vote.file;
    } else {
      counts.set(vote.layer, { count: 1, kind: vote.kind, neighbour: vote.file });
    }
  }
  let winner: ArchitectureLayer | undefined;
  let winnerCount = 0;
  let winnerKind = 'import';
  let winnerNeighbour = '';
  for (const [layer, info] of counts) {
    if (
      info.count > winnerCount
      || (info.count === winnerCount && winner !== undefined && layer.localeCompare(winner) < 0)
    ) {
      winner = layer;
      winnerCount = info.count;
      winnerKind = info.kind;
      winnerNeighbour = info.neighbour;
    }
  }
  if (!winner) return undefined;
  return { layer: winner, share: winnerCount / votes.length, kind: winnerKind, neighbour: winnerNeighbour };
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

function removeFileFromLayer(summary: LayerSummary, filePath: string): void {
  const n = normalizeRelPath(filePath);
  const next = summary.files.filter((f) => normalizeRelPath(f) !== n);
  if (next.length === summary.files.length) return;
  summary.files = next;
  if (summary.fileCount > 0) summary.fileCount -= 1;
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

function looksLikeCleanNames(projects: readonly ArchitectureRefineProject[], result: ArchitectureResult): boolean {
  const haystacks: string[] = [];
  for (const p of projects) {
    haystacks.push(p.name, p.path);
  }
  for (const folder of result.folders ?? []) haystacks.push(folder.path);
  for (const layer of result.layers) {
    for (const f of layer.files) haystacks.push(f);
  }
  const joined = haystacks.join('\n');
  const hasDomain = /(^|[/\s.])domain([/\s.]|$)/i.test(joined);
  const hasApplication = /(^|[/\s.])application([/\s.]|$)/i.test(joined);
  const hasInfrastructure = /(^|[/\s.])infrastructure([/\s.]|$)/i.test(joined);
  return hasDomain && hasApplication && hasInfrastructure;
}

function layerFileCount(result: ArchitectureResult): number {
  return result.layers.filter((l) => l.fileCount > 0 && !EXEMPT_LAYERS.has(l.layer)).length;
}

function inferStructure(
  result: ArchitectureResult,
  projects: readonly ArchitectureRefineProject[],
): ArchitectureStructure | undefined {
  const evidencePrimary = result.evidence
    ?.filter((e) => e.dimension === 'structure')
    .slice()
    .sort((a, b) => b.confidence - a.confidence || a.value.localeCompare(b.value))[0];

  if (looksLikeCleanNames(projects, result)) {
    const characteristics: string[] = [];
    if (evidencePrimary && evidencePrimary.value !== 'clean' && evidencePrimary.confidence >= 0.5) {
      characteristics.push(evidencePrimary.value);
    }
    return {
      primary: 'clean',
      characteristics: characteristics.sort((a, b) => a.localeCompare(b)),
      confidence: 0.8,
    };
  }

  if (evidencePrimary) {
    return {
      primary: evidencePrimary.value,
      characteristics: [],
      confidence: evidencePrimary.confidence,
    };
  }

  if (layerFileCount(result) >= 3) {
    return { primary: 'layered', characteristics: [], confidence: 0.6 };
  }
  return undefined;
}

function selectBoundaryProfile(structure: ArchitectureStructure | undefined, result: ArchitectureResult): string | undefined {
  const primary = structure?.primary;
  if (primary && CLEAN_PROFILES.has(primary)) return primary;
  if (primary === 'vertical-slice' || primary === 'mvc' || primary === 'mvvm' || primary === 'layered') {
    return primary;
  }
  if (layerFileCount(result) >= 3) return 'layered';
  return undefined;
}

function sliceOf(filePath: string): string | undefined {
  const m = normalizeRelPath(filePath).match(/(?:^|\/)(?:features|modules|slices)\/([^/]+)/i);
  return m?.[1]?.toLowerCase();
}

function isSliceInternal(filePath: string): boolean {
  const base = normalizeRelPath(filePath).split('/').pop() ?? '';
  return !/^(index|public|api|mod)\.[^./]+$/i.test(base);
}

function isIllegalEdge(profile: string, from: ArchitectureLayer, to: ArchitectureLayer, fromFile: string, toFile: string): { illegal: boolean; rule: string } {
  if (from === to) return { illegal: false, rule: '' };

  if (CLEAN_PROFILES.has(profile)) {
    if (from === 'domain' && (to === 'data-access' || to === 'infrastructure')) {
      return { illegal: true, rule: `${profile}:domain→${to}` };
    }
    return { illegal: false, rule: '' };
  }

  if (profile === 'vertical-slice') {
    const fromSlice = sliceOf(fromFile);
    const toSlice = sliceOf(toFile);
    if (fromSlice && toSlice && fromSlice !== toSlice && isSliceInternal(toFile)) {
      return { illegal: true, rule: 'vertical-slice:cross-slice-internal' };
    }
    return { illegal: false, rule: '' };
  }

  if (profile === 'layered' || profile === 'mvc' || profile === 'mvvm') {
    if (EXEMPT_LAYERS.has(from) || EXEMPT_LAYERS.has(to)) return { illegal: false, rule: '' };
    const a = LAYERED_RANK.get(from);
    const b = LAYERED_RANK.get(to);
    if (a === undefined || b === undefined) return { illegal: false, rule: '' };
    if (a > b) return { illegal: true, rule: `${profile}:upward:${from}→${to}` };
    return { illegal: false, rule: '' };
  }

  return { illegal: false, rule: '' };
}

function sameOwningProject(
  fromFile: string,
  toFile: string,
  projectPath: string | undefined,
  projects: readonly ArchitectureRefineProject[],
): boolean {
  if (projects.length > 0) {
    const paths = projects.map((p) => p.path);
    return owningProjectPath(fromFile, paths) === owningProjectPath(toFile, paths);
  }
  if (projectPath) {
    return pathOwnsFile(projectPath, fromFile) && pathOwnsFile(projectPath, toFile);
  }
  return true;
}

function fileInScope(filePath: string, projectPath: string | undefined): boolean {
  if (!projectPath || projectPath === '.') return true;
  return pathOwnsFile(projectPath, filePath);
}

function applyConfirmation(
  result: ArchitectureResult,
  graph: ArchitectureGraphView,
  projectPath: string | undefined,
  index: GraphIndex,
): { conflicts: ArchitectureViolation[]; states: Map<string, FileLayerState> } {
  if (isLayerSkipped(result)) return { conflicts: [], states: new Map() };

  const unclassified = new Set((result.unclassifiedFiles ?? []).map(normalizeRelPath));
  const known = new Set(collectKnownFiles(result));
  for (const file of index.fileNodes.keys()) {
    if (fileInScope(file, projectPath)) known.add(file);
  }

  const states = new Map<string, FileLayerState>();
  const stateOf = (file: string): FileLayerState => {
    const n = normalizeRelPath(file);
    const existing = states.get(n);
    if (existing) return existing;
    const built = buildFileState(n, result);
    states.set(n, built);
    return built;
  };

  for (const file of known) stateOf(file);

  const conflicts: ArchitectureViolation[] = [];
  const scopedFiles = [...known].filter((f) => fileInScope(f, projectPath)).sort(compareRelPath);

  for (const file of scopedFiles) {
    const state = stateOf(file);
    const votes = neighbourhoodVotes(file, index, stateOf);
    const majority = majorityLayer(votes);
    if (!majority || majority.share < NEIGHBORHOOD_SHARE) continue;

    const heuristic = votes.some((v) => v.resolution === 'heuristic');
    const extra = heuristic ? ['heuristic'] : [];

    if (!state.layer) {
      state.layer = majority.layer;
      state.confidence = GRAPH_ASSIGN_CONFIDENCE;
      state.signals = sortedSignals([GRAPH_NEIGHBORHOOD_SIGNAL, ...extra]);
      const target = ensureLayer(result, majority.layer);
      addFileToLayer(target, file);
      result.totalClassified += 1;
      unclassified.delete(file);
      if (result.unclassified > 0) result.unclassified -= 1;
      addFolderSignal(result, file, GRAPH_NEIGHBORHOOD_SIGNAL);
      continue;
    }

    if (state.layer === majority.layer) {
      if (state.confidence >= PATH_TRUST_MIN) {
        state.confidence = Math.min(1, Math.round((state.confidence + 0.1) * 100) / 100);
        state.signals = sortedSignals([...state.signals, GRAPH_CONFIRM_SIGNAL, ...extra]);
        addFolderSignal(result, file, GRAPH_CONFIRM_SIGNAL);
      }
      continue;
    }

    if (state.confidence < PATH_TRUST_MIN) {
      const previous = state.layer;
      const fromSummary = result.layers.find((l) => l.layer === previous);
      if (fromSummary) removeFileFromLayer(fromSummary, file);
      state.layer = majority.layer;
      state.confidence = GRAPH_ASSIGN_CONFIDENCE;
      state.signals = sortedSignals([...state.signals, GRAPH_OVERRIDE_SIGNAL, ...extra]);
      addFileToLayer(ensureLayer(result, majority.layer), file);
      addFolderSignal(result, file, GRAPH_OVERRIDE_SIGNAL);
      continue;
    }

    const conflictSignal = `${GRAPH_CONFLICT_SIGNAL_PREFIX}${majority.layer}`;
    state.signals = sortedSignals([...state.signals, conflictSignal, ...extra]);
    addFolderSignal(result, file, conflictSignal);
    conflicts.push({
      fromFile: file,
      toFile: majority.neighbour,
      fromLayer: state.layer,
      toLayer: majority.layer,
      edgeKind: majority.kind,
      rule: conflictSignal,
      confidence: Math.round(majority.share * 100) / 100,
    });
  }

  const remaining = capUnclassifiedFiles([...unclassified]);
  if (remaining) result.unclassifiedFiles = remaining;
  else delete result.unclassifiedFiles;

  return { conflicts, states };
}

function collectBoundaryViolations(
  result: ArchitectureResult,
  graph: ArchitectureGraphView,
  profile: string | undefined,
  projectPath: string | undefined,
  projects: readonly ArchitectureRefineProject[],
  states: Map<string, FileLayerState>,
  index: GraphIndex,
): ArchitectureViolation[] {
  if (!profile || isLayerSkipped(result)) return [];
  const seen = new Set<string>();
  const out: ArchitectureViolation[] = [];

  for (const edge of graph.edges) {
    if (!BOUNDARY_EDGE_KINDS.has(edge.kind)) continue;
    const fromFile = index.nodeFile.get(edge.src);
    const toFile = index.nodeFile.get(edge.dst);
    if (!fromFile || !toFile || fromFile === toFile) continue;
    if (!fileInScope(fromFile, projectPath) || !fileInScope(toFile, projectPath)) continue;
    if (!sameOwningProject(fromFile, toFile, projectPath, projects)) continue;

    const fromState = states.get(fromFile);
    const toState = states.get(toFile);
    if (!fromState?.layer || !toState?.layer) continue;

    const { illegal, rule } = isIllegalEdge(profile, fromState.layer, toState.layer, fromFile, toFile);
    if (!illegal) continue;
    const key = `${fromFile}|${toFile}|${rule}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      fromFile,
      toFile,
      fromLayer: fromState.layer,
      toLayer: toState.layer,
      edgeKind: edge.kind,
      rule,
      confidence: Math.round(Math.min(fromState.confidence, toState.confidence, edge.confidence) * 100) / 100,
    });
  }
  return out;
}

function graphWorkspaceEdges(
  graph: ArchitectureGraphView,
  projects: readonly ArchitectureRefineProject[],
  index: GraphIndex,
): ArchitectureWorkspaceEdge[] {
  if (projects.length === 0) return [];
  const { nodeFile } = index;
  const paths = projects.map((p) => p.path);
  const edges: ArchitectureWorkspaceEdge[] = [];
  const seen = new Set<string>();

  for (const edge of graph.edges) {
    if (!WORKSPACE_EDGE_KINDS.has(edge.kind)) continue;
    const fromFile = nodeFile.get(edge.src);
    const toFile = nodeFile.get(edge.dst);
    if (!fromFile || !toFile) continue;
    const fromProject = owningProjectPath(fromFile, paths);
    const toProject = owningProjectPath(toFile, paths);
    const kind = edge.kind as ArchitectureWorkspaceEdge['kind'];
    const key = `${kind}|${fromProject}|${toProject}|${fromFile}|${toFile}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      kind,
      fromProject,
      toProject,
      fromFile,
      toFile,
      confidence: edge.confidence,
    });
  }
  return edges;
}

function applyViolations(result: ArchitectureResult, violations: readonly ArchitectureViolation[]): void {
  const capped = capViolations(violations);
  result.violations = capped.violations;
  if (capped.violationsCapped) result.violationsCapped = true;
  else delete result.violationsCapped;
}

function applyStructureAndProfile(
  result: ArchitectureResult,
  projects: readonly ArchitectureRefineProject[],
): string | undefined {
  const structure = inferStructure(result, projects);
  if (structure) result.structure = structure;
  else delete result.structure;
  const profile = selectBoundaryProfile(structure, result);
  if (profile) result.boundaryProfile = profile;
  else delete result.boundaryProfile;
  return profile;
}

/**
 * Confirm / override layers from a narrow graph view and emit intra-project
 * boundary violations. Always writes `violations` (possibly `[]`) — absent is
 * reserved for callers that never pass a graph.
 */
export function refineArchitectureResult(
  result: ArchitectureResult,
  graph: ArchitectureGraphView,
  opts: {
    projectPath?: string;
    projects?: readonly ArchitectureRefineProject[];
    attachWorkspaceEdges?: boolean;
  } = {},
): void {
  const projects = opts.projects ?? [];
  const projectPath = opts.projectPath;
  const index = indexGraph(graph);
  const { conflicts, states } = applyConfirmation(result, graph, projectPath, index);
  const profile = applyStructureAndProfile(result, projects.length > 0 ? projects : [{ path: projectPath ?? '.', name: '' }]);
  const boundary = collectBoundaryViolations(result, graph, profile, projectPath, projects, states, index);
  applyViolations(result, [...conflicts, ...boundary]);

  if (opts.attachWorkspaceEdges) {
    const incoming = graphWorkspaceEdges(graph, projects, index);
    if (incoming.length > 0) {
      const merged = capWorkspaceEdges([...(result.workspaceEdges ?? []), ...incoming]);
      if (merged.workspaceEdges) result.workspaceEdges = merged.workspaceEdges;
      if (merged.workspaceEdgesCapped) result.workspaceEdgesCapped = true;
    }
  }
}

/**
 * Handshake entry: mutate `extended.architecture` and each `project.architecture`
 * (and solution aggregates) from a already-built map. No-op when architecture
 * was never produced. Does not invent `violations` on artifacts that have no
 * architecture result.
 */
export function refineArchitectureWithGraph(
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
  graph: ArchitectureGraphView,
): void {
  const projects: ArchitectureRefineProject[] = artifact.projects.map((p) => ({
    path: normalizeRelPath(p.path),
    name: p.name,
  }));

  for (const project of artifact.projects) {
    if (!project.architecture) continue;
    refineArchitectureResult(project.architecture, graph, {
      projectPath: normalizeRelPath(project.path),
      projects,
    });
    project.architectureMermaid = mermaidFromArchitecture(project.architecture);
  }

  if (artifact.extended?.architecture) {
    refineArchitectureResult(artifact.extended.architecture, graph, {
      projectPath: '.',
      projects,
      attachWorkspaceEdges: true,
    });
  }

  for (const solution of artifact.solutions ?? []) {
    if (!solution.architecture) continue;
    refineArchitectureResult(solution.architecture, graph, {
      projectPath: '.',
      projects,
    });
  }
}
