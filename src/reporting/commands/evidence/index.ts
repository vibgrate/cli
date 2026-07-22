// ── `vg evidence` — Vibgrate Evidence command surface ──
//
// Jurisdiction-neutral regulatory-evidence product. Deterministic, offline-
// capable, signed. No language model touches a number; every determination
// carries the regime's indicative-not-audit-grade disclaimer.

import * as path from 'node:path';
import * as fs from 'node:fs';
import { Command } from 'commander';
import chalk from 'chalk';
import { VERSION } from '../../../version.js';
import { CliError, ExitCode } from '../../../util/exit.js';
import { writeJsonFile } from '../../utils/fs.js';
import { resolveRegime, listRegimes, DEFAULT_REGIME } from './regimes.js';
import { loadOrg, saveOrg, loadProducts, saveProducts, getProduct, freezeRelease, loadReleases } from './state.js';
import { computeExposure, exposureSubjectDigest } from './exposure.js';
import { requestTimestamp, parseTimestampToken, verifyTimestamp } from './tsa.js';
import { fetchKevCatalog, kevAdvisoriesForComponents } from './feeds.js';
import { computeReadiness } from './readiness.js';
import { resolveAdvisory } from './advisory.js';
import { buildRelease } from './release.js';
import { buildPack } from './pack.js';
import { buildEvidenceStatement, signEvidenceStatement, verifyEvidenceEnvelope, resolveSigningKey, writeBundle } from './bundle.js';
import { synthesizeAdvisory, undeterminedFields, recordDrill, hasRecentDrill } from './drill.js';
import { formatExposure, formatReadiness, formatRegimeList } from './format.js';
import { resolveDsn } from '../../credentials.js';
import { parseDsn } from '../push.js';
import type { Product, Release, ExposureResult, Regime, ResponsiblePerson, FrozenComponent } from './types.js';
import type { DsseEnvelope } from '../../../engine/attest.js';

function root(opts: { cwd?: string }): string {
  return path.resolve(opts.cwd ?? process.cwd());
}
function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'product';
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function nowIso(): string {
  return new Date().toISOString();
}
function csv(v?: string): string[] {
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
}
const cwdOption: [string, string] = ['-C, --cwd <dir>', 'Run against this directory (default: current)'];

async function releasesByProductMap(rootDir: string, products: Product[]): Promise<Map<string, Release[]>> {
  const map = new Map<string, Release[]>();
  for (const p of products) map.set(p.id, await loadReleases(rootDir, p.id));
  return map;
}

// ── init ──
const initCmd = new Command('init')
  .description('Set org, coordinator, and the person with filing authority (per regime)')
  .option(...cwdOption)
  .option('--regime <id>', 'Default regime for this repo', DEFAULT_REGIME)
  .option('--legal-entity <name>', 'Legal entity name')
  .option('--establishment <cc>', 'Main establishment (country code)')
  .option('--eu-rep <name>', 'EU authorised representative')
  .option('--coordinator <csirt>', 'Coordinator CSIRT / competent authority')
  .option('--responsible <name>', 'Add a responsible person')
  .option('--role <role>', 'Role of the responsible person')
  .option('--filing-authority', 'The responsible person has filing authority')
  .option('--ooo <contact>', 'Out-of-hours contact for the responsible person')
  .action(async (opts) => {
    const rootDir = root(opts);
    resolveRegime(opts.regime); // validate
    const org = await loadOrg(rootDir);
    org.defaultRegime = opts.regime;
    if (opts.legalEntity) org.legalEntity = opts.legalEntity;
    if (opts.establishment) org.mainEstablishment = opts.establishment;
    if (opts.euRep) org.euAuthorisedRepresentative = opts.euRep;
    if (opts.coordinator) org.coordinatorCsirt = opts.coordinator;
    if (opts.responsible) {
      const existing = org.responsiblePersons.find((p) => p.name === opts.responsible);
      const person: ResponsiblePerson = existing ?? { name: opts.responsible, filingAuthority: false };
      person.role = opts.role ?? person.role;
      if (opts.filingAuthority) person.filingAuthority = true;
      if (opts.ooo) person.outOfHoursContact = opts.ooo;
      if (!existing) org.responsiblePersons.push(person);
    }
    await saveOrg(rootDir, org);
    console.log(chalk.green('✔') + ` evidence org saved (default regime: ${org.defaultRegime})`);
  });

