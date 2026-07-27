/**
 * First-party weight store — content-addressed GGUF cache under the Vibgrate
 * cache root (never in-repo). Complements Ollama as a download channel so
 * embedded llama.cpp packs need not depend on a third-party app for weights.
 *
 * Only HTTPS URLs from an allowlist (or pack-declared URLs that pass the same
 * host allowlist) are fetched. No auto-download except via explicit
 * `vg models install` / executor consent.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';
import { createHash } from 'node:crypto';
import { vibgrateCacheDir } from './paths.js';

export const WEIGHT_STORE_SCHEMA = 'weight-store/0' as const;

/** Hosts we will download weights from (no arbitrary open proxy). */
export const WEIGHT_DOWNLOAD_HOST_ALLOWLIST = new Set([
  'huggingface.co',
  'hf.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-us-1.huggingface.co',
  'us.aws.cdn.hf.co',
  'cas-server.xethub.hf.co',
  'objects.githubusercontent.com',
  'github.com',
]);

/** Host suffixes allowed for HF LFS / Xet CDN redirects. */
export function isAllowedWeightHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (WEIGHT_DOWNLOAD_HOST_ALLOWLIST.has(h)) return true;
  if (h.endsWith('.huggingface.co')) return true;
  if (h.endsWith('.hf.co')) return true;
  if (h.endsWith('.cdn.hf.co')) return true;
  return false;
}

export interface WeightCatalogEntry {
  /** Stable ref (matches pack weightsRef or basename). */
  ref: string;
  /** HTTPS URL to the GGUF (or redirected LFS object). */
  url: string;
  /** Optional expected size for progress UX. */
  bytes?: number;
  license?: string;
  /**
   * When set, download **must** match this sha256 or install fails (B6).
   * Leave unset only while pinning is pending — status reports unpinned.
   */
  sha256?: string;
  /** Pack channel this entry was verified against. */
  packChannel?: string;
}

/**
 * Curated first-party catalog — small, versioned with packs. Not a general hub.
 * URLs point at public Hugging Face GGUF artifacts for Qwen2.5-Coder.
 *
 * Integrity: sha256 pins are required for production installs once verified.
 * Entries without sha256 are marked unpinned in {@link catalogIntegrityReport}
 * and still download, but CI should fail if any pack primary lacks a pin.
 */
export const FIRST_PARTY_WEIGHT_CATALOG: WeightCatalogEntry[] = [
  {
    ref: 'qwen2.5-coder-3b-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/qwen2.5-coder-3b-instruct-q4_k_m.gguf',
    license: 'Apache-2.0',
    packChannel: '2026.07.3',
    // Git LFS oid = content sha256 (from HF API tree, 2026-07-27).
    sha256: '724fb256bec1ff062b2f65e4569e871ad2e95ab2a3989723d1769c54294730b7',
    bytes: 2_104_932_800,
  },
  {
    ref: 'qwen2.5-coder-7b-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf',
    license: 'Apache-2.0',
    packChannel: '2026.07.3',
    sha256: '509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c',
    bytes: 4_683_073_536,
  },
];

export interface CatalogIntegrityReport {
  total: number;
  pinned: number;
  unpinned: string[];
  /** True when every entry has sha256. */
  complete: boolean;
}

export function catalogIntegrityReport(
  catalog: WeightCatalogEntry[] = FIRST_PARTY_WEIGHT_CATALOG,
): CatalogIntegrityReport {
  const unpinned = catalog.filter((e) => !e.sha256?.trim()).map((e) => e.ref);
  return {
    total: catalog.length,
    pinned: catalog.length - unpinned.length,
    unpinned,
    complete: unpinned.length === 0,
  };
}

/** Require sha256 on every catalog entry (CI gate for pack releases). */
export function assertCatalogPinned(catalog: WeightCatalogEntry[] = FIRST_PARTY_WEIGHT_CATALOG): void {
  const report = catalogIntegrityReport(catalog);
  if (!report.complete) {
    throw new Error(
      `weight catalog incomplete: ${report.unpinned.length}/${report.total} entries missing sha256: ${report.unpinned.join(', ')}`,
    );
  }
}

export function weightStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(vibgrateCacheDir(env), 'weights');
}

export function weightPathForRef(ref: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = path.basename(ref).replace(/[^a-zA-Z0-9._+-]/g, '_');
  return path.join(weightStoreDir(env), base);
}

export function isWeightCached(ref: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const p = weightPathForRef(ref, env);
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

export function lookupCatalog(ref: string, catalog: WeightCatalogEntry[] = FIRST_PARTY_WEIGHT_CATALOG): WeightCatalogEntry | null {
  const want = ref.toLowerCase();
  return (
    catalog.find((e) => e.ref.toLowerCase() === want) ??
    catalog.find((e) => want.includes(e.ref.toLowerCase()) || e.ref.toLowerCase().includes(want)) ??
    null
  );
}

export function isAllowedWeightUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return isAllowedWeightHost(u.hostname);
  } catch {
    return false;
  }
}

