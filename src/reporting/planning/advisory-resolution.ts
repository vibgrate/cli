import * as fs from 'node:fs';
import * as path from 'node:path';
import * as semver from 'semver';
import { compareCodeUnits } from '../../core-open/utils/code-unit.js';
import { isVersionAffected } from '../../core-open/scanners/vulnerability-scanner.js';

/**
 * Offline advisory resolution for `vg fix --offline --package-manifest`.
 *
 * A plan may call an advisory resolved only when the version it actually
 * selects sits outside that advisory's affected range AND every constraint
 * that pins the package (a parent dependency range, a peer range, or the
 * allowed upgrade policy) permits that version. Otherwise the advisory stays
 * blocked, with the blocking package and range named, or is reported as
 * having no fix. Ordering is by package name, then advisory id.
 */

export type AdvisoryResolutionStatus = 'resolved' | 'blocked' | 'no-fix';

/** Which bumps a plan is allowed to take. `safe` is patch and minor only. */
export type UpgradePolicy = 'safe' | 'balanced' | 'aggressive';

export interface AdvisoryStatusEntry {
  id: string;
  package: string;
  ecosystem: string;
  severity: string;
  installedVersion: string;
  /** Set only when `status` is `resolved`. */
  plannedVersion: string | null;
  status: AdvisoryResolutionStatus;
  reason: string;
}

export interface AdvisoryPlanUpgrade {
  package: string;
  ecosystem: string;
  from: string;
  to: string;
}

export interface AdvisoryResolutionPlan {
  tier: UpgradePolicy;
  upgrades: AdvisoryPlanUpgrade[];
  advisories: AdvisoryStatusEntry[];
}

export interface AdvisoryResolutionReport {
  status: 'ok';
  offline: true;
  policy: UpgradePolicy;
  plans: AdvisoryResolutionPlan[];
}

export interface ExplicitUpgrade {
  package: string;
  to: string;
}

interface VersionRange {
  introduced?: string;
  fixed?: string;
}

interface ParsedAdvisory {
  id: string;
  severity: string;
  ranges: VersionRange[];
  versions: string[];
}

interface ManifestPackage {
  versions: string[];
  requires: Record<string, Record<string, string>>;
  peers: Record<string, Record<string, string>>;
  vulns: ParsedAdvisory[];
}

interface AdvisoryManifest {
  npm: Record<string, ManifestPackage>;
}

type ConstraintKind = 'dependency' | 'peer';

interface Constraint {
  package: string;
  version: string;
  range: string;
  kind: ConstraintKind;
}

interface InstalledPackage {
  name: string;
  version: string;
  direct: boolean;
  requiredBy: Constraint[];
}

interface OpenAdvisory {
  key: string;
  pkg: InstalledPackage;
  advisory: ParsedAdvisory;
  published: string[];
}

interface ProposedUpgrade {
  package: string;
  ecosystem: string;
  from: string;
  to: string;
}

interface Proposal {
  key: string;
  upgrades: ProposedUpgrade[];
}

const ECOSYSTEM = 'npm';
const SEVERITIES = new Set(['low', 'moderate', 'high', 'critical', 'unknown']);

function canon(version: string): string | null {
  const valid = semver.valid(version);
  if (valid) return valid;
  const coerced = semver.coerce(version);
  return coerced ? semver.valid(coerced) : null;
}

function satisfies(version: string, range: string): boolean {
  const parsed = canon(version);
  if (!parsed) return false;
  try {
    return semver.satisfies(parsed, range, { includePrerelease: true });
  } catch {
    return false;
  }
}

function policyAllows(from: string, to: string, policy: UpgradePolicy): boolean {
  const current = canon(from);
  const target = canon(to);
  if (!current || !target || !semver.gt(target, current)) return false;
  const delta = semver.major(target) - semver.major(current);
  if (policy === 'aggressive') return true;
  if (policy === 'balanced') return delta <= 1;
  return delta === 0;
}

