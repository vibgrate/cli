/**
 * `@vibgrate/graph` — programmatic API.
 *
 * The open (Apache-2.0), deterministic code-graph engine. All functions are pure
 * over their inputs and never touch the network. See VG-PACKAGE-AND-SCHEMA §2.3.
 */

export * from './schema.js';
export { VERSION } from './version.js';

export { buildGraph } from './engine/build.js';
export type { BuildOptions, BuildResult } from './engine/build.js';

export { loadGraph } from './engine/load.js';
export { serializeGraph, parseGraph, stableStringify } from './engine/serialize.js';
export { writeArtifacts, defaultGraphPath, vibgrateDir } from './engine/artifacts.js';
export type { WriteOptions, WrittenArtifacts } from './engine/artifacts.js';
export { verifyDeterminism } from './engine/verify.js';
export type { VerifyResult } from './engine/verify.js';
export { renderReport } from './engine/report.js';
export { renderHtml } from './engine/html.js';

export { buildModuleResolver, relativeResolver, parseJsonc } from './engine/module-resolver.js';
export type { ModuleResolver } from './engine/module-resolver.js';
export { decodeScipIndex, scipEdges } from './engine/scip.js';
export type { ScipIndex, ScipDocument, ScipOccurrence } from './engine/scip.js';
export { discover, SKIP_DIRS, UsageError } from './engine/discover.js';
export type { DiscoveredFile, DiscoverOptions } from './engine/discover.js';
export { LANGUAGES, allLanguageIds, langById, langForExtension } from './engine/languages.js';
export type { LanguageDef } from './engine/languages.js';
export { parseSource } from './engine/parse.js';
export type { FileParse } from './engine/types.js';

// Phase 1 — query, navigation, analysis, MCP.
export { queryGraph, queryGraphSemantic, identifierParts } from './engine/query.js';
export type { QueryOptions, QueryResult, QueryMatch, SemanticQueryOptions } from './engine/query.js';
export { loadEmbedder, getNodeEmbeddings, cosine, nodeEmbedText } from './engine/embeddings.js';
export type { Embedder, LoadEmbedderOptions } from './engine/embeddings.js';
export { findNodes, resolveOne, nodeById } from './engine/lookup.js';
export { impactOf } from './engine/impact.js';
export type { ImpactResult, ImpactItem } from './engine/impact.js';
export { shortestPath } from './engine/paths.js';
export type { PathResult } from './engine/paths.js';
export { analyze } from './engine/analyze.js';
export type { AnalyzeResult, AnalyzeOptions, ClusterMode } from './engine/analyze.js';
export { GraphIndex } from './engine/relations.js';
export { TOOLS } from './mcp/tools.js';
export type { VgTool } from './mcp/tools.js';
export { createServer, serveStdio } from './mcp/server.js';

// Phase 2 — the moat (tests, facts, grounding, drift) + savings.
export { isTestFile, applyStaticTestLinkage } from './engine/tests.js';
export { coveringTests, testsToRun, detectRunner } from './engine/test-query.js';
export { loadCoverage, applyCoverage } from './engine/coverage.js';
export { buildFacts } from './engine/facts.js';
export { groundGraph } from './engine/grounding.js';
export { FREE_PACK } from './grounding/pack.js';
export type { KnowledgePack, PackEntry } from './grounding/pack.js';
export { inventory as dependencyInventory, enrichOnline } from './engine/drift.js';
export type { DriftInventory, DepRecord } from './engine/drift.js';
export { discoverModels } from './engine/models.js';
export type { LocalModel } from './engine/models.js';
export { readSavings, recordSaving, savingsRecorded } from './engine/savings.js';
export type { SavingsReport } from './engine/savings.js';

// Phase 3 — library currency (Context7 parity) + install breadth.
export { loadCatalog, saveCatalog, resolveLib, addLibrary, readDoc, driftFor, libId } from './engine/lib.js';
export type { LibCatalog, LibEntry, LibSource, DriftNote } from './engine/lib.js';
export { ASSISTANTS, assistantById, installAssistant, uninstallAssistant } from './install/registry.js';
export type { Assistant } from './install/registry.js';

// Phase 4 — export formats, the decoupled push seam, air-gapped bundle.
export { exportGraph, formatForExt } from './engine/export.js';
export type { ExportFormat, ExportContext } from './engine/export.js';
export { buildEnvelope, redactGraph } from './engine/push.js';
export type { GraphUploadEnvelope } from './engine/push.js';
export { grammarsSourceDir } from './engine/grammars.js';
