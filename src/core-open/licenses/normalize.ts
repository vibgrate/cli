// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * License normalization — the single entry point that turns an arbitrary
 * declared license string into a canonical, classified verdict.
 *
 * Resolution order (deterministic-first):
 *   1. Exact SPDX id match against the catalog.
 *   2. Compound SPDX expression (OR / AND / WITH).
 *   3. Alias map (legacy / free-text forms).
 *   4. Fuzzy family detection (last deterministic resort).
 *   5. Unknown (explicit — never silently bucketed).
 */

import {
  getLicenseRecord,
  unknownLicenseRecord,
  riskForCategory,
  type LicenseRecord,
  type LicenseCategory,
  type RiskLevel,
  type LicenseObligations,
} from './spdx-catalog.js';
import { resolveAlias } from './spdx-aliases.js';
import { parseLicenseExpression, isCompoundExpression } from './spdx-expression.js';

export type LicenseMatchStatus =
  | 'exact'
  | 'expression'
  | 'alias'
  | 'fuzzy'
  | 'unknown';

export interface LicenseVerdict {
  /** Canonical SPDX id (or NOASSERTION when unknown). For OR expressions this
   *  is the least-restrictive choice; for AND, the most-restrictive. */
  spdxId: string;
  /** Display name. */
  name: string;
  /** Full normalized expression when compound, else the single id. */
  expression: string;
  family: string;
  category: LicenseCategory;
  riskLevel: RiskLevel;
  osiApproved: boolean;
  fsfLibre: boolean;
  obligations: LicenseObligations;
  matchStatus: LicenseMatchStatus;
  /** 0–1 confidence in the identification. */
  confidence: number;
  /** All constituent SPDX ids when compound. */
  components: string[];
}

const CATEGORY_RESTRICTIVENESS: Record<LicenseCategory, number> = {
  'public-domain': 0,
  permissive: 1,
  'weak-copyleft': 2,
  copyleft: 3,
  'network-copyleft': 4,
  proprietary: 5,
  unknown: 2,
};

function verdictFromRecord(
  rec: LicenseRecord,
  matchStatus: LicenseMatchStatus,
  confidence: number,
  expression?: string,
  components?: string[],
): LicenseVerdict {
  return {
    spdxId: rec.spdxId,
    name: rec.name,
    expression: expression ?? rec.spdxId,
    family: rec.family,
    category: rec.category,
    riskLevel: rec.riskLevel,
    osiApproved: rec.osiApproved,
    fsfLibre: rec.fsfLibre,
    obligations: rec.obligations,
    matchStatus,
    confidence,
    components: components ?? [rec.spdxId],
  };
}

/** Fuzzy family detection for strings the catalog/aliases miss. */
function fuzzyMatch(raw: string): LicenseRecord | undefined {
  const s = raw.toLowerCase();
  // Order matters: most specific / most restrictive first.
  if (/\bagpl/.test(s)) return getLicenseRecord('AGPL-3.0-or-later');
  if (/\bsspl/.test(s)) return getLicenseRecord('SSPL-1.0');
  if (/\bbusl|business source/.test(s)) return getLicenseRecord('BUSL-1.1');
  if (/\blgpl/.test(s)) return getLicenseRecord('LGPL-3.0-or-later');
  if (/\bgpl/.test(s)) return getLicenseRecord('GPL-3.0-or-later');
  if (/\bmpl|mozilla/.test(s)) return getLicenseRecord('MPL-2.0');
  if (/\bepl|eclipse/.test(s)) return getLicenseRecord('EPL-2.0');
  if (/\bapache/.test(s)) return getLicenseRecord('Apache-2.0');
  if (/\bbsd/.test(s)) return getLicenseRecord('BSD-3-Clause');
  if (/\bmit\b/.test(s)) return getLicenseRecord('MIT');
  if (/\bisc\b/.test(s)) return getLicenseRecord('ISC');
  if (/commons clause/.test(s)) return getLicenseRecord('Commons-Clause');
  if (/proprietary|commercial|all rights reserved/.test(s)) return getLicenseRecord('LicenseRef-Proprietary');
  if (/public domain|cc0/.test(s)) return getLicenseRecord('CC0-1.0');
  return undefined;
}

