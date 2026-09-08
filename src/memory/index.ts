/**
 * Cross-agent memory — public barrel.
 *
 * `MemoryStore` (JSONL per scope, content-addressed, redacted at ingest),
 * `buildMemoryInjection` (the exact READ-ONLY block), `memoryTools` +
 * `handleMemoryTool` (model-facing tools), `TrafficLearner` (evidence-gated
 * rule extraction from live traffic) and `projectKey` (fail-closed scoping).
 */

import * as fs from 'node:fs';
import { memoryDir } from '../compress/paths.js';
import { env as knobs } from '../compress/config.js';
import { MemoryStore } from './store.js';
import { resolveProject } from './project.js';
import { AGENT_IDS } from '../learn/types.js';

export type { Memory, MemoryInput, MemoryKind, MemoryScope, MemorySource, MemoryStats, SearchHit, SearchOptions, ListOptions, VectorHook } from './types.js';
export { MEMORY_KINDS, MEMORY_SCOPES, MEMORY_SOURCES, NO_PROJECT, DEFAULT_USER, normalizeMemoryText, normalizeTags, isMemoryKind, isMemoryScope, isMemorySource } from './types.js';
export { MemoryStore, MEMORY_FILE, memoryHash, memoryIdFromHash, parseMemoryLine, serializeMemory, userKey } from './store.js';
export type { MemoryStoreOptions } from './store.js';
export { projectKey, resolveProject, normalizeRoot, sanitizeIdentity, defaultGitRunner } from './project.js';
export type { GitRunner, ResolvedProject, ResolveProjectOptions } from './project.js';
export { rankMemories, bm25, tokenize, cosine, recencyFactor, evidenceBoost, compareHits, RECENCY_DECAY_DAYS, SCOPE_WEIGHTS } from './rank.js';
export type { RankOptions } from './rank.js';
export {
  buildMemoryInjection,
  memoryInjectionHeader,
  renderMemoryRow,
  applyInjectionBudget,
  injectedMemoryIds,
  MEMORY_INJECTION_PREFIX,
  MEMORY_INJECTION_SUFFIX,
  MEMORY_INJECTION_MAX_TOKENS,
  MEMORY_INJECTION_MAX_ENTRIES,
  MEMORY_INJECTION_MIN_SCORE,
} from './inject.js';
export type { InjectionOptions } from './inject.js';
export {
  memoryTools,
  handleMemoryTool,
  isMemoryTool,
  inferKind,
  MEMORY_TOOL_NAMES,
  mcpMemorySearch,
  mcpMemorySave,
  MCP_MEMORY_SEARCH_DESCRIPTION,
  MCP_MEMORY_SAVE_DESCRIPTION,
  MCP_MEMORY_SEARCH_SCHEMA,
  MCP_MEMORY_SAVE_SCHEMA,
} from './tools.js';
export type { MemoryToolName, ToolResult, HandleOptions } from './tools.js';
export {
  extractMemories,
  extractToolCalls,
  extractPreference,
  extractDecision,
  extractEnvironment,
  buildRecovery,
  dropContradictions,
  stripSystemReminders,
  canonicalizeUserText,
  isLearnableUserText,
  levenshtein,
  pathsRelatedAsTypo,
  commandsRelatedAsRetry,
  normalizeBashForKey,
} from './extract.js';
export type { ExtractedMemory, ExtractOptions, ToolObservation } from './extract.js';
export { TrafficLearner, DEFAULT_MIN_EVIDENCE, DEDUP_WINDOW, MAX_PENDING, keyTag } from './learner.js';
export type { TrafficLearnerOptions, TrafficLearnerStats } from './learner.js';

export interface MemoryDiagnostics {
  enabled: boolean;
  dir: string;
  dirExists: boolean;
  project: { root: string | null; key: string; resolved: boolean; source: string };
  user: string;
  counts: { project: number; user: number; global: number; total: number };
  minEvidence: number;
  topK: number;
  learnAgents: readonly string[];
  problems: string[];
}

/** Doctor-style snapshot: where memory lives, whether the project resolves, counts. */
export function memoryDiagnostics(env: NodeJS.ProcessEnv = process.env, opts: { cwd?: string; git?: import('./project.js').GitRunner } = {}): MemoryDiagnostics {
  const cwd = opts.cwd ?? process.cwd();
  const project = resolveProject(cwd, { env, git: opts.git });
  const dir = memoryDir(env);
  const problems: string[] = [];
  let counts = { project: 0, user: 0, global: 0, total: 0 };
  let user = 'default';
  try {
    const store = new MemoryStore({ cwd, env, git: opts.git });
    const s = store.stats();
    counts = { project: s.byScope.project, user: s.byScope.user, global: s.byScope.global, total: s.total };
    user = s.user;
  } catch (e) {
    problems.push(`memory store unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!project.resolved) problems.push('no project root resolved (not a git repo?) — project-scoped memories are never injected here; set VG_MEMORY_PROJECT_ROOT to override');
  return {
    enabled: knobs.bool('VG_MEMORY', env),
    dir,
    dirExists: fs.existsSync(dir),
    project: { root: project.root, key: project.key, resolved: project.resolved, source: project.source },
    user,
    counts,
    minEvidence: knobs.int('VG_MEMORY_MIN_EVIDENCE', env, { min: 1 }),
    topK: knobs.int('VG_MEMORY_TOP_K', env, { min: 0 }),
    learnAgents: AGENT_IDS,
    problems,
  };
}