/** Semver window the policy permits above `from`. Named in blocked reasons. */
function allowedUpgradeRange(from: string, policy: UpgradePolicy): string {
  const current = canon(from);
  if (!current) return '*';
  if (policy === 'aggressive') return `>=${current}`;
  const ceiling = semver.major(current) + (policy === 'balanced' ? 2 : 1);
  return `>=${current} <${ceiling}.0.0`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readRangeTable(value: unknown): Record<string, Record<string, string>> {
  if (!isPlainObject(value)) return {};
  const out: Record<string, Record<string, string>> = {};
  const versions = Object.keys(value).sort(compareCodeUnits);
  for (const version of versions) {
    const deps = value[version];
    if (!isPlainObject(deps)) continue;
    const ranges: Record<string, string> = {};
    for (const name of Object.keys(deps).sort(compareCodeUnits)) {
      const range = deps[name];
      if (typeof range === 'string' && range.trim()) ranges[name] = range.trim();
    }
    const key = canon(version) ?? version;
    out[key] = ranges;
  }
  return out;
}

function parseRanges(value: unknown): VersionRange[] {
  if (!Array.isArray(value)) return [];
  const ranges: VersionRange[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const range: VersionRange = {};
    if (typeof item.introduced === 'string' && item.introduced.trim()) range.introduced = item.introduced.trim();
    if (typeof item.fixed === 'string' && item.fixed.trim()) range.fixed = item.fixed.trim();
    if (range.introduced || range.fixed) ranges.push(range);
  }
  return ranges;
}

function parseAdvisories(value: unknown): ParsedAdvisory[] {
  if (!Array.isArray(value)) return [];
  const out: ParsedAdvisory[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    if (typeof item.id !== 'string' || !item.id.trim()) continue;
    if (typeof item.withdrawn === 'string' && item.withdrawn.trim()) continue;
    const severity = typeof item.severity === 'string' && SEVERITIES.has(item.severity) ? item.severity : 'unknown';
    const versions = Array.isArray(item.versions)
      ? item.versions.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim())
      : [];
    out.push({ id: item.id.trim(), severity, ranges: parseRanges(item.ranges), versions });
  }
  return out;
}

function parseManifest(manifest: unknown): AdvisoryManifest {
  const npm: Record<string, ManifestPackage> = {};
  if (!isPlainObject(manifest) || !isPlainObject(manifest.npm)) return { npm };
  for (const name of Object.keys(manifest.npm).sort(compareCodeUnits)) {
    const entry = manifest.npm[name];
    if (!isPlainObject(entry)) continue;
    const versions = Array.isArray(entry.versions)
      ? entry.versions.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim())
      : [];
    npm[name] = {
      versions,
      requires: readRangeTable(entry.requires),
      peers: readRangeTable(entry.peers),
      vulns: parseAdvisories(entry.vulns),
    };
  }
  return { npm };
}

function affected(version: string, advisory: ParsedAdvisory): boolean {
  return isVersionAffected(version, advisory.ranges, advisory.versions.length ? advisory.versions : undefined);
}

function affectedRangeLabel(advisory: ParsedAdvisory): string {
  if (advisory.ranges.length) {
    return advisory.ranges
      .map((range) => {
        const intro = range.introduced && range.introduced !== '0' ? `>=${range.introduced}` : '>=0.0.0';
        return range.fixed ? `${intro} <${range.fixed}` : intro;
      })
      .join(' || ');
  }
  if (advisory.versions.length) return advisory.versions.join(', ');
  return '*';
}

function hasFixBound(advisory: ParsedAdvisory): boolean {
  return advisory.ranges.some((range) => typeof range.fixed === 'string' && range.fixed.length > 0);
}

function publishedVersions(entry: ManifestPackage | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of entry?.versions ?? []) {
    const version = canon(raw);
    if (!version || seen.has(version)) continue;
    seen.add(version);
    out.push(version);
  }
  out.sort(semver.compare);
  return out;
}

/** True when nothing in the manifest or the advisory leaves the affected set. */
function noFixAvailable(advisory: ParsedAdvisory, published: string[], installed: string): boolean {
  if (hasFixBound(advisory)) return false;
  return !published.some((version) => semver.gt(version, installed) && !affected(version, advisory));
}

