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
  try {
    const res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
