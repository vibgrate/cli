// ── Vibgrate Evidence — core types ──
//
// The regulatory-evidence product. Jurisdiction-neutral: reporting duties are
// modelled as `regime` profiles (the EU CRA is the first). Nothing in this
// module asserts compliance — it produces evidence and readiness signals only.
// See docs/REGULATORY-EVIDENCE-MODULE-ANALYSIS.md and docs/regulatory-evidence/.

/** The event a reporting clock counts from. `awareness` is the trap the whole
 *  module exists to solve: the clock starts at awareness, not at confirmation. */
export type ClockFrom = 'awareness' | 'notification' | 'corrective-measure' | 'placed-on-market';

export interface RegimeClock {
  /** Stage id, used as `--stage <stage>`. e.g. 'early-warning'. */
  stage: string;
  label: string;
  /** ISO 8601 duration for the deadline. e.g. 'PT24H', 'P14D'. */
  within: string;
  from: ClockFrom;
  /** An alternative deadline that applies under a stated condition. */
  alt?: { within: string; from: ClockFrom; when: string };
}

export interface RegimeSubmission {
  /** The platform/body a human submits to. */
  target: string;
  /** Whether a submission API exists. false ⇒ build the pack a human pastes in. */
  api: boolean;
  /** Filing inputs the human must supply/select, surfaced by the pack. */
  requires: string[];
}

export interface RegimeClassification {
  id: string;
  label: string;
  note?: string;
}

export interface RegimeReference {
  label: string;
  url: string;
}

/** A jurisdiction-neutral reporting/obligation profile. */
export interface Regime {
  id: string;
  name: string;
  jurisdiction: string;
  obligation: string;
  status: 'draft' | 'active' | 'superseded';
  appliesFrom?: string;
  clocks: RegimeClock[];
  submission: RegimeSubmission;
  classifications: RegimeClassification[];
  /** Fields the exposure determination must emit for this regime. */
  requiredOutputFields: string[];
  scopeAid?: string;
  inScopeHint: string[];
  outOfScopeHint: string[];
  /** The honest, per-regime disclaimer shown on every surface. */
  disclaimer: string;
  references: RegimeReference[];
}

// ── Local evidence state (persisted under .vibgrate/evidence/) ──

export interface ResponsiblePerson {
  name: string;
  role?: string;
  filingAuthority: boolean;
  outOfHoursContact?: string;
}

export interface EvidenceOrg {
  legalEntity?: string;
  mainEstablishment?: string;
  euAuthorisedRepresentative?: string;
  coordinatorCsirt?: string;
  responsiblePersons: ResponsiblePerson[];
  /** Default regime id used when `--regime` is omitted. */
  defaultRegime: string;
}

export interface SupportPeriod {
  declaredFrom?: string;
  declaredUntil?: string;
}

export interface Product {
  id: string;
  name: string;
  /** Regime-owned classification id (see Regime.classifications), or 'default'. */
  classification: string;
  scopeDetermination?: {
    inScope: boolean;
    rationale?: string;
    determinedBy?: string;
    determinedAt?: string;
  };
  memberStates: string[];
  supportPeriod?: SupportPeriod;
  /** Bindings to sources of truth (repo path / image ref / registry). */
  bindings: string[];
  createdAt: string;
}

/** A single frozen component in a shipped release manifest. */
export interface FrozenComponent {
  /** Package coordinate name. */
  name: string;
  /** The exact shipped/resolved version (never a range). */
  version: string;
  /** package-url, when derivable. */
  purl?: string;
  /** Ecosystem, e.g. npm / PyPI / Maven — drives OSV matching. */
  ecosystem?: string;
}

/** An immutable, frozen-at-ship-time release manifest. Never regenerated. */
export interface Release {
  productId: string;
  version: string;
  shipDate?: string;
  buildId?: string;
  /** sha256 (or other) digest of the shipped artefact. */
  artefactDigest?: string;
  manifestFormat: 'vibgrate-frozen-1' | 'cyclonedx' | 'spdx';
  components: FrozenComponent[];
  /** Distribution channels / markets, for the affected-population question. */
  distribution: string[];
  /** When this manifest was frozen (records the freeze, not the answer). */
  frozenAt: string;
}

// ── Advisory + exposure ──

export interface AdvisoryRange {
  /** Ecosystem the range applies to (matches FrozenComponent.ecosystem). */
  ecosystem?: string;
  /** Package name the range applies to. */
  package: string;
  /** semver introduced bound (inclusive). Omitted ⇒ from 0. */
  introduced?: string;
  /** semver fixed bound (exclusive). Omitted ⇒ unbounded. */
  fixed?: string;
  /** Explicit affected versions, in addition to the range. */
  versions?: string[];
}

export interface Advisory {
  id: string;
  publishedAt?: string;
  kevListedAt?: string;
  epss?: number;
  ranges: AdvisoryRange[];
  /** Where the advisory came from — provenance is part of the evidence. */
  sourceProvenance: string;
}

export type ExposureStatus = 'affected' | 'not-affected' | 'undetermined';

export interface AffectedRelease {
  version: string;
  shipDate?: string;
  buildId?: string;
  artefactDigest?: string;
  markets: string[];
  /** The transitive path to the vulnerable component, when known. */
  componentPath?: string[];
  matchedComponent: { name: string; version: string };
}

export type SupportStatus = 'in_support' | 'expired' | 'not_declared';

export interface ProductExposure {
  productId: string;
  productName: string;
  classification: string;
  status: ExposureStatus;
  /** Reason, always present when status is 'undetermined'. */
  reason?: string;
  affectedVersions: string[];
  releases: AffectedRelease[];
  memberStates: string[];
  supportStatus: SupportStatus;
  supportDetail?: string;
}

export interface ExposureResult {
  /** Stable schema version for the deterministic result document. */
  schemaVersion: 'evidence-1';
  regime: string;
  advisory: { id: string; sourceProvenance: string; kevListed: boolean };
  overallStatus: ExposureStatus;
  products: ProductExposure[];
  /** Filing context derived from org state + regime. */
  coordinatorCsirt?: string;
  responsiblePerson?: { name: string; filingAuthority: boolean };
  /** Reproducibility metadata. Kept OUT of the signed subject digest. */
  meta: {
    evidenceId: string;
    dataPackVersion: string;
    kernelVersion: string;
    /** RFC 3161 status: 'none' until a TSA is wired in — never faked. */
    timestamp: { source: 'local-clock' | 'rfc3161'; value: string };
  };
}