function lowestFixVersion(advisory: ParsedAdvisory, installed: string): string | null {
  const fixes: string[] = [];
  for (const range of advisory.ranges) {
    if (!range.fixed) continue;
    const version = canon(range.fixed);
    if (version && semver.gt(version, installed)) fixes.push(version);
  }
  fixes.sort(semver.compare);
  return fixes[0] ?? null;
}

function selectableFixes(published: string[], installed: string, advisory: ParsedAdvisory, policy: UpgradePolicy): string[] {
  return published.filter((version) => semver.gt(version, installed) && !affected(version, advisory) && policyAllows(installed, version, policy));
}

function lookupRange(table: Record<string, Record<string, string>> | undefined, version: string, dep: string): string | undefined {
  if (!table) return undefined;
  const key = canon(version) ?? version;
  return table[key]?.[dep];
}

function effectiveRange(req: Constraint, parentVersion: string, childName: string, manifest: AdvisoryManifest): string | undefined {
  const entry = manifest.npm[req.package];
  const table = req.kind === 'peer' ? entry?.peers : entry?.requires;
  const declared = lookupRange(table, parentVersion, childName);
  if (declared) return declared;
  if (parentVersion === req.version) return req.range;
  return undefined;
}

function blockingConstraints(
  pkg: InstalledPackage,
  target: string,
  upgrades: Map<string, string>,
  manifest: AdvisoryManifest,
): Constraint[] {
  const blockers: Constraint[] = [];
  for (const req of pkg.requiredBy) {
    const parentVersion = upgrades.get(req.package) ?? req.version;
    const range = effectiveRange(req, parentVersion, pkg.name, manifest);
    if (!range || !satisfies(target, range)) {
      blockers.push({
        package: req.package,
        version: parentVersion,
        range: range ?? (parentVersion === req.version ? req.range : 'unknown'),
        kind: req.kind,
      });
    }
  }
  return blockers;
}

function formatBlockers(blockers: Constraint[], child: string): string {
  return [...blockers]
    .sort(
      (a, b) =>
        compareCodeUnits(a.package, b.package) ||
        compareCodeUnits(a.version, b.version) ||
        compareCodeUnits(a.range, b.range) ||
        compareCodeUnits(a.kind, b.kind),
    )
    .map((blocker) => `blocked by ${blocker.package}@${blocker.version} (${child}@${blocker.range})`)
    .join('; ');
}

function policyBlockReason(pkg: InstalledPackage, advisory: ParsedAdvisory, policy: UpgradePolicy): string {
  const fix = lowestFixVersion(advisory, pkg.version) ?? 'unknown';
  return `blocked by upgrade policy (${allowedUpgradeRange(pkg.version, policy)}); ${pkg.name} fix requires ${fix}`;
}

function canMoveParent(parent: InstalledPackage, to: string, manifest: AdvisoryManifest): boolean {
  if (parent.direct) return true;
  for (const req of parent.requiredBy) {
    const range = effectiveRange(req, req.version, parent.name, manifest);
    if (!range || !satisfies(to, range)) return false;
  }
  return true;
}

function findInstalled(installed: InstalledPackage[], name: string, version: string): InstalledPackage | undefined {
  return installed.find((pkg) => pkg.name === name && pkg.version === version);
}

function parentBump(
  req: Constraint,
  childName: string,
  childVersion: string,
  policy: UpgradePolicy,
  manifest: AdvisoryManifest,
  installed: InstalledPackage[],
): string | null {
  const parent = findInstalled(installed, req.package, req.version);
  if (!parent) return null;
  const entry = manifest.npm[parent.name];
  for (const version of publishedVersions(entry)) {
    if (!policyAllows(parent.version, version, policy)) continue;
    if (!canMoveParent(parent, version, manifest)) continue;
    const table = req.kind === 'peer' ? entry?.peers : entry?.requires;
    const range = lookupRange(table, version, childName);
    if (range && satisfies(childVersion, range)) return version;
  }
  return null;
}

