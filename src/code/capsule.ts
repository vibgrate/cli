/**
 * Source-bearing Context Capsule compiler (Fusion Runtime Phase 0).
 *
 * Today's {@link buildCodeContext} pays for graph metadata, then the model still
 * calls `read_file` — double payment. This module compiles a Context Capsule that
 * includes exact source ranges (from Tree-sitter spans already on graph nodes)
 * so the first inference can solve without navigation tool calls (ZNS@1 path).
 *
 * Deterministic given (graph, instruction, file contents, options). Injectable
 * `readFile` keeps unit tests offline and pure.
 *
 * Schema: docs/fusion/task-capsule-v0.schema.json
 */

import { queryGraph } from '../engine/query.js';
import { indexFor } from '../engine/relations.js';
import { impactOf } from '../engine/impact.js';
import { hashString } from '../engine/hash.js';
import type { GraphNode, VgGraph } from '../schema.js';
import type { CodeContext } from './types.js';
import { buildCodeContext, type BuildContextOptions } from './context.js';

export const TASK_CAPSULE_SCHEMA_VERSION = 'task-capsule/0' as const;
/** Frozen ranking policy id — bump when the heuristic changes (benchmark gate). */
/** Bumped 2026.07.1: strip URL/quoted needles from seed ranking (no path-token false positives). */
/** Bumped 2026.08.1: term roles (weak process verbs never seed alone), concept/bigram
 *  expansion, multi-term coverage bonus, directory-segment evidence. */
/** Bumped 2026.08.2: optional relevance-provider seam — sanitized provider expansions
 *  join term preparation (own 0..1 weight capped at EXPANSION_WEIGHT; weak-provenance
 *  dropped); provider version recorded as `relevanceVersion` provenance. Absent
 *  provider = 2026.08.1 behaviour exactly — gated by the same corpus, dual-mode. */
/** Bumped 2026.08.3: multi-turn field report ("do we support direct debits?" after a
 *  stripe ask seeded direct* distractors). (a) Tokens consumed by a fired bigram
 *  concept are demoted to the weak role — "direct" corroborates, never seeds.
 *  (b) Conversation carry-over: the previous ask's content terms join ranking at
 *  CARRY_WEIGHT when the caller passes `priorInstruction`. (c) A plain-language
 *  "how the ask was interpreted" concept map is rendered for small local models.
 *  No prior instruction + no bigram ask = 2026.08.2 behaviour exactly. */
/** Bumped 2026.08.4: relevance relocation — the ranking engine (lexicon, term
 *  roles, IDF, tiers, typo repair, morphology, diversification, concept map)
 *  moved into the auto-provisioned relevance module behind the seam's
 *  rankSymbols API; the host keeps mechanical name matching as the
 *  module-less fallback. Seed content with the module active matches
 *  2026.08.3 + the coding-prompt-corpus improvements; the recorded
 *  relevanceVersion says which engine ranked this capsule. */
export const CAPSULE_RANKING_VERSION = 'capsule-rank@2026.08.4' as const;
export const CAPSULE_COMPILER_ID = 'vg-task-capsule/0' as const;

export interface BuildCapsuleOptions extends BuildContextOptions {
  /**
   * Read file contents relative to the repository root. Required for source
   * slices; when omitted, the capsule still builds metadata + empty slices
   * (useful for schema/shape tests).
   */
  readFile?: (relativePath: string) => string | null;
  /** Extra lines of context around each symbol span (default 1). */
  padding?: number;
  /** Max source slices after merge (default 12). */
  maxSlices?: number;
  repositoryId?: string | null;
  /** Optional provenance from the Model Execution Profile / security ladder. */
  provenance?: CapsuleProvenanceExtras;
  /**
   * Extra pinned facts (e.g. high-confidence federation bridge edges) appended
   * after graph-derived facts. Secret-free, short strings only.
   */
  extraPinnedFacts?: string[];
}

export interface CapsuleSymbolRef {
  id: string;
  qualifiedName: string;
  kind: string;
  file: string;
  span: { start: number; end: number };
  signature?: string | null;
  why: string;
  importance: number;
}

export interface SourceSlice {
  file: string;
  start: number;
  end: number;
  content: string;
  contentHash: string;
  symbolIds: string[];
}

export interface CapsuleRelationship {
  kind: 'calls' | 'called-by' | 'impacts' | 'contains' | 'other';
  from: string;
  to: string;
}

