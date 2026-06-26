import { Command } from 'commander';
import {
  loadCatalog,
  resolveLib,
  addLibrary,
  readDoc,
  driftFor,
  resolveVersion,
  localPackageDocs,
  localApiSurface,
  libId,
} from '../engine/lib.js';
import type { DriftNote } from '../engine/lib.js';
import { selectForBudget, symbolsFromApi } from '../engine/select.js';
import { assessDocQuality } from '../engine/quality.js';
import { fetchHostedDocs, type HostedDocsResult } from '../engine/hosted.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { rootOf } from './util.js';
import { CliError, ExitCode, usageError } from '../util/exit.js';
import { c, info, json, out } from '../util/output.js';

/**
 * `vg lib` (VG-CLI-SPEC §5 / VG-VS-CONTEXT7) — library currency, the Context7
 * superset. Family:
 *   vg lib                  list the catalog
 *   vg lib <name>           version-correct, drift-annotated docs for <name>
 *   vg lib add <source>     ingest docs (local path; --online for a URL/llms.txt/git repo)
 *   vg lib resolve <name>   name → catalog id + version
 *   vg lib refresh          re-ingest local sources
 */
export function registerLib(program: Command): void {
  const cmd = program
    .command('lib')
    .description('library currency: version-correct, drift-annotated usage docs')
    .argument('[args...]', 'a library name, or: add <source> | resolve <name> | refresh')
    .option('--name <name>', 'library name for `add`')
    .option('--version <v>', 'pin the doc version for `add`')
    .option('--online', '(deprecated; network is on by default) allow network for add/refresh URL sources')
    .option('-b, --budget <n>', 'trim docs to ~N tokens')
    .option('--region <region>', 'data-residency region for the hosted catalog (same as scans; default us)')
    .option('--ingest <url>', 'hosted catalog/ingest URL override (host extracted; wins over --region)')
    .action(async function (this: Command, args: string[], opts: { name?: string; version?: string; online?: boolean; budget?: string; region?: string; ingest?: string }) {
      const global = readGlobal(this);
      const root = rootOf(global);
      const [verb, ...rest] = args;

      // Network is ON BY DEFAULT (local-first, hosted-on-miss). `--local` is the hard airgap:
      // no network ever. `--online` is kept only as a back-compat no-op for add/refresh sources.
      const network = !global.local;
      if (!verb) return listCatalog(root, global.json);
      // add/refresh still gate URL/git fetching behind --online (or network default) to avoid surprise fetches.
      const online = (Boolean(opts.online) || network) && !global.local;
      if (verb === 'add') return addCmd(root, rest, { ...opts, online }, global.json);
      if (verb === 'resolve') return resolveCmd(root, rest, global.json);
      if (verb === 'refresh') return refreshCmd(root, { online }, global.json);
      // `vg lib <name>`: local-first; on a thin/missing local doc, fall through to the hosted
      // catalog automatically unless --local. No flag required.
      return showCmd(root, args.join(' '), opts.budget ? Number(opts.budget) : undefined, global.json, {
        online: network, // hosted-on-miss allowed unless --local
        region: opts.region,
        ingest: opts.ingest,
      });
    });
  applyGlobalOptions(cmd);
}

function listCatalog(root: string, asJson?: boolean): void {
  const catalog = loadCatalog(root);
  const libs = Object.values(catalog.libraries).sort((a, b) => a.name.localeCompare(b.name));
  if (asJson) {
    json(libs.map((l) => ({ id: l.id, name: l.name, version: l.version, source: l.source.type })));
    return;
  }
  info(`${c.cyan('vg lib')} · ${libs.length} library(ies) in the catalog`);
  for (const l of libs) {
    const d = driftFor(root, l);
    const tag = d.drift === 'behind' ? c.yellow(' (docs behind your version)') : d.drift === 'ahead' ? c.dim(' (docs ahead)') : '';
    info(`  ${c.bold(l.name)} ${c.dim(`@${l.version}`)} ${c.dim(`[${l.source.type}]`)}${tag}`);
  }
  if (!libs.length) info(c.dim('  empty — add docs with `vg lib add <path|url>`'));
}

async function addCmd(root: string, rest: string[], opts: { name?: string; version?: string; online?: boolean }, asJson?: boolean): Promise<void> {
  const source = rest[0];
  if (!source) throw usageError('usage: vg lib add <path|url|git> [--name <name>] [--version <v>] [--online]');
  let entry;
  try {
    entry = await addLibrary(source, { root, name: opts.name, version: opts.version, allowNetwork: opts.online });
  } catch (err) {
    throw new CliError((err as Error).message, ExitCode.ERROR);
  }
  if (asJson) {
    json(entry);
    return;
  }
  info(`${c.green('✔')} added ${c.bold(entry.name)} ${c.dim(`@${entry.version}`)} (${entry.bytes} bytes) → ${entry.docFile}`);
}

