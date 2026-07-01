import { describe, expect, it, vi, afterEach } from 'vitest';
import { emitIngestIdLine, emitDriftScoreLine } from './ingest-id-output.js';

describe('emitIngestIdLine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints VIBGRATE_INGEST_ID without ANSI', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    emitIngestIdLine('ing_abc123def456');
    expect(log).toHaveBeenCalledWith('VIBGRATE_INGEST_ID=ing_abc123def456');
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('prints unchanged marker when requested', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    emitIngestIdLine('ing_abc123def456', { unchanged: true });
    expect(log).toHaveBeenNthCalledWith(1, 'VIBGRATE_INGEST_ID=ing_abc123def456');
    expect(log).toHaveBeenNthCalledWith(2, 'VIBGRATE_INGEST_UNCHANGED=1');
  });
});

describe('emitDriftScoreLine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.VIBGRATE_EMIT_MARKERS;
  });

  it('prints the drift marker only when VIBGRATE_EMIT_MARKERS=1 (off by default)', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    emitDriftScoreLine(42);
    expect(log).not.toHaveBeenCalled();

    process.env.VIBGRATE_EMIT_MARKERS = '1';
    emitDriftScoreLine(42);
    expect(log).toHaveBeenCalledWith('VIBGRATE_DRIFT_SCORE=42');
  });
});