export interface VerificationPlan {
  syntaxFiles: string[];
  suggestedTests: string[];
  notes: string[];
}

export interface TaskCapsule {
  schemaVersion: typeof TASK_CAPSULE_SCHEMA_VERSION;
  instruction: string;
  primary: CapsuleSymbolRef[];
  supporting: CapsuleSymbolRef[];
  sourceSlices: SourceSlice[];
  relationships: CapsuleRelationship[];
  pinnedFacts: string[];
  /** Plain-language interpretation of the ask (concept expansions, relevance
   *  topics, carried prior-turn terms) — see engine/query.ts conceptMapLines. */
  conceptMap: string[];
  targetFiles: string[];
  verificationPlan: VerificationPlan;
  rendered: string;
  tokensEstimate: number;
  provenance: {
    compiler: string;
    rankingVersion: string;
    graphCorpusHash: string | null;
    repositoryId: string | null;
    /** Model Execution Profile id when resolved (Fusion Phase 4/7). */
    modelProfileId?: string | null;
    /** Security tier for shell during this task. */
    securityTier?: string | null;
    /** Frozen policy / ranking patch id if any. */
    policyVersion?: string | null;
    /** Version of the optional relevance provider that widened seed
     *  vocabulary for this capsule, or null when none was active. */
    relevanceVersion?: string | null;
  };
}

export interface CapsuleProvenanceExtras {
  modelProfileId?: string | null;
  securityTier?: string | null;
  policyVersion?: string | null;
}

/** Host-safe capsule summary for VS Code / stream-json capsule transparency. */
export interface CapsuleSummary {
  schemaVersion: string;
  instruction: string;
  primary: Array<{ qualifiedName: string; file: string; kind: string; why: string }>;
  supporting: Array<{ qualifiedName: string; file: string; kind: string; why: string }>;
  sourceSliceCount: number;
  sourceFiles: string[];
  tokensEstimate: number;
  rankingVersion: string;
  /**
   * How the ask was interpreted, ready to show a human: the capsule's concept
   * map with the model-facing seed-notation legend dropped and the leading
   * "- " bullet stripped. Empty when no relevance engine widened the ask.
   */
  interpretation: string[];
  /** Truncated rendered capsule for display (not the full prompt dump). */
  preview: string;
}

/**
 * The concept map, projected for a human surface. The rendered capsule ends its
 * concept map with a notation legend that exists so a small local model can
 * decode the `a→b` slugs on each seed line; a terminal or panel reader has the
 * `why` strings spelled out next to the symbol, so the legend is noise there.
 */
function interpretationFor(conceptMap: string[]): string[] {
  return conceptMap
    .filter((line) => !/^\s*-?\s*Seed notation\b/i.test(line))
    .map((line) => line.replace(/^\s*-\s+/, '').trim())
    .filter(Boolean);
}

/** Host-safe capsule summary (capsule transparency UI / stream-json). */
export function summarizeCapsule(capsule: TaskCapsule): CapsuleSummary {
  const sourceFiles = [...new Set(capsule.sourceSlices.map((s) => s.file))].sort();
  const preview = capsule.rendered.length > 4000 ? `${capsule.rendered.slice(0, 4000)}\n… (truncated)` : capsule.rendered;
  return {
    schemaVersion: capsule.schemaVersion,
    instruction: capsule.instruction,
    primary: capsule.primary.map((p) => ({ qualifiedName: p.qualifiedName, file: p.file, kind: p.kind, why: p.why })),
    supporting: capsule.supporting.map((p) => ({ qualifiedName: p.qualifiedName, file: p.file, kind: p.kind, why: p.why })),
    sourceSliceCount: capsule.sourceSlices.length,
    sourceFiles,
    tokensEstimate: capsule.tokensEstimate,
    rankingVersion: capsule.provenance.rankingVersion,
    interpretation: interpretationFor(capsule.conceptMap),
    preview,
  };
}

/**
 * Interpretation lines shown before the seeds. Matches the VS Code panel's cap
 * so the two surfaces explain an ask the same way. Three was too few in
 * practice: the concept map orders broad taxonomy lines ahead of the specific
 * ones, so a typo repair ("read \"chekout\" as \"checkout\"") — the line a
 * reader who typed the typo most needs — fell past the cut.
 */
const TRANSPARENCY_INTERPRETATION_LINES = 6;
/** Seeds shown with their match provenance. */
const TRANSPARENCY_SEED_LINES = 3;

