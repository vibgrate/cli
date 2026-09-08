/**
 * Filesystem contract for the context-compression layer.
 *
 * Everything lives under vg's platform-correct global roots (see
 * `src/runtime/paths.ts`): durable state in the data dir, throw-away runtime
 * state (pid/lock files) in the runtime dir. Pure path construction — callers
 * `mkdir -p` when they write, and every file is created `0o600`.
 *
 * Precedence for every resource: explicit argument > per-resource env var >
 * derived from the root > default. Overrides never cache, so tests can set
 * env vars per case.
 *
 * Retention (GUARDRAILS §1.7): everything here is derived scan-class data —
 * short TTLs (CCR: minutes) or 30-day rolling ledgers. Nothing holds
 * customer-authored content except memory, which is purged on
 * `vg serve memory` state.
 */

import * as path from 'node:path';
import { vibgrateDataDir, vibgrateRuntimeDir } from '../runtime/paths.js';

export const CONTEXT_DIR_ENV = 'VG_CONTEXT_DIR';

function override(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? path.resolve(v) : undefined;
}

/** Root for durable context-compression state. */
export function contextDir(env: NodeJS.ProcessEnv = process.env): string {
  return override(env, CONTEXT_DIR_ENV) ?? path.join(vibgrateDataDir(env), 'context');
}

/** Root for pid / lock / marker files. */
export function contextRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  return override(env, 'VG_CONTEXT_RUNTIME_DIR') ?? path.join(vibgrateRuntimeDir(env), 'context');
}

/** Directory holding one JSON file per retrievable original (`<hash>.json`). */
export function ccrStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  return override(env, 'VG_CCR_STORE_DIR') ?? path.join(contextDir(env), 'ccr');
}

/** Append-only savings ledger (one compression event per line). */
export function savingsEventsPath(env: NodeJS.ProcessEnv = process.env): string {
  return override(env, 'VG_SAVINGS_EVENTS_PATH') ?? path.join(contextDir(env), 'savings-events.jsonl');
}

/** Durable proxy savings totals + rollups. */
export function proxySavingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return override(env, 'VG_PROXY_SAVINGS_PATH') ?? path.join(contextDir(env), 'proxy-savings.json');
}

/** Cross-process MCP session stats (2-hour rolling window). */
export function sessionStatsPath(env: NodeJS.ProcessEnv = process.env): string {
  return override(env, 'VG_SESSION_STATS_PATH') ?? path.join(contextDir(env), 'session-stats.jsonl');
}

/** Output-token savings estimator state (baseline strata + holdout ledger). */
export function outputSavingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return override(env, 'VG_OUTPUT_SAVINGS_PATH') ?? path.join(contextDir(env), 'output-savings.json');
}

/** Learned verbosity profile. */
export function verbosityProfilePath(env: NodeJS.ProcessEnv = process.env): string {
  return override(env, 'VG_VERBOSITY_PATH') ?? path.join(contextDir(env), 'verbosity.json');
}

/** User-editable settings (applied to env with set-if-absent semantics). */
export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return override(env, 'VG_CONTEXT_SETTINGS_PATH') ?? path.join(contextDir(env), 'settings.json');
}

/** User overrides for model context limits + pricing. */
export function modelsConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return override(env, 'VG_MODELS_CONFIG_PATH') ?? path.join(contextDir(env), 'models.json');
}

/** Root for memory stores. */
export function memoryDir(env: NodeJS.ProcessEnv = process.env): string {
  return override(env, 'VG_MEMORY_DIR') ?? path.join(contextDir(env), 'memory');
}

export function memoryProjectDir(projectKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(memoryDir(env), 'projects', projectKey);
}

export function memoryUserDir(userKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(memoryDir(env), 'users', userKey);
}

export function memoryGlobalDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(memoryDir(env), 'global');
}

/** Learn state (last analysis timestamps per project, verbosity, loops). */
export function learnDir(env: NodeJS.ProcessEnv = process.env): string {
  return override(env, 'VG_LEARN_DIR') ?? path.join(contextDir(env), 'learn');
}

/** Rotating proxy log directory. */
export function logDir(env: NodeJS.ProcessEnv = process.env): string {
  return override(env, 'VG_CONTEXT_LOG_DIR') ?? path.join(contextDir(env), 'logs');
}

export function proxyLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(logDir(env), 'proxy.log');
}

export function debugDumpDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(logDir(env), 'debug-4xx');
}

/** MCP install ledger (fingerprints of entries we wrote, per agent). */
export function mcpInstallLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(contextDir(env), 'mcp-installs.json');
}

/** Anonymous per-install id lives with the rest of vg's telemetry state. */

// --- runtime (pid / lock / client markers) ---------------------------------

/** `{pid, port, version, startedAt, mode, …}` for a running proxy. */
export function proxyStatePath(port: number, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(contextRuntimeDir(env), `proxy-${port}.json`);
}

/** Advisory lock held across the check-and-start critical section. */
export function proxyStartLockPath(port: number, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(contextRuntimeDir(env), `proxy-${port}.lock`);
}

/** One marker per wrap client attached to a proxy port (`<pid>.json`). */
export function proxyClientsDir(port: number, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(contextRuntimeDir(env), 'clients', String(port));
}

/** Per-project wrap sidecars (beside the agent settings file we edited). */
export function wrapMarkerPath(settingsFile: string): string {
  return path.join(path.dirname(settingsFile), '.vg-wrap-marker.json');
}

export function wrapOwnersPath(settingsFile: string): string {
  return path.join(path.dirname(settingsFile), '.vg-wrap-owners.json');
}

export function wrapSettingsLockPath(settingsFile: string): string {
  return path.join(path.dirname(settingsFile), '.vg-wrap-settings.lock');
}

/** Backup written before an agent's config file is edited for routing. */
export function wrapBackupPath(configFile: string): string {
  return `${configFile}.vg-backup`;
}
