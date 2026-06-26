// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * SPDX license catalog — the canonical, in-code seed for Vibgrate's license
 * library. The persistent "growing library" lives in D1 (see API
 * license_catalog / license_aliases tables); this catalog seeds it and acts as
 * the offline fallback for normalization in the CLI and API.
 *
 * This module is intentionally dependency-free (no Node built-ins) so it can be
 * shared verbatim with the Cloudflare-Worker API package.
 */

export type LicenseCategory =
  | 'public-domain'
  | 'permissive'
  | 'weak-copyleft'
  | 'copyleft'
  | 'network-copyleft'
  | 'proprietary'
  | 'unknown';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface LicenseObligations {
  /** Must preserve copyright / license notices. */
  attribution: boolean;
  /** Derivative works must be licensed under the same terms. */
  copyleft: boolean;
  /** Network/SaaS use triggers source-disclosure obligations (AGPL/SSPL). */
  networkCopyleft: boolean;
  /** Must make corresponding source available. */
  discloseSource: boolean;
  /** Includes an explicit patent grant. */
  patentGrant: boolean;
  /** Restricts commercial use or imposes field-of-use limits. */
  commercialRestriction: boolean;
}

export interface LicenseRecord {
  spdxId: string;
  name: string;
  family: string;
  category: LicenseCategory;
  osiApproved: boolean;
  fsfLibre: boolean;
  deprecated: boolean;
  referenceUrl: string;
  riskLevel: RiskLevel;
  obligations: LicenseObligations;
}

/** Default risk level implied by a category, used when seeding records. */
export function riskForCategory(category: LicenseCategory): RiskLevel {
  switch (category) {
    case 'public-domain':
    case 'permissive':
      return 'low';
    case 'weak-copyleft':
      return 'medium';
    case 'copyleft':
    case 'network-copyleft':
    case 'proprietary':
      return 'high';
    case 'unknown':
    default:
      return 'medium';
  }
}

const NO_OBLIGATIONS: LicenseObligations = {
  attribution: false,
  copyleft: false,
  networkCopyleft: false,
  discloseSource: false,
  patentGrant: false,
  commercialRestriction: false,
};

interface Seed {
  id: string;
  name: string;
  family: string;
  category: LicenseCategory;
  osi?: boolean;
  fsf?: boolean;
  deprecated?: boolean;
  url?: string;
  obligations?: Partial<LicenseObligations>;
}

function record(seed: Seed): LicenseRecord {
  return {
    spdxId: seed.id,
    name: seed.name,
    family: seed.family,
    category: seed.category,
    osiApproved: seed.osi ?? false,
    fsfLibre: seed.fsf ?? false,
    deprecated: seed.deprecated ?? false,
    referenceUrl: seed.url ?? `https://spdx.org/licenses/${seed.id}.html`,
    riskLevel: riskForCategory(seed.category),
    obligations: { ...NO_OBLIGATIONS, ...(seed.obligations ?? {}) },
  };
}

// Common obligation presets ---------------------------------------------------
const ATTRIB: Partial<LicenseObligations> = { attribution: true };
const ATTRIB_PATENT: Partial<LicenseObligations> = { attribution: true, patentGrant: true };
const WEAK: Partial<LicenseObligations> = { attribution: true, copyleft: true, discloseSource: true };
const STRONG: Partial<LicenseObligations> = { attribution: true, copyleft: true, discloseSource: true };
const NETWORK: Partial<LicenseObligations> = {
  attribution: true,
  copyleft: true,
  networkCopyleft: true,
  discloseSource: true,
};

