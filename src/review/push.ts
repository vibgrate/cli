/**
 * `vg review --push` — send the receipt to Vibgrate Cloud.
 *
 * Reuses the existing workspace identity, DSN, and ingest host: Review does not
 * create a second cloud product. The envelope carries `kind: "review"` so the
 * ingest writer switches on it (spec §6.1) — drift keeps using `kind: "scan"`.
 *
 * **Source, prompts, and capsules are not telemetry.** By default the payload
 * is the receipt: decisions, claims, evidence ids, and paths. Line ranges are
 * opt-in (`--include-spans`); source snippets are a second, explicit opt-in
 * (`--include-snippets`) and are capped. The capsule body is never sent.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CliError, ExitCode } from '../util/exit.js';
import { VERSION } from '../version.js';
import type { AnalysisCapsule, ReviewIngestEnvelope, ReviewReceipt } from './schemas.js';
import { RECEIPT_SCHEMA } from './schemas.js';

/** Snippet cap — a handful of lines per finding, never a file. */
const MAX_SNIPPET_LINES = 12;
const MAX_SNIPPET_FINDINGS = 20;

export interface PushPrivacy {
  includeSpans?: boolean;
  includeSnippets?: boolean;
}

export interface ReviewSpanRef {
  evidence_id: string;
  path: string;
  start_line: number;
  end_line: number;
  /** Present only under `--include-snippets`; capped to MAX_SNIPPET_LINES. */
  snippet?: string;
}

export interface ReviewPushBody extends ReviewIngestEnvelope {
  /** Present only under `--include-spans` / `--include-snippets`. */
  spans?: ReviewSpanRef[];
}

/**
 * `--offline` / `--local` forbids `--push`. The receipt stays on disk; an
 * upload would be a network call the user explicitly ruled out.
 */
export function rejectPushWhenOffline(offline: boolean | undefined): void {
  if (!offline) return;
  throw new CliError(
    '`--push` needs the network — drop `--offline` (or `--local`) to upload the receipt, or drop `--push` to keep it on disk',
    ExitCode.USAGE_ERROR,
  );
}

export function buildEnvelope(
  receipt: ReviewReceipt,
  opts: { workspaceId?: string | null; pushedAt: string } = { pushedAt: new Date().toISOString() },
): ReviewIngestEnvelope {
  return {
    kind: 'review',
    schema_version: RECEIPT_SCHEMA,
    workspace_id: opts.workspaceId ?? receipt.workspace_id ?? null,
    pushed_at: opts.pushedAt,
    cli_version: VERSION,
    receipt,
  };
}

/**
 * Collect the opt-in span references. Returns `undefined` when neither privacy
 * flag is set — the field is then absent from the payload rather than empty,
 * so the server can tell "not sent" from "sent, none".
 */
export function collectSpans(
  root: string,
  receipt: ReviewReceipt,
  capsule: AnalysisCapsule,
  privacy: PushPrivacy,
): ReviewSpanRef[] | undefined {
  if (!privacy.includeSpans && !privacy.includeSnippets) return undefined;
  const citedIds = new Set(
    [...receipt.findings.architecture_findings, ...receipt.findings.security_findings]
      .slice(0, MAX_SNIPPET_FINDINGS)
      .flatMap((f) => f.evidence_ids),
  );
  const spans: ReviewSpanRef[] = [];
  for (const e of capsule.evidence) {
    if (!citedIds.has(e.id)) continue;
    if (!e.path || e.start_line === undefined || e.end_line === undefined) continue;
    const ref: ReviewSpanRef = {
      evidence_id: e.id,
      path: e.path,
      start_line: e.start_line,
      end_line: e.end_line,
    };
    if (privacy.includeSnippets) {
      const snippet = readSnippet(root, e.path, e.start_line, e.end_line);
      if (snippet) ref.snippet = snippet;
    }
    spans.push(ref);
  }
  return spans;
}

function readSnippet(root: string, rel: string, start: number, end: number): string | null {
  try {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return null;
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    return lines.slice(Math.max(0, start - 1), Math.min(lines.length, start - 1 + MAX_SNIPPET_LINES, end)).join('\n');
  } catch {
    return null;
  }
}

export interface ParsedDsn {
  keyId: string;
  secret: string;
  host: string;
  workspaceId: string;
  scheme: 'https' | 'http';
}

export interface PushResult {
  ok: boolean;
  status: number;
  host: string;
  detail?: string;
}

/**
 * POST the envelope. Network failures are surfaced with the host that was
 * tried; the caller decides whether that is fatal (`--strict`) or a warning.
 */
export async function pushReceipt(
  dsn: ParsedDsn,
  body: ReviewPushBody,
  fetchImpl: typeof fetch = fetch,
): Promise<PushResult> {
  const url = `${dsn.scheme}://${dsn.host}/v1/ingest/review`;
  const payload = JSON.stringify(body);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Vibgrate-Timestamp': String(Date.now()),
        Authorization: `VibgrateDSN ${dsn.keyId}:${dsn.secret}`,
      },
      body: payload,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new CliError(
      `could not reach ${dsn.host}: ${e instanceof Error ? e.message : String(e)}`,
      ExitCode.ERROR,
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, status: res.status, host: dsn.host, detail: detail.slice(0, 200) };
  }
  return { ok: true, status: res.status, host: dsn.host };
}