// ── regimes ──
const regimesCmd = new Command('regimes').description('List available reporting regimes').action(() => {
  console.log(formatRegimeList());
});

// ── product ──
const productAdd = new Command('add')
  .description('Register a product with digital elements (PDE)')
  .argument('<name>', 'Product name')
  .option(...cwdOption)
  .option('--regime <id>', 'Regime whose classification vocabulary applies')
  .option('--classification <id>', 'Regime classification id (see `vg evidence regimes`)', 'default')
  .option('--markets <cc,cc>', 'Member states / markets, comma-separated')
  .option('--bind <ref>', 'Bind to a repo/image/registry (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option('--in-scope', 'Record an in-scope determination')
  .option('--out-of-scope', 'Record an out-of-scope determination')
  .option('--rationale <text>', 'Scope determination rationale')
  .option('--until <date>', 'Declared support period end (YYYY-MM-DD)')
  .action(async (name: string, opts) => {
    const rootDir = root(opts);
    const regime = resolveRegime(opts.regime ?? (await loadOrg(rootDir)).defaultRegime);
    if (opts.classification !== 'default' && regime.classifications.length && !regime.classifications.some((c) => c.id === opts.classification)) {
      throw new CliError(`classification "${opts.classification}" is not valid for regime ${regime.id} — options: ${regime.classifications.map((c) => c.id).join(', ')}`, ExitCode.USAGE_ERROR);
    }
    const products = await loadProducts(rootDir);
    const id = slug(name);
    if (products.some((p) => p.id === id)) throw new CliError(`product "${id}" already exists`, ExitCode.USAGE_ERROR);
    const product: Product = {
      id,
      name,
      classification: opts.classification,
      memberStates: csv(opts.markets),
      bindings: opts.bind,
      supportPeriod: opts.until ? { declaredUntil: opts.until } : undefined,
      scopeDetermination:
        opts.inScope || opts.outOfScope ? { inScope: Boolean(opts.inScope), rationale: opts.rationale, determinedAt: today() } : undefined,
      createdAt: nowIso(),
    };
    products.push(product);
    await saveProducts(rootDir, products);
    console.log(chalk.green('✔') + ` product ${chalk.bold(id)} registered (${regime.name})`);
  });

const productList = new Command('list').description('List registered products').option(...cwdOption).action(async (opts) => {
  const products = await loadProducts(root(opts));
  if (!products.length) return console.log(chalk.dim('no products registered — vg evidence product add <name>'));
  for (const p of products) {
    console.log(`  ${chalk.bold(p.id)}  ${p.name}  ${chalk.dim(`[${p.classification}]`)}  ${chalk.dim(p.memberStates.join(' ') || 'no markets')}`);
  }
});

const productShow = new Command('show').description('Show a product and its frozen releases').argument('<id>').option(...cwdOption).action(async (id: string, opts) => {
  const rootDir = root(opts);
  const product = await getProduct(rootDir, id);
  if (!product) throw new CliError(`no such product: ${id}`, ExitCode.NOT_FOUND);
  const releases = await loadReleases(rootDir, product.id);
  console.log(JSON.stringify({ product, releases: releases.map((r) => ({ version: r.version, shipDate: r.shipDate, components: r.components.length })) }, null, 2));
});

const productCmd = new Command('product').description('Register and inspect products with digital elements').addCommand(productAdd).addCommand(productList).addCommand(productShow);

// ── release ──
const releaseCmd = new Command('release')
  .description('Freeze a shipped release into an immutable component manifest')
  .argument('<product>', 'Product id')
  .argument('<version>', 'Shipped version')
  .option(...cwdOption)
  .option('--from <file>', 'Scan artifact or SBOM captured at release', '.vibgrate/scan_result.json')
  .option('--ship-date <date>', 'Ship date (YYYY-MM-DD)')
  .option('--build-id <id>', 'Build id')
  .option('--digest <sha256>', 'Artefact digest')
  .option('--markets <cc,cc>', 'Distribution markets/channels, comma-separated')
  .action(async (productId: string, version: string, opts) => {
    const rootDir = root(opts);
    const product = await getProduct(rootDir, productId);
    if (!product) throw new CliError(`no such product: ${productId} — register it with \`vg evidence product add\``, ExitCode.NOT_FOUND);
    const release = await buildRelease({
      productId: product.id,
      version,
      from: path.resolve(rootDir, opts.from),
      shipDate: opts.shipDate,
      buildId: opts.buildId,
      artefactDigest: opts.digest,
      distribution: csv(opts.markets),
      frozenAt: nowIso(),
    });
    const p = await freezeRelease(rootDir, release);
    console.log(chalk.green('✔') + ` froze ${chalk.bold(`${product.id}@${version}`)} — ${release.components.length} components, immutable at ${path.relative(rootDir, p)}`);
  });

// ── shared: gather exposure inputs ──
async function runExposure(rootDir: string, vuln: string, opts: Record<string, unknown>): Promise<{ result: ExposureResult; regime: Regime; releases: Release[]; advisory: Awaited<ReturnType<typeof resolveAdvisory>> }> {
  const org = await loadOrg(rootDir);
  const regime = resolveRegime((opts.regime as string) ?? org.defaultRegime);
  const products = await loadProducts(rootDir);
  const advisory = await resolveAdvisory(vuln, { advisoryFile: opts.advisory as string | undefined, offline: Boolean(opts.offline) });
  const releasesByProduct = await releasesByProductMap(rootDir, products);
  const filter = opts.products ? (p: Product) => p.id.includes(opts.products as string) || p.name.toLowerCase().includes((opts.products as string).toLowerCase()) : undefined;
  const asOf = (opts.asOf as string) ?? today();
  const generatedAt = (opts.generatedAt as string) ?? nowIso();
  const result = computeExposure({
    regime,
    advisory,
    products,
    releasesByProduct,
    org,
    asOf,
    dataPackVersion: (opts.dataPackVersion as string) ?? 'none',
    generatedAt,
    productFilter: filter,
    includeEol: Boolean(opts.includeEol),
  });
  const consulted: Release[] = [];
  for (const list of releasesByProduct.values()) consulted.push(...list);
  return { result, regime, releases: consulted, advisory };
}

function exposureExit(status: ExposureResult['overallStatus']): number {
  if (status === 'affected') return ExitCode.GATE_FAILED; // 2 — fail the build
  if (status === 'undetermined') return ExitCode.NOT_FOUND; // 3 — manual review
  return ExitCode.OK; // 0
}

// ── exposure ──
const exposureCmd = new Command('exposure')
  .description('Which shipped products contain this vulnerability — with signed evidence')
  .argument('<vuln>', 'Vulnerability id (CVE / GHSA / OSV / EUVD)')
  .option(...cwdOption)
  .option('--regime <id>', 'Reporting regime')
  .option('--advisory <file>', 'Advisory file (OSV or Vibgrate-shaped) instead of fetching')
  .option('--offline', 'No network; requires --advisory')
  .option('--as-of <date>', 'Determine as of this date (drives support status)')
  .option('--products <substr>', 'Restrict to products matching this substring')
  .option('--include-eol', 'Include releases whose support period has expired')
  .option('--format <fmt>', 'Output format (table|json)', 'table')
  .option('--generated-at <iso>', 'Override the recorded timestamp (reproducibility)')
  .option('--data-pack-version <v>', 'Record the data pack version used')
  .option('--pack', 'Also print the submission pack')
  .option('--stage <stage>', 'Pack stage (regime-specific)')
  .option('--bundle <dir>', 'Write a signed evidence bundle to this directory')
  .option('--no-sign', 'Do not sign the evidence bundle')
  .option('--tsa <url>', 'RFC 3161 Time-Stamping Authority URL to timestamp the result')
  .option('--pub <file>', 'Trust root to pin the signer when re-verifying')
  .action(async (vuln: string, opts) => {
    const rootDir = root(opts);
    const { result, regime, releases, advisory } = await runExposure(rootDir, vuln, opts);

    let timestampToken: Buffer | undefined;
    if (opts.tsa) {
      const digest = Buffer.from(exposureSubjectDigest(result), 'hex');
      timestampToken = await requestTimestamp(opts.tsa as string, digest);
      result.meta.timestamp = { source: 'rfc3161', value: parseTimestampToken(timestampToken).genTime };
    }

    if (opts.format === 'json') {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatExposure(result, regime));
    }

    if (opts.pack) {
      const org = await loadOrg(rootDir);
      const stage = (opts.stage as string) ?? regime.clocks[0]?.stage ?? 'early-warning';
      console.log('\n' + buildPack(result, regime, org, stage));
    }

    if (opts.bundle) {
      const dir = path.resolve(rootDir, opts.bundle as string, `evidence-${result.meta.evidenceId}`);
      let envelope: DsseEnvelope | undefined;
      if (opts.sign !== false) {
        const { key, minted } = resolveSigningKey(rootDir);
        if (minted) console.error(chalk.yellow('minted a new Ed25519 signing key at .vibgrate/attest-key.pem — keep it and gitignore it to re-sign reproducibly'));
        envelope = signEvidenceStatement(buildEvidenceStatement(result, VERSION), key);
      }
      writeBundle({ outDir: dir, result, advisory, releases, regime, envelope, timestampToken, cliVersion: VERSION });
      console.error(chalk.green('✔') + ` evidence bundle written to ${path.relative(rootDir, dir)}${envelope ? ' (signed)' : ' (unsigned)'}${timestampToken ? ' · RFC 3161' : ''}`);
    }

    process.exitCode = exposureExit(result.overallStatus);
  });

