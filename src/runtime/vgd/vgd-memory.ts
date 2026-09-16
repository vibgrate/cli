import * as os from 'node:os';
import type { ActiveGraphCacheOptions } from '../active-graph-cache.js';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Default fraction of machine RAM the daemon may keep as resident slots. */
export const DEFAULT_VGD_RSS_FRACTION = 0.45;

export interface VgdMemoryFacts {
  totalmemBytes?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Slot caps + RSS budget for the daemon's ActiveGraphCache.
 *
 * Count caps still apply (overflow LILO). The RSS budget is the extra brake
 * for "five published maps on a 2 GiB box": evict idle slots until
 * `process.memoryUsage().rss` is under the budget, never evicting current.
 */
export function resolveVgdCacheOptions(facts: VgdMemoryFacts = {}): ActiveGraphCacheOptions {
  const env = facts.env ?? process.env;
  const total = facts.totalmemBytes ?? os.totalmem();
  const low = total < 4 * GIB;

  const budgetMb = envIntFrom(env, 'VG_VGD_RSS_BUDGET_MB');
  const rssBudgetBytes =
    budgetMb === 0 ? 0 : budgetMb != null ? budgetMb * MIB : Math.floor(total * DEFAULT_VGD_RSS_FRACTION);

  return {
    maxPerRepo: envIntFrom(env, 'VG_VGD_MAX_SLOTS_PER_REPO') ?? (low ? 2 : 8),
    maxTotal: envIntFrom(env, 'VG_VGD_MAX_SLOTS') ?? (low ? 3 : 32),
    rssBudgetBytes,
  };
}

function envIntFrom(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}
