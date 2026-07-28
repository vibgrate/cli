/**
 * Vulnerability enrichment for the panel accordion, from OSV.dev.
 *
 * OSV.dev is the ecosystem-agnostic vulnerability API: one endpoint keyed by an
 * ecosystem slug (npm, PyPI, Go, Maven, crates.io, …) and a version, so a single
 * client covers every package manager the scanner supports. This is deliberately
 * NOT Vibgrate's own API — the editor enriches straight from the public source,
 * so nothing about your dependencies is sent to us.
 *
 * Lazy + cached: called only when the user expands a package in the accordion,
 * and each `ecosystem:name@version` result is cached for the session so a
 * re-expand (or the CVE-count overlay) is instant. Honours `--local`: an offline
 * server never reaches the network and reports `offline`.
 */

/** A single advisory, trimmed to what the accordion shows. */
export interface VulnSummary {
  /** OSV id (often a GHSA), the stable key. */
  id: string;
  /** CVE aliases, for the count and cross-reference. */
  cves: string[];
  /** One-line summary (OSV `summary`, else the start of `details`). */
  summary: string;
  /** Normalised severity band, best-effort from OSV data. */
  severity: 'critical' | 'high' | 'moderate' | 'low' | 'unknown';
}

export interface EnrichResult {
  vulns: VulnSummary[];
  /** Distinct CVE count across all advisories (for the overlay badge). */
  cveCount: number;
  /** Where the answer came from — surfaced for honesty, never a spinner lie. */
  source: 'osv' | 'cache' | 'offline' | 'error';
}

/** One advisory × package row for the Vulnerabilities panel (flat, severity-ranked). */
export interface VulnFinding {
  package: string;
  version: string;
  ecosystem: string;
  /** OSV id (often a GHSA) — stable key for osv.dev links. */
  id: string;
  cves: string[];
  summary: string;
  severity: VulnSummary['severity'];
}

export interface VulnsWorkspaceResult {
  findings: VulnFinding[];
  counts: Record<VulnSummary['severity'], number>;
  /** Distinct packages queried (not advisory rows). */
  packagesChecked: number;
  /**
   * `osv` = live check finished; `offline` / `error` / `pending` are honest
   * absent states (never report "0 vulns" when we could not check).
   */
  source: 'osv' | 'offline' | 'error' | 'pending';
}

const OSV_QUERY_URL = 'https://api.osv.dev/v1/query';
const cache = new Map<string, EnrichResult>();

/** Critical → low for sort / priority (Snyk-style ordering). */
const SEVERITY_RANK: Record<VulnSummary['severity'], number> = {
  critical: 4,
  high: 3,
  moderate: 2,
  low: 1,
  unknown: 0,
};

function key(ecosystem: string, name: string, version: string): string {
  return `${ecosystem}:${name}@${version}`;
}

function emptyCounts(): Record<VulnSummary['severity'], number> {
  return { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 };
}

/** Normalise OSV severity signals (database_specific.severity or a CVSS vector). */
function severityOf(v: Record<string, unknown>): VulnSummary['severity'] {
  const dbSpecific = v.database_specific as Record<string, unknown> | undefined;
  const label = typeof dbSpecific?.severity === 'string' ? dbSpecific.severity.toLowerCase() : '';
  if (label.includes('critical')) return 'critical';
  if (label.includes('high')) return 'high';
  if (label.includes('moderate') || label.includes('medium')) return 'moderate';
  if (label.includes('low')) return 'low';
  // Fall back to a CVSS base score if present.
  const sev = Array.isArray(v.severity) ? (v.severity as Record<string, unknown>[]) : [];
  const cvss = sev.find((s) => typeof s.score === 'string' && String(s.type).startsWith('CVSS'));
  if (cvss) {
    const m = /\/AV:.*$/.test(String(cvss.score)) ? null : Number(cvss.score);
    if (m != null && !Number.isNaN(m)) {
      if (m >= 9) return 'critical';
      if (m >= 7) return 'high';
      if (m >= 4) return 'moderate';
      if (m > 0) return 'low';
    }
  }
  return 'unknown';
}

