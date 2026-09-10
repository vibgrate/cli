export { adaptGraph, isCallableKind, symbolKindOf } from './adapter.js';
export { formatHaileLines, haileJsonFields } from './format.js';
export type { FormatHaileOptions } from './format.js';
export { loadHaileProvider, resetHaileProviderCache, haileModuleDir } from './haile-provider.js';
export type { HaileClassification, HaileClassifyInput, HaileProvider } from './haile-provider.js';
export {
  deleteHaileSidecarFor,
  emptySidecar,
  findHaileSymbol,
  haileSidecarPathFor,
  readHaileSidecar,
  serializeSidecar,
  writeHaileSidecarFor,
  writeSidecarDocument,
} from './sidecar.js';
export {
  inferArchitecturePolicy,
  renderArchitecturePolicy,
  seedArchitecturePolicy,
} from './policy-seed.js';
export type { SeedArchitecturePolicyOptions, SeedArchitecturePolicyResult } from './policy-seed.js';
export { architecturePolicyFor, isHailePolicy, ARCHITECTURE_CONFIG_FILE } from './policy-config.js';
export {
  ArchitecturePolicyError,
  applyArchitectureOverlays,
  loadArchitecturePolicy,
  parseArchitecturePolicy,
} from './policy-overlay.js';
export type { ArchitectureOverlay, ArchitecturePolicyDocument, OverlayAction, OverlaySeverity } from './policy-overlay.js';
export type {
  HaileCallable,
  HaileFinding,
  HailePolicy,
  HaileModuleSummary,
  HaileProfile,
  HaileSidecar,
  HaileSymbol,
} from './types.js';
export {
  ARCH_POLICY_SCHEMA,
  DEFAULT_POLICY,
  DEFAULT_PROFILE,
  DEFAULT_SYMBOL_CAP,
  HAILE_ENGINE_VERSION,
  HAILE_IR,
  HAILE_MAGIC,
  HAILE_TAXONOMY,
  POLICIES,
  PURPOSES,
  ROLES,
} from './types.js';