// ── readiness ──
const readinessCmd = new Command('readiness')
  .description('Deterministic gap report against the regime obligations')
  .option(...cwdOption)
  .option('--regime <id>', 'Reporting regime')
  .option('--format <fmt>', 'Output format (table|json)', 'table')
  .action(async (opts) => {
    const rootDir = root(opts);
    const org = await loadOrg(rootDir);
    const regime = resolveRegime((opts.regime as string) ?? org.defaultRegime);
    const products = await loadProducts(rootDir);
    const releasesByProduct = await releasesByProductMap(rootDir, products);
    const recentDrill = await hasRecentDrill(rootDir, today());
    const report = computeReadiness({ regime, org, products, releasesByProduct, recentDrill });
    console.log(opts.format === 'json' ? JSON.stringify(report, null, 2) : formatReadiness(report, regime));
  });

// ── support-period ──
const supportCmd = new Command('support-period')
  .description('Declare or show a product support period')
  .argument('<product>', 'Product id')
  .option(...cwdOption)
  .option('--from <date>', 'Declared support start (YYYY-MM-DD)')
  .option('--until <date>', 'Declared support end (YYYY-MM-DD)')
  .action(async (productId: string, opts) => {
    const rootDir = root(opts);
    const products = await loadProducts(rootDir);
    const product = products.find((p) => p.id === productId || p.name === productId);
    if (!product) throw new CliError(`no such product: ${productId}`, ExitCode.NOT_FOUND);
    if (opts.from || opts.until) {
      product.supportPeriod = { declaredFrom: opts.from ?? product.supportPeriod?.declaredFrom, declaredUntil: opts.until ?? product.supportPeriod?.declaredUntil };
      await saveProducts(rootDir, products);
    }
    console.log(`  ${chalk.bold(product.id)} support period: ${product.supportPeriod?.declaredFrom ?? '—'} → ${chalk.bold(product.supportPeriod?.declaredUntil ?? 'not declared')}`);
  });

