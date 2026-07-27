/**
 * Speculative draft ranking + multi-candidate accept (Approach B / P2).
 *
 * Graph-verbatim drafts (signatures, imports) are ranked against the last user
 * turn; the host tries accept in rank order until one evaluates cleanly.
 */

import type { LlmChatMessage } from './types.js';

export interface RankedDraft {
  text: string;
  score: number;
  reason: string;
}

/**
 * Rank draft candidates for the current user ask. Higher score first.
 */
export function rankDraftCandidates(
  candidates: string[] | undefined,
  messages: LlmChatMessage[],
  max = 3,
): RankedDraft[] {
  if (!candidates?.length) return [];
  const last = messages[messages.length - 1]?.content?.toLowerCase() ?? '';
  const ranked: RankedDraft[] = [];

  for (const raw of candidates) {
    const d = raw.trim();
    if (d.length < 8) continue;
    let score = 0;
    const reasons: string[] = [];
    const head = d.slice(0, 48).toLowerCase().replace(/\s+/g, ' ');
    const tokens = head.split(/[^a-z0-9_]+/).filter((t) => t.length > 3);
    for (const t of tokens) {
      if (last.includes(t)) {
        score += 3;
        reasons.push(`token:${t}`);
      }
    }
    if (/\b(signature|import|export function|export class|implements|extends)\b/i.test(last)) {
      score += 2;
      reasons.push('quotational-ask');
    }
    if (/^export\s+(async\s+)?(function|class|const|type|interface)\b/.test(d)) {
      score += 1;
      reasons.push('export-shape');
    }
    if (score > 0) {
      ranked.push({ text: d, score, reason: reasons.join(',') || 'match' });
    }
  }

  // If nothing scored but ask looks quotational, keep top candidates at low score.
  if (ranked.length === 0 && /\b(signature|import|export function|export class)\b/i.test(last)) {
    for (const d of candidates.slice(0, max)) {
      if (d.trim().length >= 8) ranked.push({ text: d.trim(), score: 1, reason: 'fallback-quotational' });
    }
  }

  return ranked.sort((a, b) => b.score - a.score || b.text.length - a.text.length).slice(0, max);
}

/** Pick a single best draft (back-compat with P1 pickDraft). */
export function pickBestDraft(candidates: string[] | undefined, messages: LlmChatMessage[]): string | null {
  return rankDraftCandidates(candidates, messages, 1)[0]?.text ?? null;
}
