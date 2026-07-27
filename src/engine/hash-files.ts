/**
 * Parallel content hashing for the build hash stage.
 * Deterministic: callers sort/merge results by path; workers only compute hashes.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { hashBytes } from './hash.js';

export interface HashJob {
  rel: string;
  abs: string;
}

export interface HashResult {
  rel: string;
  hash: string;
  /** False if the file could not be read. */
  ok: boolean;
}

/**
 * Hash many files with bounded concurrency. Order of results is not guaranteed;
 * sort by `rel` if you need stable order.
 */
export async function hashFilesParallel(
  jobs: HashJob[],
  concurrency?: number,
): Promise<HashResult[]> {
  if (jobs.length === 0) return [];
  const limit = Math.max(
    1,
    Math.min(concurrency ?? Math.max(1, (os.cpus()?.length ?? 4) * 2), jobs.length),
  );

  const out: HashResult[] = new Array(jobs.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      const job = jobs[i];
      try {
        const buf = await fs.readFile(job.abs);
        out[i] = { rel: job.rel, hash: hashBytes(buf), ok: true };
      } catch {
        out[i] = { rel: job.rel, hash: '', ok: false };
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return out;
}
