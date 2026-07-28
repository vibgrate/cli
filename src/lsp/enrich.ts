/**
 * Vulnerability enrichment for the panel accordion and Vulnerabilities panel,
 * from OSV.dev (+ optional CISA KEV listing for exploit-awareness chips).
 *
 * OSV.dev is the ecosystem-agnostic vulnerability API: one endpoint keyed by an
 * ecosystem slug (npm, PyPI, Go, Maven, crates.io, …) and a version, so a single
 * client covers every package manager the scanner supports. This is deliberately
 * NOT Vibgrate's own API — the editor enriches straight from the public source,
 * so nothing about your dependencies is sent to us.
 *
 * Lazy + cached: called only when the user expands a package in the accordion
 * (or when the workspace vulns pass runs), and each `ecosystem:name@version`
 * result is cached for the session. Honours `--local`: an offline server never
 * reaches the network and reports `offline`.
 */

/** A single advisory, trimmed to what the accordion / panel shows. */
export interface VulnSummary {
  /** OSV id (often a GHSA), the stable key. */
  id: string;
  /** CVE aliases, for the count and cross-reference. */
  cves: string[];
  /** One-line summary (OSV `summary`, else the start of `details`). */
  summary: string;
  /** Normalised severity band, best-effort from OSV data. */
  severity: 'critical' | 'high' | 'moderate' | 'low' | 'unknown';
  /** Fixed versions from OSV affected ranges (upgrade targets). */
  fixedVersions: string[];
  /** ISO publish date when present. */
  published: string | null;
}

export interface EnrichResult {
  vulns: VulnSummary[];
  /** Distinct CVE count across all advisories (for the overlay badge). */
  cveCount: number;
  /** Where the answer came from — surfaced for honesty, never a spinner lie. */
  source: 'osv' | 'cache' | 'offline' | 'error';
}

/**
 * Confidence that app code reaches this dependency — graph-derived, never proof.
 * `unknown` when no code map is available.
 */
export type Reachability = 'reached' | 'not-observed' | 'unknown';

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
  fixedVersions: string[];
  published: string | null;
  /** True when any CVE alias is listed in CISA KEV (best-effort, online). */
  kev: boolean;
  /**
   * Drift-aware exposure signal from the local code map. Honest about unknowns.
   */
  reachability: Reachability;
  /** Workspace-relative manifest path when known. */
  file: string | null;
  /** 1-based line of the package in the manifest, when known. */
  line: number | null;
  /** Manifest section (dependencies / devDependencies / …). */
  section: string | null;
  /** Latest stable from the scan row when present (currency context). */
  latestStable: string | null;
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
  /** Whether KEV enrichment was applied this pass. */
  kevSource: 'cisa' | 'skipped' | 'error';
}

export interface VulnTarget {
  ecosystem: string;
  package: string;
  version: string;
  file?: string | null;
  line?: number | null;
  section?: string | null;
  latestStable?: string | null;
  /** Precomputed package-level reachability (from the code map). */
  reachability?: Reachability;
}

const OSV_QUERY_URL = 'https://api.osv.dev/v1/query';
const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const cache = new Map<string, EnrichResult>();
let kevCache: { at: number; cves: Set<string> } | null = null;
const KEV_TTL_MS = 6 * 60 * 60 * 1000;

/** Critical → low for sort / priority (Snyk-style ordering). KEV bumps within band. */
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

/** Extract fixed versions from OSV `affected[].ranges[].events[].fixed`. */
function fixedVersionsOf(v: Record<string, unknown>, packageName: string): string[] {
  const affected = Array.isArray(v.affected) ? (v.affected as Record<string, unknown>[]) : [];
  const lower = packageName.toLowerCase();
  const out: string[] = [];
  for (const a of affected) {
    const pkg = a.package as { name?: string } | undefined;
    if (pkg?.name && pkg.name.toLowerCase() !== lower) continue;
    const ranges = Array.isArray(a.ranges) ? (a.ranges as Record<string, unknown>[]) : [];
    for (const range of ranges) {
      const events = Array.isArray(range.events) ? (range.events as Record<string, unknown>[]) : [];
      for (const ev of events) {
        if (typeof ev.fixed === 'string' && ev.fixed && !out.includes(ev.fixed)) out.push(ev.fixed);
      }
    }
  }
  return out;
}