function upgrade(packageName: string, from: string, to: string): ProposedUpgrade {
  return { package: packageName, ecosystem: ECOSYSTEM, from, to };
}

function propose(open: OpenAdvisory, policy: UpgradePolicy, manifest: AdvisoryManifest, installed: InstalledPackage[]): Proposal | null {
  const { pkg, advisory, published } = open;
  for (const fix of selectableFixes(published, pkg.version, advisory, policy)) {
    const installedBlockers = blockingConstraints(pkg, fix, new Map(), manifest);
    if (installedBlockers.length === 0) {
      return { key: open.key, upgrades: [upgrade(pkg.name, pkg.version, fix)] };
    }
    const bumps: ProposedUpgrade[] = [];
    let ok = true;
    for (const blocker of installedBlockers) {
      const next = parentBump(blocker, pkg.name, fix, policy, manifest, installed);
      const parent = findInstalled(installed, blocker.package, blocker.version);
      if (!next || !parent) {
        ok = false;
        break;
      }
      bumps.push(upgrade(parent.name, parent.version, next));
    }
    if (!ok) continue;
    const map = new Map<string, string>([[pkg.name, fix]]);
    for (const bump of bumps) {
      const prev = map.get(bump.package);
      if (!prev || semver.gt(bump.to, prev)) map.set(bump.package, bump.to);
    }
    if (blockingConstraints(pkg, fix, map, manifest).length === 0) {
      const byPackage = new Map<string, ProposedUpgrade>();
      for (const bump of bumps) {
        const prev = byPackage.get(bump.package);
        if (!prev || semver.gt(bump.to, prev.to)) byPackage.set(bump.package, bump);
      }
      byPackage.set(pkg.name, upgrade(pkg.name, pkg.version, fix));
      const upgrades = [...byPackage.values()].sort((a, b) => compareCodeUnits(a.package, b.package));
      return { key: open.key, upgrades };
    }
  }
  return null;
}

function judgeOne(open: OpenAdvisory, policy: UpgradePolicy, manifest: AdvisoryManifest, upgrades: Map<string, string>): AdvisoryStatusEntry {
  const { pkg, advisory } = open;
  const planned = upgrades.get(pkg.name) ?? null;
  const base = {
    id: advisory.id,
    package: pkg.name,
    ecosystem: ECOSYSTEM,
    severity: advisory.severity,
    installedVersion: pkg.version,
  };

  if (noFixAvailable(advisory, open.published, pkg.version)) {
    return { ...base, plannedVersion: null, status: 'no-fix', reason: 'no fix available' };
  }

  if (
    planned &&
    !affected(planned, advisory) &&
    policyAllows(pkg.version, planned, policy) &&
    blockingConstraints(pkg, planned, upgrades, manifest).length === 0
  ) {
    return { ...base, plannedVersion: planned, status: 'resolved', reason: `resolved by ${pkg.name}@${planned}` };
  }

  if (planned && affected(planned, advisory)) {
    return {
      ...base,
      plannedVersion: null,
      status: 'blocked',
      reason: `blocked by ${pkg.name} affected range (${affectedRangeLabel(advisory)})`,
    };
  }

  const inPolicy = selectableFixes(open.published, pkg.version, advisory, policy);
  if (inPolicy.length === 0) {
    return { ...base, plannedVersion: null, status: 'blocked', reason: policyBlockReason(pkg, advisory, policy) };
  }

  const target = inPolicy[0];
  const blockers = blockingConstraints(pkg, target, upgrades, manifest);
  if (blockers.length > 0) {
    return { ...base, plannedVersion: null, status: 'blocked', reason: formatBlockers(blockers, pkg.name) };
  }

  return {
    ...base,
    plannedVersion: null,
    status: 'blocked',
    reason: `blocked by ${pkg.name}@${pkg.version} (${allowedUpgradeRange(pkg.version, policy)}); ${pkg.name} fix requires ${target}`,
  };
}

