/**
 * Wire protocol for the lightweight Vibgrate daemon (`vgd`) — Fusion Runtime Phase 2 prototype.
 *
 * Line-delimited JSON over a local Unix domain socket (named pipe on Windows).
 * No credentials leave this process; the socket is local-only.
 */

export const VGD_PROTOCOL_VERSION = 'vgd/0' as const;

export interface WorkspaceRecord {
  /** Stable repository id (same as global store key). */
  id: string;
  /** Absolute repository root. */
  root: string;
  /** Absolute path to the current graph snapshot (may not exist yet). */
  graphPath: string;
  /** ISO timestamp when this workspace was last registered / refreshed. */
  registeredAt: string;
  /** Optional federation label. */
  label?: string;
  /** Optional federation role. */
  role?: 'primary' | 'member';
  /** Git branch or detached SHA at registration (multi-branch ActiveGraph). */
  gitRef?: string;
}

/** Lightweight ActiveGraph slot summary (no full graph payload). */
export interface GraphSlotSummary {
  repositoryId: string;
  gitRef: string;
  loadedAt: number;
  lastAccessAt: number;
  nodeCount: number;
  current: boolean;
  idleMs: number;
  evictable: boolean;
}

export type VgdRequest =
  | { op: 'ping' }
  | { op: 'status' }
  /** Ask the daemon to exit cleanly (honoured only by a standalone `vg daemon start`). */
  | { op: 'shutdown' }
  | { op: 'list' }
  | { op: 'register'; root: string; label?: string; role?: 'primary' | 'member' }
  | { op: 'unregister'; root: string }
  | {
      op: 'register-federation';
      primaryRoot: string;
      members: Array<{ root: string; label?: string; role?: 'primary' | 'member' }>;
    }
  | { op: 'list-graph-slots'; repositoryId?: string }
  | { op: 'select-git-ref'; repositoryId: string; gitRef: string }
  | { op: 'put-graph'; repositoryId: string; gitRef: string; graph: unknown }
  /**
   * Load the workspace's on-disk code map into ActiveGraph inside the daemon
   * (binary snapshot first, JSON fallback). The fast-path alternative to
   * shipping the whole graph over the socket with put-graph — use it whenever
   * the map already exists on disk.
   */
  | { op: 'load-graph'; root: string; gitRef?: string; graphPath?: string }
  /** Lexical/structural query against the ActiveGraph for a repository. */
  | { op: 'query-graph'; repositoryId: string; query: string; limit?: number; gitRef?: string }
  /** Blast-radius impact for a symbol id or qualified name. */
  | { op: 'impact-of'; repositoryId: string; symbol: string; depth?: number; gitRef?: string }
  /** Compact graph meta for the current (or named) slot — not the full graph. */
  | { op: 'graph-summary'; repositoryId: string; gitRef?: string }
  /** Semantic warm (docs/VGD-SEMANTIC-WARM-SPEC.md): worker + per-slot index state. */
  | { op: 'embed-status'; repositoryId?: string }
  /** Embed one string in the daemon's warm worker; the caller ranks locally. */
  | { op: 'embed-query'; text: string }
  /** Ensure the slot's vector index exists, building it if needed. */
  | { op: 'embed-index'; repositoryId: string; gitRef?: string }
  /** Approach B host broker: warm model status inside vgd. */
  | { op: 'host-status' }
  | { op: 'host-load'; modelPath: string }
  | { op: 'host-unload'; modelPath?: string }
  | {
      op: 'host-generate';
      modelPath: string;
      messages: Array<{ role: string; content: string }>;
      grammar?: string;
      requireGrammar?: boolean;
      maxTokens?: number;
      temperature?: number;
    };

/** Semantic warm state: the worker, and one row per resident slot index. */
export interface EmbedStatusPayload {
  worker: 'stopped' | 'starting' | 'ready' | 'unavailable';
  pid?: number;
  model?: string;
  crashes: number;
  reason?: string;
  slots: Array<{
    repositoryId: string;
    gitRef: string;
    state: string;
    vectors: number;
    nodeCount: number;
    builtAt?: number;
    buildMs?: number;
    error?: string;
  }>;
}

