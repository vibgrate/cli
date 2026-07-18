import type { PlanTier, UpgradePlan } from './types.js';

/**
 * Collapse duplicate plans onto the lowest-risk tier.
 *
 * The hosted planner always returns all three tiers, and in small estates they
 * frequently converge on the identical upgrade set (e.g. one drifted package
 * with only a minor update available). Presenting three indistinguishable
 * "choices" is noise, so a plan whose upgrade set is identical to a lower-risk
 * plan's is dropped and its tier is aliased to that surviving plan.
 */

/** Tier order from lowest to highest risk — the survivor of a duplicate group is the earliest. */
const TIER_ORDER: PlanTier[] = ['safe', 'balanced', 'aggressive'];

export interface DedupedPlans {
  /** Surviving plans, in the planner's original order. */
  plans: UpgradePlan[];
  /** Every original tier → the tier of the surviving plan with the identical upgrade set. */
  canonicalTier: Map<PlanTier, PlanTier>;
}

/** Order-insensitive identity of a plan's upgrade set. */
function upgradeSetKey(plan: UpgradePlan): string {
  return plan.upgrades
    .map((u) => `${u.ecosystem}\0${u.package}\0${u.from ?? ''}\0${u.to ?? ''}`)
    .sort()
    .join('\n');
}

export function dedupePlans(plans: UpgradePlan[]): DedupedPlans {
  const byTier = (plan: UpgradePlan): number => {
    const i = TIER_ORDER.indexOf(plan.tier);
    return i === -1 ? TIER_ORDER.length : i;
  };
  const ordered = [...plans].sort((a, b) => byTier(a) - byTier(b));

  const survivorByKey = new Map<string, UpgradePlan>();
  const canonicalTier = new Map<PlanTier, PlanTier>();
  for (const plan of ordered) {
    const key = upgradeSetKey(plan);
    const survivor = survivorByKey.get(key) ?? plan;
    if (!survivorByKey.has(key)) survivorByKey.set(key, plan);
    canonicalTier.set(plan.tier, survivor.tier);
  }

  const survivors = new Set(survivorByKey.values());
  return { plans: plans.filter((p) => survivors.has(p)), canonicalTier };
}