function mergeProposals(proposals: Proposal[]): Map<string, ProposedUpgrade> {
  const merged = new Map<string, ProposedUpgrade>();
  const ordered = [...proposals].sort((a, b) => compareCodeUnits(a.key, b.key));
  for (const proposal of ordered) {
    for (const item of proposal.upgrades) {
      const prev = merged.get(item.package);
      if (!prev || semver.gt(item.to, prev.to)) merged.set(item.package, item);
    }
  }
  return merged;
}

function toUpgradeMap(merged: Map<string, ProposedUpgrade>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, item] of merged) map.set(name, item.to);
  return map;
}

function listUpgrades(merged: Map<string, ProposedUpgrade>): AdvisoryPlanUpgrade[] {
  return [...merged.values()]
    .map((item) => ({ package: item.package, ecosystem: item.ecosystem, from: item.from, to: item.to }))
    .sort((a, b) => compareCodeUnits(a.package, b.package) || compareCodeUnits(a.from, b.from) || compareCodeUnits(a.to, b.to));
}

function sortAdvisories(entries: AdvisoryStatusEntry[]): AdvisoryStatusEntry[] {
  return [...entries].sort(
    (a, b) =>
      compareCodeUnits(a.package, b.package) ||
      compareCodeUnits(a.id, b.id) ||
      compareCodeUnits(a.installedVersion, b.installedVersion),
  );
}

function sameKeys(a: Proposal[], b: Proposal[]): boolean {
  const left = a.map((item) => item.key).sort(compareCodeUnits);
  const right = b.map((item) => item.key).sort(compareCodeUnits);
  return left.length === right.length && left.every((key, i) => key === right[i]);
}

function collectOpen(installed: InstalledPackage[], manifest: AdvisoryManifest): OpenAdvisory[] {
  const open: OpenAdvisory[] = [];
  for (const pkg of installed) {
    const entry = manifest.npm[pkg.name];
    if (!entry) continue;
    const published = publishedVersions(entry);
    for (const advisory of entry.vulns) {
      if (!affected(pkg.version, advisory)) continue;
      open.push({
        key: `${pkg.name}\0${pkg.version}\0${advisory.id}`,
        pkg,
        advisory,
        published,
      });
    }
  }
  open.sort((a, b) => compareCodeUnits(a.key, b.key));
  return open;
}

function buildPlan(
  open: OpenAdvisory[],
  policy: UpgradePolicy,
  manifest: AdvisoryManifest,
  installed: InstalledPackage[],
  explicit: Map<string, string> | null,
): AdvisoryResolutionPlan {
  if (explicit) {
    const advisories = sortAdvisories(open.map((item) => judgeOne(item, policy, manifest, explicit)));
    return { tier: policy, upgrades: upgradesFromExplicit(explicit, installed), advisories };
  }

  const proposals = new Map<string, Proposal>();
  for (const item of open) {
    const proposal = propose(item, policy, manifest, installed);
    if (proposal) proposals.set(item.key, proposal);
  }

  let active = [...proposals.values()];
  let merged = mergeProposals(active);
  let judged = open.map((item) => judgeOne(item, policy, manifest, toUpgradeMap(merged)));
  for (let pass = 0; pass < open.length + 1; pass++) {
    const resolvedKeys = new Set(judged.filter((entry) => entry.status === 'resolved').map((entry) => `${entry.package}\0${entry.installedVersion}\0${entry.id}`));
    const next = active.filter((proposal) => resolvedKeys.has(proposal.key));
    const nextMerged = mergeProposals(next);
    const nextJudged = open.map((item) => judgeOne(item, policy, manifest, toUpgradeMap(nextMerged)));
    const prevList = listUpgrades(merged);
    const nextList = listUpgrades(nextMerged);
    const sameUpgrades =
      prevList.length === nextList.length &&
      nextList.every((item, i) => prevList[i]?.package === item.package && prevList[i]?.to === item.to);
    const stable = sameKeys(next, active) && sameUpgrades;
    active = next;
    merged = nextMerged;
    judged = nextJudged;
    if (stable) break;
  }

  return { tier: policy, upgrades: listUpgrades(merged), advisories: sortAdvisories(judged) };
}

