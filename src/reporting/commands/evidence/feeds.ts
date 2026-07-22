// ── Threat-intelligence feeds for `vg evidence watch` ──
//
// Fetches the CISA Known Exploited Vulnerabilities (KEV) catalog and joins it to
// the components in your frozen release manifests via OSV, so a newly
// actively-exploited vulnerability affecting something you shipped surfaces
// immediately.
//
// Boundary (legal + trust): `watch` SURFACES the KEV listing. It does not decide
// that a vulnerability is "actively exploited" for the purposes of a filing —
// that determination stays with a human.

import { CliError, ExitCode } from '../../../util/exit.js';
import { osvToAdvisory } from './advisory.js';
import type { Advisory, FrozenComponent } from './types.js';

const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const OSV_BATCH_URL = 'https://api.osv.dev/v1/querybatch';
const OSV_VULN_URL = 'https://api.osv.dev/v1/vulns/';

export interface KevEntry {
  cveID: string;
  vulnerabilityName?: string;
  dateAdded?: string;
  knownRansomwareCampaignUse?: string;
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  if (typeof fetch !== 'function') throw new CliError('network fetch is unavailable in this runtime', ExitCode.ERROR);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new CliError(`could not reach ${new URL(url).host}: ${e instanceof Error ? e.message : String(e)}`, ExitCode.ERROR);
  }
  if (!res.ok) throw new CliError(`${new URL(url).host} returned ${res.status}`, ExitCode.ERROR);
  return res.json();
}

/** Fetch the CISA KEV catalog as a map of CVE id → entry. */
export async function fetchKevCatalog(): Promise<Map<string, KevEntry>> {
  const data = (await getJson(KEV_URL)) as { vulnerabilities?: KevEntry[] };
  const map = new Map<string, KevEntry>();
  for (const v of data.vulnerabilities ?? []) {
    if (v.cveID) map.set(v.cveID.toUpperCase(), v);
  }
  return map;
}

const OSV_ECOSYSTEM: Record<string, string> = {
  npm: 'npm', PyPI: 'PyPI', Maven: 'Maven', NuGet: 'NuGet', Go: 'Go', 'crates.io': 'crates.io', RubyGems: 'RubyGems', Packagist: 'Packagist', Pub: 'Pub', Hex: 'Hex',
};

/** Query OSV for the advisory ids affecting a set of shipped components. */
async function osvIdsForComponents(components: FrozenComponent[]): Promise<Set<string>> {
  const queries = components
    .filter((c) => c.ecosystem && OSV_ECOSYSTEM[c.ecosystem])
    .map((c) => ({ package: { name: c.name, ecosystem: OSV_ECOSYSTEM[c.ecosystem as string] }, version: c.version }));
  if (queries.length === 0) return new Set();
  const ids = new Set<string>();
  // OSV querybatch caps at 1000 queries per request; chunk to be safe.
  for (let i = 0; i < queries.length; i += 500) {
    const batch = queries.slice(i, i + 500);
    const data = (await getJson(OSV_BATCH_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queries: batch }) })) as {
      results?: { vulns?: { id: string }[] }[];
    };
    for (const r of data.results ?? []) for (const v of r.vulns ?? []) ids.add(v.id);
  }
  return ids;
}

interface OsvVulnDoc {
  id?: string;
  aliases?: string[];
  affected?: unknown[];
}

/**
 * Join KEV to your shipped components: return one Advisory per OSV advisory that
 * (a) affects a component in your frozen manifests and (b) is KEV-listed (its
 * CVE alias appears in the KEV catalog). Each advisory is tagged with its KEV
 * listing date via `kevListedAt`.
 */
export async function kevAdvisoriesForComponents(kev: Map<string, KevEntry>, components: FrozenComponent[]): Promise<Advisory[]> {
  const osvIds = await osvIdsForComponents(components);
  const advisories: Advisory[] = [];
  for (const id of osvIds) {
    const doc = (await getJson(`${OSV_VULN_URL}${encodeURIComponent(id)}`)) as OsvVulnDoc;
    const aliases = (doc.aliases ?? []).map((a) => a.toUpperCase());
    const kevCve = [id.toUpperCase(), ...aliases].find((a) => kev.has(a));
    if (!kevCve) continue;
    const entry = kev.get(kevCve)!;
    const advisory = osvToAdvisory(doc as never, `osv.dev:${id} · CISA KEV ${kevCve}`);
    advisory.kevListedAt = entry.dateAdded;
    // Prefer the CVE id as the advisory id for filing.
    advisory.id = kevCve;
    advisories.push(advisory);
  }
  return advisories;
}