function resolveCmd(root: string, rest: string[], asJson?: boolean): void {
  const name = rest.join(' ');
  if (!name) throw usageError('usage: vg lib resolve <name>');
  const entry = resolveLib(loadCatalog(root), name);
  if (!entry) throw new CliError(`no library matches "${name}" (id ${libId(name)})`, ExitCode.NOT_FOUND);
  if (asJson) json({ id: entry.id, name: entry.name, version: entry.version });
  else info(`${entry.id} ${c.dim(`(${entry.name}@${entry.version})`)}`);
}

async function refreshCmd(root: string, opts: { online?: boolean }, asJson?: boolean): Promise<void> {
  const catalog = loadCatalog(root);
  const results: { name: string; ok: boolean }[] = [];
  for (const entry of Object.values(catalog.libraries)) {
    try {
      await addLibrary(entry.source.location, { root, name: entry.name, version: entry.version, allowNetwork: opts.online });
      results.push({ name: entry.name, ok: true });
    } catch {
      results.push({ name: entry.name, ok: false });
    }
  }
  if (asJson) json({ refreshed: results });
  else info(`${c.cyan('vg lib refresh')} · ${results.filter((r) => r.ok).length}/${results.length} re-ingested`);
}

interface ShowOpts {
  online?: boolean;
  region?: string;
  ingest?: string;
}

async function showCmd(root: string, name: string, budget: number | undefined, asJson?: boolean, opts: ShowOpts = {}): Promise<void> {
  const online = opts.online;
  const catalog = loadCatalog(root);
  const entry = resolveLib(catalog, name);
  const ver = resolveVersion(root, name);

  const displayName = entry?.name ?? name;
  let localDoc: string | undefined;
  let docVersion = ver.served ?? '*';
  let docSource: string | undefined;
  let drift: DriftNote | undefined;

  if (entry) {
    // 1. Committed catalog (drift-annotated).
    localDoc = readDoc(root, entry);
    docVersion = entry.version;
    drift = driftFor(root, entry);
  } else {
    // 2. Local-first: docs from the installed package on disk, version-correct, offline.
    const local = localPackageDocs(root, name);
    if (local) {
      localDoc = local.docs;
      docVersion = local.version ?? ver.served ?? '*';
      docSource = local.source;
    }
  }

  // Quality gate (D18): assess the full local extraction. An insufficient doc (no example /
  // stub / off-topic) — or no local doc at all — is a candidate for hosted escalation.
  const apiSurface = localApiSurface(root, displayName);
  const quality =
    localDoc !== undefined
      ? assessDocQuality([localDoc, apiSurface].filter(Boolean).join('\n\n'), { name: displayName, symbols: symbolsFromApi(apiSurface) })
      : { sufficient: false, score: 0, reasons: ['no local docs'] };

  // D18 escalation (D7 no-key funnel): only when --online AND local is missing/insufficient.
  // fetchHostedDocs fails closed to null, so the local path never breaks.
  let hosted: HostedDocsResult | null = null;
  if (online && !quality.sufficient) {
    hosted = await fetchHostedDocs({ name: displayName, query: name, maxTokens: budget }, { region: opts.region, ingest: opts.ingest });
  }

  if (localDoc === undefined && !hosted) {
    throw new CliError(
      `no library docs for "${name}" — add with \`vg lib add <path|url> --name ${name}\` or install the package${online ? '' : ' (or retry with --online for the hosted catalog)'}`,
      ExitCode.NOT_FOUND,
    );
  }

  let doc: string;
  if (hosted) {
    doc = hosted.content;
    docSource = 'hosted';
    docVersion = hosted.version ?? docVersion;
  } else {
    doc = selectForBudget({ readme: localDoc!, apiSurface, budget }).text;
  }

  if (asJson) {
    json({
      id: entry?.id,
      name: displayName,
      version: docVersion,
      source: docSource ?? 'catalog',
      drift: drift ?? null,
      version_mismatch: ver.mismatch ?? null,
      quality: { sufficient: quality.sufficient, score: quality.score, reasons: quality.reasons },
      escalate: quality.sufficient ? null : 'hosted',
      escalated: Boolean(hosted),
      docs: doc,
    });
    return;
  }
  info(`${c.cyan('vg lib')} · ${c.bold(displayName)} ${c.dim(`@${docVersion}`)}${docSource ? c.dim(` (from ${docSource})`) : ''}`);
  if (ver.mismatch) info(c.yellow(`  ⚠ ${ver.mismatch.note}`));
  if (hosted) info(c.green('  ✔ local docs were thin — served richer docs from the hosted catalog'));
  else if (!quality.sufficient) info(c.yellow(`  ⚠ local docs look thin (${quality.reasons.join(', ')})${online ? ' — hosted catalog had nothing better' : ' — run without --local for the hosted catalog'}`));
  if (drift?.drift === 'behind') info(c.yellow(`  ⚠ docs are for ${drift.cataloged}, but your installed version is ${drift.installed} — refresh the docs`));
  else if (drift?.drift === 'current') info(c.green(`  ✔ docs match your installed version (${drift.installed})`));
  info('');
  out(doc);
}
