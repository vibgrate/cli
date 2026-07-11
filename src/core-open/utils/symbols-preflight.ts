// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Scan symbols preflight transport — the client half of the reachability
 * hand-off. Posts the scan's dependency coordinates (ecosystem/package/version
 * ONLY — never source, never file paths) to
 * `POST /v1/ingest/scan/preflight/symbols` and receives the risky-symbol
 * manifest: "for the versions you have, here are the vulnerable symbols to
 * look for" in the local code graph.
 *
 * Best-effort by design: callers treat any failure as "no manifest" and leave
 * every finding Unknown — reachability never blocks or fails a scan.
 */

import type { ParsedDsn } from './dsn.js';
import type { ProjectType } from '../types.js';

/** One dependency coordinate posted to the preflight (OSV ecosystem naming). */
export interface SymbolsPreflightDependency {
  ecosystem: string;
  package: string;
  version: string;
}

export interface RiskySymbol {
  symbol: string;
  kind: 'function' | 'method' | 'class' | 'module';
  confidence: number;
  source: 'osv' | 'patch-diff';
  evidenceUrl?: string;
}

export interface RiskySymbolManifestEntry {
  advisoryId: string;
  aliases: string[];
  ecosystem: string;
  package: string;
  /** The posted version this advisory matched. */
  version: string;
  symbols: RiskySymbol[];
  symbolCoverage: 'function' | 'module' | 'none';
  state: 'pending' | 'extracting' | 'ready' | 'needs-review' | 'failed' | 'stale';
}

export interface SymbolsPreflightResponse {
  status: 'ok' | 'error';
  schemaVersion?: '1';
  generatedAt?: string;
  methodologyVersion?: string;
  advisories?: RiskySymbolManifestEntry[];
  /** Advisories registered for background symbol extraction on this call. */
  pendingExtractions?: number;
  error?: string;
}

/**
 * OSV-canonical ecosystem name per project type (matches the server's SCA
 * mapping). Types absent here have no reliable OSV coverage and are not posted.
 */
export const PROJECT_TYPE_TO_OSV_ECOSYSTEM: Partial<Record<ProjectType, string>> = {
  node: 'npm',
  typescript: 'npm',
  dotnet: 'NuGet',
  'visual-basic': 'NuGet',
  python: 'PyPI',
  ruby: 'RubyGems',
  java: 'Maven',
  kotlin: 'Maven',
  scala: 'Maven',
  groovy: 'Maven',
  clojure: 'Maven',
  go: 'Go',
  rust: 'crates.io',
  php: 'Packagist',
  dart: 'Pub',
  elixir: 'Hex',
};

const MAX_DEPENDENCIES = 4000;

/**
 * Call POST /v1/ingest/scan/preflight/symbols with the scan's dependency list.
 * Throws on transport/HTTP errors — the caller degrades to "no manifest".
 */
export async function fetchRiskySymbols(
  parsed: ParsedDsn,
  ingestHost: string,
  dependencies: SymbolsPreflightDependency[],
): Promise<SymbolsPreflightResponse> {
  const url = `${parsed.scheme}://${ingestHost}/v1/ingest/scan/preflight/symbols`;
  const body = JSON.stringify({
    schemaVersion: '1',
    dependencies: dependencies.slice(0, MAX_DEPENDENCIES),
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Vibgrate-Timestamp': String(Date.now()),
      Authorization: `VibgrateDSN ${parsed.keyId}:${parsed.secret}`,
    },
    body,
  });

  const payload = (await response.json()) as SymbolsPreflightResponse;
  if (!response.ok && payload.status !== 'error') {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}