function toSummary(raw: unknown): VulnSummary {
  const v = (raw ?? {}) as Record<string, unknown>;
  const aliases = Array.isArray(v.aliases) ? v.aliases.map(String) : [];
  const details = typeof v.details === 'string' ? v.details : '';
  const summary =
    (typeof v.summary === 'string' && v.summary) ||
    (details ? details.split('\n')[0]!.slice(0, 140) : '') ||
    'Advisory';
  return {
    id: String(v.id ?? 'unknown'),
    cves: aliases.filter((a) => a.startsWith('CVE-')),
    summary,
    severity: severityOf(v),
  };
}

/**
 * Query OSV.dev for advisories affecting `name@version` in `ecosystem`.
 * Returns cached results instantly; never throws (a failed lookup degrades to an
 * empty, `error`-sourced result so the accordion just shows "no known vulns").
 */
export async function enrichVulns(
  ecosystem: string | null,
  name: string,
  version: string | null,
  opts: { offline: boolean } = { offline: false },
): Promise<EnrichResult> {
  if (!ecosystem || !version) return { vulns: [], cveCount: 0, source: 'error' };
  if (opts.offline) return { vulns: [], cveCount: 0, source: 'offline' };

  const k = key(ecosystem, name, version);
  const cached = cache.get(k);
  if (cached) return { ...cached, source: 'cache' };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(OSV_QUERY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version, package: { name, ecosystem } }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!res.ok) return { vulns: [], cveCount: 0, source: 'error' };
    const data = (await res.json()) as { vulns?: unknown[] };
    const vulns = (data.vulns ?? []).map(toSummary);
    const cveCount = new Set(vulns.flatMap((v) => v.cves)).size;
    const result: EnrichResult = { vulns, cveCount, source: 'osv' };
    cache.set(k, result);
    return result;
  } catch {
    return { vulns: [], cveCount: 0, source: 'error' };
  }
}

/**
 * Live OSV.dev pass over every resolved package in the workspace scan.
 * Concurrent, session-cached via `enrichVulns`. Flattens to one row per
 * advisory, sorted Critical → Low (then package name) for the panel.
 */
export async function scanWorkspaceVulns(
  targets: Array<{ ecosystem: string; package: string; version: string }>,
  opts: { offline: boolean; concurrency?: number } = { offline: false },
): Promise<VulnsWorkspaceResult> {
  if (opts.offline) {
    return { findings: [], counts: emptyCounts(), packagesChecked: 0, source: 'offline' };
  }
  if (targets.length === 0) {
    return { findings: [], counts: emptyCounts(), packagesChecked: 0, source: 'osv' };
  }

  // Dedupe ecosystem:name@version.
  const seen = new Set<string>();
  const unique: typeof targets = [];
  for (const t of targets) {
    if (!t.ecosystem || !t.package || !t.version) continue;
    const k = key(t.ecosystem, t.package, t.version);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(t);
  }

  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 8, 16));
  const findings: VulnFinding[] = [];
  let anyOk = false;
  let anyError = false;
  let i = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const idx = i++;
      if (idx >= unique.length) return;
      const t = unique[idx]!;
      const r = await enrichVulns(t.ecosystem, t.package, t.version, { offline: false });
      if (r.source === 'osv' || r.source === 'cache') anyOk = true;
      else if (r.source === 'error') anyError = true;
      for (const v of r.vulns) {
        findings.push({
          package: t.package,
          version: t.version,
          ecosystem: t.ecosystem,
          id: v.id,
          cves: v.cves,
          summary: v.summary,
          severity: v.severity,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()));

  findings.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      a.package.localeCompare(b.package) ||
      a.id.localeCompare(b.id),
  );

  const counts = emptyCounts();
  for (const f of findings) counts[f.severity]++;

  // Honest source: if every query failed, don't claim a clean OSV pass.
  const source: VulnsWorkspaceResult['source'] =
    anyOk ? 'osv' : anyError ? 'error' : 'osv';

  return {
    findings,
    counts,
    packagesChecked: unique.length,
    source,
  };
}
