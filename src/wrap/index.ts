/**
 * Agent routing: point any AI coding agent at the local compression listener,
 * and put its configuration back exactly as it was.
 *
 * This module is the engine, not a command. Two surfaces drive it:
 *
 *   `vg install <agent> --compress`   durable — writes the agent's own config
 *   `vg serve --compress -- <agent>`  one session — environment only
 *
 * and `vg uninstall <agent>` is the single revert path for both.
 */

export type { WrapAgent, AgentSpec, AppliedChange, WrapMethod, WrapPlan, WrapStatusRow, EditContext, DurableScope, EnsureProxyFn, ApplyResult, RevertResult, PrevValue } from './types.js';
export { WRAP_AGENTS, isWrapAgent } from './types.js';
export { AGENTS, agentSpec, applyProxyToAgent, claudeBaseUrlKey, claudeProxyUrl, codexLaunchArgs, codexDottedKey, codexActiveProvider, codexUsesChatGptAuth, copilotLane, defaultWireApiForModel, stripAutoModelArgs, projectNameFromCwd, withProjectHeader, toolSearchValue, opencodeConfigContent, COPILOT_BYOK_ENV_VARS, PROJECT_HEADER_NAME, PROJECT_ENV, TOOL_SEARCH_ENV } from './agents.js';
export { wrap, quietCliEnv, tcpPortAlive, runChild, waitForSignal, healDeadMarker, proxyTimeoutMs, type WrapOptions, type WrapResult, type SpawnFn } from './wrap.js';
export { unwrap, candidateFiles, type UnwrapOptions, type UnwrapResult } from './unwrap.js';
export { wrapStatus, wrapDiagnostics, type WrapDiagnostic, type StatusOptions } from './status.js';
export {
  loginCopilot,
  copilotToken,
  copilotTokenCandidates,
  copilotApiHost,
  copilotAuthFile,
  copilotStatus,
  saveCopilotToken,
  readCopilotToken,
  tokenFingerprint,
  exchangeCopilotToken,
  resolveCopilotBearer,
  copilotGithubHost,
  copilotEnterpriseDomain,
  copilotOauthUrls,
  copilotTokenExchangeUrl,
  copilotUserInfoUrl,
  copilotExchangeHeaders,
  copilotIntegrationId,
  copilotApiTokenValid,
  isCopilotApiUrl,
  parseExpiry,
  startDeviceAuthorization,
  pollDeviceAuthorization,
  COPILOT_DEFAULT_API_URL,
  COPILOT_CHAT_OAUTH_CLIENT_ID,
  type AuthDeps,
  type TokenCandidate,
  type CopilotApiToken,
} from './copilot-auth.js';
export {
  trackUsage,
  windowStatus,
  recordWindowReset,
  shouldPoll,
  onDemandPollAllowed,
  loadSubscriptionState,
  saveSubscriptionState,
  subscriptionStatePath,
  resetSubscriptionState,
  trackingEnabled,
  pollIntervalSeconds,
  FIVE_HOUR_MS,
  SEVEN_DAY_MS,
  ROLLOVER_MIN_ADVANCE_MS,
  type UsageEvent,
  type WindowStatus,
  type SubscriptionStatus,
  type SubscriptionState,
  type WindowAnchor,
  type WindowKind,
} from './subscription.js';
export { CaptureWriter, captureExchange, readCaptureFile, compareCaptures, sanitizeHeaders, sanitizeUrl, bodyDigest, routeKey, pathKey, MAX_BODY_PREVIEW_CHARS, type CaptureRecord, type CapturedExchange, type CaptureSession, type CaptureDiff, type CaptureLane, type ExchangeInput } from './capture.js';
export { readMarker, readOwners, acquireLock, withLock, applyManaged, revertManaged, applyJsonFields, revertJsonFields, applyYamlFields, revertYamlFields, applyTomlManaged, revertTomlManaged, stripJsonc, parseJsonLoose, type WrapMarker, type OwnersFile, type OwnerEntry, type OwnerHolder } from './edit.js';
