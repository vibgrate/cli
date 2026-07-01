/**
 * Hosted catalog fall-through client (VG-LIB-SUPERSET-PLAN D7/D18, S2.4).
 *
 * The CLI is local-first: it serves the on-disk answer for free, offline, no key. This
 * client is the OPT-IN escalation seam — only consulted when (a) the user passed `--online`
 * (and not `--local`), AND (b) the deterministic quality gate (engine/quality.ts) judged the
 * local extraction insufficient. It calls the public hosted catalog (the §4 canonical shape
 * over HTTP) and returns a better answer, or `null`.
 *
 * Hard guarantees: it NEVER throws and NEVER blocks the local path — any failure (offline,
 * timeout, non-200, unparseable, not-yet-deployed) resolves to `null`, so `vg lib` always
 * still prints the best local answer. No key is sent; the public catalog is anonymous (the
 * no-key funnel, D7).
 *
 * Endpoint: the SAME regional ingest host the CLI already uses for `scan`/`push`
 * (`us.ingest.vibgrate.com` by default, region-aware), resolved via `resolveIngestHost` —
 * the lib catalog rides the existing API surface rather than a separate host. Overridable
 * by `--region`/`--ingest` (like scans) or `VIBGRATE_LIB_HOST`.
 */
import { resolveIngestHost } from '../reporting/regions.js';

export interface HostedDocsRequest {
  name?: string;
  targetId?: string;
  query?: string;
  verbosity?: 'concise' | 'balanced' | 'exhaustive';
  maxTokens?: number;
}

export interface HostedDocsResult {
  content: string;
  version: string | null;
  source: 'hosted';
  metadata?: Record<string, unknown>;
}

export interface HostedOptions {
  /** Raw base URL override; else VIBGRATE_LIB_HOST env; else the resolved ingest host. */
  base?: string;
  /** Data-residency region (us/eu/…), same as scans. Defaults to us. */
  region?: string;
  /** Explicit ingest URL override (host extracted), same as scans (wins over region). */
  ingest?: string;
  /** Optional DSN identity — sends the `VibgrateDSN` header so the call gets the workspace tier. */
  auth?: { keyId: string; secret: string };
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch (undefined → disabled, returns null). */
  fetchImpl?: typeof fetch;
}

/** Resolve the hosted base URL: explicit base / env → the regional ingest host (default us). */
export function hostedBase(opts: { base?: string; region?: string; ingest?: string } = {}): string {
  const explicit = opts.base || process.env.VIBGRATE_LIB_HOST;
  if (explicit) return explicit.replace(/\/+$/, '');
  let host: string;
  try {
    host = resolveIngestHost(opts.region, opts.ingest); // same host the CLI uses for scan/push
  } catch {
    host = 'us.ingest.vibgrate.com'; // fail safe to the default region
  }
  return `https://${host}`;
}

/**
 * Ask the hosted catalog for docs. Returns the hosted answer, or `null` on ANY failure
 * (so the caller keeps the local answer). Never throws.
 */
export async function fetchHostedDocs(req: HostedDocsRequest, opts: HostedOptions = {}): Promise<HostedDocsResult | null> {
  const f = opts.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  if (!f) return null; // no fetch available → stay local
  const url = `${hostedBase(opts)}/v1/lib/docs`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 4000);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.auth) {
    // Identify the workspace for higher rate limits + tracking (same DSN auth as scan/push).
    headers['Authorization'] = `VibgrateDSN ${opts.auth.keyId}:${opts.auth.secret}`;
    headers['X-Vibgrate-Timestamp'] = String(Date.now());
  }
  try {
    const res = await f(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: req.name,
        targetId: req.targetId,
        query: req.query,
        verbosity: req.verbosity,
        max_tokens: req.maxTokens,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: unknown; docs?: unknown; version?: unknown; metadata?: unknown };
    const content = typeof data.content === 'string' ? data.content : typeof data.docs === 'string' ? data.docs : '';
    if (!content.trim()) return null;
    return {
      content,
      version: typeof data.version === 'string' ? data.version : null,
      source: 'hosted',
      metadata: (data.metadata as Record<string, unknown> | undefined) ?? undefined,
    };
  } catch {
    return null; // offline / timeout / parse error — fail closed to local
  } finally {
    clearTimeout(timer);
  }
}

export interface PublishRequest {
  name: string;
  version: string;
  readme?: string;
  dts?: string;
  compliance?: string[];
  language?: string;
  sourceUrl?: string;
}
export interface PublishOk {
  ok: true;
  targetId: string;
  ecosystem: string;
  entities: number;
  indexedTokens: number;
}
export interface PublishErr {
  ok: false;
  status: number;
  error?: string;
  message?: string;
}

/**
 * Publish a PRIVATE library to the hosted catalog (`POST /v1/lib/private`, S6). Unlike the read
 * path, this is an explicit user write, so it SURFACES errors (no fail-closed): a DSN is required
 * (workspace identity), the workspace must be on a paid plan (402), and the result reports the
 * indexed token cost charged to the MCP-token meter.
 */
export async function publishPrivateLibrary(req: PublishRequest, opts: HostedOptions = {}): Promise<PublishOk | PublishErr> {
  const f = opts.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  if (!f) return { ok: false, status: 0, message: 'no network available' };
  if (!opts.auth) return { ok: false, status: 401, message: 'a DSN is required to publish a private library (run `vibgrate login` or set VIBGRATE_DSN)' };
  const url = `${hostedBase(opts)}/v1/lib/private`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15000);
  try {
    const res = await f(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `VibgrateDSN ${opts.auth.keyId}:${opts.auth.secret}`,
        'X-Vibgrate-Timestamp': String(Date.now()),
      },
      body: JSON.stringify({
        name: req.name,
        version: req.version,
        readme: req.readme,
        dts: req.dts,
        compliance: req.compliance,
        language: req.language,
        sourceUrl: req.sourceUrl,
      }),
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, status: res.status, error: typeof data.error === 'string' ? data.error : undefined, message: typeof data.message === 'string' ? data.message : undefined };
    return {
      ok: true,
      targetId: String(data.targetId ?? ''),
      ecosystem: String(data.ecosystem ?? ''),
      entities: Number(data.entities) || 0,
      indexedTokens: Number(data.indexedTokens) || 0,
    };
  } catch (err) {
    return { ok: false, status: 0, message: err instanceof Error ? err.message : 'request failed' };
  } finally {
    clearTimeout(timer);
  }
}