/**
 * The capsule transparency block for a text surface: how the ask was read, and
 * which symbols that reached, with the reason each one matched.
 *
 * Returns indented, ready-to-print lines (the caller applies dimming). Both
 * sections are capped — a coding session prints one of these per turn, and the
 * complete block already travels inside the capsule itself. Empty when there is
 * nothing to explain (no relevance engine active and no seeds).
 */
export function capsuleTransparencyLines(summary: CapsuleSummary): string[] {
  const lines: string[] = [];

  const interpretation = summary.interpretation ?? [];
  for (const line of interpretation.slice(0, TRANSPARENCY_INTERPRETATION_LINES)) {
    lines.push(`      read: ${line}`);
  }
  const hiddenInterpretation = interpretation.length - TRANSPARENCY_INTERPRETATION_LINES;
  if (hiddenInterpretation > 0) lines.push(`      read: … ${hiddenInterpretation} more`);

  const seeds = (summary.primary ?? []).filter((p) => p.qualifiedName);
  for (const seed of seeds.slice(0, TRANSPARENCY_SEED_LINES)) {
    // An external/module node carries no file of its own — no dangling separator.
    const where = seed.file ? ` · ${seed.file}` : '';
    const why = seed.why ? ` — ${seed.why}` : '';
    lines.push(`      seed: ${seed.qualifiedName}${where}${why}`);
  }
  const hiddenSeeds = seeds.length - TRANSPARENCY_SEED_LINES;
  if (hiddenSeeds > 0) lines.push(`      seed: … ${hiddenSeeds} more`);

  return lines;
}

/**
 * Compile a source-bearing Context Capsule. Reuses the same seed / impact /
 * fact-pinning path as {@link buildCodeContext}, then attaches exact source
 * slices and a verification sketch.
 */
export function buildTaskCapsule(graph: VgGraph, instruction: string, options: BuildCapsuleOptions = {}): TaskCapsule {
  const base = buildCodeContext(graph, instruction, options);
  const padding = options.padding ?? 1;
  const maxSlices = options.maxSlices ?? 12;
  const budget = options.budget ?? 3000;
  const index = indexFor(graph);

  const primary = base.seeds.map((s) => toRef(s.node, s.why));
  const primaryIds = new Set(primary.map((p) => p.id));

  const supporting: CapsuleSymbolRef[] = [];
  for (const { node, via } of base.impacted) {
    if (primaryIds.has(node.id)) continue;
    supporting.push(toRef(node, `depends on ${via}`));
  }

  const relationships = collectRelationships(base, index);
  const sourceSlices = options.readFile
    ? buildSourceSlices(
        [...base.seeds.map((s) => s.node), ...base.impacted.map((i) => i.node)],
        options.readFile,
        padding,
        maxSlices,
      )
    : [];

  const extraFacts = (options.extraPinnedFacts ?? []).filter((f) => typeof f === 'string' && f.trim());
  const pinnedFacts = [...base.pinnedFacts, ...extraFacts];
  const verificationPlan = buildVerificationPlan(graph, base);
  const rendered = renderCapsule(instruction, primary, supporting, sourceSlices, pinnedFacts, base.conceptMap, base.targetFiles, verificationPlan, relationships, budget);

  return {
    schemaVersion: TASK_CAPSULE_SCHEMA_VERSION,
    instruction,
    primary,
    supporting,
    sourceSlices,
    relationships,
    pinnedFacts,
    conceptMap: base.conceptMap,
    targetFiles: base.targetFiles,
    verificationPlan,
    rendered,
    tokensEstimate: estimateTokens(rendered),
    provenance: {
      compiler: CAPSULE_COMPILER_ID,
      rankingVersion: CAPSULE_RANKING_VERSION,
      graphCorpusHash: graph.provenance?.corpusHash ?? null,
      repositoryId: options.repositoryId ?? null,
      modelProfileId: options.provenance?.modelProfileId ?? null,
      securityTier: options.provenance?.securityTier ?? null,
      policyVersion: options.provenance?.policyVersion ?? null,
      relevanceVersion: options.ranked?.version ?? null,
    },
  };
}

/**
 * Project a capsule into the legacy {@link CodeContext} shape so the existing
 * agent prompt path can consume it without a full rewrite (A/B flag).
 */
