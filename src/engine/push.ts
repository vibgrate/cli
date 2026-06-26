import { execFileSync } from 'node:child_process';
import type { VgGraph } from '../schema.js';

/**
 * The deferred, decoupled push envelope (VG-PACKAGE-AND-SCHEMA §7). In the open
 * CLI `vg push` is **specified but not built**: it assembles and redacts the
 * envelope and prints a notice, but performs **no network upload**. Nothing in
 * the free path depends on it. Drift-over-time/governance is the separate
 * commercial product.
 */

export interface GraphUploadEnvelope {
  schemaVersion: 'vg-graph/1.0';
  artifactType: 'graph';
  scanIngestId?: string;
  vcs: { sha: string; shortSha: string; branch: string };
  repository?: { name?: string; remoteUrl?: string };
  generatedAt: string;
  graph: VgGraph;
}

export function buildEnvelope(root: string, graph: VgGraph, scanIngestId?: string): GraphUploadEnvelope {
  const sha = git(root, ['rev-parse', 'HEAD']) ?? '0000000000000000000000000000000000000000';
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'HEAD';
  const remoteUrl = git(root, ['config', '--get', 'remote.origin.url']) ?? undefined;
  return {
    schemaVersion: 'vg-graph/1.0',
    artifactType: 'graph',
    scanIngestId,
    vcs: { sha, shortSha: sha.slice(0, 12), branch },
    repository: remoteUrl ? { remoteUrl: redactRemote(remoteUrl) } : undefined,
    generatedAt: graph.generatedAt,
    graph: redactGraph(graph),
  };
}

/**
 * Redaction pass (GUARDRAILS §1: redact before storage). The graph is structure,
 * not content, but we defensively scrub any signature/name that matches a
 * credential-shaped pattern, and strip credentials from the remote URL.
 */
export function redactGraph(graph: VgGraph): VgGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.signature && looksSecret(n.signature) ? { ...n, signature: '[redacted]' } : n)),
  };
}

const SECRET_RE =
  /(sk-[a-z0-9]{16,}|AKIA[0-9A-Z]{12,}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|[A-Za-z0-9+/]{40,}={0,2})/;

function looksSecret(s: string): boolean {
  return SECRET_RE.test(s);
}

function redactRemote(url: string): string {
  // Strip embedded credentials: https://user:token@host/… → https://host/…
  return url.replace(/\/\/[^@/]+@/, '//');
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}
