import { describe, it, expect } from 'vitest';
import { rankDraftCandidates, pickBestDraft } from './speculative.js';

describe('speculative drafts', () => {
  it('ranks drafts that share tokens with the user ask', () => {
    const ranked = rankDraftCandidates(
      [
        'export function readConfig(): Config {',
        'export function unrelatedHelper() {',
        'short',
      ],
      [{ role: 'user', content: 'reproduce the signature for readConfig please' }],
      3,
    );
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].text).toMatch(/readConfig/);
    expect(ranked[0].score).toBeGreaterThan(0);
  });

  it('pickBestDraft returns null when no candidates', () => {
    expect(pickBestDraft([], [{ role: 'user', content: 'hi' }])).toBeNull();
  });

  it('fallback keeps candidates for quotational asks', () => {
    const ranked = rankDraftCandidates(
      ['export function foo(): void {'],
      [{ role: 'user', content: 'show me the export function signature' }],
      2,
    );
    expect(ranked.length).toBeGreaterThan(0);
  });
});