/**
 * Normalize a single (possibly compound) license string into a verdict.
 */
export function normalizeLicense(raw: string | null | undefined): LicenseVerdict {
  const input = (raw ?? '').trim();
  if (!input || /^(unknown|noassertion|none|n\/a)$/i.test(input)) {
    return verdictFromRecord(unknownLicenseRecord(), 'unknown', 0);
  }

  // 1. Exact SPDX id
  const exact = getLicenseRecord(input);
  if (exact) return verdictFromRecord(exact, 'exact', 1);

  // 2. Compound expression
  if (isCompoundExpression(input)) {
    return resolveExpression(input);
  }

  // 3. Alias
  const aliasId = resolveAlias(input);
  if (aliasId) {
    const rec = getLicenseRecord(aliasId);
    if (rec) return verdictFromRecord(rec, 'alias', 0.95);
  }

  // 4. Fuzzy family
  const fuzzy = fuzzyMatch(input);
  if (fuzzy) {
    return { ...verdictFromRecord(fuzzy, 'fuzzy', 0.6), name: input.slice(0, 120) };
  }

  // 5. Unknown
  return verdictFromRecord(unknownLicenseRecord(input.slice(0, 120)), 'unknown', 0);
}

function resolveExpression(input: string): LicenseVerdict {
  const parsed = parseLicenseExpression(input);
  if (parsed.licenseIds.length === 0) {
    return verdictFromRecord(unknownLicenseRecord(input.slice(0, 120)), 'unknown', 0);
  }

  // Resolve each constituent id to a verdict (via recursion through the
  // single-id path: exact → alias → fuzzy).
  const componentVerdicts = parsed.licenseIds.map((id) => {
    const exact = getLicenseRecord(id);
    if (exact) return verdictFromRecord(exact, 'exact', 1);
    const aliasId = resolveAlias(id);
    if (aliasId) {
      const rec = getLicenseRecord(aliasId);
      if (rec) return verdictFromRecord(rec, 'alias', 0.95);
    }
    const fuzzy = fuzzyMatch(id);
    if (fuzzy) return verdictFromRecord(fuzzy, 'fuzzy', 0.6);
    return verdictFromRecord(unknownLicenseRecord(id), 'unknown', 0);
  });

  // For OR the consumer may pick the least-restrictive; for AND all apply, so
  // the most-restrictive governs.
  const pickMostRestrictive = parsed.operator !== 'OR';
  let chosen = componentVerdicts[0]!;
  for (const v of componentVerdicts) {
    const more = CATEGORY_RESTRICTIVENESS[v.category] > CATEGORY_RESTRICTIVENESS[chosen.category];
    if (pickMostRestrictive ? more : !more) chosen = v;
  }

  // Union of obligations across all components that actually apply.
  const obligations = unionObligations(
    pickMostRestrictive ? componentVerdicts : [chosen],
  );
  const components = componentVerdicts.map((v) => v.spdxId);
  const category = chosen.category;

  return {
    spdxId: chosen.spdxId,
    name: parsed.normalized,
    expression: parsed.normalized,
    family: chosen.family,
    category,
    riskLevel: riskForCategory(category),
    osiApproved: componentVerdicts.every((v) => v.osiApproved),
    fsfLibre: componentVerdicts.every((v) => v.fsfLibre),
    obligations,
    matchStatus: 'expression',
    confidence: Math.min(...componentVerdicts.map((v) => v.confidence)) || 0.5,
    components,
  };
}

function unionObligations(verdicts: LicenseVerdict[]): LicenseObligations {
  const out: LicenseObligations = {
    attribution: false,
    copyleft: false,
    networkCopyleft: false,
    discloseSource: false,
    patentGrant: false,
    commercialRestriction: false,
  };
  for (const v of verdicts) {
    out.attribution ||= v.obligations.attribution;
    out.copyleft ||= v.obligations.copyleft;
    out.networkCopyleft ||= v.obligations.networkCopyleft;
    out.discloseSource ||= v.obligations.discloseSource;
    out.patentGrant ||= v.obligations.patentGrant;
    out.commercialRestriction ||= v.obligations.commercialRestriction;
  }
  return out;
}
