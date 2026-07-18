import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  sanitizeClient,
  recordCliCall,
  recordSaving,
  readUsage,
  readSavings,
} from '../src/engine/savings.js';
import { buildBatch, statsEndpoint, telemetryOptOut, isCI, installId } from '../src/engine/stats-share.js';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vg-stats-'));
}

describe('sanitizeClient', () => {
  it('normalises to a bounded, non-PII label', () => {
    expect(sanitizeClient('Claude Code')).toBe('claude-code');
    expect(sanitizeClient('Cursor')).toBe('cursor');
    expect(sanitizeClient('  weird//name!! ')).toBe('weird-name');
    expect(sanitizeClient('-x-')).toBe('x');
    expect(sanitizeClient('a'.repeat(80)).length).toBe(40);
  });

  it('falls back to unknown for empty/absent input', () => {
    expect(sanitizeClient('')).toBe('unknown');
    expect(sanitizeClient(undefined)).toBe('unknown');
    expect(sanitizeClient(null)).toBe('unknown');
    expect(sanitizeClient('!!!')).toBe('unknown');
  });
});

describe('CLI recording + the command-vs-MCP split', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('records a CLI call under the shared tool vocabulary with source cli', () => {
    const now = Date.now();
    recordCliCall(root, { tool: 'query_graph', client: 'Claude', outcome: 'complete', vgTokens: 100, baselineFiles: 3 }, now);
    // An MCP-side entry for the same tool.
    recordSaving(root, { tool: 'query_graph', source: 'mcp', client: 'cursor', outcome: 'complete', vgTokens: 80, baselineTokens: 1200 }, now);

    const usage = readUsage(root, 30, now + 1000);
    expect(usage.totals.calls).toBe(2);
    const bySource = Object.fromEntries(usage.sources.map((s) => [s.key, s.calls]));
    expect(bySource.cli).toBe(1);
    expect(bySource.mcp).toBe(1);
    const byClient = Object.fromEntries(usage.clients.map((c) => [c.key, c.calls]));
    expect(byClient.claude).toBe(1); // sanitized from "Claude"
    expect(byClient.cursor).toBe(1);

    // The CLI query_graph call carries a real grep baseline (3 files * 400).
    const savings = readSavings(root, 30, now + 1000);
    expect(savings.baselineTokens).toBe(3 * 400 + 1200);
  });

  it('back-compat: a legacy line with no source/client reads as mcp/unknown', () => {
    const now = Date.now();
    recordSaving(root, { tool: 'get_node', outcome: 'complete', vgTokens: 10, baselineTokens: 400 }, now);
    const usage = readUsage(root, 30, now + 1000);
    expect(usage.sources.find((s) => s.key === 'mcp')?.calls).toBe(1);
    expect(usage.clients.find((c) => c.key === 'unknown')?.calls).toBe(1);
  });
});

describe('buildBatch (opt-in share-stats aggregation)', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('aggregates counts-only rows and advances the offset', () => {
    const now = Date.UTC(2026, 6, 9, 12, 0, 0);
    recordCliCall(root, { tool: 'query_graph', client: 'claude', outcome: 'complete', vgTokens: 100, baselineFiles: 2 }, now);
    recordCliCall(root, { tool: 'query_graph', client: 'claude', outcome: 'complete', vgTokens: 50, baselineFiles: 1 }, now + 1000);
    recordSaving(root, { tool: 'get_node', source: 'mcp', client: 'claude', outcome: 'miss', vgTokens: 0, baselineTokens: 0 }, now + 2000);

    const { batch, newOffset } = buildBatch(root, 0, 'test-install');
    expect(batch).not.toBeNull();
    expect(batch!.installId).toBe('test-install');
    expect(batch!.totalCalls).toBe(3);
    expect(batch!.os).toBe(process.platform);
    // Two identical (source,client,tool,outcome) calls collapse into one row.
    const qg = batch!.rows.find((r) => r.tool === 'query_graph' && r.source === 'cli');
    expect(qg?.calls).toBe(2);
    expect(qg?.vgTokens).toBe(150);
    expect(qg?.baselineTokens).toBe((2 + 1) * 400);
    expect(batch!.windowStart).toBe(new Date(now).toISOString());
    expect(batch!.windowEnd).toBe(new Date(now + 2000).toISOString());

    // Nothing new past the consumed offset.
    const again = buildBatch(root, newOffset, 'test-install');
    expect(again.batch).toBeNull();
  });

  it('never sends code or question text — only counts and coarse labels', () => {
    const now = Date.now();
    recordCliCall(root, { tool: 'query_graph', client: 'claude', outcome: 'complete', vgTokens: 10, baselineFiles: 1 }, now);
    const { batch } = buildBatch(root, 0, 'id');
    const serialized = JSON.stringify(batch);
    for (const row of batch!.rows) {
      expect(Object.keys(row).sort()).toEqual(
        ['baselineTokens', 'calls', 'client', 'outcome', 'source', 'tool', 'vgTokens'].sort(),
      );
    }
    // Structural guarantee: the payload is entirely counts + enums + version/os.
    expect(serialized).not.toMatch(/question|context|signature|\/home\//);
  });

  it('returns null when there is nothing to send', () => {
    const { batch } = buildBatch(root, 0, 'id');
    expect(batch).toBeNull();
  });
});

