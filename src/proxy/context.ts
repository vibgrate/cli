/**
 * The per-process proxy context every handler receives: configuration, the
 * dependency bundle, and the long-lived subsystems (sessions, limiter, cost,
 * savings, metrics, logs, caches).
 */

import type { ProxyConfig } from './config.js';
import type { ProxyDeps } from './deps.js';
import type { RuntimeEnv } from './runtime-env.js';
import type { Metrics } from './metrics.js';
import type { SessionEngine } from './session.js';
import type { RateLimiter } from './rate-limit.js';
import type { CostTracker } from './cost.js';
import type { BudgetGuard } from './budget.js';
import type { SavingsTracker } from './savings-tracker.js';
import type { OutputSavingsRecorder } from './output-savings.js';
import type { ProxyLogger, RequestLogger } from './request-log.js';
import type { AuditLog } from './audit.js';
import type { SemanticCache } from './semantic-cache.js';
import type { Cidr } from './guards.js';

export interface ProxyLimits {
  maxBodyBytes: number;
  bodyTooLargeStatus: number;
  sseBufferMaxBytes: number;
  requestTimeoutMs: number;
  bufferedGraceMs: number;
  heartbeatMs: number;
  maxMessages: number;
  retryMaxAttempts: number;
}

export interface ProxyContext {
  config: ProxyConfig;
  deps: ProxyDeps;
  runtime: RuntimeEnv;
  metrics: Metrics;
  sessions: SessionEngine;
  rateLimiter: RateLimiter;
  cost: CostTracker;
  budget: BudgetGuard;
  savings: SavingsTracker;
  outputSavings: OutputSavingsRecorder;
  requestLog: RequestLogger;
  logger: ProxyLogger;
  audit: AuditLog;
  semanticCache: SemanticCache;
  transport: typeof fetch;
  limits: ProxyLimits;
  trustedGateways: Cidr[];
  trustedDashboard: Cidr[];
  corsOrigins: string[];
  stripInternalHeaders: boolean;
  metricsEnabled: boolean;
  startedAt: number;
  pid: number;
  version: string;
  bound: string[];
  missing: string[];
  requestCounter: number;
  inflight: number;
  /** Learned verbosity level (from the verbosity profile file), when present. */
  learnedVerbosity?: number;
  requestShutdown: () => void;
}

export const MAX_MESSAGE_ARRAY_LENGTH = 10_000;
