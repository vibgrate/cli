/**
 * Whether to send a ranked Context Capsule, paste the mapped tree, or send
 * neither. Independent of Model Execution Profiles (those describe how a
 * local model is run). Mass × greppability, not file count.
 *
 * See docs/graph/VG-CAPSULE-SMALL-REPO-DISABLE.md.
 */

import { queryGraph } from '../engine/query.js';
import { userAskFromInstruction } from '../engine/user-ask.js';
import type { VgGraph } from '../schema.js';

export type CapsuleMode = 'off' | 'whole-repo' | 'compile';

/** Trees this small are cheaper to paste (or grep) than to rank. */
export const WHOLE_REPO_MAX_SOURCE_TOKENS = 1_500;
/** Above this, discovery has a real bill — always compile. */
export const COMPILE_MIN_SOURCE_TOKENS = 8_000;

export function estimateSourceTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Unique mapped paths from the graph, stable order. */
export function mappedFilePaths(graph: VgGraph): string[] {
  const files = new Set<string>();
  for (const n of graph.nodes) {
    const f = normalize(n.file);
    if (!f || skipMappedPath(f)) continue;
    files.add(f);
  }
  return [...files].sort();
}

export function sourceTokenMass(contents: Iterable<string>): number {
  let bytes = 0;
  for (const c of contents) bytes += c.length;
  return Math.ceil(bytes / 4);
}

/**
 * True when the mechanical fallback would pin an identifier the ask actually
 * names (F0/F1). Does not use the relevance module.
 */
export function askNamesSymbol(graph: VgGraph, instruction: string): boolean {
  const ask = userAskFromInstruction(instruction);
  const q = queryGraph(graph, ask, { budget: 400, limit: 8 });
  // Score 6 = camel-part; 10 = exact name. Substring hits (3) are not "named".
  return q.matches.some((m) => m.score >= 6);
}

export function capsuleMode(input: { sourceTokens: number; askNamesSymbol: boolean }): CapsuleMode {
  const mass = Math.max(0, input.sourceTokens);
  if (mass <= WHOLE_REPO_MAX_SOURCE_TOKENS) return 'whole-repo';
  if (mass > COMPILE_MIN_SOURCE_TOKENS) return 'compile';
  // Modest mass: greppable asks lose to grep (measured). Symptom-only in this
  // band is unmeasured — fail closed to off.
  if (input.askNamesSymbol) return 'off';
  return 'off';
}

export interface WholeRepoFile {
  path: string;
  content: string;
}

export interface WholeRepoPacket {
  rendered: string;
  tokensEstimate: number;
  files: string[];
  sourceTokens: number;
}

/**
 * First-turn packet = the mapped files, not a ranked dump. Files are sorted
 * by path. `budget` caps the paste (default {@link WHOLE_REPO_MAX_SOURCE_TOKENS});
 * at least one file is always included when any exist.
 */
export function buildWholeRepoPacket(
  instruction: string,
  files: WholeRepoFile[],
  budget: number = WHOLE_REPO_MAX_SOURCE_TOKENS,
): WholeRepoPacket {
  const sorted = [...files]
    .map((f) => ({ path: normalize(f.path), content: f.content }))
    .filter((f) => f.path && f.content.length > 0)
    .sort((a, b) => a.path.localeCompare(b.path));
  const sourceTokens = sourceTokenMass(sorted.map((f) => f.content));

  const lines: string[] = [
    '# Repository source (entire mapped tree)',
    '',
    'The files below are the repository. Use them; search or read outside only if they are insufficient.',
    '',
  ];
  const included: string[] = [];
  for (const f of sorted) {
    const block = [`### \`${f.path}\``, `\`\`\`${langFor(f.path)}`, f.content.replace(/\n$/, ''), '```', ''];
    const candidate = [...lines, ...block, '## Task', instruction].join('\n');
    if (included.length > 0 && estimateSourceTokens(candidate) > budget) break;
    lines.push(...block);
    included.push(f.path);
  }
  lines.push('## Task');
  lines.push(instruction);
  const rendered = lines.join('\n');
  return {
    rendered,
    tokensEstimate: estimateSourceTokens(rendered),
    files: included,
    sourceTokens,
  };
}

function skipMappedPath(file: string): boolean {
  return (
    file.startsWith('node_modules/') ||
    file.includes('/node_modules/') ||
    file.startsWith('.git/') ||
    file.startsWith('.vibgrate/')
  );
}

function normalize(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

function langFor(file: string): string {
  const ext = file.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'ts',
    tsx: 'tsx',
    js: 'js',
    jsx: 'jsx',
    mjs: 'js',
    cjs: 'js',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    cs: 'csharp',
    md: 'md',
    json: 'json',
  };
  return map[ext] ?? '';
}
