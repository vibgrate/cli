export { VGD_PROTOCOL_VERSION, parseRequest } from './protocol.js';
export type { WorkspaceRecord, VgdRequest, VgdResponse } from './protocol.js';
export { WorkspaceRegistry } from './registry.js';
export { startVgdServer } from './server.js';
export type { VgdServer, VgdServerOptions } from './server.js';
export { vgdRequest, vgdIsRunning } from './client.js';
export type { VgdClientOptions } from './client.js';
export { vgdSocketPath, vgdPidPath } from './paths.js';
// Re-export federation helpers used with vgd multi-root registration.
export {
  loadFederation,
  loadOrDiscoverFederation,
  federationPath,
  federationFromWorkspaceRoots,
  writeFederationFile,
  highConfidenceBridges,
  FEDERATION_SCHEMA_VERSION,
} from '../federation.js';
export type { FederatedWorkspace, FederationMember, BridgeEdge } from '../federation.js';
export { resolveExecutionEnv, detectSecurityCapabilities, createHostExecutionEnv } from '../execution-env.js';
export type { SecurityTier, ExecutionEnv, SecurityCapabilities } from '../execution-env.js';
export {
  resolveModelExecutionProfile,
  defaultModelExecutionProfile,
  mergeModelExecutionProfile,
  MODEL_EXECUTION_PROFILE_SCHEMA_VERSION,
} from '../model-execution-profile.js';
export type { ModelExecutionProfile } from '../model-execution-profile.js';
export { detectSandboxCapabilities, selectSandboxBackend, firejailArgv } from '../sandbox-backend.js';
export type { SandboxBackendInfo, SandboxCapabilities } from '../sandbox-backend.js';
export { ActiveGraphCache, DEFAULT_ACTIVE_GRAPH_IDLE_MS } from '../active-graph-cache.js';
export type { ActiveGraphSlot, ActiveGraphSlotSummary } from '../active-graph-cache.js';
export { detectGitRef, branchGraphSnapshotId, activeGraphSlotKey } from '../git-ref.js';
export type { GitRefInfo, GitRefKind } from '../git-ref.js';
export { BranchGraphSession } from '../branch-graph-session.js';
export type { BranchGraphLoadResult, BranchGraphSessionOptions } from '../branch-graph-session.js';
