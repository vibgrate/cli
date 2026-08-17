// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import type { ArchitectureResult, ArchitectureWorkspaceEdge, ProjectScan } from '../../types.js';
import { contractKindFromName, isContractBasename, isContractExtension } from './walker.js';

function normalizeRelPath(p: string): string {
  return (p || '.').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '') || '.';
}

function parentDir(projectPath: string): string {
  const n = normalizeRelPath(projectPath);
  if (n === '.') return '.';
  const i = n.lastIndexOf('/');
  return i < 0 ? '.' : n.slice(0, i);
}

function isContractish(result: ArchitectureResult, path: string): boolean {
  if (result.projectKind === 'contract' || result.artifactKind === 'contract') return true;
  const n = normalizeRelPath(path);
  return /(^|\/)(proto|contracts|api-specs?)(\/|$)/.test(n);
}

function isIacish(result: ArchitectureResult, path: string): boolean {
  if (result.projectKind === 'iac' || result.artifactKind === 'infrastructure-definition') return true;
  return /(^|\/)(infra|infrastructure|terraform|iac)(\/|$)/.test(normalizeRelPath(path));
}

function isAppish(result: ArchitectureResult): boolean {
  const kind = result.projectKind;
  return kind === 'web-api' || kind === 'web-app' || kind === 'cli' || kind === 'worker' || kind === 'library'
    || result.artifactKind === 'source'
    || (!kind && result.archetype !== 'unknown');
}

/**
 * Path / manifest workspace edges. Omit the field entirely when none fire.
 * Later PRs attach graph `deploys` / `provisions`; this records what folders
 * already make obvious (proto next to a service, infra next to an app).
 */
export function detectWorkspaceEdges(
  projects: readonly ProjectScan[],
  results: readonly ArchitectureResult[],
): ArchitectureWorkspaceEdge[] {
  if (projects.length === 0 || projects.length !== results.length) return [];
  const edges: ArchitectureWorkspaceEdge[] = [];
  const seen = new Set<string>();

  const push = (edge: ArchitectureWorkspaceEdge) => {
    const key = `${edge.kind}|${edge.fromProject}|${edge.toProject}|${edge.fromFile ?? ''}|${edge.toFile ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  for (let i = 0; i < projects.length; i++) {
    const from = projects[i]!;
    const fromResult = results[i]!;
    const fromParent = parentDir(from.path);
    for (let j = 0; j < projects.length; j++) {
      if (i === j) continue;
      const to = projects[j]!;
      const toResult = results[j]!;
      const sameParent = parentDir(to.path) === fromParent;
      const contractAtRoot = isContractish(toResult, to.path) &&
        /^(proto|contracts|api-specs?)(\/|$)/.test(normalizeRelPath(to.path));
      const iacAtRoot = isIacish(fromResult, from.path) &&
        /^(infra|infrastructure|terraform|iac)(\/|$)/.test(normalizeRelPath(from.path));

      if (isAppish(fromResult) && isContractish(toResult, to.path) && (sameParent || contractAtRoot)) {
        push({
          kind: 'implements-contract',
          fromProject: normalizeRelPath(from.path),
          toProject: normalizeRelPath(to.path),
          confidence: sameParent ? 0.72 : 0.64,
        });
      }
      if (isIacish(fromResult, from.path) && isAppish(toResult) && (sameParent || iacAtRoot)) {
        push({
          kind: 'provisions',
          fromProject: normalizeRelPath(from.path),
          toProject: normalizeRelPath(to.path),
          confidence: sameParent ? 0.68 : 0.6,
        });
      }
    }
  }

  return edges;
}

/** Same-project proto / openapi files → implements-contract (toFile set). */
export function detectLocalContractEdges(
  projectPath: string,
  files: readonly string[],
  projectKind: string | undefined,
): ArchitectureWorkspaceEdge[] {
  if (projectKind === 'contract' || projectKind === 'iac') return [];
  const edges: ArchitectureWorkspaceEdge[] = [];
  const prefix = normalizeRelPath(projectPath);
  for (const f of files) {
    const base = f.replace(/\\/g, '/').split('/').pop() ?? f;
    const ext = (() => {
      const i = f.lastIndexOf('.');
      return i >= 0 ? f.slice(i).toLowerCase() : '';
    })();
    if (!isContractExtension(ext) && !isContractBasename(base)) continue;
    if (!contractKindFromName(f, base)) continue;
    const toFile = prefix === '.' ? f.replace(/\\/g, '/') : `${prefix}/${f.replace(/\\/g, '/')}`;
    edges.push({
      kind: 'implements-contract',
      fromProject: prefix,
      toProject: prefix,
      toFile,
      confidence: 0.7,
    });
  }
  return edges;
}
