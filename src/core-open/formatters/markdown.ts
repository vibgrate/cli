// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import type { ScanArtifact } from '../types.js';

/** Generate a Markdown report from scan artifact */
export function formatMarkdown(artifact: ScanArtifact): string {
  const lines: string[] = [];

  // Billing (micro-project pricing) is a commercial signal attached by the full
  // scan; the open base scan omits it.
  const billing = artifact.billing;

  lines.push('# Vibgrate Drift Report');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| **Drift Score** | ${artifact.drift.score}/100 |`);
  lines.push(`| **Risk Level** | ${artifact.drift.riskLevel.toUpperCase()} |`);
  lines.push(`| **Projects** | ${artifact.projects.length} |`);
  if (billing) {
    lines.push(
      `| **Classification** | ${billing.nanoCount} nano · ${billing.microCount} micro · ${billing.smallCount} small · ${billing.standardCount} standard |`,
    );
    lines.push(
      `| **Billable Projects** | ${billing.billableProjects} (${billing.totalScanned} detected → ${billing.billableProjects} billable) |`,
    );
  }
  const scannedMeta: string[] = [artifact.timestamp];
  if (artifact.durationMs !== undefined) scannedMeta.push(`${(artifact.durationMs / 1000).toFixed(1)}s`);
  if (artifact.filesScanned !== undefined) scannedMeta.push(`${artifact.filesScanned} files`);
  if (artifact.treeSummary) scannedMeta.push(`${artifact.treeSummary.totalFiles.toLocaleString()} workspace files · ${artifact.treeSummary.totalDirs.toLocaleString()} dirs`);
  lines.push(`| **Scanned** | ${scannedMeta.join(' · ')} |`);
  if (artifact.vcs) {
    lines.push(`| **VCS** | ${artifact.vcs.type} |`);
    if (artifact.vcs.branch) lines.push(`| **Branch** | ${artifact.vcs.branch} |`);
    if (artifact.vcs.sha) lines.push(`| **Commit** | \`${artifact.vcs.shortSha}\` |`);
  }
  lines.push('');

  // Score breakdown
  lines.push('## Score Breakdown');
  lines.push('');
  lines.push(`| Component | Score |`);
  lines.push(`|-----------|-------|`);
  lines.push(`| Runtime | ${artifact.drift.components.runtimeScore} |`);
  lines.push(`| Frameworks | ${artifact.drift.components.frameworkScore} |`);
  lines.push(`| Dependencies | ${artifact.drift.components.dependencyScore} |`);
  lines.push(`| EOL Risk | ${artifact.drift.components.eolScore} |`);
  lines.push('');

  // Per project
  lines.push('## Projects');
  lines.push('');

  for (const project of artifact.projects) {
    lines.push(`### ${project.name} (${project.type})`);
    lines.push('');

    if (project.runtime) {
      const lag = project.runtimeMajorsBehind !== undefined && project.runtimeMajorsBehind > 0
        ? ` — ${project.runtimeMajorsBehind} major(s) behind`
        : ' — current';
      lines.push(`- **Runtime:** ${project.runtime}${lag}`);
    }

    if (project.frameworks.length > 0) {
      lines.push('- **Frameworks:**');
      for (const fw of project.frameworks) {
        const lag = fw.majorsBehind !== null
          ? (fw.majorsBehind === 0 ? 'current' : `${fw.majorsBehind} behind`)
          : 'unknown';
        lines.push(`  - ${fw.name}: ${fw.currentVersion ?? '?'} → ${fw.latestVersion ?? '?'} (${lag})`);
      }
    }

    const b = project.dependencyAgeBuckets;
    const total = b.current + b.oneBehind + b.twoPlusBehind + b.unknown;
    if (total > 0) {
      lines.push(`- **Dependencies:** ${b.current} current, ${b.oneBehind} 1-behind, ${b.twoPlusBehind} 2+ behind, ${b.unknown} unknown`);
    }

    lines.push('');
  }


  if (artifact.extended?.uiPurpose) {
    const up = artifact.extended.uiPurpose;
    lines.push('## Product Purpose Signals');
    lines.push('');
    lines.push(`- **Frameworks:** ${up.detectedFrameworks.length > 0 ? up.detectedFrameworks.join(', ') : 'unknown'}`);
    lines.push(`- **Evidence Items:** ${up.topEvidence.length}${up.capped ? ` (capped from ${up.evidenceCount})` : ''}`);
    if (up.topEvidence.length > 0) {
      lines.push('- **Top Evidence:**');
      for (const item of up.topEvidence.slice(0, 10)) {
        lines.push(`  - [${item.kind}] ${item.value} (${item.file})`);
      }
    }
    if (up.unknownSignals.length > 0) {
      lines.push('- **Unknowns:**');
      for (const u of up.unknownSignals.slice(0, 5)) {
        lines.push(`  - ${u}`);
      }
    }
    lines.push('');
  }
  // Recommended standards (purpose-matched)
  if (artifact.extended?.standards && artifact.extended.standards.recommended.length > 0) {
    const std = artifact.extended.standards;
    lines.push('## Recommended Standards');
    lines.push('');
    const purposes = std.projectPurposes.map((p) => `${p.project} → ${p.category}`).join(', ');
    if (purposes) lines.push(`- **Detected purpose:** ${purposes}`);
    if (std.frameworks.length > 0) {
      lines.push('- **Compliance framework coverage:**');
      for (const f of std.frameworks) {
        lines.push(`  - ${f.name}: ${f.recommendedMembers}/${f.totalMembers} member standards apply`);
      }
    }
    lines.push('- **Top standards to consider:**');
    for (const rec of std.recommended.slice(0, 10)) {
      const flag = rec.complianceRelevant ? ' _(compliance)_' : '';
      lines.push(`  - **${rec.name}** — ${rec.reason}${flag}`);
    }
    lines.push('');
  }
  // Findings
  if (artifact.findings.length > 0) {
    lines.push('## Findings');
    lines.push('');
    lines.push(`| Level | Rule | Message | Location |`);
    lines.push(`|-------|------|---------|----------|`);
    for (const f of artifact.findings) {
      const emoji = f.level === 'error' ? '🔴' : f.level === 'warning' ? '🟡' : '🔵';
      lines.push(`| ${emoji} ${f.level} | ${f.ruleId} | ${f.message} | ${f.location} |`);
    }
    lines.push('');
  }

  if (artifact.delta !== undefined) {
    const dir = artifact.delta > 0 ? '📈' : artifact.delta < 0 ? '📉' : '➡️';
    lines.push(`## Drift Delta: ${dir} ${artifact.delta > 0 ? '+' : ''}${artifact.delta} vs baseline`);
    lines.push('');
  }

  return lines.join('\n');
}
