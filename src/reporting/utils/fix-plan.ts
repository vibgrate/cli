/**
 * Transport for the hosted upgrade planner (`POST /v1/fix/plan`).
 *
 * `vg fix` is a thin, DSN-authenticated client: it sends drifted-dependency
 * candidates (versions + the usage/contract signals measured from local source)
 * and renders the plan the server returns. All planning intelligence lives
 * server-side. Mirrors the residency-aware retry of the scan upload transport —
 * a workspace is pinned to one region, so a 409 `REGION_MISMATCH` transparently
 * retries against the named regional host.
 */

import { ingestHostForRegionId } from '../regions.js';
import type { FixPlanRequest, FixPlanResponse } from '../planning/types.js';

export interface FixPlanInput {
  scheme: string;
  host: string;
  keyId: string;
  secret: string;
  request: FixPlanRequest;
  timestamp: string;
}

export interface FixPlanResult {
  response: Response;
  /** The host the final request was sent to — differs from input.host on a region redirect. */
  host: string;
}

function postOnce(input: FixPlanInput, host: string): Promise<Response> {
  return fetch(`${input.scheme}://${host}/v1/fix/plan`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Vibgrate-Timestamp': input.timestamp,
      Authorization: `VibgrateDSN ${input.keyId}:${input.secret}`,
      Connection: 'close',
    },
    body: JSON.stringify(input.request),
  });
}

async function regionRedirectHost(response: Response): Promise<string | undefined> {
  try {
    const payload = (await response.clone().json()) as { code?: string; region?: string };
    if (payload?.code !== 'REGION_MISMATCH' || !payload.region) return undefined;
    return ingestHostForRegionId(payload.region);
  } catch {
    return undefined;
  }
}

/**
 * Request an upgrade plan from the hosted planner, transparently retrying
 * against the workspace's pinned region on a residency mismatch.
 */
export async function requestFixPlan(input: FixPlanInput): Promise<FixPlanResult> {
  let host = input.host;
  let response = await postOnce(input, host);

  if (response.status === 409) {
    const target = await regionRedirectHost(response);
    if (target && target !== host) {
      host = target;
      response = await postOnce(input, host);
    }
  }
  return { response, host };
}

/** Parse a fix-plan response body, tolerating an error envelope. */
export async function parseFixPlanResponse(response: Response): Promise<FixPlanResponse> {
  return (await response.json()) as FixPlanResponse;
}
