// ── Submission pack ──
//
// There is no submission API for the CRA (ENISA SRP is manual), so we build the
// pack a human pastes in. Every free-text narrative field is labelled
// `model-drafted, human-review-required` — no model touches a number.

import type { ExposureResult, Regime, EvidenceOrg } from './types.js';

export function buildPack(result: ExposureResult, regime: Regime, org: EvidenceOrg, stage: string): string {
  const clock = regime.clocks.find((c) => c.stage === stage);
  const affected = result.products.filter((p) => p.status === 'affected');
  const undetermined = result.products.filter((p) => p.status === 'undetermined');
  const L: string[] = [];

  L.push(`# ${regime.name} — submission pack (${stage})`);
  L.push('');
  L.push(`> Prepared by Vibgrate Evidence. **This is evidence and a draft, not a filing.** Your`);
  L.push(`> named person reviews, completes the model-drafted narrative, and submits it to`);
  L.push(`> ${regime.submission.target}. Vibgrate does not determine compliance and is not legal advice.`);
  L.push('');
  L.push('## Filing context');
  L.push('');
  L.push(`- Regime: ${regime.name} (${regime.jurisdiction})`);
  if (clock) L.push(`- Stage: ${clock.label} — due within ${clock.within} of ${clock.from.replace('-', ' ')}`);
  L.push(`- Advisory: ${result.advisory.id}${result.advisory.kevListed ? ' (KEV-listed)' : ''} — ${result.advisory.sourceProvenance}`);
  L.push(`- Coordinator / authority: ${result.coordinatorCsirt ?? '⚠ NOT SET — vg evidence init --coordinator'}`);
  L.push(`- Responsible person: ${result.responsiblePerson ? `${result.responsiblePerson.name} (filing authority: ${result.responsiblePerson.filingAuthority ? 'yes' : 'no'})` : '⚠ NOT SET'}`);
  L.push(`- Evidence id: ${result.meta.evidenceId} · kernel ${result.meta.kernelVersion} · data-pack ${result.meta.dataPackVersion}`);
  L.push(`- Generated at: ${result.meta.timestamp.value} (${result.meta.timestamp.source})`);
  L.push('');

  L.push('## Affected products (from frozen release manifests)');
  L.push('');
  if (affected.length === 0) {
    L.push('_No affected shipped release identified._');
  } else {
    L.push('| Product | Classification | Shipped versions | Markets | Support |');
    L.push('|---|---|---|---|---|');
    for (const p of affected) {
      L.push(`| ${p.productName} | ${p.classification} | ${p.affectedVersions.join(', ')} | ${p.memberStates.join(' ')} | ${p.supportDetail ?? p.supportStatus} |`);
    }
  }
  L.push('');

  if (undetermined.length) {
    L.push('## ⚠ Undetermined — manual review required before filing');
    L.push('');
    for (const p of undetermined) L.push(`- ${p.productName}: ${p.reason}`);
    L.push('');
  }

  L.push('## Required fields for this regime');
  L.push('');
  for (const field of regime.submission.requires) {
    L.push(`- [ ] ${field.replace(/_/g, ' ')}`);
  }
  L.push('');

  L.push('## Narrative — `model-drafted, human-review-required`');
  L.push('');
  L.push('> The fields below are the only place a language model may assist. They contain');
  L.push('> **no numbers, versions, dates, or scope determinations** — those come solely from');
  L.push('> the deterministic evidence above. Review and rewrite before submitting.');
  L.push('');
  L.push('- **Nature of the vulnerability / incident:** _[model-drafted, human-review-required]_');
  L.push('- **Impact and severity assessment:** _[model-drafted, human-review-required]_');
  L.push('- **Mitigations and corrective measures:** _[model-drafted, human-review-required]_');
  L.push('- **Affected user population and notification plan:** _[model-drafted, human-review-required]_');
  L.push('');
  L.push('---');
  L.push('');
  L.push(regime.disclaimer);
  L.push('');
  return L.join('\n');
}
