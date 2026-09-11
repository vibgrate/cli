/**
 * `vg show surfaces` — the external surfaces the last scan found.
 *
 * Not a new top-level verb (FEATURE-DESIGN-PRINCIPLES P1): nested under
 * `vg show` so the terminal view, the report, and `--json` stay one surface.
 *
 * This reads the stored artifact rather than re-scanning. It never contacts a
 * vendor and never re-derives a freshness verdict — those are the catalog's,
 * recorded at scan time, and printing a different answer here would mean the
 * CLI and the dashboard disagreed about the same scan.
 */
import * as path from 'node:path';
import type { Command } from 'commander';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { pathExists, readJsonFile } from '../core-open/index.js';
import type { ExternalSurface, ScanArtifact, SurfaceInventory } from '../core-open/index.js';
import { rootOf } from './util.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info, json } from '../util/output.js';

const DEFAULT_ARTIFACT = '.vibgrate/scan_result.json';

/** Display groups, in print order — the same grouping the dashboard uses. */
const GROUPS: Array<{ label: string; categories: string[] }> = [
  { label: 'AI & inference', categories: ['ai'] },
  { label: 'MCP & agent tools', categories: ['mcp'] },
  { label: 'Payments', categories: ['payment'] },
  { label: 'Auth / identity', categories: ['auth'] },
  { label: 'Data stores', categories: ['databases'] },
  { label: 'Messaging', categories: ['messaging'] },
  { label: 'Observability', categories: ['observability'] },
  { label: 'Cloud / IaaS', categories: ['cloud', 'storage'] },
  { label: 'Email / comms', categories: ['email'] },
  { label: 'Search / vectors', categories: ['search'] },
  { label: 'Other SaaS', categories: ['crm', 'other'] },
];

const KIND_LABEL: Record<string, string> = {
  api: 'API',
  model: 'model',
  mcp: 'MCP server',
  saas: 'service',
};

const KINDS = ['api', 'model', 'mcp', 'saas'];

/** A terminal has no brand marks, so a surface is named and its state spelled out. */
const STATUS_LABEL: Record<string, string> = {
  current: 'current',
  behind: 'behind',
  deprecated: 'deprecated',
  retired: 'retired',
  unknown: 'unverified',
};

export function registerShowSurfaces(show: Command): void {
  const cmd = show
    .command('surfaces')
    .alias('surface')
    .description('list the external APIs, AI models, MCP servers and SaaS the last scan found')
    .option('--in <file>', 'scan artifact to read', DEFAULT_ARTIFACT)
    .option('--kind <kind>', `only this kind (${KINDS.join('|')})`)
    .option('--behind', 'only surfaces the vendor catalog reports as not current')
    .action(async function (this: Command, opts: { in?: string; kind?: string; behind?: boolean }) {
      const global = readGlobal(this);
      const root = rootOf(global);
      const inFile = opts.in ?? DEFAULT_ARTIFACT;
      const artifactPath = path.isAbsolute(inFile) ? inFile : path.join(root, inFile);

      if (opts.kind && !KINDS.includes(opts.kind)) {
        throw new CliError(`unknown --kind "${opts.kind}" — use one of: ${KINDS.join(', ')}`, ExitCode.USAGE_ERROR);
      }
      if (!(await pathExists(artifactPath))) {
        throw new CliError(`no scan found at ${inFile} — run \`vg scan\` first`, ExitCode.NOT_FOUND);
      }

      const artifact = await readJsonFile<ScanArtifact>(artifactPath);
      const inventory = artifact.extended?.surfaceInventory;
      if (!inventory) {
        // Absent is not empty: this scan did not inventory surfaces at all.
        throw new CliError(
          'this scan did not inventory external surfaces — re-run `vg scan` with the surface catalog available',
          ExitCode.NOT_FOUND,
        );
      }

      const surfaces = filterSurfaces(inventory.surfaces, opts);
      if (global.json) {
        json({ ...inventory, surfaces });
        return;
      }
      printSurfaces(inventory, surfaces, Boolean(opts.behind || opts.kind));
    });
  applyGlobalOptions(cmd);
}

