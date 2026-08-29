/**
 * Review output formats (spec §3).
 *
 *   text  — the human report on stderr-adjacent stdout
 *   json  — the receipt itself; the object `--push` sends
 *   sarif — **security findings only**, for GitHub code scanning. Architectural
 *           findings deliberately stay on the receipt and the Check summary:
 *           code scanning is a security surface and filling it with layering
 *           observations trains reviewers to ignore it.
 *   md    — the PR / Check summary
 */

import { c } from '../util/output.js';
import type { RunReviewResult } from './run.js';
import type { ReviewDecision, ReviewFinding, ReviewReceipt } from './schemas.js';

export type ReviewFormat = 'text' | 'json' | 'sarif' | 'md';

const DECISION_LABEL: Record<ReviewDecision, string> = {
  pass: 'pass',
  needs_review: 'needs review',
  fail: 'fail',
  undetermined: 'undetermined',
};

function colorDecision(decision: ReviewDecision): string {
  const label = DECISION_LABEL[decision];
  if (decision === 'pass') return c.green(label);
  if (decision === 'fail') return c.red(label);
  return c.yellow(label);
}

export function formatText(result: RunReviewResult): string {
  const { receipt, reasons, budget } = result;
  const lines: string[] = [];
  const all = [...receipt.findings.architecture_findings, ...receipt.findings.security_findings];

  lines.push(`${c.cyan('vg review')} · ${colorDecision(receipt.decision)} · ${receipt.enforcement}`);
  lines.push(
    c.dim(
      `  ${receipt.git.dirty ? 'working tree' : receipt.git.head_sha.slice(0, 8)} vs ${receipt.git.base_sha.slice(0, 8)}` +
        `${receipt.git.merge_base ? ' (merge-base)' : ''} · ${receipt.change_class.join(', ')}`,
    ),
  );
  lines.push('');

  if (all.length === 0) {
    lines.push(c.dim('  no architecture or security-control findings'));
  }
  for (const f of all) {
    const badge = f.protected_finding ? c.red('protected') : severityColor(f.severity);
    lines.push(`  ${c.bold(f.id)} ${badge} ${c.dim(f.kind)}`);
    lines.push(`    ${f.claim}`);
    lines.push(c.dim(`    → ${f.remediation}`));
    lines.push(
      c.dim(`    alignment ${f.target_alignment} · confidence ${f.confidence.toFixed(2)} · ${f.paths.slice(0, 3).join(', ')}`),
    );
    lines.push('');
  }

  if (receipt.findings.unknowns.length > 0) {
    lines.push(c.yellow('  unknowns'));
    for (const u of receipt.findings.unknowns) lines.push(c.dim(`    · ${u}`));
    lines.push('');
  }
  if (receipt.findings.required_checks.length > 0) {
    lines.push(c.dim(`  required checks: ${receipt.findings.required_checks.join(', ')}`));
  }

  lines.push(c.dim(`  policy: ${reasons.join('; ')}`));
  lines.push(
    c.dim(
      `  capsule ~${budget.estimatedTokens} tokens (median target ${budget.median}, cap ${budget.cap}${budget.trimmed ? ', trimmed' : ''})`,
    ),
  );
  lines.push(
    c.dim(
      `  ${receipt.versions.policy} · model ${receipt.versions.model} · graph ${receipt.versions.graph_schema} · ${receipt.digests.receipt.slice(0, 19)}…`,
    ),
  );
  lines.push(c.dim('  explain one: `vg review explain <finding-id>` · machine result: `vg review --format json`'));
  // The product does not certify. Say so where a human reads the result.
  lines.push(c.dim('  Review reports change integrity. It is not a proof of security and absence of findings is not a certification.'));
  return lines.join('\n');
}

function severityColor(severity: string): string {
  if (severity === 'critical' || severity === 'high') return c.red(severity);
  if (severity === 'medium') return c.yellow(severity);
  return c.dim(severity);
}

