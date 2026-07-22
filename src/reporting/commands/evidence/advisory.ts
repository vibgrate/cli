// ── Advisory ingestion ──
//
// An advisory can come from a local file (Vibgrate-shaped or OSV-shaped) or,
// online, from OSV by id. KEV/EUVD/NVD/EPSS enrichment is server-side/premium
// and intentionally NOT fetched here — the open path stays OSV + local, and an
// unreachable feed yields an honest error, never a false "clean".

import { readJsonFile, pathExists } from '../../utils/fs.js';
import { CliError, ExitCode } from '../../../util/exit.js';
import type { Advisory, AdvisoryRange } from './types.js';

interface OsvEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
}
interface OsvRange {
  type?: string;
  events?: OsvEvent[];
}
interface OsvAffected {
  package?: { name?: string; ecosystem?: string; purl?: string };
  ranges?: OsvRange[];
  versions?: string[];
}
interface OsvVuln {
  id?: string;
  published?: string;
  affected?: OsvAffected[];
}

function isOsvShaped(data: unknown): data is OsvVuln {
  return typeof data === 'object' && data !== null && Array.isArray((data as OsvVuln).affected);
}

/** Convert an OSV vuln document into a Vibgrate advisory. */
export function osvToAdvisory(osv: OsvVuln, source: string): Advisory {
  const ranges: AdvisoryRange[] = [];
  for (const aff of osv.affected ?? []) {
    const name = aff.package?.name;
    if (!name) continue;
    const ecosystem = aff.package?.ecosystem;
    let introduced: string | undefined;
    let fixed: string | undefined;
    for (const r of aff.ranges ?? []) {
      for (const ev of r.events ?? []) {
        if (ev.introduced && ev.introduced !== '0') introduced = ev.introduced;
        if (ev.fixed) fixed = ev.fixed;
      }
    }
    ranges.push({ ecosystem, package: name, introduced, fixed, versions: aff.versions });
  }
  return {
    id: osv.id ?? 'UNKNOWN',
    publishedAt: osv.published,
    ranges,
    sourceProvenance: source,
  };
}

/** Load an advisory from a local file — Vibgrate-shaped or OSV-shaped. */
export async function loadAdvisoryFile(filePath: string): Promise<Advisory> {
  if (!(await pathExists(filePath))) {
    throw new CliError(`advisory file not found: ${filePath}`, ExitCode.NOT_FOUND);
  }
  const data = await readJsonFile<unknown>(filePath);
  if (isOsvShaped(data)) return osvToAdvisory(data as OsvVuln, `local:${filePath} (OSV)`);
  const adv = data as Advisory;
  if (!adv.id || !Array.isArray(adv.ranges)) {
    throw new CliError(`advisory file is not a valid Vibgrate or OSV advisory: ${filePath}`, ExitCode.USAGE_ERROR);
  }
  return { ...adv, sourceProvenance: adv.sourceProvenance ?? `local:${filePath}` };
}

/** Fetch an advisory from OSV by id. Requires network; refuses in offline mode. */
export async function fetchOsvAdvisory(id: string, opts: { offline?: boolean } = {}): Promise<Advisory> {
  if (opts.offline) {
    throw new CliError(
      `cannot fetch advisory ${id} in --offline mode — supply it with --advisory <file> (OSV or Vibgrate-shaped)`,
      ExitCode.USAGE_ERROR,
    );
  }
  if (typeof fetch !== 'function') {
    throw new CliError('network fetch is unavailable in this runtime — supply the advisory with --advisory <file>', ExitCode.ERROR);
  }
  let res: Response;
  try {
    res = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15000) });
  } catch {
    throw new CliError(`could not reach OSV to resolve ${id} — supply it with --advisory <file>, or retry online`, ExitCode.ERROR);
  }
  if (!res.ok) {
    throw new CliError(`OSV returned ${res.status} for ${id} — check the id, or supply the advisory with --advisory <file>`, ExitCode.ERROR);
  }
  const osv = (await res.json()) as OsvVuln;
  return osvToAdvisory(osv, `osv.dev:${id}`);
}

/** Resolve an advisory from the flags: --advisory file wins; else fetch by id. */
export async function resolveAdvisory(id: string, opts: { advisoryFile?: string; offline?: boolean }): Promise<Advisory> {
  if (opts.advisoryFile) {
    const adv = await loadAdvisoryFile(opts.advisoryFile);
    // Keep the caller-supplied id if the file didn't set one meaningfully.
    return adv.id && adv.id !== 'UNKNOWN' ? adv : { ...adv, id };
  }
  return fetchOsvAdvisory(id, { offline: opts.offline });
}