function filterSurfaces(surfaces: ExternalSurface[], opts: { kind?: string; behind?: boolean }): ExternalSurface[] {
  return surfaces.filter((s) => {
    if (opts.kind && s.kind !== opts.kind) return false;
    // `unknown` is not "behind": the catalog simply does not cover it, and
    // listing it under --behind would present absence of data as a finding.
    if (opts.behind && !['behind', 'deprecated', 'retired'].includes(s.freshness.status)) return false;
    return true;
  });
}

function printSurfaces(inventory: SurfaceInventory, surfaces: ExternalSurface[], filtered: boolean): void {
  if (surfaces.length === 0) {
    info(
      filtered
        ? 'No surfaces match that filter.'
        : 'No external APIs, models, or MCP servers detected. Detection is static, so a service reached only at runtime will not appear here.',
    );
    return;
  }

  info(c.bold('Surface'));
  for (const group of GROUPS) {
    const rows = surfaces
      .filter((s) => group.categories.includes(s.provider.category))
      .sort(
        (a, b) =>
          a.provider.displayName.localeCompare(b.provider.displayName) || a.detectedId.localeCompare(b.detectedId),
      );
    if (rows.length === 0) continue;

    const behind = rows.filter((s) => ['behind', 'deprecated', 'retired'].includes(s.freshness.status)).length;
    info(`  ${c.cyan(group.label)}   ${rows.length} ${rows.length === 1 ? 'surface' : 'surfaces'}${behind > 0 ? `  ·  ${behind} not current` : ''}`);

    const nameWidth = Math.max(...rows.map((s) => s.provider.displayName.length));
    const idWidth = Math.min(36, Math.max(...rows.map((s) => detectedLabel(s).length)));
    for (const row of rows) {
      // A SaaS package carries no vendor freshness verdict — that is ordinary
      // dependency drift. Printing "unverified" on every one of them would
      // drown the rows where the state is a real vendor statement.
      const status = row.kind === 'saas' ? '' : STATUS_LABEL[row.freshness.status] ?? 'unverified';
      // The catalog's own words: the vendor's current id when it names one,
      // otherwise the replacement it points at. Never a guess of our own.
      const latest = row.freshness.latest && row.freshness.latest !== row.detectedId
        ? c.dim(`  latest ${row.freshness.latest}`)
        : row.freshness.alternatives.length > 0
          ? c.dim(`  vendor suggests ${row.freshness.alternatives.join(', ')}`)
          : '';
      const tail = row.confidence === 'low' ? c.dim('  (inferred)') : '';
      const line =
        `    ${row.provider.displayName.padEnd(nameWidth)}  ${detectedLabel(row).padEnd(idWidth)}  ` +
        `${status ? statusColor(row.freshness.status, status) : ''}${latest}${tail}`;
      info(line.trimEnd());
    }
  }

  // The comparison's provenance, always — a reader must be able to tell
  // "current" from "we could not check".
  const { catalog } = inventory;
  info(
    c.dim(
      catalog.generatedAt
        ? `  vendor catalog ${catalog.generatedAt}${catalog.stale ? ' · older than 7 days, freshness may lag' : ''}`
        : '  no vendor catalog was available — no surface is reported as current or behind',
    ),
  );
  if (inventory.unknownHosts.length > 0) {
    info(
      c.dim(
        `  ${inventory.unknownHosts.length} external host${inventory.unknownHosts.length === 1 ? '' : 's'} matched no catalogued vendor`,
      ),
    );
  }
}

/** What the row is about: a model id, an API version, an MCP package, a vendor. */
function detectedLabel(s: ExternalSurface): string {
  if (s.kind === 'api' && s.version) return `API ${s.version}`;
  if (s.kind === 'saas') {
    const version = s.metadata?.sdkVersion;
    return version ? `${KIND_LABEL[s.kind]} ${version}` : KIND_LABEL[s.kind];
  }
  return s.detectedId;
}

function statusColor(status: string, label: string): string {
  if (status === 'behind' || status === 'deprecated' || status === 'retired') return c.yellow(label);
  if (status === 'current') return c.green(label);
  return c.dim(label);
}