export function formatMarkdown(result: RunReviewResult): string {
  const { receipt, reasons } = result;
  const all = [...receipt.findings.architecture_findings, ...receipt.findings.security_findings];
  const lines: string[] = [];
  lines.push(`## Vibgrate Review — \`${DECISION_LABEL[receipt.decision]}\``);
  lines.push('');
  lines.push(
    `\`${receipt.git.base_sha.slice(0, 8)}\` → \`${receipt.git.head_sha.slice(0, 8)}\`${receipt.git.dirty ? ' (working tree)' : ''} · enforcement \`${receipt.enforcement}\``,
  );
  lines.push('');
  lines.push(
    `| architecture | security | protected | unknowns |\n|---:|---:|---:|---:|\n| ${receipt.counts.architecture} | ${receipt.counts.security} | ${receipt.counts.protected} | ${receipt.counts.unknowns} |`,
  );
  lines.push('');
  if (all.length === 0) {
    lines.push('No architecture or security-control findings.');
  } else {
    lines.push('| id | kind | severity | alignment | claim |');
    lines.push('|---|---|---|---|---|');
    for (const f of all) {
      const kind = f.protected_finding ? `${f.kind} **(protected)**` : f.kind;
      lines.push(`| \`${f.id}\` | ${kind} | ${f.severity} | ${f.target_alignment} | ${escapeCell(f.claim)} |`);
    }
  }
  if (receipt.findings.unknowns.length > 0) {
    lines.push('');
    lines.push('**Unknowns**');
    lines.push('');
    for (const u of receipt.findings.unknowns) lines.push(`- ${u}`);
  }
  lines.push('');
  lines.push(`<sub>${escapeCell(reasons.join('; '))}</sub>`);
  lines.push('');
  lines.push(
    `<sub>policy \`${receipt.versions.policy}\` · model \`${receipt.versions.model}\` · receipt \`${receipt.digests.receipt.slice(0, 23)}…\`</sub>`,
  );
  lines.push('');
  lines.push(
    '<sub>Vibgrate Review reports change integrity against the declared architecture and security controls. It does not prove code is secure, and absence of findings is not a certification.</sub>',
  );
  return lines.join('\n');
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** SARIF 2.1.0 over the security findings only. */
export function formatSarif(receipt: ReviewReceipt): string {
  const findings = receipt.findings.security_findings;
  const rules = [...new Map(findings.map((f) => [f.kind, f])).values()].map((f) => ({
    id: f.kind,
    name: f.kind,
    shortDescription: { text: f.kind.replace(/_/g, ' ') },
    fullDescription: { text: f.remediation },
    defaultConfiguration: { level: sarifLevel(f) },
    properties: { tags: ['security', 'vibgrate-review'] },
  }));
  return JSON.stringify(
    {
      $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'Vibgrate Review',
              version: receipt.versions.cli,
              informationUri: 'https://vibgrate.com/review',
              rules,
            },
          },
          automationDetails: { id: `vibgrate-review/${receipt.git.head_sha}` },
          results: findings.map((f) => ({
            ruleId: f.kind,
            level: sarifLevel(f),
            message: { text: f.claim },
            locations: f.paths.map((p) => ({
              physicalLocation: { artifactLocation: { uri: p } },
            })),
            properties: {
              findingId: f.id,
              confidence: f.confidence,
              targetAlignment: f.target_alignment,
              protectedFinding: f.protected_finding === true,
              remediation: f.remediation,
            },
          })),
        },
      ],
    },
    null,
    2,
  );
}

function sarifLevel(f: ReviewFinding): 'error' | 'warning' | 'note' {
  if (f.protected_finding || f.severity === 'critical' || f.severity === 'high') return 'error';
  if (f.severity === 'medium') return 'warning';
  return 'note';
}

/** `vg review explain <finding-id>` — the evidence behind one finding. */
export function formatExplain(result: RunReviewResult, findingId: string): string | null {
  const all = [...result.receipt.findings.architecture_findings, ...result.receipt.findings.security_findings];
  const finding = all.find((f) => f.id === findingId);
  if (!finding) return null;
  const lines: string[] = [];
  lines.push(`${c.bold(finding.id)} ${severityColor(finding.severity)} ${c.dim(finding.kind)}`);
  lines.push('');
  lines.push(`  ${finding.claim}`);
  lines.push('');
  lines.push(c.dim(`  remediation: ${finding.remediation}`));
  lines.push(c.dim(`  alignment:   ${finding.target_alignment}`));
  lines.push(c.dim(`  confidence:  ${finding.confidence.toFixed(2)}`));
  lines.push(c.dim(`  protected:   ${finding.protected_finding === true ? 'yes — policy cannot pass while it is unresolved' : 'no'}`));
  lines.push(c.dim(`  produced by: ${finding.source ?? 'scanner'}`));
  lines.push('');
  lines.push(c.dim('  evidence'));
  for (const id of finding.evidence_ids) {
    const e = result.capsule.evidence.find((x) => x.id === id);
    if (!e) {
      lines.push(c.red(`    ${id} — not present in the capsule (this finding failed verification)`));
      continue;
    }
    const span = e.start_line ? `:${e.start_line}${e.end_line && e.end_line !== e.start_line ? `-${e.end_line}` : ''}` : '';
    lines.push(`    ${c.bold(e.id)} ${c.dim(e.kind)} ${e.path ?? ''}${span}`);
    if (e.note) lines.push(c.dim(`      ${e.note}`));
  }
  return lines.join('\n');
}
