import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LedgerTail, ingestLedgerLine } from '../src/mcp/ledger-tail.js';
import { SessionStats } from '../src/mcp/serve-stats.js';

const cliLine = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ ts: 1, tool: 'impact_of', source: 'cli', client: 'claude', outcome: 'complete', vgTokens: 0, baselineTokens: 0, ...over });

describe('ingestLedgerLine', () => {
  it('records cli entries with sanitized client and no ms', () => {
    const stats = new SessionStats(0);
    ingestLedgerLine(stats, cliLine({ client: 'Claude Code!' }), 5);
    const snap = stats.snapshot();
    expect(snap.totals.calls).toBe(1);
    expect(snap.totals.timed).toBe(0); // untimed — never a fake 0ms average
    expect(snap.clients[0]!.key).toBe('claude-code');
    expect(snap.sources[0]!.key).toBe('cli');
    expect(snap.lastCallAt).toBe(5);
  });

  it('skips mcp entries (already recorded live), blanks, and corrupt lines', () => {
    const stats = new SessionStats(0);
    ingestLedgerLine(stats, cliLine({ source: 'mcp' }), 1);
    ingestLedgerLine(stats, JSON.stringify({ ts: 1, tool: 'query_graph' }), 1); // absent source = mcp
    ingestLedgerLine(stats, '', 1);
    ingestLedgerLine(stats, '{not json', 1);
    expect(stats.snapshot().totals.calls).toBe(0);
  });

  it('defaults an absent outcome to complete', () => {
    const stats = new SessionStats(0);
    ingestLedgerLine(stats, cliLine({ outcome: undefined }), 1);
    expect(stats.snapshot().totals.complete).toBe(1);
  });
});

describe('LedgerTail', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-ledger-tail-'));
    file = path.join(dir, 'savings.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('only counts lines appended after start', () => {
    fs.writeFileSync(file, cliLine() + '\n'); // pre-existing history
    const stats = new SessionStats(0);
    const tail = new LedgerTail(file, stats);
    tail.start();
    tail.stop(); // no timers in tests — poll() directly

    tail.poll(1);
    expect(stats.snapshot().totals.calls).toBe(0);

    fs.appendFileSync(file, cliLine({ tool: 'get_node' }) + '\n' + cliLine() + '\n');
    tail.poll(2);
    expect(stats.snapshot().totals.calls).toBe(2);
    expect(stats.snapshot().tools.map((t) => t.key).sort()).toEqual(['get_node', 'impact_of']);
  });

  it('works when the ledger does not exist yet at start', () => {
    const stats = new SessionStats(0);
    const tail = new LedgerTail(file, stats);
    tail.start();
    tail.stop();

    fs.writeFileSync(file, cliLine() + '\n');
    tail.poll(1);
    expect(stats.snapshot().totals.calls).toBe(1);
  });

  it('holds a partial trailing line until its newline arrives', () => {
    const stats = new SessionStats(0);
    const tail = new LedgerTail(file, stats);
    tail.start();
    tail.stop();

    const line = cliLine();
    fs.writeFileSync(file, line.slice(0, 10)); // mid-write flush
    tail.poll(1);
    expect(stats.snapshot().totals.calls).toBe(0);

    fs.appendFileSync(file, line.slice(10) + '\n');
    tail.poll(2);
    expect(stats.snapshot().totals.calls).toBe(1);
  });

  it('re-reads from the top after truncation', () => {
    const stats = new SessionStats(0);
    const tail = new LedgerTail(file, stats);
    fs.writeFileSync(file, cliLine() + '\n');
    tail.start();
    tail.stop();

    fs.writeFileSync(file, ''); // rotated/cleared
    tail.poll(1);
    fs.appendFileSync(file, cliLine() + '\n');
    tail.poll(2);
    expect(stats.snapshot().totals.calls).toBe(1);
  });

  it('ignores an mcp line another serve process appended', () => {
    const stats = new SessionStats(0);
    const tail = new LedgerTail(file, stats);
    tail.start();
    tail.stop();
    fs.appendFileSync(file, cliLine({ source: 'mcp', ms: 12 }) + '\n');
    tail.poll(1);
    expect(stats.snapshot().totals.calls).toBe(0);
  });
});