describe('telemetryOptOut', () => {
  it('honours DO_NOT_TRACK unless explicitly falsy', () => {
    expect(telemetryOptOut({ DO_NOT_TRACK: '1' })).toBe('DO_NOT_TRACK');
    expect(telemetryOptOut({ DO_NOT_TRACK: 'true' })).toBe('DO_NOT_TRACK');
    expect(telemetryOptOut({ DO_NOT_TRACK: 'yes' })).toBe('DO_NOT_TRACK');
    expect(telemetryOptOut({ DO_NOT_TRACK: '0' })).toBeNull();
    expect(telemetryOptOut({ DO_NOT_TRACK: 'false' })).toBeNull();
    expect(telemetryOptOut({ DO_NOT_TRACK: '' })).toBeNull();
    expect(telemetryOptOut({})).toBeNull();
  });

  it('honours the VIBGRATE_TELEMETRY alias only for explicit off values', () => {
    expect(telemetryOptOut({ VIBGRATE_TELEMETRY: '0' })).toBe('VIBGRATE_TELEMETRY');
    expect(telemetryOptOut({ VIBGRATE_TELEMETRY: 'off' })).toBe('VIBGRATE_TELEMETRY');
    expect(telemetryOptOut({ VIBGRATE_TELEMETRY: 'false' })).toBe('VIBGRATE_TELEMETRY');
    expect(telemetryOptOut({ VIBGRATE_TELEMETRY: '1' })).toBeNull();
  });

  it('DO_NOT_TRACK is reported first when both are set', () => {
    expect(telemetryOptOut({ DO_NOT_TRACK: '1', VIBGRATE_TELEMETRY: '0' })).toBe('DO_NOT_TRACK');
  });
});

describe('isCI', () => {
  it('recognises common CI markers and ignores falsy values', () => {
    expect(isCI({ CI: 'true' })).toBe(true);
    expect(isCI({ GITHUB_ACTIONS: 'true' })).toBe(true);
    expect(isCI({ JENKINS_URL: 'https://ci.example.test' })).toBe(true);
    expect(isCI({ CI: 'false' })).toBe(false);
    expect(isCI({ CI: '0' })).toBe(false);
    expect(isCI({})).toBe(false);
  });
});

describe('installId under opt-out / CI', () => {
  it('returns an ephemeral id and persists nothing under DO_NOT_TRACK', () => {
    const a = installId({ DO_NOT_TRACK: '1' });
    const b = installId({ DO_NOT_TRACK: '1' });
    expect(a).not.toBe(b); // ephemeral: never read from or written to disk
  });

  it('returns an ephemeral id on CI runners', () => {
    const a = installId({ CI: 'true' });
    const b = installId({ CI: 'true' });
    expect(a).not.toBe(b);
  });
});

describe('statsEndpoint', () => {
  const saved = process.env.VIBGRATE_STATS_ENDPOINT;
  afterEach(() => {
    if (saved === undefined) delete process.env.VIBGRATE_STATS_ENDPOINT;
    else process.env.VIBGRATE_STATS_ENDPOINT = saved;
  });

  it('defaults to the region ingest host and honours an override', () => {
    delete process.env.VIBGRATE_STATS_ENDPOINT;
    expect(statsEndpoint()).toMatch(/^https:\/\/.*\/v1\/ingest\/cli-mcp-usage$/);
    process.env.VIBGRATE_STATS_ENDPOINT = 'https://example.test/hook';
    expect(statsEndpoint()).toBe('https://example.test/hook');
  });
});