export function capsuleToCodeContext(capsule: TaskCapsule): CodeContext {
  return {
    instruction: capsule.instruction,
    seeds: capsule.primary.map((p) => ({
      node: {
        id: p.id,
        qualifiedName: p.qualifiedName,
        kind: p.kind,
        file: p.file,
        span: p.span,
        signature: p.signature ?? undefined,
        importance: p.importance,
      } as GraphNode,
      why: p.why,
    })),
    targetFiles: capsule.targetFiles,
    conceptMap: capsule.conceptMap,
    impacted: capsule.supporting.map((s) => ({
      node: {
        id: s.id,
        qualifiedName: s.qualifiedName,
        kind: s.kind,
        file: s.file,
        span: s.span,
        signature: s.signature ?? undefined,
        importance: s.importance,
      } as GraphNode,
      via: s.why.replace(/^depends on /, ''),
    })),
    pinnedFacts: capsule.pinnedFacts,
    rendered: capsule.rendered,
    tokensEstimate: capsule.tokensEstimate,
  };
}

function toRef(node: GraphNode, why: string): CapsuleSymbolRef {
  return {
    id: node.id,
    qualifiedName: node.qualifiedName,
    kind: node.kind,
    file: normalize(node.file),
    span: { start: node.span.start, end: node.span.end },
    signature: node.signature ?? null,
    why,
    importance: node.importance,
  };
}

