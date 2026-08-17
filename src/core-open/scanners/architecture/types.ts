// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import type {
  ArchitectureEvidence,
  ArchitectureEvidenceDimension,
  ArchitectureFileRole,
  ArchitectureLayer,
  ArchitectureWorkspaceEdge,
  ProjectArchetype,
  ProjectScan,
  ProjectType,
} from '../../types.js';

export type {
  ArchitectureEvidence,
  ArchitectureEvidenceDimension,
  ArchitectureFileRole,
  ArchitectureWorkspaceEdge,
};

/**
 * Pack-scoped tree-sitter role query. Executed against the parse already
 * paid for by `buildGraph` — core-open stores the query text only and never
 * imports `web-tree-sitter`.
 */
export interface AstRoleQuery {
  /** Graph / parse language ids (`java`, `cs`, `py`, `go`, `ts`, `tsx`, `js`). */
  languages: readonly string[];
  /** Tree-sitter query. A compile miss is skipped, not a failure. */
  query: string;
  /**
   * Literal token the tree-sitter-free matcher uses (tests, and the
   * parse-time fallback when a query fails to compile).
   */
  needle: string;
  role: ArchitectureFileRole;
  layer: ArchitectureLayer;
  confidence: number;
  signal: string;
}

/** Path-based layer rule. `archetypes` is a back-compat filter; prefer attaching the rule to the matching pack. */
export interface ArchitecturePathRule {
  pattern: RegExp;
  layer: ArchitectureLayer;
  confidence: number;
  signal: string;
  archetypes?: ProjectArchetype[];
}

export interface ArchitectureSuffixRule {
  suffix: string;
  layer: ArchitectureLayer;
  confidence: number;
  signal: string;
}

export interface ArchitectureDependencyRule {
  package: string;
  layer: ArchitectureLayer;
}

export interface ProjectContext {
  project: ProjectScan;
  /** Project-local relative paths from the (single) walk. */
  files: readonly string[];
  fileNames: ReadonlySet<string>;
  extensions: ReadonlySet<string>;
  packages: ReadonlySet<string>;
  frameworkNames: readonly string[];
  projectPath: string;
  projectType: ProjectType | string;
}

export interface ArchitectureKnowledgePack {
  id: string;
  languages?: readonly string[];
  projectKinds?: readonly string[];
  frameworks?: readonly string[];
  platforms?: readonly string[];
  buildSystems?: readonly string[];
  match(context: ProjectContext): ArchitectureEvidence[];
  /** Additive only — never removes extensions from the generic walker. */
  extensions?: readonly string[];
  pathRules?: readonly ArchitecturePathRule[];
  suffixRules?: readonly ArchitectureSuffixRule[];
  pascalSuffixRules?: readonly ArchitectureSuffixRule[];
  dependencyRules?: readonly ArchitectureDependencyRule[];
  structureHints?: readonly string[];
  astRoles?: readonly AstRoleQuery[];
}

export interface FusionWinner {
  value: string;
  confidence: number;
  packId: string;
}

export interface FusionResult {
  /** Uncapped evidence that fired (every pack with a non-empty match). */
  evidence: ArchitectureEvidence[];
  /** Winning value per dimension, computed on the uncapped set above the floor. */
  winners: Map<ArchitectureEvidenceDimension, FusionWinner>;
  packIds: string[];
}

export const EVIDENCE_FLOOR = 0.4;
export const EVIDENCE_PAYLOAD_CAP = 64;
export const WORKSPACE_EDGES_CAP = 40;
export const VIOLATIONS_CAP = 100;
export const CLASSIFIED_ROLE_CAP = 64;