function toSummary(raw: unknown, packageName = ''): VulnSummary {
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
    fixedVersions: fixedVersionsOf(v, packageName),
    published: typeof v.published === 'string' ? v.published : null,
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
    const vulns = (data.vulns ?? []).map((raw) => toSummary(raw, name));
    const cveCount = new Set(vulns.flatMap((v) => v.cves)).size;
    const result: EnrichResult = { vulns, cveCount, source: 'osv' };
    cache.set(k, result);
    return result;
  } catch {
    return { vulns: [], cveCount: 0, source: 'error' };
  }
}

/** Best-effort CISA KEV catalog (CVE id set). Cached for the process lifetime + TTL. */
export async function loadKevCves(opts: { offline: boolean } = { offline: false }): Promise<{
  cves: Set<string>;
  source: 'cisa' | 'skipped' | 'error';
}> {
  if (opts.offline) return { cves: new Set(), source: 'skipped' };
  if (kevCache && Date.now() - kevCache.at < KEV_TTL_MS) {
    return { cves: kevCache.cves, source: 'cisa' };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    const res = await fetch(KEV_URL, { signal: controller.signal }).finally(() => clearTimeout(timer));
    if (!res.ok) return { cves: new Set(), source: 'error' };
    const data = (await res.json()) as { vulnerabilities?: Array<{ cveID?: string }> };
    const cves = new Set<string>();
    for (const v of data.vulnerabilities ?? []) {
      if (v.cveID) cves.add(v.cveID.toUpperCase());
    }
    kevCache = { at: Date.now(), cves };
    return { cves, source: 'cisa' };
  } catch {
    return { cves: new Set(), source: 'error' };
  }
}

/**
 * Live OSV.dev pass over every resolved package in the workspace scan.
 * Concurrent, session-cached via `enrichVulns`. Flattens to one row per
 * advisory, sorted Critical → Low (KEV first within band, then package name).
 */
export async function scanWorkspaceVulns(
  targets: VulnTarget[],
  opts: { offline: boolean; concurrency?: number } = { offline: false },
): Promise<VulnsWorkspaceResult> {
  if (opts.offline) {
    return {
      findings: [],
      counts: emptyCounts(),
      packagesChecked: 0,
      source: 'offline',
      kevSource: 'skipped',
    };
  }
  if (targets.length === 0) {
    return {
      findings: [],
      counts: emptyCounts(),
      packagesChecked: 0,
      source: 'osv',
      kevSource: 'skipped',
    };
  }

  // Dedupe ecosystem:name@version (keep first location metadata).
  const seen = new Set<string>();
  const unique: VulnTarget[] = [];
  for (const t of targets) {
    if (!t.ecosystem || !t.package || !t.version) continue;
    const k = key(t.ecosystem, t.package, t.version);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(t);
  }

  const [kev] = await Promise.all([loadKevCves({ offline: false })]);

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
        const kevHit = v.cves.some((c) => kev.cves.has(c.toUpperCase()));
        findings.push({
          package: t.package,
          version: t.version,
          ecosystem: t.ecosystem,
          id: v.id,
          cves: v.cves,
          summary: v.summary,
          severity: v.severity,
          fixedVersions: v.fixedVersions,
          published: v.published,
          kev: kevHit,
          reachability: t.reachability ?? 'unknown',
          file: t.file ?? null,
          line: t.line ?? null,
          section: t.section ?? null,
          latestStable: t.latestStable ?? null,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()));

  findings.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      Number(b.kev) - Number(a.kev) ||
      a.package.localeCompare(b.package) ||
      a.id.localeCompare(b.id),
  );

  const counts = emptyCounts();
  for (const f of findings) counts[f.severity]++;

  const source: VulnsWorkspaceResult['source'] = anyOk ? 'osv' : anyError ? 'error' : 'osv';

  return {
    findings,
    counts,
    packagesChecked: unique.length,
    source,
    kevSource: kev.source,
  };
}
