/**
 * Model host broker inside vgd (Approach B / B4 + P4 multi-client).
 *
 * Long-lived daemon process can keep warm llama.cpp sessions so CLI and IDE
 * clients share one loaded model. Management (which pack/mode) stays in the
 * client/orchestrator; vgd only loads paths the client requests and generates.
 *
 * P4: clients acquire/release leases per model path so unload is refcounted
 * (one IDE + CLI can share a warm model without the first exit killing it).
 *
 * Binding is injected (never static node-llama-cpp import).
 */

import {
  acquireHostSession,
  clearHostSessionPool,
  dropHostSession,
  evictIdleSessions,
  generateOnSession,
  hostSessionPoolSize,
  listHostSessions,
  type HostGenerateReport,
  type HostSessionInfo,
} from '../llm-host/session.js';
import type { LlmChatMessage, LlmGenerateOptions } from '../llm-host/types.js';

export interface HostBrokerStatus {
  poolSize: number;
  loadedModels: string[];
  bindingReady: boolean;
  /** Per-path client lease counts (P4). */
  leases: Record<string, number>;
  sessions: HostSessionInfo[];
}

export interface HostClientLease {
  clientId: string;
  modelPath: string;
}

export class VgdHostBroker {
  private binding: unknown | null = null;
  private readonly loaded = new Set<string>();
  /** modelPath → set of client ids holding a lease. */
  private readonly leases = new Map<string, Set<string>>();

  setBinding(lib: unknown | null): void {
    this.binding = lib;
  }

  hasBinding(): boolean {
    return this.binding != null;
  }

  status(): HostBrokerStatus {
    const leases: Record<string, number> = {};
    for (const [path, clients] of this.leases) {
      leases[path] = clients.size;
    }
    return {
      poolSize: hostSessionPoolSize(),
      loadedModels: [...this.loaded],
      bindingReady: this.binding != null,
      leases,
      sessions: listHostSessions(),
    };
  }

  /**
   * Load weights and optionally register a client lease (P4 multi-client).
   * When clientId is omitted, behaves like a one-shot load (no lease bookkeeping).
   */
  async load(
    modelPath: string,
    clientId?: string,
  ): Promise<{ ok: true; modelPath: string; leases: number } | { ok: false; error: string }> {
    if (!this.binding) {
      return { ok: false, error: 'host binding not configured — start vgd with llama runtime or attach binding' };
    }
    try {
      await acquireHostSession(this.binding, modelPath);
      this.loaded.add(modelPath);
      if (clientId) {
        let set = this.leases.get(modelPath);
        if (!set) {
          set = new Set();
          this.leases.set(modelPath, set);
        }
        set.add(clientId);
      }
      evictIdleSessions(4);
      return { ok: true, modelPath, leases: this.leases.get(modelPath)?.size ?? 0 };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Release a client lease. When the last lease is released, drop the warm
   * session for that path. Without clientId, clears all leases for the path
   * (or entire pool if modelPath omitted).
   */
  async unload(
    modelPath?: string,
    clientId?: string,
  ): Promise<{ ok: true; cleared: number; remainingLeases: number }> {
    if (!modelPath) {
      const n = hostSessionPoolSize();
      clearHostSessionPool();
      this.loaded.clear();
      this.leases.clear();
      return { ok: true, cleared: n, remainingLeases: 0 };
    }

    if (clientId) {
      const set = this.leases.get(modelPath);
      if (set) {
        set.delete(clientId);
        if (set.size === 0) this.leases.delete(modelPath);
      }
      const remaining = this.leases.get(modelPath)?.size ?? 0;
      if (remaining === 0) {
        const dropped = dropHostSession(modelPath) ? 1 : 0;
        this.loaded.delete(modelPath);
        return { ok: true, cleared: dropped, remainingLeases: 0 };
      }
      return { ok: true, cleared: 0, remainingLeases: remaining };
    }

    // No clientId: force drop path (all leases).
    this.leases.delete(modelPath);
    const dropped = dropHostSession(modelPath) ? 1 : 0;
    this.loaded.delete(modelPath);
    return { ok: true, cleared: dropped, remainingLeases: 0 };
  }

  /** How many clients hold a lease on modelPath. */
  leaseCount(modelPath: string): number {
    return this.leases.get(modelPath)?.size ?? 0;
  }

  async generate(
    modelPath: string,
    messages: LlmChatMessage[],
    opts?: LlmGenerateOptions,
  ): Promise<{ ok: true; result: HostGenerateReport } | { ok: false; error: string }> {
    if (!this.binding) {
      return { ok: false, error: 'host binding not configured' };
    }
    try {
      const session = await acquireHostSession(this.binding, modelPath);
      this.loaded.add(modelPath);
      const result = await generateOnSession(session, messages, {
        grammar: opts?.grammar,
        requireGrammar: opts?.requireGrammar,
        identifierTrie: opts?.identifierTrie,
        annotateUnknownIdentifiers: opts?.annotateUnknownIdentifiers,
        draftCandidates: opts?.draftCandidates,
        maxTokens: opts?.maxTokens,
        temperature: opts?.temperature,
        promptSegments: opts?.promptSegments,
      });
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** Process-wide broker for the running vgd (tests may replace). */
let defaultBroker: VgdHostBroker | null = null;

export function getVgdHostBroker(): VgdHostBroker {
  if (!defaultBroker) defaultBroker = new VgdHostBroker();
  return defaultBroker;
}

export function resetVgdHostBroker(): void {
  defaultBroker = null;
  clearHostSessionPool();
}
