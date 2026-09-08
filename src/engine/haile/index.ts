export { adaptGraph, isCallableKind, symbolKindOf } from './adapter.js';
export { formatHaileLines, haileJsonFields } from './format.js';
export { loadHaileProvider, resetHaileProviderCache, haileModuleDir } from './haile-provider.js';
export type { HaileClassification, HaileClassifyInput, HaileProvider } from './haile-provider.js';
export {
  deleteHaileSidecarFor,
  emptySidecar,
  findHaileSymbol,
  haileSidecarPathFor,
  readHaileSidecar,
  serializeSidecar,
  legacyHaileSidecarPathFor,
  writeHaileSidecarFor,
  writeSidecarDocument,
} from './sidecar.js';
export type {
  HaileCallable,
  HaileModuleSummary,
  HaileProfile,
  HaileSidecar,
  HaileSymbol,
} from './types.js';
export {
  DEFAULT_PROFILE,
  DEFAULT_SYMBOL_CAP,
  HAILE_ENGINE_VERSION,
  HAILE_IR,
  HAILE_IR_LEGACY,
  HAILE_MAGIC_LEGACY,
  HAILE_TAXONOMY_LEGACY,
  HAILE_MAGIC,
  HAILE_TAXONOMY,
  PURPOSES,
  ROLES,
} from './types.js';
