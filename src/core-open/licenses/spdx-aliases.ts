// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Alias map: maps non-canonical, legacy, and free-text license strings to their
 * canonical SPDX identifier. Seeds the D1 license_aliases table (state=trusted).
 *
 * Keys are normalized (see normalizeAliasKey) so that case, spacing, and common
 * punctuation differences collapse to a single lookup.
 */

/** Normalize a raw license token for alias lookup. */
export function normalizeAliasKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^\(+|\)+$/g, '')
    .replace(/[._]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*/g, '-')
    .replace(/\bversion\b/g, 'v')
    .replace(/\blicen[sc]e\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// raw alias (human form) → canonical SPDX id. Normalized at module load.
const RAW_ALIASES: Record<string, string> = {
  // MIT
  'mit': 'MIT',
  'mit license': 'MIT',
  'the mit license': 'MIT',
  'expat': 'MIT',

  // ISC
  'isc': 'ISC',

  // Apache
  'apache': 'Apache-2.0',
  'apache 2': 'Apache-2.0',
  'apache2': 'Apache-2.0',
  'apache 2.0': 'Apache-2.0',
  'apache-2': 'Apache-2.0',
  'apache license 2.0': 'Apache-2.0',
  'apache license version 2.0': 'Apache-2.0',
  'asl 2.0': 'Apache-2.0',
  'al2': 'Apache-2.0',

  // BSD
  'bsd': 'BSD-3-Clause',
  'bsd license': 'BSD-3-Clause',
  'bsd-2': 'BSD-2-Clause',
  'bsd 2-clause': 'BSD-2-Clause',
  'simplified bsd': 'BSD-2-Clause',
  'freebsd': 'BSD-2-Clause',
  'bsd-3': 'BSD-3-Clause',
  'bsd 3-clause': 'BSD-3-Clause',
  'new bsd': 'BSD-3-Clause',
  'modified bsd': 'BSD-3-Clause',
  'revised bsd': 'BSD-3-Clause',

  // GPL
  'gpl': 'GPL-3.0-or-later',
  'gplv2': 'GPL-2.0-only',
  'gpl2': 'GPL-2.0-only',
  'gpl-2': 'GPL-2.0-only',
  'gpl 2.0': 'GPL-2.0-only',
  'gpl-2.0': 'GPL-2.0-only',
  'gpl-2.0+': 'GPL-2.0-or-later',
  'gnu gpl v2': 'GPL-2.0-only',
  'gplv3': 'GPL-3.0-only',
  'gpl3': 'GPL-3.0-only',
  'gpl-3': 'GPL-3.0-only',
  'gpl 3.0': 'GPL-3.0-only',
  'gpl-3.0': 'GPL-3.0-only',
  'gpl-3.0+': 'GPL-3.0-or-later',
  'gnu gpl v3': 'GPL-3.0-only',
  'gnu general public v3': 'GPL-3.0-only',

  // LGPL
  'lgpl': 'LGPL-3.0-or-later',
  'lgplv2.1': 'LGPL-2.1-only',
  'lgpl-2.1': 'LGPL-2.1-only',
  'lgpl 2.1': 'LGPL-2.1-only',
  'lgplv3': 'LGPL-3.0-only',
  'lgpl-3': 'LGPL-3.0-only',
  'lgpl-3.0': 'LGPL-3.0-only',
  'lgpl 3.0': 'LGPL-3.0-only',

  // AGPL
  'agpl': 'AGPL-3.0-or-later',
  'agplv3': 'AGPL-3.0-only',
  'agpl-3': 'AGPL-3.0-only',
  'agpl-3.0': 'AGPL-3.0-only',
  'agpl 3.0': 'AGPL-3.0-only',
  'gnu agpl v3': 'AGPL-3.0-only',

  // MPL
  'mpl': 'MPL-2.0',
  'mpl 2.0': 'MPL-2.0',
  'mpl-2': 'MPL-2.0',
  'mozilla public 2.0': 'MPL-2.0',

  // EPL
  'epl': 'EPL-2.0',
  'eclipse public 2.0': 'EPL-2.0',
  'epl-2': 'EPL-2.0',

  // Source-available / proprietary
  'sspl': 'SSPL-1.0',
  'server side public': 'SSPL-1.0',
  'busl': 'BUSL-1.1',
  'business source': 'BUSL-1.1',
  'elastic': 'Elastic-2.0',
  'elastic-2': 'Elastic-2.0',
  'commons clause': 'Commons-Clause',
  'proprietary': 'LicenseRef-Proprietary',
  'commercial': 'LicenseRef-Proprietary',
  'see license in license': 'LicenseRef-Proprietary',
  'unlicensed': 'LicenseRef-Proprietary',
  'all rights reserved': 'LicenseRef-Proprietary',

  // Public domain
  'cc0': 'CC0-1.0',
  'cc0 1.0': 'CC0-1.0',
  'public domain': 'CC0-1.0',
  'the unlicense': 'Unlicense',
  'wtfpl': 'WTFPL',

  // Boost / zlib / others
  'boost': 'BSL-1.0',
  'bsl': 'BSL-1.0',
  'zlib/libpng': 'Zlib',
  'python': 'Python-2.0',
  'psf': 'PSF-2.0',
  'artistic': 'Artistic-2.0',
};

const ALIASES = new Map<string, string>();
for (const [raw, spdx] of Object.entries(RAW_ALIASES)) {
  ALIASES.set(normalizeAliasKey(raw), spdx);
}

/** Resolve a normalized alias key to a canonical SPDX id, if known. */
export function resolveAlias(raw: string): string | undefined {
  return ALIASES.get(normalizeAliasKey(raw));
}

/** Export the seed pairs (raw → spdx) for D1 seeding. */
export function aliasSeedPairs(): Array<{ alias: string; spdxId: string }> {
  return Object.entries(RAW_ALIASES).map(([alias, spdxId]) => ({ alias, spdxId }));
}
