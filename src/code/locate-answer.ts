/**
 * Deterministic string/URL locate answers for VG Code.
 *
 * Local constrained models are forced onto PatchIR grammar for edits. That is
 * the wrong contract for "where is https://…?" — the model then dumps invalid
 * JSON into the panel. For pure locate asks we answer from the hybrid literal
 * sweep and never surface PatchIR or identifier-annotation noise.
 */

import { extractLiteralNeedles, isLocateOnlyInstruction } from '../engine/query.js';
import { searchSymbols, type TextHit } from '../engine/search.js';
import type { VgGraph } from '../schema.js';

export { isLocateOnlyInstruction };

export interface LocateAnswer {
  needle: string;
  hits: Array<{ file: string; line: number; preview: string }>;
  totalTextMatches: number;
  /** Human summary for the panel (finalText / assistant). */
  summary: string;
}

/** Prefer the longest extracted URL/quote; else the trimmed instruction. */
export function primaryLocateNeedle(instruction: string): string {
  const needles = extractLiteralNeedles(instruction);
  if (needles.length === 0) return instruction.trim();
  return [...needles].sort((a, b) => b.length - a.length)[0]!;
}

export function formatLocateAnswer(
  needle: string,
  hits: Array<{ file: string; line: number; preview: string }>,
  total: number,
): string {
  if (hits.length === 0) {
    return (
      `No occurrences of \`${needle}\` in this workspace.\n` +
      `(Literal search complete — 0 matches.)`
    );
  }
  const lines = hits.slice(0, 20).map((h) => `- ${h.file}:${h.line}  ${h.preview.trim().slice(0, 120)}`);
  const more =
    total > hits.length
      ? `\n… and ${total - hits.length} more (showing ${hits.length} of ${total}).`
      : total > 1
        ? `\n(${total} occurrence${total === 1 ? '' : 's'}.)`
        : '';
  return `Found \`${needle}\`:\n${lines.join('\n')}${more}`;
}

/**
 * Run the hybrid literal sweep and build a panel-ready locate answer.
 * Call only when {@link isLocateOnlyInstruction} is true.
 */
export async function answerLocateInstruction(
  graph: VgGraph,
  root: string,
  instruction: string,
  limit = 30,
): Promise<LocateAnswer> {
  const needle = primaryLocateNeedle(instruction);
  const result = await searchSymbols(graph, root, needle, limit);
  const hits = result.matches
    .filter((m): m is TextHit => m.kind === 'text')
    .map((m) => ({ file: m.file, line: m.line, preview: m.preview }));
  const total = result.totalTextMatches ?? hits.length;
  return {
    needle,
    hits,
    totalTextMatches: total,
    summary: formatLocateAnswer(needle, hits, total),
  };
}

/**
 * Strip model dump noise that must never be the panel's "answer":
 * PatchIR JSON blobs and `/* vg: unknown identifiers … *\/` annotations.
 */
export function sanitizeAgentDisplayText(text: string): string {
  if (!text) return text;
  let t = text.replace(/\n*\/\*\s*vg:\s*unknown identifiers[\s\S]*?\*\//gi, '').trim();
  // No-op / garbage PatchIR is not a user answer.
  if (
    /"schemaVersion"\s*:\s*"patch-ir\/0"/i.test(t) ||
    (/"op"\s*:\s*"replace-text"/i.test(t) && /"operations"\s*:/i.test(t))
  ) {
    return (
      'This looked like a locate/search question, but the model returned an edit payload instead of an answer. ' +
      'Ask again as “where is <url or string>?” — VG Code will use the literal search path.'
    );
  }
  return t;
}
