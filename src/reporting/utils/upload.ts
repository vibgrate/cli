/**
 * Scan-artifact upload transport.
 *
 * Centralises the POST /v1/ingest/scan call shared by the `push` and
 * `scan --push` commands, including residency-aware retry: a workspace is
 * pinned to exactly one region, but the DSN (or default) host the CLI uploads
 * to may belong to a different region. When that happens the API rejects the
 * upload with HTTP 409 `REGION_MISMATCH` and names the correct regional
 * endpoint, so we transparently retry against it instead of failing the scan.
 */

import chalk from 'chalk';
import { ingestHostForRegionId } from '../regions.js';

export interface ScanUploadInput {
  scheme: string;
  host: string;
  keyId: string;
  secret: string;
  body: Buffer;
  contentEncoding: string;
  timestamp: string;
  /** Force a fresh ingest server-side even when the repo is unchanged (skips the
   *  duplicate-vcsSha reuse). Set for scheduled and dashboard-triggered scans. */
  force?: boolean;
}

export interface ScanUploadResult {
  response: Response;
  /** The host the (final) request was sent to — differs from input.host on a region redirect. */
  host: string;
}

function postOnce(input: ScanUploadInput, host: string): Promise<Response> {
  const url = input.force
    ? `${input.scheme}://${host}/v1/ingest/scan?force=1`
    : `${input.scheme}://${host}/v1/ingest/scan`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Encoding': input.contentEncoding,
      'X-Vibgrate-Timestamp': input.timestamp,
      'Authorization': `VibgrateDSN ${input.keyId}:${input.secret}`,
      'Connection': 'close', // Prevent keep-alive delays on exit
    },
    body: input.body,
  });
}

/**
 * Inspect a 409 response for a residency redirect. Returns the correct ingest
 * host only when the response is a `REGION_MISMATCH` that names a region we
 * recognise — we never follow an arbitrary host from the response body.
 */
async function regionRedirectHost(response: Response): Promise<string | undefined> {
  try {
    const payload = (await response.clone().json()) as {
      code?: string;
      region?: string;
    };
    if (payload?.code !== 'REGION_MISMATCH' || !payload.region) return undefined;
    return ingestHostForRegionId(payload.region);
  } catch {
    return undefined;
  }
}

/**
 * Upload a compressed scan artifact, transparently retrying against the
 * workspace's pinned region if the first endpoint reports a residency mismatch.
 */
export async function uploadScanArtifact(input: ScanUploadInput): Promise<ScanUploadResult> {
  let host = input.host;
  let response = await postOnce(input, host);

  if (response.status === 409) {
    const target = await regionRedirectHost(response);
    if (target && target !== host) {
      console.log(
        chalk.yellow(
          `↻ Workspace is pinned to a different region — retrying upload to ${target}...`,
        ),
      );
      host = target;
      response = await postOnce(input, host);
    }
  }

  return { response, host };
}
