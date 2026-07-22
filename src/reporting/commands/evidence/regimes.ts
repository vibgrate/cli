// ── Bundled regime profiles ──
//
// A `regime` is a named reporting/obligation profile. Vibgrate Evidence is
// jurisdiction-neutral: the EU CRA is the first profile; other jurisdictions
// plug in as additional entries here (kept in sync with the reviewable spec in
// docs/regulatory-evidence/regimes/*.json). Adding a jurisdiction is data, not
// a new command.

import { CliError, ExitCode } from '../../../util/exit.js';
import type { Regime } from './types.js';

const INDICATIVE_DISCLAIMER =
  'Vibgrate produces evidence to support your obligations under the selected regime. ' +
  'It does not determine compliance, is not a certification, and is not legal advice. ' +
  'The scope determination, the "actively exploited" determination, and the filing ' +
  'decision are yours.';

export const REGIMES: Record<string, Regime> = {
  cra: {
    id: 'cra',
    name: 'EU Cyber Resilience Act',
    jurisdiction: 'EU · Regulation (EU) 2024/2847',
    obligation: 'art-14-reporting',
    status: 'draft',
    appliesFrom: '2026-09-11',
    clocks: [
      { stage: 'early-warning', label: 'Early warning', within: 'PT24H', from: 'awareness' },
      { stage: 'notification', label: 'Vulnerability / incident notification', within: 'PT72H', from: 'awareness' },
      {
        stage: 'final',
        label: 'Final report',
        within: 'P14D',
        from: 'corrective-measure',
        alt: { within: 'P1M', from: 'notification', when: 'severe-incident' },
      },
    ],
    submission: {
      target: 'ENISA Single Reporting Platform (Art. 16)',
      api: false,
      requires: ['member_states', 'coordinator_csirt', 'responsible_person'],
    },
    classifications: [
      { id: 'default', label: 'Default (self-assessment)', note: 'Products with digital elements not listed in Annex III/IV.' },
      { id: 'annex-iii-class-i', label: 'Annex III — Class I', note: 'Important products with digital elements, Class I.' },
      { id: 'annex-iii-class-ii', label: 'Annex III — Class II', note: 'Important products with digital elements, Class II.' },
      { id: 'annex-iv', label: 'Annex IV', note: 'Critical products with digital elements.' },
    ],
    requiredOutputFields: [
      'affected',
      'products',
      'versions_affected',
      'releases',
      'component_path',
      'member_states',
      'support_period_status',
      'reachability',
      'vex_status',
      'coordinator_csirt',
      'responsible_person',
      'evidence_id',
      'data_pack_version',
      'kernel_version',
      'generated_at',
    ],
    scopeAid: 'cra-scope',
    inScopeHint: [
      'embedded',
      'iot',
      'industrial-automation',
      'building-automation',
      'network-appliance',
      'security-appliance',
      'on-prem-software',
      'installable-software',
      'firmware',
      'component-placed-separately',
      'hybrid-with-installed-component',
    ],
    outOfScopeHint: ['browser-only-saas', 'standalone-paas', 'standalone-iaas'],
    disclaimer: INDICATIVE_DISCLAIMER,
    references: [
      { label: 'Regulation (EU) 2024/2847 (CRA)', url: 'https://eur-lex.europa.eu/eli/reg/2024/2847/oj' },
      { label: 'European Commission — CRA reporting obligations', url: 'https://digital-strategy.ec.europa.eu/en/policies/cra-reporting' },
    ],
  },
  'dora-incident': {
    id: 'dora-incident',
    name: 'DORA major ICT-related incident reporting',
    jurisdiction: 'EU · Regulation (EU) 2022/2554',
    obligation: 'art-19-major-incident-reporting',
    status: 'draft',
    appliesFrom: '2025-01-17',
    clocks: [
      { stage: 'initial-notification', label: 'Initial notification', within: 'PT24H', from: 'awareness' },
      { stage: 'intermediate-report', label: 'Intermediate report', within: 'P3D', from: 'awareness' },
      { stage: 'final-report', label: 'Final report', within: 'P1M', from: 'awareness' },
    ],
    submission: {
      target: "Relevant competent authority (per the ESAs' harmonised templates)",
      api: false,
      requires: ['competent_authority', 'responsible_person'],
    },
    classifications: [],
    requiredOutputFields: [
      'affected',
      'products',
      'versions_affected',
      'releases',
      'component_path',
      'reachability',
      'vex_status',
      'competent_authority',
      'responsible_person',
      'evidence_id',
      'data_pack_version',
      'kernel_version',
      'generated_at',
    ],
    scopeAid: 'dora-scope',
    inScopeHint: ['financial-entity-ict', 'critical-ict-third-party-provider'],
    outOfScopeHint: [],
    disclaimer: INDICATIVE_DISCLAIMER,
    references: [{ label: 'Regulation (EU) 2022/2554 (DORA)', url: 'https://eur-lex.europa.eu/eli/reg/2022/2554/oj' }],
  },
};

export const DEFAULT_REGIME = 'cra';

export function listRegimes(): Regime[] {
  return Object.values(REGIMES).sort((a, b) => a.id.localeCompare(b.id));
}

export function getRegime(id: string): Regime | undefined {
  return REGIMES[id];
}

/** Resolve a regime by id, or throw an actionable usage error listing options. */
export function resolveRegime(id: string): Regime {
  const regime = REGIMES[id];
  if (!regime) {
    const known = listRegimes()
      .map((r) => r.id)
      .join(', ');
    throw new CliError(`unknown regime "${id}" — available regimes: ${known}`, ExitCode.USAGE_ERROR);
  }
  return regime;
}