function upgradesFromExplicit(explicit: Map<string, string>, installed: InstalledPackage[]): AdvisoryPlanUpgrade[] {
  const out: AdvisoryPlanUpgrade[] = [];
  for (const [name, to] of explicit) {
    const current = installed.find((pkg) => pkg.name === name);
    out.push({ package: name, ecosystem: ECOSYSTEM, from: current?.version ?? to, to });
  }
  out.sort((a, b) => compareCodeUnits(a.package, b.package) || compareCodeUnits(a.to, b.to));
  return out;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

function packageNameFromLockPath(lockPath: string): string | null {
  const at = lockPath.lastIndexOf('node_modules/');
  if (at < 0) return null;
  const name = lockPath.slice(at + 'node_modules/'.length);
  return name || null;
}

function readDepRanges(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  const out: Record<string, string> = {};
  for (const name of Object.keys(value).sort(compareCodeUnits)) {
    const range = value[name];
    if (typeof range === 'string' && range.trim()) out[name] = range.trim();
  }
  return out;
}

function directNames(pkg: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = pkg[section];
    if (!isPlainObject(deps)) continue;
    for (const name of Object.keys(deps)) names.add(name);
  }
  return names;
}

function resolveNodeModules(paths: Set<string>, fromPath: string, dep: string): string | undefined {
  let base = fromPath;
  for (;;) {
    const hit = base ? `${base}/node_modules/${dep}` : `node_modules/${dep}`;
    if (paths.has(hit)) return hit;
    if (base === '') return undefined;
    const at = base.lastIndexOf('node_modules/');
    base = at > 0 ? base.slice(0, at - 1) : '';
  }
}

/** Installed npm packages plus the ranges that pin each one, from package.json and package-lock.json. */
function loadInstalledNpmPackages(rootDir: string): InstalledPackage[] {
  const pkgPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return [];
  const pkgJson = readJson(pkgPath);
  if (!isPlainObject(pkgJson)) return [];
  const direct = directNames(pkgJson);

  const lockPath = path.join(rootDir, 'package-lock.json');
  if (!fs.existsSync(lockPath)) {
    const installed: InstalledPackage[] = [];
    for (const name of [...direct].sort(compareCodeUnits)) {
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        const deps = pkgJson[section];
        if (!isPlainObject(deps)) continue;
        const spec = deps[name];
        const version = typeof spec === 'string' ? canon(spec.trim()) : null;
        if (!version) continue;
        installed.push({ name, version, direct: true, requiredBy: [] });
        break;
      }
    }
    return installed;
  }

  const lock = readJson(lockPath);
  if (!isPlainObject(lock) || !isPlainObject(lock.packages)) {
    throw new Error('Could not read package-lock.json: expected a lockfileVersion 2 or 3 "packages" map.');
  }

  interface LockRecord {
    path: string;
    name: string;
    version: string;
    dependencies: Record<string, string>;
    peerDependencies: Record<string, string>;
  }

  const records: LockRecord[] = [];
  const paths = new Set<string>();
  for (const lockPathKey of Object.keys(lock.packages).sort(compareCodeUnits)) {
    if (lockPathKey === '') continue;
    const entry = lock.packages[lockPathKey];
    if (!isPlainObject(entry) || entry.link === true) continue;
    const name = packageNameFromLockPath(lockPathKey);
    const version = typeof entry.version === 'string' ? canon(entry.version) : null;
    if (!name || !version) continue;
    paths.add(lockPathKey);
    const dependencies = { ...readDepRanges(entry.dependencies), ...readDepRanges(entry.optionalDependencies) };
    records.push({
      path: lockPathKey,
      name,
      version,
      dependencies,
      peerDependencies: readDepRanges(entry.peerDependencies),
    });
  }

  const byPath = new Map<string, InstalledPackage>();
  for (const record of records) {
    const topLevel = record.path === `node_modules/${record.name}`;
    byPath.set(record.path, {
      name: record.name,
      version: record.version,
      direct: topLevel && direct.has(record.name),
      requiredBy: [],
    });
  }

  for (const record of records) {
    const add = (ranges: Record<string, string>, kind: ConstraintKind): void => {
      for (const dep of Object.keys(ranges).sort(compareCodeUnits)) {
        const targetPath = resolveNodeModules(paths, record.path, dep);
        const target = targetPath ? byPath.get(targetPath) : undefined;
        if (!target) continue;
        target.requiredBy.push({ package: record.name, version: record.version, range: ranges[dep], kind });
      }
    };
    add(record.dependencies, 'dependency');
    add(record.peerDependencies, 'peer');
  }

  const installed = [...byPath.values()];
  for (const pkg of installed) {
    pkg.requiredBy.sort(
      (a, b) =>
        compareCodeUnits(a.package, b.package) ||
        compareCodeUnits(a.version, b.version) ||
        compareCodeUnits(a.kind, b.kind) ||
        compareCodeUnits(a.range, b.range),
    );
  }
  installed.sort((a, b) => compareCodeUnits(a.name, b.name) || compareCodeUnits(a.version, b.version));
  return installed;
}

