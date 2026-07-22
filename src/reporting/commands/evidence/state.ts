// ── Local evidence state: .vibgrate/evidence/ ──
//
// Deterministic, on-disk state for Vibgrate Evidence. No network, no telemetry.
// Release manifests are FROZEN AT SHIP TIME and never regenerated — freezing a
// release refuses to overwrite an existing manifest, because the 24-hour
// question is about what you *shipped*, not what is in `main` today.

import * as path from 'node:path';
import { pathExists, readJsonFile, writeJsonFile } from '../../utils/fs.js';
import { CliError, ExitCode } from '../../../util/exit.js';
import { DEFAULT_REGIME } from './regimes.js';
import type { EvidenceOrg, Product, Release } from './types.js';

export function evidenceDir(root: string): string {
  return path.join(root, '.vibgrate', 'evidence');
}
function orgPath(root: string): string {
  return path.join(evidenceDir(root), 'org.json');
}
function productsPath(root: string): string {
  return path.join(evidenceDir(root), 'products.json');
}
function releasesDir(root: string): string {
  return path.join(evidenceDir(root), 'releases');
}
/** Filesystem-safe release manifest path. */
export function releasePath(root: string, productId: string, version: string): string {
  const safe = `${productId}@${version}`.replace(/[^A-Za-z0-9._@-]/g, '_');
  return path.join(releasesDir(root), `${safe}.json`);
}

const DEFAULT_ORG: EvidenceOrg = {
  responsiblePersons: [],
  defaultRegime: DEFAULT_REGIME,
};

export async function loadOrg(root: string): Promise<EvidenceOrg> {
  const p = orgPath(root);
  if (!(await pathExists(p))) return { ...DEFAULT_ORG };
  const org = await readJsonFile<EvidenceOrg>(p);
  return { ...DEFAULT_ORG, ...org, responsiblePersons: org.responsiblePersons ?? [] };
}

export async function saveOrg(root: string, org: EvidenceOrg): Promise<void> {
  await writeJsonFile(orgPath(root), org);
}

export async function loadProducts(root: string): Promise<Product[]> {
  const p = productsPath(root);
  if (!(await pathExists(p))) return [];
  return readJsonFile<Product[]>(p);
}

export async function saveProducts(root: string, products: Product[]): Promise<void> {
  await writeJsonFile(productsPath(root), products);
}

export async function getProduct(root: string, id: string): Promise<Product | undefined> {
  const products = await loadProducts(root);
  return products.find((p) => p.id === id || p.name === id);
}

/**
 * Freeze a release manifest. Immutable by contract: if a manifest already exists
 * for this (product, version) it is NOT overwritten — re-freezing would defeat
 * the entire point (the shipped bill of materials must not change after ship).
 */
export async function freezeRelease(root: string, release: Release): Promise<string> {
  const p = releasePath(root, release.productId, release.version);
  if (await pathExists(p)) {
    throw new CliError(
      `release ${release.productId}@${release.version} is already frozen and manifests are immutable — ` +
        `delete ${path.relative(root, p)} only if it was frozen in error`,
      ExitCode.USAGE_ERROR,
    );
  }
  await writeJsonFile(p, release);
  return p;
}

export async function loadRelease(root: string, productId: string, version: string): Promise<Release | undefined> {
  const p = releasePath(root, productId, version);
  if (!(await pathExists(p))) return undefined;
  return readJsonFile<Release>(p);
}

/** All frozen releases, optionally filtered to a product. */
export async function loadReleases(root: string, productId?: string): Promise<Release[]> {
  const dir = releasesDir(root);
  if (!(await pathExists(dir))) return [];
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const releases: Release[] = [];
  for (const f of files) {
    const rel = await readJsonFile<Release>(path.join(dir, f));
    if (!productId || rel.productId === productId) releases.push(rel);
  }
  return releases;
}
