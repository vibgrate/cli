# Vibgrate scoring methodology (public specification)

**Audience:** the public GitHub repository (`github.com/vibgrate/cli`) and anyone
evaluating how Vibgrate measures software drift and risk.
**Posture:** *disclosed factors, disclosed formulas, disclosed bands — proprietary
calibration.* Everything needed to understand and sanity-check a score is here;
the tuned constants and breaking-change corpus stay proprietary (the credit-bureau
model). This is the technical companion to the overview pages at
[vibgrate.com/driftscore](https://vibgrate.com/driftscore),
[vibgrate.com/riskscore](https://vibgrate.com/riskscore), and
[vibgrate.com/driftrisk](https://vibgrate.com/driftrisk).

Vibgrate publishes **three** numbers. Two are independent measurements on
different axes; the third is a derived headline. Keeping them separate is the
whole point — a stale-but-safe stack and a current-but-exploited stack are
different problems and get different numbers.

| Score | Axis | Scale | Trademark | Methodology tag |
|---|---|---|---|---|
| **DriftScore** | Maintainability / currency | 0 = current (best) → 100 = max drift (worst) | No | `driftscore-N` |
| **RiskScore** | Security & business exposure | 0 = safe (best) → 100 = max risk (worst) | No | `riskscore-N` |
| **DriftRisk™** | Combined executive headline | 0 → 100 (more = more pressure to act) | **Yes** (Vibgrate) | `driftrisk-N` |

> **Trademark:** *DriftRisk* is a trademark of Vibgrate; the **algorithm is open
> source** and specified in full below. *DriftScore* and *RiskScore* are not
> trademarked. Every emitted score carries its methodology tag so two numbers are
> only ever compared across matching methodologies.
>
> **Availability:** **DriftScore is free** and computed by the CLI (offline).
> **RiskScore and DriftRisk are premium and [Vibgrate Cloud](https://vibgrate.com/cloud)-only** — they require a
> completed scan ingestion (server-side security data + the blend), so they appear
> in the dashboard, never in the free/offline CLI output.

---

## 1. DriftScore — maintainability drift (`driftscore-3.0`)

**What it answers:** how far has this stack drifted from current, supported,
maintainable baselines? It is *version/time distance*, not consequence — a
DriftScore of 0 says nothing about whether a current package has a CVE (that is
RiskScore's job).

Four weighted pillars, computed on a health scale and emitted as drift (0 = no
drift). Weight is redistributed across whichever pillars have data, so a scan
with no runtime metadata is not unfairly penalised.

| Pillar | Weight | Input |
|---|---:|---|
| Runtime | 0.25 | Runtime major/minor lag + real EOL date (endoflife.date) |
| Framework | 0.25 | Major-version lag for detected frameworks (worst + average blend) |
| Dependency | 0.30 | Per-dependency drift (see §1.1) |
| Support / EOL | 0.20 | Real end-of-life dates for runtimes (expanding to base images, DB engines, infra) |

Bands: **0–30 low · 31–60 moderate · 61–100 high**. Badge colours: 0–20 green ·
21–50 amber · 51–100 red.

### 1.1 Dependency drift — libyear backbone

Each dependency is scored 0–100 (0 = current) as a blend of **time** and
**version** distance, because major-version count alone is not comparable across
ecosystems with different release cadences:

```
T = min(100, 25 · libyears)                 # calendar-time distance (the backbone)
V = versionDriftPoints(majorsBehind, band)  # semver distance (fallback / complement)

drift = clamp( 0.55·T + 0.45·V )            # Verified (release dates present)
      = V                                    # Estimated (version-only, no dates)

floors: unsupported/EOL major ⇒ drift ≥ 70 ; abandoned (no release ~24mo) ⇒ ≥ 50
```

A **libyear** (Cox et al., ICSE 2015) is the calendar time between the version you
use and the latest stable — the established, ecosystem-comparable freshness unit.

Portfolio aggregation surfaces the tail instead of hiding it in a mean:

```
DriftScore(dependency) = 0.5·weightedMean + 0.3·p95 + 0.2·(unsupported_share·100)
```

Direct/production dependencies weight above transitive/dev. Four data-quality
guards handle real-registry pathologies: canary "latest" versions (e.g.
`1000.0.0`), version-scheme jumps, squatted builtin stubs (`fs`, `crypto`), and
high-cadence packages (`@aws-sdk/*` daily minors).

### 1.2 Provenance — Verified vs Estimated

Every score is a function of `(lockfile@commit, snapshot@date)` and stamped with
both. **Verified** = release-date data was available (online or from a vendored
dated snapshot — offline is *not* Estimated). **Estimated** = version-only, shown
as `~NN`. A separate `confidence` field reports the fraction of dependencies that
resolved, so a low-coverage scan cannot masquerade as clean.

---

## 2. RiskScore — security & business risk (`riskscore-1.0`)

**What it answers:** what is the probability and consequence of harm right now?
Deliberately inverted from DriftScore (higher = worse) so the two can never be
confused.

### 2.1 The evidence hierarchy (why each source gets the role it does)

The defining principle: **weight each signal by the strength of the evidence it
carries — and let observed exploitation act as an override, not a weight.** This
mirrors the modern consensus (KEV → EPSS → SSVC) and the field's explicit move
*away* from CVSS-severity-first triage (CVSS is severity, "not a measure of
risk"; dual-scored CVEs diverge >50% of the time).

| Source | Role in RiskScore | Why this role |
|---|---|---|
| **CISA KEV** + **NIST LEV Composite** (`max(EPSS, KEV, LEV)`) | **Override / floor** → critical | Observed in-the-wild exploitation is ground truth. A floor is stronger than any weight and cannot be diluted. LEV backstops KEV's known incompleteness. |
| **EPSS v4** | **Primary likelihood** (dominant weight) | Best forward predictor of 30-day exploitation; far higher efficiency than CVSS≥7 triage. Probabilistic and CVE-only, so it informs, not decides. |
| **CVSS base** | **Capped severity multiplier** (secondary) | Severity ≠ likelihood, and NVD coverage has collapsed (see §2.2). Scales *impact*; never reaches "critical" on its own. |
| **EOL / deprecated** | **Exposure floor** | No patches available = standing exposure independent of any single CVE. |
| **Business criticality / reachability** (SSVC-style) | **Context multiplier / gate** | The same CVE is not the same risk in a payment service vs an unreachable transitive dependency. |

Independent findings combine with a **probabilistic OR** so many low-risk findings
never outweigh a single actively-exploited one. Bands: **0–19 low · 20–49
moderate · 50–79 high · 80–100 critical**. Every RiskScore decomposes into its top
contributing findings (explainable, or it is not publishable).

**Base vs context-applied (one name).** The above is the **base** RiskScore —
repo-agnostic (what a CVE means in general). When a repo is scanned, the same
RiskScore becomes **context-applied**: **reachability** (is the vulnerable code
actually called?) adjusts *likelihood* and **business criticality** adjusts
*impact* — the CVSS Base-vs-Environmental distinction, surfaced as a marker plus
the listed factors, not a separate name. Reachability only ever de-prioritises with
a floor (never suppresses; `unknown ≠ safe`), and can never pull an
actively-exploited finding below its critical floor. The server-side pipeline
behind this (symbol data, preflight, feed-driven re-assessment) is proprietary;
its inputs and roles are fully described above.

### 2.2 Data-source robustness

A score is only as trustworthy as its feeds, so the sourcing is part of the
methodology, not an implementation detail:

- **Vulnerabilities + CVSS come from the OSV ∪ GHSA union, not NVD alone.** NVD's
  enrichment has collapsed (a minority of recent CVEs fully analysed; from 2026
  NVD enriches only KEV / federal / EO-critical CVEs). OSV/GHSA give materially
  better coverage, version-range and fix-version completeness, and freshness for
  open-source dependencies.
- **Exploitation** = CISA KEV plus the NIST LEV Composite (`max(EPSS, KEV, LEV)`).
- **EOL** = endoflife.date / vendor lifecycle data.
- **Every feed's snapshot date is recorded on the score** so it is reproducible
  and its provenance is auditable.

The *calculation* is pure and deterministic; the *data* (OSV/GHSA, EPSS, KEV, LEV,
EOL) is gathered server-side and is a premium feature.

---

## 3. DriftRisk™ — the combined headline (`driftrisk-1.1`)

**What it answers:** how much pressure is this codebase putting on the team to
act? A single number for executives — but a **pure, derived** function of the two
published axes that never feeds back into either.

**Evidence-tiered dynamic weighting.** Risk's pull grows with the *RiskScore
band*, so a serious security posture emphasises risk instead of being averaged
down. Because the RiskScore band is itself evidence-weighted (§2 — KEV/LEV drive
the critical band, EPSS drives likelihood, CVSS is only a capped multiplier),
tiering on the band means DriftRisk emphasises **real exploitation evidence, not
raw CVSS severity**:

```
band      = riskBand(RiskScore)                 # low | moderate | high | critical
wR        = { low .40 · moderate .50 · high .65 · critical .80 }[band]
raw       = min(100, 0.55·DriftScore + wR·RiskScore + 0.15·min(DriftScore, RiskScore))
DriftRisk = min(100, max(raw, floor[band]))     # floor: high → 55, critical → 80
```

- **Drift weight is fixed at 0.55 and never reallocated** — that, plus a risk
  weight and floor that only ever *rise* with the band, makes DriftRisk provably
  **monotonic** (raising either score can never lower it) and **sortable** (one
  global function, so leaderboards stay comparable).
- The **floor ladder generalises the v1.0 KEV/Risk-critical override** (its top
  rung): an actively-exploited CVE (RiskScore ≥ 80) floors DriftRisk at 80, so a
  live security emergency never reads green because upgrade debt is low.
- The `0.15·min(…)` term is a **danger-zone amplifier** — it only lifts the score
  when *both* axes are bad.

Bands: **0–30 low · 31–60 moderate · 61–100 high**.

**Display convention.** Use the DriftRisk *scalar* for ranking and badges; show
the **`Drift · Risk` pair beside it** for reading (`Drift 40 · Risk 60 · DriftRisk
67`), and keep the full breakdown one click away. A space-constrained surface (a
badge, a table cell) may show the scalar alone as long as the breakdown is
reachable. CI gates should fire on the axis that matters, not on the blend.

### 3.1 The 2×2 it expresses

| DriftScore | RiskScore | DriftRisk | Meaning | Action |
|:--:|:--:|:--:|---|---|
| low | low | low | current & safe | maintain |
| **low** | **high/critical** | **high (floor)** | current stack, active CVE | **patch now** |
| high | low | moderate | falling behind, no exploit yet | plan the upgrade |
| high | high | high | stale *and* exploitable | escalate |

---

## 4. Worked examples (`driftrisk-1.1`)

The tiering is what makes risk emphasis follow real evidence:

| DriftScore | RiskScore (band) | wR | raw | floor | **DriftRisk** | Read |
|:--:|:--:|:--:|:--:|:--:|:--:|---|
| 90 | 10 (low) | .40 | 55 | 0 | **55** | pure upgrade backlog — drift leads |
| 74 | 22 (moderate) | .50 | 55 | 0 | **55** | mild risk, drift still leads |
| 40 | 60 (high) | .65 | 67 | 55 | **67** | **risk now clearly leads** (flat v1.0 blend was 49) |
| 15 | 60 (high) | .65 | 49.5 | 55 | **55** | floor catches low-drift/high-risk |
| 12 | 80 (critical) | .80 | 71 | 80 | **80** | actively exploited → risk dominates; patch now |
| 90 | 95 (critical) | .80 | 100 | 80 | **100** | stale *and* exploited |

Why the source hierarchy matters — the same CVE, different evidence, feeding the
RiskScore band above (at DriftScore 30):

| CVE | CVSS | EPSS | KEV? | → RiskScore band | DriftRisk |
|---|:--:|:--:|:--:|---|:--:|
| theoretical critical | 9.8 | 0.02 | no | moderate | ~35 — *not* risk-dominated |
| exploited medium | 6.5 | 0.4 | **yes** | critical (floor 80) | **80** — exploitation trumps severity |

A 9.8 nobody exploits does not hijack the headline; a 6.5 that is actively
exploited does.

---

## 5. What is published vs proprietary

**Published (this document + [vibgrate.com](https://vibgrate.com)):** the axes and their philosophy,
every factor and data source, the formulas, the bands, worked examples, the
methodology versions and changelog, and the coverage/confidence semantics.

**Proprietary:** the exact calibration constants and weight vectors, the
breaking-change intelligence corpus, and any empirical tuning dataset — the same
disclosure posture used by credit bureaus and OpenSSF Scorecard-adjacent tools.

## 6. Versioning

Methodology tags (`driftscore-3.0`, `riskscore-1.0`, `driftrisk-1.1`) bump **only**
when the formula or weighting changes — never for routine CLI releases — so
dashboards never draw a trend line across a methodology change. The full design
rationale, sources, and limitations are in the accompanying whitepaper,
[`RISK-MODELLING-WHITEPAPER.md`](https://github.com/vibgrate/cli/blob/main/docs/public/RISK-MODELLING-WHITEPAPER.md).
