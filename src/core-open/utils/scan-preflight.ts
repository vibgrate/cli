// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import type { ParsedDsn } from './dsn.js';

export interface ScanPreflightResponse {
  status: 'ok' | 'error';
  workspaceId: string;
  /** Data-residency region the workspace is pinned to (newer APIs only). */
  region?: string;
  /** Ingest host to push results to (the workspace's region; newer APIs only). */
  ingestHost?: string;
  plan: { tier: string; label: string };
  scans: {
    used: number;
    limit: number;
    remaining: number | null;
    allowed: boolean;
    yearMonth: string;
  };
  vm?: {
    used: number;
    limit: number;
    remaining: number | null;
    allowed: boolean;
    overageEnabled: boolean;
    yearMonth: string;
  };
  repository?: {
    name: string;
    id: string | null;
    unchanged?: boolean;
    lastScannedAt?: string;
    lastIngestId?: string;
    lastVcsSha?: string;
  };
  /**
   * Repository-count accounting against the plan's `maxRepos` cap. Present when a
   * repository name was supplied. `isNew` is true when the repository is not yet
   * mapped in the workspace (so scanning it would add to the estate); `allowed`
   * is false only when binding this *new* repository would breach the cap — an
   * already-mapped repository is always allowed to re-scan.
   */
  repositories?: {
    total: number;
    /** The plan's repository cap (-1 = unlimited). */
    max: number;
    isNew: boolean;
    allowed: boolean;
  };
  error?: string;
  code?: string;
  upgradeUrl?: string;
}

export interface ScanPreflightOptions {
  repositoryName?: string;
  vcsSha?: string;
}

/**
 * Call GET /v1/ingest/scan/preflight before an expensive local scan.
 */
export async function fetchScanPreflight(
  parsed: ParsedDsn,
  ingestHost: string,
  options?: ScanPreflightOptions,
): Promise<ScanPreflightResponse> {
  const host = ingestHost;
  const url = new URL(`${parsed.scheme}://${host}/v1/ingest/scan/preflight`);
  if (options?.repositoryName) {
    url.searchParams.set('repository', options.repositoryName);
  }
  if (options?.vcsSha) {
    url.searchParams.set('vcsSha', options.vcsSha);
  }

  const timestamp = String(Date.now());
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'X-Vibgrate-Timestamp': timestamp,
      Authorization: `VibgrateDSN ${parsed.keyId}:${parsed.secret}`,
    },
  });

  const body = (await response.json()) as ScanPreflightResponse;
  if (!response.ok && body.status !== 'error') {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}