// ── pack ──
const packCmd = new Command('pack')
  .description('Build the submission pack a human pastes into the reporting platform')
  .argument('<vuln>', 'Vulnerability id')
  .option(...cwdOption)
  .option('--regime <id>', 'Reporting regime')
  .option('--stage <stage>', 'Reporting stage')
  .option('--advisory <file>', 'Advisory file (OSV or Vibgrate-shaped)')
  .option('--offline', 'No network; requires --advisory')
  .option('--out <file>', 'Write the pack to this file')
  .action(async (vuln: string, opts) => {
    const rootDir = root(opts);
    const { result, regime } = await runExposure(rootDir, vuln, opts);
    const org = await loadOrg(rootDir);
    const stage = (opts.stage as string) ?? regime.clocks[0]?.stage ?? 'early-warning';
    const md = buildPack(result, regime, org, stage);
    if (opts.out) {
      fs.writeFileSync(path.resolve(rootDir, opts.out as string), md);
      console.error(chalk.green('✔') + ` pack written to ${opts.out}`);
    } else {
      console.log(md);
    }
    process.exitCode = exposureExit(result.overallStatus);
  });

// ── drill ──
const drillCmd = new Command('drill')
  .description('Timed dry-run of the determination step against a simulated advisory')
  .option(...cwdOption)
  .option('--regime <id>', 'Reporting regime')
  .option('--scenario <name>', 'Scenario seed (deterministic pick)', 'kev-recent')
  .option('--elapsed <seconds>', 'Record the wall-clock your team actually took')
  .option('--format <fmt>', 'Output format (table|json)', 'table')
  .action(async (opts) => {
    const rootDir = root(opts);
    const org = await loadOrg(rootDir);
    const regime = resolveRegime((opts.regime as string) ?? org.defaultRegime);
    const products = await loadProducts(rootDir);
    const releasesByProduct = await releasesByProductMap(rootDir, products);
    const allReleases: Release[] = [];
    for (const list of releasesByProduct.values()) allReleases.push(...list);
    const advisory = synthesizeAdvisory(allReleases, opts.scenario as string);
    if (!advisory) throw new CliError('no frozen releases to drill against — register a product and freeze a release first', ExitCode.NOT_FOUND);
    const result = computeExposure({ regime, advisory, products, releasesByProduct, org, asOf: today(), dataPackVersion: 'drill', generatedAt: nowIso() });
    const gaps = undeterminedFields(result, regime);
    const drillId = `drill_${result.meta.evidenceId}`;
    await recordDrill(rootDir, {
      drillId,
      regime: regime.id,
      scenario: opts.scenario as string,
      simAdvisoryId: advisory.id,
      overallStatus: result.overallStatus,
      undeterminedFields: gaps,
      ranAt: nowIso(),
      elapsedSeconds: opts.elapsed ? Number(opts.elapsed) : undefined,
    });
    if (opts.format === 'json') {
      console.log(JSON.stringify({ drillId, scenario: opts.scenario, advisory: advisory.id, overallStatus: result.overallStatus, undeterminedFields: gaps }, null, 2));
    } else {
      console.log('  ' + chalk.bold(`DRILL ${drillId}`) + `   scenario: ${opts.scenario}`);
      console.log('  ' + chalk.dim('simulated advisory') + `  ${advisory.id}  ` + chalk.dim('(NOT a real vulnerability)'));
      console.log('  ' + chalk.dim('determination') + `      ${result.overallStatus === 'affected' ? chalk.red('exposure found') : result.overallStatus === 'undetermined' ? chalk.yellow('undetermined') : chalk.green('not affected')}`);
      console.log('  ' + chalk.dim('would block a filing') + `  ${gaps.length ? chalk.yellow(gaps.join(', ')) : chalk.green('nothing — all required fields present')}`);
      if (opts.elapsed) console.log('  ' + chalk.dim('team elapsed') + `        ${opts.elapsed}s`);
      console.log('\n  ' + chalk.dim(regime.disclaimer));
    }
  });