/** Compact match row for query-graph (no full node payloads). */
export interface VgdQueryMatch {
  id: string;
  qualifiedName: string;
  kind: string;
  file: string;
  line: number;
  score: number;
  why: string;
}

export interface VgdImpactItem {
  id: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  depth: number;
  confidence: number;
}

export type VgdResponse =
  | { ok: true; pong: true; version: typeof VGD_PROTOCOL_VERSION }
  | {
      ok: true;
      pid: number;
      uptimeMs: number;
      workspaces: number;
      /** Resident multi-branch ActiveGraph slots (Fusion §4.1.1). */
      graphSlots?: number;
      version: typeof VGD_PROTOCOL_VERSION;
      socketPath: string;
    }
  | { ok: true; workspaces: WorkspaceRecord[] }
  | { ok: true; workspace: WorkspaceRecord }
  | { ok: true; workspaces: WorkspaceRecord[]; federation: true }
  | { ok: true; removed: boolean }
  | { ok: true; stopping: true }
  | { ok: true; slots: GraphSlotSummary[] }
  | { ok: true; semantic: EmbedStatusPayload }
  | { ok: true; vector: number[]; model?: string }
  | {
      ok: true;
      indexed: true;
      repositoryId: string;
      gitRef: string;
      state: string;
      vectors: number;
      buildMs?: number;
    }
  | { ok: true; selected: true; repositoryId: string; gitRef: string }
  | { ok: true; stored: true; repositoryId: string; gitRef: string; nodeCount: number }
  | {
      ok: true;
      query: string;
      repositoryId: string;
      gitRef: string;
      matches: VgdQueryMatch[];
      tokensEstimate: number;
    }
  | {
      ok: true;
      repositoryId: string;
      gitRef: string;
      symbol: string;
      root: { id: string; name: string };
      depth: number;
      affected: VgdImpactItem[];
      direct: number;
      transitive: number;
    }
  | {
      ok: true;
      repositoryId: string;
      gitRef: string;
      summary: {
        nodeCount: number;
        edgeCount: number;
        languages: string[];
        corpusHash: string | null;
        root: string | null;
      };
    }
  | {
      ok: true;
      host: {
        poolSize: number;
        loadedModels: string[];
        bindingReady: boolean;
      };
    }
  | { ok: true; hostLoaded: true; modelPath: string }
  | { ok: true; hostUnloaded: true; cleared: number }
  | {
      ok: true;
      hostGenerated: true;
      text: string;
      model: string;
      constrained: boolean;
      grammarApplied?: boolean;
      draftAcceptedChars?: number;
      latencyMs?: number;
      unknownIdentifiers?: string[];
    }
  | { ok: false; error: string; code?: string };

