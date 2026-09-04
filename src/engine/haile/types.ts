/** HAILE sidecar types. Snake_case on the wire. Frozen for H0–H2. */

export const HAILE_MAGIC = 'vg.haile.v1';
export const HAILE_TAXONOMY = 'haile.taxonomy.v1';
export const HAILE_IR = 'haile.ir.v1';
export const HAILE_ENGINE_VERSION = 'haile-fast/2026.903.5';

export const ROLES = [
  'entry_point',
  'user_interface',
  'transport',
  'controller',
  'application_service',
  'use_case',
  'domain_service',
  'domain_model',
  'port',
  'repository',
  'adapter',
  'persistence',
  'integration',
  'messaging',
  'worker',
  'infrastructure',
  'cross_cutting',
  'test_support',
  'utility',
  'unknown',
] as const;

export type HaileRole = (typeof ROLES)[number];

export const PURPOSES = [
  'authenticate',
  'authorise',
  'validate',
  'orchestrate',
  'query',
  'persist',
  'transform',
  'map',
  'parse',
  'serialise',
  'render',
  'network_io',
  'respond',
  'file_io',
  'compute',
  'cache',
  'publish',
  'consume',
  'schedule',
  'configure',
  'observe',
  'encrypt',
  'hash',
  'lifecycle',
  'test',
  'unknown',
] as const;

export type HailePurpose = (typeof PURPOSES)[number];

export const SYMBOL_KINDS = [
  'function',
  'method',
  'constructor',
  'lambda',
  'type',
  'interface',
  'route',
  'handler',
  'job',
  'test',
  'query',
  'unknown',
] as const;

export type HaileSymbolKind = (typeof SYMBOL_KINDS)[number];

export type ConfidenceBand = 'high' | 'medium' | 'low' | 'abstain';
export type HaileProfile = 'strict' | 'balanced' | 'exploratory';

export interface HaileEvidence {
  kind: 'structural' | 'framework' | 'lexical' | 'name' | 'call_graph' | 'quality' | 'effect';
  signal: string;
  weight: number;
}

export interface HaileCallable {
  node_id: string;
  file_path: string;
  name: string;
  qualified_name: string;
  symbol_kind: HaileSymbolKind;
  language: string;
  signature: string;
  calls: string[];
  parameters: Array<{ name: string; type_name?: string }>;
  return_type?: string;
  file_layer?: string;
  ast_role?: string;
  pack_ids?: string[];
}

export interface HaileSymbol {
  node_id: string;
  file_path: string;
  name: string;
  qualified_name: string;
  symbol_kind: string;
  role: {
    primary: string;
    alternatives: Array<{ role: string; confidence: number }>;
    confidence: number;
    band: ConfidenceBand;
  };
  purposes: Array<{ purpose: string; confidence: number }>;
  intent: { text: string; verbs: string[]; objects: string[] };
  evidence: HaileEvidence[];
  /** Boundary findings from the module's policy pack (additive; absent when none). */
  findings?: HaileFinding[];
  file_layer?: string;
  ast_role?: string;
}

export interface HaileFinding {
  /** `hexagonal-v1/controller-persists` … */
  rule: string;
  severity: 'hard' | 'warn' | string;
  message: string;
  /** 1-based line of the symbol's own offending call; absent when the crossing is only inherited. */
  line?: number;
}

/**
 * Boundary policy packs the module can evaluate. `hexagonal-v1`: ports and
 * adapters — the application layer owns its ports, the domain stays pure,
 * handlers only delegate. `layered-v1`: controller → service → repository —
 * the service layer owns the ORM and a controller must not read or write
 * the store itself.
 */
export type HailePolicy = 'hexagonal-v1' | 'layered-v1';
export const POLICIES: readonly HailePolicy[] = ['hexagonal-v1', 'layered-v1'];
export const DEFAULT_POLICY: HailePolicy = 'hexagonal-v1';

export interface HaileModuleSummary {
  path: string;
  symbol_count: number;
  role_histogram: Record<string, number>;
  purpose_histogram: Record<string, number>;
  description: string;
  band: ConfidenceBand;
}

export interface HaileSidecar {
  magic: typeof HAILE_MAGIC;
  taxonomy: typeof HAILE_TAXONOMY;
  ir: typeof HAILE_IR;
  corpus_hash: string;
  engine_version: string;
  profile: HaileProfile;
  /** Policy pack the findings were evaluated under (module ≥ 2026.903.4; absent means hexagonal-v1). */
  policy?: HailePolicy;
  symbols: HaileSymbol[];
  symbols_capped?: true;
  modules?: HaileModuleSummary[];
}

export const DEFAULT_SYMBOL_CAP = 8_000;
export const DEFAULT_PROFILE: HaileProfile = 'balanced';
