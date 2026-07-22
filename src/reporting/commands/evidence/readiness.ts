// ── Deterministic readiness gap report ──
//
// Maps each finding to the obligation it serves and states plainly where the
// gap is and the exact command to fix it. Readiness SIGNALS only — never an
// audit result or an assertion of compliance.

import type { EvidenceOrg, Product, Regime, Release } from './types.js';

export type ReadinessStatus = 'ready' | 'gap' | 'n/a';

export interface ReadinessItem {
  id: string;
  label: string;
  status: ReadinessStatus;
  detail: string;
  /** The exact command to close a fixable gap, when there is one. */
  fix?: string;
}

export interface ReadinessReport {
  regime: string;
  score: number; // 0–100 over assessable items
  assessable: number;
  ready: number;
  items: ReadinessItem[];
  disclaimer: string;
}

export interface ReadinessInput {
  regime: Regime;
  org: EvidenceOrg;
  products: Product[];
  releasesByProduct: Map<string, Release[]>;
  /** Whether at least one drill was run in the last 90 days (from local records). */
  recentDrill?: boolean;
}

export function computeReadiness(input: ReadinessInput): ReadinessReport {
  const { org, products, releasesByProduct } = input;
  const items: ReadinessItem[] = [];

  items.push(
    products.length > 0
      ? { id: 'product-inventory', label: 'Product inventory of products with digital elements', status: 'ready', detail: `${products.length} product(s) registered` }
      : { id: 'product-inventory', label: 'Product inventory of products with digital elements', status: 'gap', detail: 'no products registered', fix: 'vg evidence product add <name>' },
  );

  const noScope = products.filter((p) => !p.scopeDetermination);
  items.push(
    products.length === 0
      ? { id: 'scope-determination', label: 'Scope determination recorded per product', status: 'n/a', detail: 'no products yet' }
      : noScope.length === 0
        ? { id: 'scope-determination', label: 'Scope determination recorded per product', status: 'ready', detail: 'all products have a recorded scope determination' }
        : { id: 'scope-determination', label: 'Scope determination recorded per product', status: 'gap', detail: `${noScope.length} product(s) without a scope determination`, fix: 'vg evidence product add <name> --in-scope --rationale "…"' },
  );

  const boundNoManifest = products.filter((p) => p.bindings.length > 0 && (releasesByProduct.get(p.id) ?? []).length === 0);
  items.push(
    products.length === 0
      ? { id: 'frozen-manifests', label: 'Frozen component manifest for every shipped release', status: 'n/a', detail: 'no products yet' }
      : boundNoManifest.length === 0
        ? { id: 'frozen-manifests', label: 'Frozen component manifest for every shipped release', status: 'ready', detail: 'every bound product has at least one frozen release' }
        : { id: 'frozen-manifests', label: 'Frozen component manifest for every shipped release', status: 'gap', detail: `${boundNoManifest.length} bound product(s) with no frozen release`, fix: 'vg evidence release <product> <version> --from <sbom-or-scan>' },
  );

  const noSupport = products.filter((p) => !p.supportPeriod?.declaredUntil);
  items.push(
    products.length === 0
      ? { id: 'support-period', label: 'Support period declared per product', status: 'n/a', detail: 'no products yet' }
      : noSupport.length === 0
        ? { id: 'support-period', label: 'Support period declared per product', status: 'ready', detail: 'all products declare a support period' }
        : { id: 'support-period', label: 'Support period declared per product', status: 'gap', detail: `${noSupport.length} product(s) without a declared support period`, fix: 'vg evidence support-period <product> --until <YYYY-MM-DD>' },
  );

  const noMarkets = products.filter((p) => p.memberStates.length === 0);
  items.push(
    products.length === 0
      ? { id: 'markets', label: 'Markets recorded per product', status: 'n/a', detail: 'no products yet' }
      : noMarkets.length === 0
        ? { id: 'markets', label: 'Markets recorded per product', status: 'ready', detail: 'all products record their markets' }
        : { id: 'markets', label: 'Markets recorded per product', status: 'gap', detail: `${noMarkets.length} product(s) with no markets recorded`, fix: 'vg evidence product add <name> --markets DE,FR' },
  );

  items.push(
    org.coordinatorCsirt
      ? { id: 'coordinator-csirt', label: 'Coordinator CSIRT identified', status: 'ready', detail: org.coordinatorCsirt }
      : { id: 'coordinator-csirt', label: 'Coordinator CSIRT identified', status: 'gap', detail: 'no coordinator CSIRT set', fix: 'vg evidence init --coordinator <csirt>' },
  );

  const filer = org.responsiblePersons.find((p) => p.filingAuthority);
  items.push(
    filer
      ? { id: 'filing-authority', label: 'Named individual with filing authority', status: 'ready', detail: filer.name }
      : { id: 'filing-authority', label: 'Named individual with filing authority', status: 'gap', detail: 'no responsible person with filing authority', fix: 'vg evidence init --responsible "<name>" --filing-authority' },
  );

  items.push(
    filer?.outOfHoursContact
      ? { id: 'out-of-hours', label: 'Out-of-hours escalation contact', status: 'ready', detail: filer.outOfHoursContact }
      : { id: 'out-of-hours', label: 'Out-of-hours escalation contact', status: 'gap', detail: 'no out-of-hours contact for the filing person', fix: 'vg evidence init --responsible "<name>" --filing-authority --ooo "<contact>"' },
  );

  items.push(
    input.recentDrill === undefined
      ? { id: 'recent-drill', label: 'A drill in the last 90 days', status: 'n/a', detail: 'no local drill records found — run one', fix: 'vg evidence drill' }
      : input.recentDrill
        ? { id: 'recent-drill', label: 'A drill in the last 90 days', status: 'ready', detail: 'a recent drill is on record' }
        : { id: 'recent-drill', label: 'A drill in the last 90 days', status: 'gap', detail: 'no drill in the last 90 days', fix: 'vg evidence drill' },
  );

  const assessableItems = items.filter((i) => i.status !== 'n/a');
  const ready = assessableItems.filter((i) => i.status === 'ready').length;
  const score = assessableItems.length === 0 ? 0 : Math.round((ready / assessableItems.length) * 100);

  return {
    regime: input.regime.id,
    score,
    assessable: assessableItems.length,
    ready,
    items,
    disclaimer: input.regime.disclaimer,
  };
}
