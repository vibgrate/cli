import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { uploadScanArtifact, type ScanUploadInput } from './upload.js';

const baseInput: ScanUploadInput = {
  scheme: 'https',
  host: 'us.ingest.vibgrate.com',
  keyId: 'key',
  secret: 'secret',
  body: Buffer.from('gzipped'),
  contentEncoding: 'gzip',
  timestamp: '1700000000000',
};

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('uploadScanArtifact', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts once and returns the response on success', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { status: 'ok', ingestId: 'ing_1' }));

    const { response, host } = await uploadScanArtifact(baseInput);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host).toBe('us.ingest.vibgrate.com');
    expect(response.ok).toBe(true);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe('https://us.ingest.vibgrate.com/v1/ingest/scan');
  });

  it('appends ?force=1 when force is set (fresh ingest for scheduled/dashboard scans)', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { status: 'ok', ingestId: 'ing_3' }));

    await uploadScanArtifact({ ...baseInput, force: true });

    expect(fetchMock.mock.calls[0][0]).toBe('https://us.ingest.vibgrate.com/v1/ingest/scan?force=1');
  });

  it('retries against the pinned region on a 409 REGION_MISMATCH', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse(409, {
          status: 'error',
          code: 'REGION_MISMATCH',
          region: 'eu',
          ingestHost: 'eu.ingest.vibgrate.com',
          error: 'pinned to eu',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { status: 'ok', ingestId: 'ing_2' }));

    const { response, host } = await uploadScanArtifact(baseInput);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(host).toBe('eu.ingest.vibgrate.com');
    expect(response.ok).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toBe('https://eu.ingest.vibgrate.com/v1/ingest/scan');
  });

  it('does not retry on a 409 without a recognised region', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        jsonResponse(409, { status: 'error', code: 'REGION_MISMATCH', region: 'mars' }),
      );

    const { response, host } = await uploadScanArtifact(baseInput);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host).toBe('us.ingest.vibgrate.com');
    expect(response.status).toBe(409);
  });

  it('does not retry on unrelated 409 conflicts', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(409, { status: 'error', code: 'SOME_OTHER_CONFLICT' }));

    const { response } = await uploadScanArtifact(baseInput);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(409);
  });
});
