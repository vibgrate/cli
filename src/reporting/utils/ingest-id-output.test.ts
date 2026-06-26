import { describe, expect, it, vi, afterEach } from 'vitest';
import { emitIngestIdLine } from './ingest-id-output.js';

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
