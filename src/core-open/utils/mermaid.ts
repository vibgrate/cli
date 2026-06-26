// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import type { ProjectScan, MermaidDiagram, SolutionScan } from '../types.js';

function sanitizeId(input: string): string {
  return input.replace(/[^a-zA-Z0-9_]/g, '_');
}

function escapeLabel(input: string): string {
  return input.replace(/"/g, '\\"');
}

function scoreClass(score: number | undefined): 'scoreHigh' | 'scoreModerate' | 'scoreLow' | 'scoreUnknown' {
  if (score === undefined || Number.isNaN(score)) return 'scoreUnknown';
  // Match dashboard thresholds: >= 80 green, >= 50 amber, < 50 red
  if (score >= 80) return 'scoreHigh';
  if (score >= 50) return 'scoreModerate';
  return 'scoreLow';
}

function nodeLabel(project: ProjectScan): string {
  const score = project.drift?.score;
  // Format: "Name (score)" matching dashboard display
  if (typeof score === 'number') {
    return `${project.name} (${score})`;
  }
  return project.name;
}

function buildDefs(): string[] {
  // Match dashboard card styling: bg-slate-800/60 with colored borders
  // Border colors: muted versions, hover would be brighter (but mermaid doesn't support hover states well)
  return [
    // Emerald border for high scores (>= 80) - border-emerald-500
    'classDef scoreHigh fill:#1e293b,stroke:#10b981,color:#f1f5f9,stroke-width:2px',
    // Amber border for moderate scores (50-79) - border-amber-500
    'classDef scoreModerate fill:#1e293b,stroke:#f59e0b,color:#f1f5f9,stroke-width:2px',
    // Red border for low scores (< 50) - border-red-500
    'classDef scoreLow fill:#1e293b,stroke:#ef4444,color:#f1f5f9,stroke-width:2px',
    // Slate border for unknown scores
    'classDef scoreUnknown fill:#1e293b,stroke:#64748b,color:#94a3b8,stroke-width:2px',
  ];
}

export function generateWorkspaceRelationshipMermaid(projects: ProjectScan[]): MermaidDiagram {
  const lines: string[] = ['flowchart LR'];
  const byPath = new Map(projects.map((p) => [p.path, p]));

  // Collect edges first so we can determine which nodes participate in relationships
  const edges: string[] = [];
  const connectedIds = new Set<string>();

  for (const project of projects) {
    const fromId = sanitizeId(project.projectId || project.path || project.name);
    for (const ref of project.projectReferences ?? []) {
      const target = byPath.get(ref.path);
      if (!target) continue;
      const toId = sanitizeId(target.projectId || target.path || target.name);
      edges.push(`${fromId} --> ${toId}`);
      connectedIds.add(fromId);
      connectedIds.add(toId);
    }
  }

  // When inter-project edges exist, show only connected nodes.
  // Otherwise show every project so the diagram is never empty.
  const showAll = connectedIds.size === 0;
  for (const project of projects) {
    const id = sanitizeId(project.projectId || project.path || project.name);
    if (!showAll && !connectedIds.has(id)) continue;
    lines.push(`${id}["${escapeLabel(nodeLabel(project))}"]`);
    lines.push(`class ${id} ${scoreClass(project.drift?.score)}`);
  }

  lines.push(...edges);
  lines.push(...buildDefs());
  return { mermaid: lines.join('\n') };
}

export function generateProjectRelationshipMermaid(project: ProjectScan, projects: ProjectScan[]): MermaidDiagram {
  const lines: string[] = ['flowchart LR'];
  const byPath = new Map(projects.map((p) => [p.path, p]));
  const parents = projects.filter((p) => p.projectReferences?.some((r) => r.path === project.path));
  const children = (project.projectReferences ?? []).map((r) => byPath.get(r.path)).filter((p): p is ProjectScan => Boolean(p));

  const centerId = sanitizeId(project.projectId || project.path || project.name);
  lines.push(`${centerId}["${escapeLabel(nodeLabel(project))}"]`);
  lines.push(`class ${centerId} ${scoreClass(project.drift?.score)}`);

  for (const parent of parents) {
    const id = sanitizeId(parent.projectId || parent.path || parent.name);
    lines.push(`${id}["${escapeLabel(nodeLabel(parent))}"]`);
    lines.push(`class ${id} ${scoreClass(parent.drift?.score)}`);
    lines.push(`${id} --> ${centerId}`);
  }

  for (const child of children) {
    const id = sanitizeId(child.projectId || child.path || child.name);
    lines.push(`${id}["${escapeLabel(nodeLabel(child))}"]`);
    lines.push(`class ${id} ${scoreClass(child.drift?.score)}`);
    lines.push(`${centerId} --> ${id}`);
  }

  lines.push(...buildDefs());
  return { mermaid: lines.join('\n') };
}


export function generateSolutionRelationshipMermaid(solution: SolutionScan, projects: ProjectScan[]): MermaidDiagram {
  const lines: string[] = ['flowchart TB'];
  const solutionNodeId = sanitizeId(solution.solutionId || solution.path || solution.name);
  const solutionScore = solution.drift?.score;
  const solutionScoreText = typeof solutionScore === 'number' ? ` (${solutionScore})` : ' (n/a)';
  lines.push(`${solutionNodeId}["${escapeLabel(`${solution.name}${solutionScoreText}`)}"]`);
  lines.push(`class ${solutionNodeId} ${scoreClass(solutionScore)}`);

  const projectByPath = new Map(projects.map((p) => [p.path, p]));
  for (const projectPath of solution.projectPaths) {
    const project = projectByPath.get(projectPath);
    if (!project) continue;
    const projectNodeId = sanitizeId(project.projectId || project.path || project.name);
    lines.push(`${projectNodeId}["${escapeLabel(nodeLabel(project))}"]`);
    lines.push(`class ${projectNodeId} ${scoreClass(project.drift?.score)}`);
    lines.push(`${solutionNodeId} --> ${projectNodeId}`);

    for (const ref of project.projectReferences ?? []) {
      const target = projectByPath.get(ref.path);
      if (!target) continue;
      const toId = sanitizeId(target.projectId || target.path || target.name);
      lines.push(`${projectNodeId} --> ${toId}`);
    }
  }

  lines.push(...buildDefs());
  return { mermaid: lines.join('\n') };
}
