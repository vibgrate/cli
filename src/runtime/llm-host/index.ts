/**
 * Factory for the dual-mode llm-host (ADR-005).
 *
 * `createLlmHost({ isolation: 'embedded' })` — default Approach B.
 * `createLlmHost({ isolation: 'process', endpoint })` — enterprise shell.
 */

import * as path from 'node:path';
import { vibgrateRuntimeDir } from '../paths.js';
import { EmbeddedLlmHost } from './embedded.js';
import { ProcessLlmHost } from './process-bridge.js';
import type { LlmHost, LlmHostIsolation } from './types.js';

export type {
  LlmHost,
  LlmHostConfig,
  LlmHostIsolation,
  LlmChatMessage,
  LlmGenerateResult,
  LlmGenerateOptions,
  LlmMemoryReport,
} from './types.js';
export { EmbeddedLlmHost } from './embedded.js';
export {
  ProcessLlmHost,
  ProcessBridgeLlmHost,
  LLM_HOST_IPC_SCHEMA,
  startProcessHostServer,
} from './process-bridge.js';
export type { LlmHostIpcRequest, LlmHostIpcResponse, ProcessHostServerOptions } from './process-bridge.js';
export { generateWithLlamaBinding } from './binding.js';
export {
  acquireHostSession,
  generateOnSession,
  clearHostSessionPool,
  hostSessionPoolSize,
  listHostSessions,
  dropHostSession,
  evictIdleSessions,
  sessionKey,
} from './session.js';
export type { HostGenerateExtras, HostGenerateReport, HostSessionInfo } from './session.js';
export { attachGrammar, assertGrammarOrThrow, allowGrammarStringFallback } from './grammar.js';
export type { GrammarAttachResult, GrammarAttachMethod } from './grammar.js';
export {
  buildIdentifierTokenBias,
  planNextCharMask,
  tokenCompatibleWithTrie,
  trieFingerprint,
} from './logit-mask.js';
export type { LogitMaskBuildResult, SamplerHookMethod, BuildLogitMaskOptions } from './logit-mask.js';
export {
  createIdentStreamState,
  stepIdentStream,
  filterTokenTexts,
  attachDynamicIdentFilter,
  dynamicAllowedNextChars,
} from './identifier-sampler.js';
export type { IdentStreamState, IdentStepResult } from './identifier-sampler.js';
export { probeBindingCapabilities, supportsDynamicIdentSampler, supportsKvPrefixEvaluate } from './binding-capabilities.js';
export type { BindingCapabilities, ProbeBindingOptions } from './binding-capabilities.js';
export { composePromptConstraints } from './compose-constraints.js';
export { rankDraftCandidates, pickBestDraft } from './speculative.js';
export type { RankedDraft } from './speculative.js';

export interface CreateLlmHostOptions {
  isolation?: LlmHostIsolation;
  /** Socket path when isolation is `process`. Defaults under vibgrate runtime dir. */
  endpoint?: string;
  /** Pre-attach binding for embedded hosts (avoids a second ensure). */
  binding?: unknown;
  preferGrammar?: boolean;
}

export function createLlmHost(options: CreateLlmHostOptions = {}): LlmHost {
  const isolation = options.isolation ?? 'embedded';
  if (isolation === 'process') {
    return new ProcessLlmHost(options.endpoint ?? defaultProcessEndpoint());
  }
  const host = new EmbeddedLlmHost();
  if (options.binding) host.setBinding(options.binding);
  if (options.preferGrammar) host.setPreferGrammar(true);
  return host;
}

/** Default IPC socket path for the isolated llm-host process. */
export function defaultProcessEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(vibgrateRuntimeDir(env), 'llm-host.sock');
}

/** Resolve isolation from env / explicit override (MEP / config later). */
export function resolveInferenceIsolation(
  explicit?: LlmHostIsolation,
  env: NodeJS.ProcessEnv = process.env,
): LlmHostIsolation {
  if (explicit === 'embedded' || explicit === 'process') return explicit;
  const v = (env.VIBGRATE_INFERENCE_ISOLATION || env.VG_INFERENCE_ISOLATION || '').toLowerCase();
  if (v === 'process' || v === 'isolated') return 'process';
  return 'embedded';
}