function collectRelationships(
  base: CodeContext,
  index: ReturnType<typeof indexFor>,
): CapsuleRelationship[] {
  const out: CapsuleRelationship[] = [];
  const seen = new Set<string>();
  const push = (kind: CapsuleRelationship['kind'], from: string, to: string) => {
    const key = `${kind}|${from}|${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, from, to });
  };

  for (const { node } of base.seeds) {
    for (const c of index.callees(node.id).slice(0, 6)) {
      push('calls', node.qualifiedName, c.node.qualifiedName);
    }
    for (const c of index.callers(node.id).slice(0, 6)) {
      push('called-by', node.qualifiedName, c.node.qualifiedName);
    }
  }
  for (const { node, via } of base.impacted.slice(0, 10)) {
    push('impacts', via, node.qualifiedName);
  }

  // Stable order for determinism.
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

function buildSourceSlices(
  nodes: GraphNode[],
  readFile: (relativePath: string) => string | null,
  padding: number,
  maxSlices: number,
): SourceSlice[] {
  // Prefer concrete symbols over file/module containers for source evidence.
  const eligible = nodes.filter((n) => !['file', 'module', 'package'].includes(n.kind));
  const byFile = new Map<string, GraphNode[]>();
  for (const n of eligible) {
    const file = normalize(n.file);
    const list = byFile.get(file) ?? [];
    list.push(n);
    byFile.set(file, list);
  }

  type Range = { file: string; start: number; end: number; symbolIds: string[]; score: number };
  const ranges: Range[] = [];

  for (const [file, fileNodes] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...fileNodes].sort((a, b) => a.span.start - b.span.start || b.importance - a.importance);
    let current: Range | null = null;
    for (const n of sorted) {
      const start = Math.max(1, n.span.start - padding);
      const end = n.span.end + padding;
      const score = n.importance + (n.isHub ? 0.25 : 0);
      if (current && current.file === file && start <= current.end + 2) {
        current.end = Math.max(current.end, end);
        current.symbolIds.push(n.id);
        current.score = Math.max(current.score, score);
      } else {
        if (current) ranges.push(current);
        current = { file, start, end, symbolIds: [n.id], score };
      }
    }
    if (current) ranges.push(current);
  }

  ranges.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.start - b.start);

  const slices: SourceSlice[] = [];
  for (const range of ranges) {
    if (slices.length >= maxSlices) break;
    const raw = readFile(range.file);
    if (raw === null) continue;
    const lines = raw.split('\n');
    const start = Math.min(range.start, lines.length);
    const end = Math.min(range.end, lines.length);
    if (start < 1 || end < start) continue;
    const content = lines.slice(start - 1, end).join('\n');
    slices.push({
      file: range.file,
      start,
      end,
      content,
      contentHash: hashString(content),
      symbolIds: [...new Set(range.symbolIds)].sort(),
    });
  }

  // Stable final order: file then start line (score only used for selection).
  return slices.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);
}

function buildVerificationPlan(graph: VgGraph, base: CodeContext): VerificationPlan {
  const syntaxFiles = [...base.targetFiles].sort();
  const seedIds = new Set(base.seeds.map((s) => s.node.id));
  const suggestedTests: string[] = [];

  for (const n of graph.nodes) {
    if (n.kind !== 'test') continue;
    // Prefer tests that share a file with seeds or whose name mentions a seed.
    const sameFile = base.seeds.some((s) => normalize(s.node.file) === normalize(n.file));
    const nameHit = base.seeds.some((s) => n.qualifiedName.toLowerCase().includes(s.node.name.toLowerCase()));
    if (sameFile || nameHit || seedIds.has(n.id)) {
      suggestedTests.push(n.qualifiedName);
    }
  }
  suggestedTests.sort();

  const notes: string[] = [];
  if (!suggestedTests.length) {
    notes.push('No graph-linked tests found for seed symbols; run the nearest project test command after apply.');
  }
  if (base.impacted.some((i) => i.node.isHub || i.node.importance >= 0.7)) {
    notes.push('High-importance dependents in blast radius — prefer targeted tests before a full build.');
  }

  return {
    syntaxFiles,
    suggestedTests: suggestedTests.slice(0, 12),
    notes,
  };
}

function renderCapsule(
  instruction: string,
  primary: CapsuleSymbolRef[],
  supporting: CapsuleSymbolRef[],
  slices: SourceSlice[],
  pinnedFacts: string[],
  conceptMap: string[],
  targetFiles: string[],
  verification: VerificationPlan,
  relationships: CapsuleRelationship[],
  budget: number,
): string {
  const lines: string[] = [];
  lines.push('# Context capsule (source-bearing, from the deterministic code graph)');
  lines.push('');
  lines.push('Use the exact source evidence below. Search or read outside it only if this capsule is insufficient.');
  lines.push('');

  if (pinnedFacts.length) {
    lines.push('## Hard constraints (do not violate)');
    for (const f of pinnedFacts) lines.push(`- ${f}`);
    lines.push('');
  }

  // Rendered before the symbol list on purpose: a small local model reads the
  // interpretation first, so the `a→b` provenance slugs on each seed line are
  // decodable instead of noise.
  if (conceptMap.length) {
    lines.push('## How the ask was interpreted');
    for (const l of conceptMap) lines.push(l);
    lines.push('');
  }

  lines.push('## Primary symbols');
  for (const s of primary) {
    lines.push(`- ${s.qualifiedName} (${s.kind}, ${s.file}:${s.span.start}-${s.span.end})${s.signature ? ` — \`${s.signature}\`` : ''} — ${s.why}`);
  }
  lines.push('');

  if (supporting.length) {
    lines.push('## Supporting / blast radius');
    for (const s of supporting.slice(0, 10)) {
      lines.push(`- ${s.qualifiedName} (${s.file}:${s.span.start}) — ${s.why}`);
    }
    lines.push('');
  }

  if (relationships.length) {
    lines.push('## Relationships');
    for (const r of relationships.slice(0, 24)) {
      lines.push(`- ${r.kind}: ${r.from} → ${r.to}`);
    }
    lines.push('');
  }

  lines.push('## Exact source evidence');
  if (!slices.length) {
    lines.push('_No source slices available (file reader missing or spans unreadable)._');
    lines.push('');
  } else {
    let included = 0;
    for (const slice of slices) {
      const block = [
        `### ${slice.file}:${slice.start}-${slice.end}`,
        `\`\`\`${langFor(slice.file)}`,
        slice.content,
        '```',
        '',
      ];
      const candidate = [...lines, ...block, '## Task', instruction].join('\n');
      if (estimateTokens(candidate) > budget && included > 0) break;
      lines.push(...block);
      included += 1;
    }
  }

  lines.push('## Files in scope');
  for (const f of targetFiles) lines.push(`- ${f}`);
  lines.push('');

  lines.push('## Verification plan');
  for (const f of verification.syntaxFiles) lines.push(`- syntax: ${f}`);
  for (const t of verification.suggestedTests) lines.push(`- test: ${t}`);
  for (const n of verification.notes) lines.push(`- note: ${n}`);
  lines.push('');

  lines.push('## Task');
  lines.push(instruction);
  return lines.join('\n');
}

function langFor(file: string): string {
  const ext = file.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'ts',
    tsx: 'tsx',
    js: 'js',
    jsx: 'jsx',
    mjs: 'js',
    cjs: 'js',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    cs: 'csharp',
    md: 'md',
    json: 'json',
  };
  return map[ext] ?? '';
}

function normalize(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Re-export query touch so tree-shaking keeps the dependency explicit for tests.
export const __testing = { queryGraph, impactOf };