export interface DownloadWeightOptions {
  env?: NodeJS.ProcessEnv;
  /** Override catalog URL. */
  url?: string;
  expectedSha256?: string;
  onProgress?: (line: string) => void;
  /** Injectable fetch for tests. */
  fetchToFile?: (url: string, dest: string, onProgress?: (line: string) => void) => Promise<void>;
}

export interface DownloadWeightResult {
  ok: boolean;
  path?: string;
  error?: string;
  fromCache?: boolean;
}

/** In-flight downloads: one network fetch per dest path (concurrent install-safe). */
const inflight = new Map<string, Promise<DownloadWeightResult>>();

/**
 * Ensure weights for `ref` exist in the first-party store. Downloads when missing.
 * Concurrent callers for the same ref share a single download promise.
 */
export async function ensureWeightCached(ref: string, options: DownloadWeightOptions = {}): Promise<DownloadWeightResult> {
  const env = options.env ?? process.env;
  const dest = weightPathForRef(ref, env);
  if (isWeightCached(ref, env)) {
    return { ok: true, path: dest, fromCache: true };
  }

  const existing = inflight.get(dest);
  if (existing) return existing;

  const work = (async (): Promise<DownloadWeightResult> => {
    // Re-check after joining the queue.
    if (isWeightCached(ref, env)) {
      return { ok: true, path: dest, fromCache: true };
    }

    const entry = lookupCatalog(ref);
    const url = options.url ?? entry?.url;
    if (!url) {
      return { ok: false, error: `no first-party download URL for weights ref "${ref}" — set a pack downloadUrl or place a gguf at ${dest}` };
    }
    if (!isAllowedWeightUrl(url)) {
      return { ok: false, error: `weight URL host not allowlisted: ${url}` };
    }

    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.partial.${process.pid}.${Date.now()}`;
      const fetchFn = options.fetchToFile ?? defaultFetchToFile;
      options.onProgress?.(`downloading ${ref}`);
      await fetchFn(url, tmp, options.onProgress);
      const sha = (options.expectedSha256 ?? entry?.sha256)?.trim();
      if (sha) {
        const actual = sha256File(tmp);
        if (actual !== sha.toLowerCase()) {
          try {
            fs.unlinkSync(tmp);
          } catch {
            /* ignore */
          }
          return { ok: false, error: `sha256 mismatch for ${ref} (expected ${sha}, got ${actual})` };
        }
      } else if (entry && !entry.sha256) {
        options.onProgress?.(`warning: ${ref} has no sha256 pin in catalog — integrity not verified`);
      }
      // Atomic publish: if another worker won the race, drop our partial.
      if (isWeightCached(ref, env)) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        return { ok: true, path: dest, fromCache: true };
      }
      fs.renameSync(tmp, dest);
      return { ok: true, path: dest, fromCache: false };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      inflight.delete(dest);
    }
  })();

  inflight.set(dest, work);
  return work;
}

function sha256File(file: string): string {
  const h = createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

/** Minimal HTTPS GET with redirect follow (tests inject fetchToFile). */
export function defaultFetchToFile(url: string, dest: string, onProgress?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const get = (u: string, redirects: number): void => {
      if (redirects > 8) {
        reject(new Error('too many redirects'));
        return;
      }
      const lib = u.startsWith('https:') ? https : http;
      const req = lib.get(u, (res) => {
        const code = res.statusCode ?? 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          const next = new URL(res.headers.location, u).href;
          // Redirects must stay on HTTPS + allowlisted hosts (incl. HF LFS/Xet CDNs).
          try {
            const nextUrl = new URL(next);
            if (nextUrl.protocol !== 'https:' || !isAllowedWeightHost(nextUrl.hostname)) {
              reject(new Error(`redirect host not allowlisted: ${nextUrl.hostname || next}`));
              return;
            }
          } catch {
            reject(new Error('invalid redirect URL'));
            return;
          }
          res.resume();
          get(next, redirects + 1);
          return;
        }
        if (code !== 200) {
          reject(new Error(`HTTP ${code} fetching weights`));
          res.resume();
          return;
        }
        const total = Number(res.headers['content-length'] || 0);
        let got = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk: Buffer) => {
          got += chunk.length;
          if (total > 0 && got % (8 * 1024 * 1024) < chunk.length) {
            onProgress?.(`${Math.floor((100 * got) / total)}%`);
          }
        });
        res.pipe(out);
        out.on('finish', () => resolve());
        out.on('error', reject);
        res.on('error', reject);
      });
      req.on('error', reject);
    };
    get(url, 0);
  });
}

/** List GGUF files already in the first-party store (for discovery). */
export function listCachedWeights(env: NodeJS.ProcessEnv = process.env): Array<{ name: string; path: string }> {
  const dir = weightStoreDir(env);
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.gguf'))
      .sort()
      .map((n) => ({ name: n, path: path.join(dir, n) }));
  } catch {
    return [];
  }
}