export function parseRequest(line: string): VgdRequest | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { error: 'invalid JSON' };
  }
  if (!raw || typeof raw !== 'object') return { error: 'request must be an object' };
  const op = (raw as { op?: unknown }).op;
  if (op === 'ping' || op === 'status' || op === 'shutdown' || op === 'list') return { op };
  if (op === 'list-graph-slots') {
    const repositoryId = (raw as { repositoryId?: unknown }).repositoryId;
    return {
      op: 'list-graph-slots',
      repositoryId: typeof repositoryId === 'string' && repositoryId.trim() ? repositoryId.trim() : undefined,
    };
  }
  if (op === 'select-git-ref') {
    const repositoryId = (raw as { repositoryId?: unknown }).repositoryId;
    const gitRef = (raw as { gitRef?: unknown }).gitRef;
    if (typeof repositoryId !== 'string' || !repositoryId.trim()) return { error: 'select-git-ref requires repositoryId' };
    if (typeof gitRef !== 'string' || !gitRef.trim()) return { error: 'select-git-ref requires gitRef' };
    return { op: 'select-git-ref', repositoryId: repositoryId.trim(), gitRef: gitRef.trim() };
  }
  if (op === 'put-graph') {
    const repositoryId = (raw as { repositoryId?: unknown }).repositoryId;
    const gitRef = (raw as { gitRef?: unknown }).gitRef;
    const graph = (raw as { graph?: unknown }).graph;
    if (typeof repositoryId !== 'string' || !repositoryId.trim()) return { error: 'put-graph requires repositoryId' };
    if (typeof gitRef !== 'string' || !gitRef.trim()) return { error: 'put-graph requires gitRef' };
    if (!graph || typeof graph !== 'object') return { error: 'put-graph requires graph object' };
    return { op: 'put-graph', repositoryId: repositoryId.trim(), gitRef: gitRef.trim(), graph };
  }
  if (op === 'load-graph') {
    const root = (raw as { root?: unknown }).root;
    const gitRef = (raw as { gitRef?: unknown }).gitRef;
    const graphPath = (raw as { graphPath?: unknown }).graphPath;
    if (typeof root !== 'string' || !root.trim()) return { error: 'load-graph requires a non-empty root' };
    return {
      op: 'load-graph',
      root: root.trim(),
      gitRef: typeof gitRef === 'string' && gitRef.trim() ? gitRef.trim() : undefined,
      graphPath: typeof graphPath === 'string' && graphPath.trim() ? graphPath.trim() : undefined,
    };
  }
  if (op === 'embed-status') {
    const repositoryId = (raw as { repositoryId?: unknown }).repositoryId;
    return {
      op: 'embed-status',
      repositoryId: typeof repositoryId === 'string' && repositoryId.trim() ? repositoryId.trim() : undefined,
    };
  }
  if (op === 'embed-query') {
    const text = (raw as { text?: unknown }).text;
    if (typeof text !== 'string' || !text.trim()) return { error: 'embed-query requires text' };
    // Socket input is untrusted like every other op's; bound it so one caller
    // cannot make the worker chew on an arbitrarily large string.
    return { op: 'embed-query', text: text.trim().slice(0, 8_000) };
  }
  if (op === 'embed-index') {
    const repositoryId = (raw as { repositoryId?: unknown }).repositoryId;
    const gitRef = (raw as { gitRef?: unknown }).gitRef;
    if (typeof repositoryId !== 'string' || !repositoryId.trim()) return { error: 'embed-index requires repositoryId' };
    return {
      op: 'embed-index',
      repositoryId: repositoryId.trim(),
      gitRef: typeof gitRef === 'string' && gitRef.trim() ? gitRef.trim() : undefined,
    };
  }
  if (op === 'query-graph') {
    const repositoryId = (raw as { repositoryId?: unknown }).repositoryId;
    const query = (raw as { query?: unknown }).query;
    const limit = (raw as { limit?: unknown }).limit;
    const gitRef = (raw as { gitRef?: unknown }).gitRef;
    if (typeof repositoryId !== 'string' || !repositoryId.trim()) return { error: 'query-graph requires repositoryId' };
    if (typeof query !== 'string' || !query.trim()) return { error: 'query-graph requires query' };
    return {
      op: 'query-graph',
      repositoryId: repositoryId.trim(),
      query: query.trim(),
      limit: typeof limit === 'number' && limit > 0 ? Math.min(Math.floor(limit), 50) : undefined,
      gitRef: typeof gitRef === 'string' && gitRef.trim() ? gitRef.trim() : undefined,
    };
  }
  if (op === 'impact-of') {
    const repositoryId = (raw as { repositoryId?: unknown }).repositoryId;
    const symbol = (raw as { symbol?: unknown }).symbol;
    const depth = (raw as { depth?: unknown }).depth;
    const gitRef = (raw as { gitRef?: unknown }).gitRef;
    if (typeof repositoryId !== 'string' || !repositoryId.trim()) return { error: 'impact-of requires repositoryId' };
    if (typeof symbol !== 'string' || !symbol.trim()) return { error: 'impact-of requires symbol' };
    return {
      op: 'impact-of',
      repositoryId: repositoryId.trim(),
      symbol: symbol.trim(),
      depth: typeof depth === 'number' && depth > 0 ? Math.min(Math.floor(depth), 12) : undefined,
      gitRef: typeof gitRef === 'string' && gitRef.trim() ? gitRef.trim() : undefined,
    };
  }
  if (op === 'graph-summary') {
    const repositoryId = (raw as { repositoryId?: unknown }).repositoryId;
    const gitRef = (raw as { gitRef?: unknown }).gitRef;
    if (typeof repositoryId !== 'string' || !repositoryId.trim()) return { error: 'graph-summary requires repositoryId' };
    return {
      op: 'graph-summary',
      repositoryId: repositoryId.trim(),
      gitRef: typeof gitRef === 'string' && gitRef.trim() ? gitRef.trim() : undefined,
    };
  }
  if (op === 'register' || op === 'unregister') {
    const root = (raw as { root?: unknown }).root;
    if (typeof root !== 'string' || !root.trim()) return { error: `${op} requires a non-empty root` };
    const label = (raw as { label?: unknown }).label;
    const role = (raw as { role?: unknown }).role;
    if (op === 'register') {
      return {
        op: 'register',
        root: root.trim(),
        label: typeof label === 'string' ? label : undefined,
        role: role === 'primary' || role === 'member' ? role : undefined,
      };
    }
    return { op: 'unregister', root: root.trim() };
  }
  if (op === 'register-federation') {
    const primaryRoot = (raw as { primaryRoot?: unknown }).primaryRoot;
    const members = (raw as { members?: unknown }).members;
    if (typeof primaryRoot !== 'string' || !primaryRoot.trim()) return { error: 'register-federation requires primaryRoot' };
    if (!Array.isArray(members) || members.length === 0) return { error: 'register-federation requires members[]' };
    const parsed: Array<{ root: string; label?: string; role?: 'primary' | 'member' }> = [];
    for (const m of members) {
      if (!m || typeof m !== 'object') continue;
      const root = (m as { root?: unknown }).root;
      if (typeof root !== 'string' || !root.trim()) continue;
      const label = (m as { label?: unknown }).label;
      const role = (m as { role?: unknown }).role;
      parsed.push({
        root: root.trim(),
        label: typeof label === 'string' ? label : undefined,
        role: role === 'primary' || role === 'member' ? role : undefined,
      });
    }
    if (!parsed.length) return { error: 'register-federation members must include at least one root' };
    return { op: 'register-federation', primaryRoot: primaryRoot.trim(), members: parsed };
  }
  if (op === 'host-status') return { op: 'host-status' };
  if (op === 'host-load') {
    const modelPath = (raw as { modelPath?: unknown }).modelPath;
    if (typeof modelPath !== 'string' || !modelPath.trim()) return { error: 'host-load requires modelPath' };
    return { op: 'host-load', modelPath: modelPath.trim() };
  }
  if (op === 'host-unload') {
    const modelPath = (raw as { modelPath?: unknown }).modelPath;
    return {
      op: 'host-unload',
      modelPath: typeof modelPath === 'string' && modelPath.trim() ? modelPath.trim() : undefined,
    };
  }
  if (op === 'host-generate') {
    const modelPath = (raw as { modelPath?: unknown }).modelPath;
    const messages = (raw as { messages?: unknown }).messages;
    if (typeof modelPath !== 'string' || !modelPath.trim()) return { error: 'host-generate requires modelPath' };
    if (!Array.isArray(messages) || messages.length === 0) return { error: 'host-generate requires messages[]' };
    const parsed: Array<{ role: string; content: string }> = [];
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      const role = (m as { role?: unknown }).role;
      const content = (m as { content?: unknown }).content;
      if (typeof role !== 'string' || typeof content !== 'string') continue;
      parsed.push({ role, content });
    }
    if (!parsed.length) return { error: 'host-generate messages must include role+content' };
    const grammar = (raw as { grammar?: unknown }).grammar;
    const requireGrammar = (raw as { requireGrammar?: unknown }).requireGrammar;
    const maxTokens = (raw as { maxTokens?: unknown }).maxTokens;
    const temperature = (raw as { temperature?: unknown }).temperature;
    return {
      op: 'host-generate',
      modelPath: modelPath.trim(),
      messages: parsed,
      grammar: typeof grammar === 'string' ? grammar : undefined,
      requireGrammar: requireGrammar === true,
      maxTokens: typeof maxTokens === 'number' ? maxTokens : undefined,
      temperature: typeof temperature === 'number' ? temperature : undefined,
    };
  }
  return { error: `unknown op: ${String(op)}` };
}
