import { describe, it, expect, vi, afterEach } from 'vitest';

// We test DSN parsing and HMAC computation from push.ts by extracting the logic.
// Since parseDsn and computeHmac are not exported, we test them via the module's behavior
// or replicate the logic here for unit testing.

import * as crypto from 'node:crypto';
import { resolveIngestHost, createWorkspaceDsn } from './dsn.js';
import { parseDsn, computeHmac } from './push.js';

// ── DSN parsing (now exported from push.ts) ──

describe('DSN parsing', () => {
  it('parses a valid DSN string', () => {
    const dsn = 'vibgrate+https://abc123:secret456@ingest.vibgrate.dev/ws-001';
    const result = parseDsn(dsn);

    expect(result).not.toBeNull();
    expect(result!.keyId).toBe('abc123');
    expect(result!.secret).toBe('secret456');
    expect(result!.host).toBe('ingest.vibgrate.dev');
    expect(result!.workspaceId).toBe('ws-001');
  });

  it('returns null for invalid DSN format', () => {
    expect(parseDsn('')).toBeNull();
    expect(parseDsn('not-a-dsn')).toBeNull();
    expect(parseDsn('https://example.com')).toBeNull();
  });

  it('returns null for DSN without protocol prefix', () => {
    expect(parseDsn('https://key:secret@host/ws')).toBeNull();
  });

  it('handles workspace IDs with special chars', () => {
    const dsn = 'vibgrate+https://key:secret@host.com/ws-123-abc_def';
    const result = parseDsn(dsn);
    expect(result!.workspaceId).toBe('ws-123-abc_def');
  });

  it('handles long hex key and secret', () => {
    const dsn = 'vibgrate+https://4a445ff36e993ca0:039b4a2d8d5b04d71942d0e2c6e90969e76312a4e7e5c8ac3edacbb90eaa3bec@ingest.vibgrate.dev/ws-test';
    const result = parseDsn(dsn);
    expect(result).not.toBeNull();
    expect(result!.keyId).toBe('4a445ff36e993ca0');
    expect(result!.secret).toHaveLength(64);
  });
});

describe('HMAC computation', () => {
  it('produces a base64-encoded HMAC-SHA256', () => {
    const hmac = computeHmac('{"test":true}', 'my-secret');
    expect(hmac).toBeTruthy();
    // Should be valid base64
    expect(Buffer.from(hmac, 'base64').toString('base64')).toBe(hmac);
  });

  it('produces consistent output for same input', () => {
    const h1 = computeHmac('hello', 'secret');
    const h2 = computeHmac('hello', 'secret');
    expect(h1).toBe(h2);
  });

  it('produces different output for different bodies', () => {
    const h1 = computeHmac('body1', 'secret');
    const h2 = computeHmac('body2', 'secret');
    expect(h1).not.toBe(h2);
  });

  it('produces different output for different secrets', () => {
    const h1 = computeHmac('body', 'secret1');
    const h2 = computeHmac('body', 'secret2');
    expect(h1).not.toBe(h2);
  });
});

describe('resolveIngestHost', () => {
  it('defaults to us region', () => {
    expect(resolveIngestHost()).toBe('us.ingest.vibgrate.com');
  });

  it('resolves us region', () => {
    expect(resolveIngestHost('us')).toBe('us.ingest.vibgrate.com');
  });

  it('resolves eu region', () => {
    expect(resolveIngestHost('eu')).toBe('eu.ingest.vibgrate.com');
  });

  it('is case-insensitive', () => {
    expect(resolveIngestHost('US')).toBe('us.ingest.vibgrate.com');
    expect(resolveIngestHost('EU')).toBe('eu.ingest.vibgrate.com');
  });

  it('custom ingest URL overrides region', () => {
    expect(resolveIngestHost('eu', 'https://custom.example.com')).toBe('custom.example.com');
  });

  it('throws for unknown region', () => {
    expect(() => resolveIngestHost('ap')).toThrow('Unknown region');
  });

  it('throws for invalid ingest URL', () => {
    expect(() => resolveIngestHost(undefined, 'not-a-url')).toThrow('Invalid ingest URL');
  });
});

describe('createWorkspaceDsn', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('provisions a workspace and returns a well-formed DSN pinned to the region', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return { ok: true, json: async () => ({}) } as Response;
      }),
    );

    const result = await createWorkspaceDsn({ region: 'eu' });

    expect(result.ingestHost).toBe('eu.ingest.vibgrate.com');
    expect(result.region).toBe('eu');
    // DSN shape: vibgrate+https://<24hex>:<64hex>@<host>/<16hex>
    expect(result.dsn).toMatch(
      /^vibgrate\+https:\/\/[0-9a-f]{24}:[0-9a-f]{64}@eu\.ingest\.vibgrate\.com\/[0-9a-f]{16}$/,
    );
    const parsed = parseDsn(result.dsn);
    expect(parsed!.keyId).toBe(result.keyId);
    expect(parsed!.workspaceId).toBe(result.workspaceId);

    // The provision call hit the right host and pinned the region.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://eu.ingest.vibgrate.com/v1/provision');
    expect((calls[0].body as { region: string }).region).toBe('eu');
  });

  it('does not pin a region for a custom --ingest host', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        calls.push({ body: JSON.parse(init.body) });
        return { ok: true, json: async () => ({}) } as Response;
      }),
    );

    const result = await createWorkspaceDsn({ ingest: 'https://custom.example.com' });
    expect(result.ingestHost).toBe('custom.example.com');
    expect(result.region).toBeUndefined();
    expect(calls[0].body).not.toHaveProperty('region');
  });

  it('throws an actionable error when provisioning fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'workspace exists' }) }) as Response),
    );

    await expect(createWorkspaceDsn({ region: 'us' })).rejects.toThrow(
      /Failed to provision workspace: workspace exists/,
    );
  });
});
