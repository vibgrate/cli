/**
 * The Analysis Capsule compiler (`vg.analysis.capsule.v1`).
 *
 * Turns the code map + the change set into a *bounded evidence packet*: the
 * facts a reviewer (deterministic or model) needs to judge this change, and
 * nothing else. It is emphatically not a repository dump — budgets are enforced
 * here (spec §4.1), and only spans required to disambiguate a fact are carried.
 *
 * The capsule owns facts. It never owns intent and never owns the decision.
 */

import { classifyFile } from '../core-open/scanners/architecture/classify.js';
import { boundaryProfileRules } from '../core-open/scanners/architecture/graph-refine.js';
import { classifyDataAccess, type DataAccessPattern } from './dimensions.js';
import { MIN_GROUP_SIZE, voteAll, type DominanceVote, type PeerFile } from './dominance.js';
import type { DeclaredIntent } from './intent.js';
import type { ArchitectureLayer } from '../core-open/types.js';
import type { GraphEdge, GraphNode, VgGraph } from '../schema.js';
import { VERSION } from '../version.js';
import type { ReviewConfig } from './config.js';
import { isIntroducedEdge, removedDestinations } from './delta.js';
import type { ChangeSet, ChangedFile } from './git.js';
import {
  CAPSULE_BUDGETS,
  CAPSULE_SCHEMA,
  MAX_ROLE_PEERS,
  digestString,
  type AnalysisCapsule,
  type CapsuleChangeEdge,
  type CapsuleChangeSymbol,
  type CapsuleEvidence,
  type CapsuleProfile,
  type CapsuleRole,
} from './schemas.js';

/**
 * Edge kinds that carry an architectural dependency.
 *
 * `references` is included alongside `import` and `call`, which is where this
 * departs from the graph refiner's narrower set. A field or constructor
 * parameter typed as a concrete repository is a *compile-time* coupling across
 * the boundary — often the only edge there is, because the controller never
 * calls the type in the changed hunk, it just holds one. Excluding it meant a
 * Clean Architecture repository whose controller newed up a repository produced
 * no boundary finding at all, which is the violation the style exists to
 * prevent.
 */
const BOUNDARY_EDGE_KINDS = new Set(['import', 'call', 'references']);

/** Layers exempt from boundary reasoning — config/shared/testing are not tiers. */
const EXEMPT_LAYERS = new Set<ArchitectureLayer>(['config', 'shared', 'testing']);

export interface CompileCapsuleInput {
  root: string;
  graph: VgGraph | null;
  change: ChangeSet;
  config: ReviewConfig;
  profile: CapsuleProfile;
  repoPseudonym: string;
  /** Days since last commit per repo-relative path — drives temporal weighting. */
  recencyDays?: Map<string, number>;
  /** What humans declared in CLAUDE.md / AGENTS.md, seeding the vote. */
  intent?: DeclaredIntent;
  /**
   * `git show <base>:path` text for changed files. Occupancy filter: an edge
   * that the base already referenced is not an `added_edge`.
   */
  baseFileText?: Map<string, string>;
  /** Working-tree / HEAD text of changed files (for removed-edge detection). */
  headFileText?: Map<string, string>;
}