function explicitMap(upgrades: readonly ExplicitUpgrade[] | undefined): Map<string, string> | null {
  if (!upgrades) return null;
  const map = new Map<string, string>();
  const ordered = [...upgrades].sort((a, b) => compareCodeUnits(a.package, b.package) || compareCodeUnits(a.to, b.to));
  for (const item of ordered) {
    const version = canon(item.to);
    if (!item.package || !version) continue;
    const prev = map.get(item.package);
    if (!prev || semver.gt(version, prev)) map.set(item.package, version);
  }
  return map;
}

/**
 * Build (or judge) an offline advisory plan.
 *
 * Pass `upgrades` to judge that exact set and not add parent bumps the set
 * omitted. Omit it to build the plan: a transitive advisory is resolved only
 * when the selected versions also lift every parent or peer pin.
 */
export function resolveAdvisoryPlan(input: {
  rootDir: string;
  manifest: unknown;
  policy?: UpgradePolicy;
  upgrades?: readonly ExplicitUpgrade[];
}): AdvisoryResolutionReport {
  const policy = input.policy ?? 'safe';
  const manifest = parseManifest(input.manifest);
  const installed = loadInstalledNpmPackages(input.rootDir);
  const open = collectOpen(installed, manifest);
  const plan = buildPlan(open, policy, manifest, installed, explicitMap(input.upgrades));
  return { status: 'ok', offline: true, policy, plans: [plan] };
}

export function renderAdvisoryResolutionText(report: AdvisoryResolutionReport): string {
  const plan = report.plans[0];
  const lines = ['Vibgrate fix — advisory resolution (offline)', `policy ${report.policy}`, ''];
  if (!plan || plan.advisories.length === 0) {
    lines.push('No affected advisories in the local manifest.');
    return lines.join('\n');
  }
  for (const advisory of plan.advisories) {
    const version = advisory.plannedVersion ? `${advisory.installedVersion} → ${advisory.plannedVersion}` : advisory.installedVersion;
    lines.push(`${advisory.status}  ${advisory.id}  ${advisory.package}@${version}  ${advisory.reason}`);
  }
  return lines.join('\n');
}

export function renderAdvisoryResolutionMarkdown(report: AdvisoryResolutionReport): string {
  const plan = report.plans[0];
  const lines = [
    '# Vibgrate fix — advisory resolution (offline)',
    '',
    `Policy: \`${report.policy}\`.`,
    '',
    '| Status | Advisory | Package | Installed | Planned | Reason |',
    '|---|---|---|---|---|---|',
  ];
  for (const advisory of plan?.advisories ?? []) {
    lines.push(
      `| ${advisory.status} | ${advisory.id} | \`${advisory.package}\` | ${advisory.installedVersion} | ${advisory.plannedVersion ?? ''} | ${advisory.reason} |`,
    );
  }
  return lines.join('\n');
}