const SEEDS: Seed[] = [
  // ── Public domain / unlicensed ──
  { id: 'CC0-1.0', name: 'Creative Commons Zero v1.0 Universal', family: 'CC', category: 'public-domain', fsf: true },
  { id: 'Unlicense', name: 'The Unlicense', family: 'Public Domain', category: 'public-domain', osi: true, fsf: true },
  { id: '0BSD', name: 'BSD Zero Clause License', family: 'BSD', category: 'permissive', osi: true },
  { id: 'WTFPL', name: 'Do What The F*ck You Want To Public License', family: 'WTFPL', category: 'permissive', fsf: true },

  // ── Permissive ──
  { id: 'MIT', name: 'MIT License', family: 'MIT', category: 'permissive', osi: true, fsf: true, obligations: ATTRIB },
  { id: 'MIT-0', name: 'MIT No Attribution', family: 'MIT', category: 'permissive', osi: true },
  { id: 'ISC', name: 'ISC License', family: 'ISC', category: 'permissive', osi: true, fsf: true, obligations: ATTRIB },
  { id: 'BSD-2-Clause', name: 'BSD 2-Clause "Simplified" License', family: 'BSD', category: 'permissive', osi: true, fsf: true, obligations: ATTRIB },
  { id: 'BSD-3-Clause', name: 'BSD 3-Clause "New" or "Revised" License', family: 'BSD', category: 'permissive', osi: true, fsf: true, obligations: ATTRIB },
  { id: 'BSD-3-Clause-Clear', name: 'BSD 3-Clause Clear License', family: 'BSD', category: 'permissive', osi: true, obligations: ATTRIB },
  { id: 'Apache-2.0', name: 'Apache License 2.0', family: 'Apache', category: 'permissive', osi: true, fsf: true, obligations: ATTRIB_PATENT },
  { id: 'Apache-1.1', name: 'Apache Software License 1.1', family: 'Apache', category: 'permissive', osi: true, obligations: ATTRIB },
  { id: 'Zlib', name: 'zlib License', family: 'Zlib', category: 'permissive', osi: true, fsf: true },
  { id: 'BSL-1.0', name: 'Boost Software License 1.0', family: 'Boost', category: 'permissive', osi: true, fsf: true, obligations: ATTRIB },
  { id: 'PostgreSQL', name: 'PostgreSQL License', family: 'BSD', category: 'permissive', osi: true, obligations: ATTRIB },
  { id: 'Python-2.0', name: 'Python License 2.0', family: 'Python', category: 'permissive', osi: true, obligations: ATTRIB },
  { id: 'PSF-2.0', name: 'Python Software Foundation License 2.0', family: 'Python', category: 'permissive', obligations: ATTRIB },
  { id: 'Artistic-2.0', name: 'Artistic License 2.0', family: 'Artistic', category: 'permissive', osi: true, fsf: true, obligations: ATTRIB },
  { id: 'NCSA', name: 'University of Illinois/NCSA Open Source License', family: 'NCSA', category: 'permissive', osi: true, fsf: true, obligations: ATTRIB },
  { id: 'Unicode-DFS-2016', name: 'Unicode License Agreement - Data Files and Software (2016)', family: 'Unicode', category: 'permissive', osi: true, obligations: ATTRIB },
  { id: 'BlueOak-1.0.0', name: 'Blue Oak Model License 1.0.0', family: 'BlueOak', category: 'permissive', obligations: ATTRIB },

  // ── Weak / file-level copyleft ──
  { id: 'LGPL-2.0-only', name: 'GNU Library General Public License v2 only', family: 'LGPL', category: 'weak-copyleft', osi: true, fsf: true, obligations: WEAK },
  { id: 'LGPL-2.1-only', name: 'GNU Lesser General Public License v2.1 only', family: 'LGPL', category: 'weak-copyleft', osi: true, fsf: true, obligations: WEAK },
  { id: 'LGPL-2.1-or-later', name: 'GNU Lesser General Public License v2.1 or later', family: 'LGPL', category: 'weak-copyleft', osi: true, fsf: true, obligations: WEAK },
  { id: 'LGPL-3.0-only', name: 'GNU Lesser General Public License v3.0 only', family: 'LGPL', category: 'weak-copyleft', osi: true, fsf: true, obligations: { ...WEAK, patentGrant: true } },
  { id: 'LGPL-3.0-or-later', name: 'GNU Lesser General Public License v3.0 or later', family: 'LGPL', category: 'weak-copyleft', osi: true, fsf: true, obligations: { ...WEAK, patentGrant: true } },
  { id: 'MPL-2.0', name: 'Mozilla Public License 2.0', family: 'MPL', category: 'weak-copyleft', osi: true, fsf: true, obligations: { ...WEAK, patentGrant: true } },
  { id: 'MPL-1.1', name: 'Mozilla Public License 1.1', family: 'MPL', category: 'weak-copyleft', osi: true, fsf: true, obligations: WEAK },
  { id: 'EPL-1.0', name: 'Eclipse Public License 1.0', family: 'EPL', category: 'weak-copyleft', osi: true, fsf: true, obligations: { ...WEAK, patentGrant: true } },
  { id: 'EPL-2.0', name: 'Eclipse Public License 2.0', family: 'EPL', category: 'weak-copyleft', osi: true, fsf: true, obligations: { ...WEAK, patentGrant: true } },
  { id: 'CDDL-1.0', name: 'Common Development and Distribution License 1.0', family: 'CDDL', category: 'weak-copyleft', osi: true, fsf: true, obligations: WEAK },
  { id: 'CDDL-1.1', name: 'Common Development and Distribution License 1.1', family: 'CDDL', category: 'weak-copyleft', obligations: WEAK },
  { id: 'CPL-1.0', name: 'Common Public License 1.0', family: 'CPL', category: 'weak-copyleft', osi: true, fsf: true, obligations: WEAK },
  { id: 'MS-PL', name: 'Microsoft Public License', family: 'Microsoft', category: 'weak-copyleft', osi: true, fsf: true, obligations: ATTRIB },
  { id: 'MS-RL', name: 'Microsoft Reciprocal License', family: 'Microsoft', category: 'weak-copyleft', osi: true, fsf: true, obligations: WEAK },

  // ── Strong copyleft ──
  { id: 'GPL-2.0-only', name: 'GNU General Public License v2.0 only', family: 'GPL', category: 'copyleft', osi: true, fsf: true, obligations: STRONG },
  { id: 'GPL-2.0-or-later', name: 'GNU General Public License v2.0 or later', family: 'GPL', category: 'copyleft', osi: true, fsf: true, obligations: STRONG },
  { id: 'GPL-3.0-only', name: 'GNU General Public License v3.0 only', family: 'GPL', category: 'copyleft', osi: true, fsf: true, obligations: { ...STRONG, patentGrant: true } },
  { id: 'GPL-3.0-or-later', name: 'GNU General Public License v3.0 or later', family: 'GPL', category: 'copyleft', osi: true, fsf: true, obligations: { ...STRONG, patentGrant: true } },
  { id: 'EUPL-1.1', name: 'European Union Public License 1.1', family: 'EUPL', category: 'copyleft', osi: true, fsf: true, obligations: STRONG },
  { id: 'EUPL-1.2', name: 'European Union Public License 1.2', family: 'EUPL', category: 'copyleft', osi: true, fsf: true, obligations: STRONG },
  { id: 'OSL-3.0', name: 'Open Software License 3.0', family: 'OSL', category: 'copyleft', osi: true, fsf: true, obligations: { ...STRONG, patentGrant: true } },
  { id: 'CECILL-2.1', name: 'CeCILL Free Software License Agreement v2.1', family: 'CeCILL', category: 'copyleft', osi: true, fsf: true, obligations: STRONG },
  { id: 'CC-BY-SA-4.0', name: 'Creative Commons Attribution Share Alike 4.0 International', family: 'CC', category: 'copyleft', obligations: { attribution: true, copyleft: true } },

  // ── Network copyleft ──
  { id: 'AGPL-3.0-only', name: 'GNU Affero General Public License v3.0 only', family: 'AGPL', category: 'network-copyleft', osi: true, fsf: true, obligations: { ...NETWORK, patentGrant: true } },
  { id: 'AGPL-3.0-or-later', name: 'GNU Affero General Public License v3.0 or later', family: 'AGPL', category: 'network-copyleft', osi: true, fsf: true, obligations: { ...NETWORK, patentGrant: true } },

  // ── Source-available / proprietary (non-OSI) ──
  { id: 'SSPL-1.0', name: 'Server Side Public License 1.0', family: 'SSPL', category: 'network-copyleft', obligations: NETWORK },
  { id: 'BUSL-1.1', name: 'Business Source License 1.1', family: 'BUSL', category: 'proprietary', obligations: { commercialRestriction: true, discloseSource: true } },
  { id: 'Elastic-2.0', name: 'Elastic License 2.0', family: 'Elastic', category: 'proprietary', obligations: { commercialRestriction: true } },
  { id: 'RPL-1.5', name: 'Reciprocal Public License 1.5', family: 'RPL', category: 'network-copyleft', osi: true, obligations: NETWORK },
  { id: 'Commons-Clause', name: 'Commons Clause License Condition v1.0', family: 'Commons-Clause', category: 'proprietary', obligations: { commercialRestriction: true } },
  { id: 'LicenseRef-Proprietary', name: 'Proprietary / Commercial', family: 'Proprietary', category: 'proprietary', obligations: { commercialRestriction: true } },

  // ── Non-commercial Creative Commons (restrictive) ──
  { id: 'CC-BY-NC-4.0', name: 'Creative Commons Attribution Non Commercial 4.0 International', family: 'CC', category: 'proprietary', obligations: { attribution: true, commercialRestriction: true } },
  { id: 'CC-BY-4.0', name: 'Creative Commons Attribution 4.0 International', family: 'CC', category: 'permissive', obligations: ATTRIB },
];

const RECORDS: LicenseRecord[] = SEEDS.map(record);

const BY_ID = new Map<string, LicenseRecord>();
for (const rec of RECORDS) {
  BY_ID.set(rec.spdxId.toLowerCase(), rec);
}

/** All seeded canonical license records. */
export function allLicenseRecords(): readonly LicenseRecord[] {
  return RECORDS;
}

/** Look up a canonical record by exact (case-insensitive) SPDX id. */
export function getLicenseRecord(spdxId: string): LicenseRecord | undefined {
  return BY_ID.get(spdxId.trim().toLowerCase());
}

/** A synthetic record for licenses we cannot identify. */
export function unknownLicenseRecord(name = 'Unknown'): LicenseRecord {
  return {
    spdxId: 'NOASSERTION',
    name,
    family: 'Unknown',
    category: 'unknown',
    osiApproved: false,
    fsfLibre: false,
    deprecated: false,
    referenceUrl: '',
    riskLevel: 'medium',
    obligations: { ...NO_OBLIGATIONS },
  };
}