// ── verify ──
const verifyCmd = new Command('verify')
  .description('Verify an evidence bundle offline (no Vibgrate needed)')
  .argument('<bundle>', 'Path to an evidence bundle directory or evidence.intoto.jsonl')
  .option('--pub <file>', 'Public key PEM to pin the signer (establish trust)')
  .action((bundlePath: string, opts) => {
    const abs = path.resolve(bundlePath);
    const envPath = fs.statSync(abs).isDirectory() ? path.join(abs, 'evidence.intoto.jsonl') : abs;
    if (!fs.existsSync(envPath)) throw new CliError(`no evidence.intoto.jsonl at ${bundlePath}`, ExitCode.NOT_FOUND);
    const envelope = JSON.parse(fs.readFileSync(envPath, 'utf8').trim().split('\n')[0]) as DsseEnvelope;
    const resultPath = path.join(path.dirname(envPath), 'result.json');
    const result = fs.existsSync(resultPath) ? (JSON.parse(fs.readFileSync(resultPath, 'utf8')) as ExposureResult) : undefined;
    const publicKeyPem = opts.pub ? fs.readFileSync(path.resolve(opts.pub as string), 'utf8') : undefined;
    const v = verifyEvidenceEnvelope(envelope, { publicKeyPem, result });
    const color = v.status === 'verified' ? chalk.green : v.status === 'failed' ? chalk.red : chalk.yellow;
    console.log('  ' + color(v.status.toUpperCase()) + `  ${v.reason}`);
    if (v.evidenceId) console.log('  ' + chalk.dim(`evidence ${v.evidenceId} · regime ${v.regime} · advisory ${v.advisoryId} · ${v.overallStatus}`));

    // RFC 3161 timestamp, when the bundle carries one.
    const tsrPath = path.join(path.dirname(envPath), 'timestamp.tsr');
    if (fs.existsSync(tsrPath) && result) {
      const t = verifyTimestamp(fs.readFileSync(tsrPath), exposureSubjectDigest(result));
      const tcolor = t.imprintMatches ? chalk.green : chalk.red;
      console.log('  ' + tcolor('TIMESTAMP') + `  ${t.reason}`);
    }

    process.exitCode = v.status === 'verified' ? ExitCode.OK : v.status === 'unverified' ? ExitCode.GATE_FAILED : ExitCode.ERROR;
  });

