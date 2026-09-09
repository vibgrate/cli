import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CliError, ExitCode } from '../util/exit.js';
import { buildEnvelope, collectSpans, pushReceipt, type ParsedDsn, type ReviewPushBody } from './push.js';
import type { CapsuleEvidence, ReviewReceipt } from './schemas.js';
import { capsule, finding, findings } from './test-fixtures.js';

// ── fixtures ────────────────────────────────────────────────────────────────

function receipt(overrides: Partial<ReviewReceipt> = {}): ReviewReceipt {
  return {
    workspace_id: null,
    decision: 'needs_review',
    findings: findings({
      architecture_findings: [finding({ id: 'arch-01', evidence_ids: ['edge:1', 'policy:1'] })],
      security_findings: [finding({ id: 'sec-01', kind: 'guard_removed', evidence_ids: ['span:1'], protected_finding: true })],
    }),
    ...overrides,
  } as ReviewReceipt;
}

const evidence: CapsuleEvidence[] = [
  { id: 'edge:1', kind: 'graph_edge', path: 'src/a.ts', start_line: 4, end_line: 9, protected_finding: false },
  { id: 'policy:1', kind: 'policy', protected_finding: false }, // no path: nothing to point at
  { id: 'span:1', kind: 'source_span', path: 'src/b.ts', start_line: 2, end_line: 40, protected_finding: true },
  { id: 'role:1', kind: 'role', path: 'src/c.ts', start_line: 1, end_line: 3, protected_finding: false }, // not cited
];

function root(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-review-push-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

// ── collectSpans ────────────────────────────────────────────────────────────

describe('collectSpans', () => {
  it('sends nothing — not an empty list — unless a privacy flag opts in', () => {
    expect(collectSpans('/repo', receipt(), capsule({ evidence }), {})).toBeUndefined();
    expect(collectSpans('/repo', receipt(), capsule({ evidence }), { includeSpans: false, includeSnippets: false })).toBeUndefined();
  });

  it('under --include-spans lists cited evidence with a location, and no source text', () => {
    const spans = collectSpans('/repo', receipt(), capsule({ evidence }), { includeSpans: true });
    expect(spans).toEqual([
      { evidence_id: 'edge:1', path: 'src/a.ts', start_line: 4, end_line: 9 },
      { evidence_id: 'span:1', path: 'src/b.ts', start_line: 2, end_line: 40 },
    ]);
    expect(spans!.some((s) => 'snippet' in s)).toBe(false);
  });

  it('under --include-snippets reads the span from disk, capped at twelve lines', () => {
    const dir = root({ 'src/a.ts': lines(20), 'src/b.ts': lines(60) });
    const spans = collectSpans(dir, receipt(), capsule({ evidence }), { includeSnippets: true })!;
    expect(spans[0].snippet).toBe(['line 4', 'line 5', 'line 6', 'line 7', 'line 8', 'line 9'].join('\n'));
    expect(spans[1].snippet!.split('\n')).toHaveLength(12);
    expect(spans[1].snippet!.split('\n')[0]).toBe('line 2');
  });

  it('keeps the span but omits the snippet when the file cannot be read', () => {
    const dir = root({ 'src/a.ts': lines(20) });
    const spans = collectSpans(dir, receipt(), capsule({ evidence }), { includeSnippets: true })!;
    expect(spans[0].snippet).toBeDefined();
    expect(spans[1]).toEqual({ evidence_id: 'span:1', path: 'src/b.ts', start_line: 2, end_line: 40 });
  });

  it('bounds the findings whose evidence is sent', () => {
    const many = Array.from({ length: 25 }, (_, i) => finding({ id: `arch-${i}`, evidence_ids: [`e:${i}`] }));
    const ev: CapsuleEvidence[] = many.map((f, i) => ({
      id: `e:${i}`, kind: 'graph_node', path: `src/f${i}.ts`, start_line: 1, end_line: 2, protected_finding: false,
    }));
    const r = receipt({ findings: findings({ architecture_findings: many }) });
    expect(collectSpans('/repo', r, capsule({ evidence: ev }), { includeSpans: true })).toHaveLength(20);
  });
});

// ── pushReceipt ─────────────────────────────────────────────────────────────

describe('pushReceipt', () => {
  const dsn: ParsedDsn = { keyId: 'key_1', secret: 's3cret-token', host: 'ingest.example.test', workspaceId: 'ws_1', scheme: 'https' };
  const body = (): ReviewPushBody => ({ ...buildEnvelope(receipt(), { workspaceId: 'ws_1', pushedAt: '2026-08-27T10:00:00Z' }) });

  it('POSTs the JSON envelope to the review ingest route with the DSN as bearer', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response('accepted', { status: 202 });
    }) as unknown as typeof fetch;

    const result = await pushReceipt(dsn, body(), fetchImpl);
    expect(result).toEqual({ ok: true, status: 202, host: 'ingest.example.test' });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://ingest.example.test/v1/ingest/review');
    expect(seen[0].init.method).toBe('POST');
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe('VibgrateDSN key_1:s3cret-token');
    expect(headers['X-Vibgrate-Timestamp']).toMatch(/^\d+$/);
    const sent = JSON.parse(seen[0].init.body as string);
    expect(sent.kind).toBe('review');
    expect(sent.workspace_id).toBe('ws_1');
    expect(sent.receipt.decision).toBe('needs_review');
    expect(seen[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('carries opt-in spans in the body only when present', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    await pushReceipt(dsn, body(), fetchImpl);
    expect('spans' in sent).toBe(false);
    await pushReceipt(dsn, { ...body(), spans: [{ evidence_id: 'edge:1', path: 'src/a.ts', start_line: 1, end_line: 2 }] }, fetchImpl);
    expect(sent.spans).toEqual([{ evidence_id: 'edge:1', path: 'src/a.ts', start_line: 1, end_line: 2 }]);
  });

  it('returns a bounded failure detail for a non-2xx response instead of throwing', async () => {
    const fetchImpl = (async () => new Response('x'.repeat(500), { status: 403 })) as unknown as typeof fetch;
    const result = await pushReceipt(dsn, body(), fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.host).toBe('ingest.example.test');
    expect(result.detail).toHaveLength(200);
  });

  it('surfaces a network failure as a CliError naming the host, never the secret', async () => {
    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND ingest.example.test');
    }) as unknown as typeof fetch;
    const err = await pushReceipt(dsn, body(), fetchImpl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(ExitCode.ERROR);
    expect((err as CliError).message).toContain('could not reach ingest.example.test');
    expect((err as CliError).message).toContain('ENOTFOUND');
    expect((err as CliError).message).not.toContain('s3cret');
  });

  it('honours an http scheme for a local ingest host', async () => {
    let url = '';
    const fetchImpl = (async (u: string) => {
      url = u;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    await pushReceipt({ ...dsn, scheme: 'http', host: 'localhost:8787' }, body(), fetchImpl);
    expect(url).toBe('http://localhost:8787/v1/ingest/review');
  });
});