export interface CompiledCapsule {
  capsule: AnalysisCapsule;
  /** Peer votes for the changed files' groups — consumed by the scanners. */
  votes: DominanceVote[];
  /** Every file's data-access label, so a scanner can compare a changed file to its peers. */
  dataAccess: Map<string, DataAccessPattern>;
  /** Facts the capsule could not establish — carried into `findings.unknowns`. */
  unknowns: string[];
  /** Rough token estimate for the compiled capsule, against its budget. */
  estimatedTokens: number;
  budget: { median: number; cap: number };
  trimmed: boolean;
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Does a graph node's span intersect any changed hunk in its file? */
function nodeTouchedByChange(node: GraphNode, file: ChangedFile): boolean {
  if (file.hunks.length === 0) return true; // whole-file add/remove
  return file.hunks.some((h) => node.span.start <= h.end && node.span.end >= h.start);
}

/** Coarse token estimate: canonical JSON length / 4. Good enough to budget on. */
function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

export function compileCapsule(input: CompileCapsuleInput): CompiledCapsule {
  const { graph, change, config, profile } = input;
  const unknowns: string[] = [];
  const evidence: CapsuleEvidence[] = [];
  const seenEvidence = new Set<string>();

  const addEvidence = (e: CapsuleEvidence): string => {
    if (!seenEvidence.has(e.id)) {
      seenEvidence.add(e.id);
      evidence.push(e);
    }
    return e.id;
  };

  const changedPaths = new Set(change.files.map((f) => normalize(f.path)));
  const changedByPath = new Map(change.files.map((f) => [normalize(f.path), f]));

  // ── Layers for every path we will reason about ───────────────────────────
  const layerOf = new Map<string, { layer: ArchitectureLayer; confidence: number; role?: string }>();
  const classify = (p: string): { layer: ArchitectureLayer; confidence: number; role?: string } | null => {
    const cached = layerOf.get(p);
    if (cached) return cached;
    const cls = classifyFile(p, 'unknown');
    if (!cls) return null;
    const value = { layer: cls.layer, confidence: cls.confidence, role: cls.role };
    layerOf.set(p, value);
    return value;
  };

  // ── Changed symbols (graph nodes intersecting a changed hunk) ────────────
  const symbols: CapsuleChangeSymbol[] = [];
  const changedNodeIds = new Set<string>();
  const nodesByFile = new Map<string, GraphNode[]>();
  if (graph) {
    for (const node of graph.nodes) {
      const file = normalize(node.file);
      let bucket = nodesByFile.get(file);
      if (!bucket) nodesByFile.set(file, (bucket = []));
      bucket.push(node);
    }
    for (const path of [...changedPaths].sort()) {
      const file = changedByPath.get(path)!;
      for (const node of nodesByFile.get(path) ?? []) {
        if (node.kind === 'file' || node.kind === 'document') continue;
        if (!nodeTouchedByChange(node, file)) continue;
        changedNodeIds.add(node.id);
        symbols.push({
          node_id: node.id,
          name: node.name,
          kind: node.kind,
          path,
          start_line: node.span.start,
          end_line: node.span.end,
        });
      }
    }
  }

  // ── Dependency edges out of the change set ───────────────────────────────
  const addedEdges: CapsuleChangeEdge[] = [];
  const removedEdges: CapsuleChangeEdge[] = [];
  const nodeById = new Map<string, GraphNode>();
  if (graph) for (const n of graph.nodes) nodeById.set(n.id, n);

  const edgeEvidenceId = (e: GraphEdge): string => `edge:${e.id.slice(0, 12)}`;
  const seenAdded = new Set<string>();

  if (graph) {
    for (const edge of graph.edges) {
      if (!BOUNDARY_EDGE_KINDS.has(edge.kind)) continue;
      const src = nodeById.get(edge.src);
      const dst = nodeById.get(edge.dst);
      if (!src || !dst) continue;
      const fromPath = normalize(src.file);
      const toPath = normalize(dst.file);
      if (fromPath === toPath) continue;
      // Only edges the change actually touches — this is the budget lever.
      if (!changedNodeIds.has(edge.src)) continue;
      const file = changedByPath.get(fromPath);
      const op = file?.op ?? 'modified';
      const baseText = input.baseFileText?.get(fromPath);
      if (!isIntroducedEdge(op, fromPath, toPath, baseText)) continue;
      const pair = `${fromPath}\0${toPath}\0${edge.kind}`;
      if (seenAdded.has(pair)) continue;
      seenAdded.add(pair);
      const from = classify(fromPath);
      const to = classify(toPath);
      const id = addEvidence({
        id: edgeEvidenceId(edge),
        kind: 'graph_edge',
        path: fromPath,
        start_line: src.span.start,
        end_line: src.span.end,
        protected_finding: false,
        note: `${edge.kind} → ${toPath}`,
      });
      addedEdges.push({
        evidence_id: id,
        kind: edge.kind,
        from_path: fromPath,
        to_path: toPath,
        from_layer: from?.layer,
        to_layer: to?.layer,
      });
    }

    const knownFiles = [...nodesByFile.keys()];
    let removedN = 0;
    for (const file of change.files) {
      const fromPath = normalize(file.path);
      const baseText = input.baseFileText?.get(fromPath);
      const headText = input.headFileText?.get(fromPath);
      if (baseText === undefined || headText === undefined) continue;
      for (const toPath of removedDestinations(fromPath, baseText, headText, knownFiles)) {
        removedN++;
        const from = classify(fromPath);
        const to = classify(toPath);
        const id = addEvidence({
          id: `edge:removed:${removedN}`,
          kind: 'graph_edge',
          path: fromPath,
          protected_finding: false,
          note: `removed → ${toPath}`,
        });
        removedEdges.push({
          evidence_id: id,
          kind: 'import',
          from_path: fromPath,
          to_path: toPath,
          from_layer: from?.layer,
          to_layer: to?.layer,
        });
      }
    }
  }

  // ── Roles (changed files, plus up to MAX_ROLE_PEERS equivalents each) ─────
  const roles: CapsuleRole[] = [];
  const roleCounter = new Map<string, number>();
  const roleEvidenceId = (role: string): string => {
    const n = (roleCounter.get(role) ?? 0) + 1;
    roleCounter.set(role, n);
    return `role:${role}:${n}`;
  };
  const emitRole = (path: string, changed: boolean): void => {
    const cls = classify(path);
    if (!cls) return;
    const role = cls.role ?? cls.layer;
    const id = addEvidence({
      id: roleEvidenceId(role),
      kind: 'role',
      path,
      protected_finding: false,
      note: `${role} (${cls.layer}, confidence ${cls.confidence.toFixed(2)})`,
    });
    roles.push({ evidence_id: id, path, role, layer: cls.layer, confidence: cls.confidence, changed });
  };

  for (const path of [...changedPaths].sort()) emitRole(path, true);

  // Peers: files sharing a changed file's role, so "is this the house style?"
  // is answerable. Capped hard — peers are context, not a corpus.
  const peerPool = graph ? [...nodesByFile.keys()].sort() : [];
  const changedRoles = new Set(roles.filter((r) => r.changed).map((r) => r.role));
  for (const role of [...changedRoles].sort()) {
    let taken = 0;
    for (const path of peerPool) {
      if (taken >= MAX_ROLE_PEERS) break;
      if (changedPaths.has(path)) continue;
      const cls = classify(path);
      if (!cls) continue;
      if ((cls.role ?? cls.layer) !== role) continue;
      emitRole(path, false);
      taken++;
    }
  }

  // ── Peer dominance vote (data-access dimension) ──────────────────────────
  // Peers are graph areas, not directories: a directory is a filing decision,
  // an area is a structural one. Directory is the fallback for unplaced files.
  const outgoingLayers = new Map<string, Set<ArchitectureLayer>>();
  if (graph) {
    for (const edge of graph.edges) {
      if (!BOUNDARY_EDGE_KINDS.has(edge.kind)) continue;
      const src = nodeById.get(edge.src);
      const dst = nodeById.get(edge.dst);
      if (!src || !dst) continue;
      const from = normalize(src.file);
      const to = normalize(dst.file);
      if (from === to) continue;
      const toLayer = classify(to)?.layer;
      if (!toLayer) continue;
      let set = outgoingLayers.get(from);
      if (!set) outgoingLayers.set(from, (set = new Set()));
      set.add(toLayer);
    }
  }

  const areaOfFile = new Map<string, number>();
  if (graph) {
    for (const area of graph.areas) {
      for (const member of area.members) {
        const node = nodeById.get(member);
        if (node) areaOfFile.set(normalize(node.file), area.id);
      }
    }
  }

  const dataAccess = new Map<string, DataAccessPattern>();
  interface Candidate {
    path: string;
    pattern: DataAccessPattern;
    role: string;
    areaGroup: string | null;
    days: number | null;
  }
  const candidates: Candidate[] = [];
  for (const filePath of graph ? [...nodesByFile.keys()].sort() : []) {
    const cls = classify(filePath);
    if (!cls) continue;
    const pattern = classifyDataAccess(cls.layer, [...(outgoingLayers.get(filePath) ?? [])]);
    if (!pattern) continue;
    dataAccess.set(filePath, pattern);
    const areaId = areaOfFile.get(filePath);
    const role = cls.role ?? cls.layer;
    candidates.push({
      path: filePath,
      pattern,
      role,
      areaGroup: areaId !== undefined ? `area:${areaId}:${role}` : null,
      days: input.recencyDays?.get(filePath) ?? null,
    });
  }

  // Prefer area-scoped peers, but only where the area actually has enough
  // same-role files to establish a convention. Areas are clustered structurally,
  // so on a small or highly-modular repository they fragment into groups of one
  // — and a group of one has no convention to deviate from, which would make the
  // vote silently never fire. Where an area is too thin, peers fall back to
  // every file of that role: still structural (a role is derived from the graph
  // and the AST, not from a folder name), just wider.
  const areaCounts = new Map<string, number>();
  for (const c of candidates) {
    if (c.areaGroup) areaCounts.set(c.areaGroup, (areaCounts.get(c.areaGroup) ?? 0) + 1);
  }
  const peerFiles: PeerFile[] = candidates.map((c) => {
    const useArea = c.areaGroup !== null && (areaCounts.get(c.areaGroup) ?? 0) >= MIN_GROUP_SIZE;
    return {
      path: c.path,
      pattern: c.pattern,
      group: useArea ? c.areaGroup! : `role:${c.role}`,
      groupKind: useArea ? 'area' : 'role',
      daysSinceCommit: c.days,
    };
  });
  const votes = voteAll(peerFiles, { declaredPatterns: input.intent?.patterns });

  // ── Patterns ─────────────────────────────────────────────────────────────
  // Declared intent read from CLAUDE.md / AGENTS.md counts as a declaration
  // only when review.toml has not already made one explicitly.
  const observed = observedDominantPattern(roles);
  const declared = config.target_pattern ?? input.intent?.patterns[0] ?? null;
  const patterns = {
    observed_dominant_pattern: observed,
    declared_target_pattern: declared,
    approved_exceptions: [...config.approved_exceptions].sort(),
    legacy_pattern: observed && declared && observed !== declared ? observed : null,
    unknown: observed === null && declared === null,
  };

  // Evidence for every group a changed file belongs to, so a peer-deviation
  // finding can cite the vote that produced it rather than assert it.
  const changedGroups = new Set(
    peerFiles.filter((f) => changedPaths.has(f.path)).map((f) => f.group),
  );
  for (const vote of votes) {
    if (!changedGroups.has(vote.group)) continue;
    addEvidence({
      id: `vote:${vote.group}`,
      kind: 'policy',
      protected_finding: false,
      note:
        vote.reason === 'dominant'
          ? `${vote.size} peers, ${(vote.share * 100).toFixed(0)}% ${vote.dominant} (entropy ${vote.entropy.toFixed(2)})`
          : `${vote.size} peers, no convention (${vote.reason}, entropy ${vote.entropy.toFixed(2)})`,
    });
  }
  for (const citation of input.intent?.citations.slice(0, 4) ?? []) {
    addEvidence({
      id: `intent:${citation.file}:${citation.line}`,
      kind: 'policy',
      path: citation.file,
      start_line: citation.line,
      end_line: citation.line,
      protected_finding: false,
      note: citation.text,
    });
  }
  // Only an unknown when the change actually crosses a layer we would have
  // judged. A change entirely inside one layer does not need a pattern to be
  // established, and reporting one there would make `pass` unreachable.

  // ── Policies (what is actually enforced, read from the engine) ───────────
  const profileForRules = declared ?? observed ?? undefined;
  const policies = boundaryProfileRules(profileForRules).map((rule, i) => ({
    evidence_id: addEvidence({
      id: `policy:layering:${i + 1}`,
      kind: 'policy',
      protected_finding: false,
      note: rule,
    }),
    id: `layering-${i + 1}`,
    rule,
    source: (declared ? 'review.toml' : 'derived') as 'review.toml' | 'derived',
  }));
  // Only worth reporting when the change actually crosses a layer boundary:
  // "no rules are enforced" is noise on a change that stays inside one layer,
  // and noise in `unknowns` would make `pass` unreachable for every repo.
  const crossesLayers = addedEdges.some(
    (e) =>
      e.from_layer
      && e.to_layer
      && e.from_layer !== e.to_layer
      && !EXEMPT_LAYERS.has(e.from_layer as ArchitectureLayer)
      && !EXEMPT_LAYERS.has(e.to_layer as ArchitectureLayer),
  );
  if (policies.length === 0 && crossesLayers) {
    unknowns.push('This change crosses a layer boundary and no layering rules are enforced for this repository — set `target_pattern` in .vibgrate/review.toml to declare one.');
  }
  if (patterns.unknown && crossesLayers) {
    unknowns.push('This change crosses a layer boundary and neither a declared target pattern nor an observed dominant pattern could be established — alignment is reported as unknown, not as a pass.');
  }

  // ── Paths: cross-layer traversals introduced by the change ───────────────
  const paths = addedEdges
    .filter((e) => e.from_layer && e.to_layer && e.from_layer !== e.to_layer)
    .filter((e) => !EXEMPT_LAYERS.has(e.from_layer as ArchitectureLayer) && !EXEMPT_LAYERS.has(e.to_layer as ArchitectureLayer))
    .map((e) => ({
      evidence_id: e.evidence_id,
      from: e.from_path,
      to: e.to_path,
      hops: [e.from_layer!, e.to_layer!],
      // Guard observation needs taint/authorization analysis this slice does
      // not run. `null` says "not observed" — never `true`.
      guarded: null as boolean | null,
    }));
  if (paths.length > 0) {
    unknowns.push('Guard presence along the changed call paths was not observed — no runtime authorization test was supplied.');
  }

  // ── Verification: is any changed file covered by a test? ─────────────────
  const verification = changedFileCoverage(graph, changedPaths).map((v, i) => ({
    evidence_id: addEvidence({
      id: `verify:${v.kind}:${i + 1}`,
      kind: 'graph_node',
      path: v.path,
      protected_finding: false,
      note: v.detail,
    }),
    kind: v.kind,
    path: v.path,
    detail: v.detail,
  }));

  // ── Areas touched ────────────────────────────────────────────────────────
  const areas = graph
    ? graph.areas
        .map((a) => ({
          id: a.id,
          label: a.label,
          size: a.size,
          changed_members: a.members.filter((m) => changedNodeIds.has(m)).length,
        }))
        .filter((a) => a.changed_members > 0)
        .sort((a, b) => b.changed_members - a.changed_members)
        .slice(0, 8)
    : [];

  const capsule: AnalysisCapsule = {
    schema_version: CAPSULE_SCHEMA,
    identity: {
      repo_pseudonym: input.repoPseudonym,
      language: dominantLanguage(graph, change),
      graph_schema: graph?.schemaVersion ?? 'none',
      analyzer_versions: { graph: graph?.provenance.version ?? 'none', scanners: VERSION },
      profile,
    },
    change: {
      base_sha: change.baseSha,
      head_sha: change.headSha,
      dirty: change.dirty,
      dirty_tree_hash: change.dirtyTreeHash,
      symbols,
      ops: change.files.map((f) => ({
        path: normalize(f.path),
        op: f.op,
        added_lines: f.addedLines,
        removed_lines: f.removedLines,
      })),
      added_edges: addedEdges,
      removed_edges: removedEdges,
      contract_changes: [],
    },
    roles,
    areas,
    patterns,
    paths,
    security: [],
    policies,
    verification,
    evidence,
  };

  const budget = CAPSULE_BUDGETS[profile];
  const trimmed = trimToBudget(capsule, budget.cap);
  return {
    capsule,
    votes,
    dataAccess,
    unknowns,
    estimatedTokens: estimateTokens(capsule),
    budget,
    trimmed,
  };
}

/**
 * Enforce the 16K hard cap. Peers go first (they are context), then non-changed
 * roles, then areas — never the change set itself, and never a protected fact.
 */
function trimToBudget(capsule: AnalysisCapsule, cap: number): boolean {
  let trimmed = false;
  const drop = (): boolean => {
    if (capsule.roles.some((r) => !r.changed)) {
      const keep = new Set(capsule.roles.filter((r) => r.changed).map((r) => r.evidence_id));
      const dropped = capsule.roles.filter((r) => !r.changed).map((r) => r.evidence_id);
      capsule.roles = capsule.roles.filter((r) => r.changed || keep.has(r.evidence_id));
      capsule.evidence = capsule.evidence.filter((e) => !dropped.includes(e.id) || e.protected_finding);
      return true;
    }
    if (capsule.areas.length > 0) {
      capsule.areas = [];
      return true;
    }
    return false;
  };
  while (estimateTokens(capsule) > cap) {
    if (!drop()) break;
    trimmed = true;
  }
  return trimmed;
}

/**
 * The layering shape the repository actually exhibits — or `null`. A majority
 * is never silently promoted to "correct"; this only names what is observed.
 */
function observedDominantPattern(roles: CapsuleRole[]): string | null {
  const layers = new Set(roles.map((r) => r.layer).filter((l) => !EXEMPT_LAYERS.has(l as ArchitectureLayer)));
  if (layers.has('domain') && (layers.has('data-access') || layers.has('infrastructure')) && layers.has('services')) {
    return 'clean';
  }
  if (layers.size >= 3) return 'layered';
  return null;
}

function dominantLanguage(graph: VgGraph | null, change: ChangeSet): string {
  if (graph && graph.meta.languages.length > 0) return graph.meta.languages[0];
  const counts = new Map<string, number>();
  for (const f of change.files) {
    const ext = f.path.split('.').pop() ?? '';
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  return top?.[0] ?? 'unknown';
}

function changedFileCoverage(
  graph: VgGraph | null,
  changedPaths: Set<string>,
): { kind: 'test_covering_change' | 'no_test_covering_change'; path: string; detail: string }[] {
  if (!graph) return [];
  const testedFiles = new Set<string>();
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const edge of graph.edges) {
    if (edge.kind !== 'test' && edge.kind !== 'coverage') continue;
    const dst = nodeById.get(edge.dst);
    if (dst) testedFiles.add(normalize(dst.file));
  }
  const out: { kind: 'test_covering_change' | 'no_test_covering_change'; path: string; detail: string }[] = [];
  for (const path of [...changedPaths].sort()) {
    // A test file changing is not a claim about its own coverage.
    if (/(^|\/)(__tests__|tests?|spec)\//i.test(path) || /\.(test|spec)\.[^.]+$/i.test(path)) continue;
    out.push(
      testedFiles.has(path)
        ? { kind: 'test_covering_change', path, detail: 'a test edge reaches this file' }
        : { kind: 'no_test_covering_change', path, detail: 'no test edge reaches this file in the map' },
    );
  }
  return out.slice(0, 25);
}

/** Pseudonym for the repository — non-reversible, stable across machines. */
export function repoPseudonym(remote: string | null, root: string): string {
  return digestString(`vg.review.pseudonym\0${remote ?? `local:${root}`}`);
}