// ── watch ──
const watchCmd = new Command('watch')
  .description('Check CISA KEV for new exposure against your shipped components (surfaces the listing; does not decide "actively exploited")')
  .option(...cwdOption)
  .option('--regime <id>', 'Reporting regime')
  .option('--since <date>', 'Only KEV entries added on/after this date (YYYY-MM-DD)')
  .option('--webhook <url>', 'POST the alert payload to this URL when there are hits')
  .option('--format <fmt>', 'Output format (table|json)', 'table')
  .action(async (opts) => {
    const rootDir = root(opts);
    const org = await loadOrg(rootDir);
    const regime = resolveRegime((opts.regime as string) ?? org.defaultRegime);
    const products = await loadProducts(rootDir);
    const releasesByProduct = await releasesByProductMap(rootDir, products);

    const compMap = new Map<string, FrozenComponent>();
    for (const list of releasesByProduct.values()) for (const rel of list) for (const c of rel.components) compMap.set(`${c.ecosystem ?? ''}|${c.name}|${c.version}`, c);
    const components = [...compMap.values()];
    if (components.length === 0) throw new CliError('no frozen releases to watch — freeze a release first with `vg evidence release`', ExitCode.NOT_FOUND);

    console.error(chalk.dim(`Checking CISA KEV against ${components.length} shipped component(s)…`));
    const kev = await fetchKevCatalog();
    let advisories = await kevAdvisoriesForComponents(kev, components);
    if (opts.since) advisories = advisories.filter((a) => (a.kevListedAt ?? '') >= (opts.since as string));

    const hits = advisories
      .map((advisory) => ({ advisory, result: computeExposure({ regime, advisory, products, releasesByProduct, org, asOf: today(), dataPackVersion: 'kev-watch', generatedAt: nowIso() }) }))
      .filter((h) => h.result.overallStatus !== 'not-affected');

    if (opts.format === 'json') {
      console.log(JSON.stringify({
        checked_components: components.length,
        kev_listed_advisories: advisories.length,
        hits: hits.map((h) => ({ advisory: h.advisory.id, kev_listed_at: h.advisory.kevListedAt, status: h.result.overallStatus, products: h.result.products.filter((p) => p.status !== 'not-affected').map((p) => ({ product: p.productName, status: p.status, versions: p.affectedVersions })) })),
      }, null, 2));
    } else if (hits.length === 0) {
      console.log('  ' + chalk.green('NO NEW EXPOSURE') + ` — ${advisories.length} KEV-listed advisory(ies) touch your components, none affect a shipped release`);
    } else {
      console.log('  ' + chalk.red(`${hits.length} KEV-listed exposure(s)`) + ` against shipped products:`);
      console.log('');
      for (const h of hits) {
        const affected = h.result.products.filter((p) => p.status === 'affected');
        const undet = h.result.products.filter((p) => p.status === 'undetermined');
        console.log('  ' + chalk.bold(h.advisory.id) + chalk.dim(` · KEV-listed ${h.advisory.kevListedAt ?? '?'}`));
        for (const p of affected) console.log('    ' + chalk.red('affected') + `  ${p.productName} @ ${p.affectedVersions.join(', ')} · ${p.memberStates.join(' ')}`);
        for (const p of undet) console.log('    ' + chalk.yellow('undetermined') + `  ${p.productName} — ${p.reason}`);
        console.log('    ' + chalk.dim(`→ vg evidence exposure ${h.advisory.id} --regime ${regime.id} --pack --stage=${regime.clocks[0]?.stage ?? 'early-warning'}`));
      }
    }

    if (opts.webhook && hits.length > 0) {
      try {
        await fetch(opts.webhook as string, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'vg evidence watch', regime: regime.id, hits: hits.map((h) => ({ advisory: h.advisory.id, status: h.result.overallStatus, evidenceId: h.result.meta.evidenceId })) }),
          signal: AbortSignal.timeout(15000),
        });
        console.error(chalk.dim(`  posted ${hits.length} hit(s) to the webhook`));
      } catch (e) {
        console.error(chalk.yellow(`  webhook post failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    }

    console.log('');
    console.log('  ' + chalk.dim('watch surfaces the CISA KEV listing. Whether a vulnerability is "actively exploited" for a filing is your determination, not ours.'));
    process.exitCode = hits.some((h) => h.result.overallStatus === 'affected') ? ExitCode.GATE_FAILED : hits.some((h) => h.result.overallStatus === 'undetermined') ? ExitCode.NOT_FOUND : ExitCode.OK;
  });

// ── export ──
const exportCmd = new Command('export')
  .description('Air-gap bundle of all evidence state (org, products, frozen releases, readiness)')
  .option(...cwdOption)
  .option('--out <dir>', 'Output directory', 'evidence-export')
  .option('--regime <id>', 'Reporting regime for the readiness snapshot')
  .action(async (opts) => {
    const rootDir = root(opts);
    const org = await loadOrg(rootDir);
    const regime = resolveRegime((opts.regime as string) ?? org.defaultRegime);
    const products = await loadProducts(rootDir);
    const releasesByProduct = await releasesByProductMap(rootDir, products);
    const releases: Release[] = [];
    for (const list of releasesByProduct.values()) releases.push(...list);
    const report = computeReadiness({ regime, org, products, releasesByProduct, recentDrill: await hasRecentDrill(rootDir, today()) });
    const dir = path.resolve(rootDir, opts.out as string);
    await writeJsonFile(path.join(dir, 'org.json'), org);
    await writeJsonFile(path.join(dir, 'products.json'), products);
    for (const r of releases) await writeJsonFile(path.join(dir, 'releases', `${r.productId}@${r.version}.json`.replace(/[^A-Za-z0-9._@-]/g, '_')), r);
    await writeJsonFile(path.join(dir, 'readiness.json'), report);
    console.error(chalk.green('✔') + ` exported evidence state to ${path.relative(rootDir, dir)} (${products.length} products, ${releases.length} frozen releases)`);
  });

// ── push ──
const pushCmd = new Command('push')
  .description('Push the product registry (and an optional exposure result) to Vibgrate Cloud')
  .option(...cwdOption)
  .option('--dsn <dsn>', 'DSN token (or use VIBGRATE_DSN env / `vg login`)')
  .option('--regime <id>', 'Reporting regime')
  .option('--result <file>', 'An exposure result.json (or a bundle dir) to include')
  .option('--signed', 'Mark the included exposure result as signed')
  .option('--strict', 'Fail on push errors')
  .action(async (opts) => {
    const rootDir = root(opts);
    const dsn = resolveDsn(opts.dsn as string | undefined);
    if (!dsn) throw new CliError('no DSN — run `vg login`, set VIBGRATE_DSN, or pass --dsn', ExitCode.USAGE_ERROR);
    const parsed = parseDsn(dsn);
    if (!parsed) throw new CliError('invalid DSN format (expected vibgrate+https://<key>:<secret>@<host>/<workspace>)', ExitCode.USAGE_ERROR);

    const org = await loadOrg(rootDir);
    const regime = resolveRegime((opts.regime as string) ?? org.defaultRegime);
    const products = await loadProducts(rootDir);
    const releasesByProduct = await releasesByProductMap(rootDir, products);

    const productPayload = products.map((p) => ({
      id: p.id,
      name: p.name,
      classification: p.classification,
      inScope: p.scopeDetermination?.inScope,
      scopeRecorded: Boolean(p.scopeDetermination),
      memberStates: p.memberStates,
      supportDeclared: Boolean(p.supportPeriod?.declaredUntil),
      supportUntil: p.supportPeriod?.declaredUntil,
      bound: p.bindings.length > 0,
      frozenReleaseCount: (releasesByProduct.get(p.id) ?? []).length,
    }));

    let exposure: ExposureResult | undefined;
    if (opts.result) {
      const raw = path.resolve(rootDir, opts.result as string);
      const resultPath = fs.existsSync(raw) && fs.statSync(raw).isDirectory() ? path.join(raw, 'result.json') : raw;
      if (!fs.existsSync(resultPath)) throw new CliError(`no result.json at ${opts.result}`, ExitCode.NOT_FOUND);
      exposure = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as ExposureResult;
    }

    const payload = { schemaVersion: 'evidence-push-1', regime: regime.id, generatedAt: nowIso(), signed: Boolean(opts.signed), products: productPayload, exposure };
    const body = JSON.stringify(payload);
    const url = `${parsed.scheme}://${parsed.host}/v1/ingest/evidence`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Vibgrate-Timestamp': String(Date.now()), Authorization: `VibgrateDSN ${parsed.keyId}:${parsed.secret}` },
        body,
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new CliError(`could not reach ${parsed.host}: ${e instanceof Error ? e.message : String(e)}`, ExitCode.ERROR);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (opts.strict) throw new CliError(`push failed (${res.status}): ${detail.slice(0, 200)}`, ExitCode.ERROR);
      console.error(chalk.yellow(`push failed (${res.status}) — ${detail.slice(0, 160)}`));
      return;
    }
    console.log(chalk.green('✔') + ` pushed ${products.length} product(s)${exposure ? ' + an exposure result' : ''} to Vibgrate Cloud`);
  });

export const evidenceCommand = new Command('evidence')
  .description('Vibgrate Evidence — signed, reproducible regulatory evidence (regime-neutral; CRA first)')
  .addCommand(initCmd)
  .addCommand(regimesCmd)
  .addCommand(productCmd)
  .addCommand(releaseCmd)
  .addCommand(exposureCmd)
  .addCommand(readinessCmd)
  .addCommand(supportCmd)
  .addCommand(packCmd)
  .addCommand(drillCmd)
  .addCommand(verifyCmd)
  .addCommand(watchCmd)
  .addCommand(pushCmd)
  .addCommand(exportCmd)
  .addHelpText('after', `\nEvidence, not compliance. ${listRegimes().length} regime(s) available — run \`vg evidence regimes\`.`);
