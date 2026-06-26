import { describe, it, expect, vi } from 'vitest';

// We test DSN parsing and HMAC computation from push.ts by extracting the logic.
// Since parseDsn and computeHmac are not exported, we test them via the module's behavior
// or replicate the logic here for unit testing.

import * as crypto from 'node:crypto';
import { resolveIngestHost } from './dsn.js';
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
