import { describe, it, expect } from 'vitest';
import { userAskFromInstruction, rankingAskFrom, USER_ATTACHMENTS_HEADING_PREFIX } from './user-ask.js';
import { extractLiteralNeedles, isLocateOnlyInstruction } from './query.js';

/** Host shape written by VS Code codeAttachments.ts (and stream-json hosts). */
function withAttachmentAppendix(ask: string): string {
  return [
    ask,
    '',
    '---',
    '## User attachments (always include in your reasoning for this turn)',
    '',
    '### Attached image: `image.png`',
    'The image is attached to this message for vision-capable models, and saved at: `.vibgrate/code-attachments/msioq2sz-0.png`',
    'MIME: image/png · ~42 KiB',
    'If you cannot view images, use the filename and any description in the user request — do not invent pixel content.',
  ].join('\n');
}

describe('userAskFromInstruction', () => {
  it('returns the instruction unchanged when there is no appendix', () => {
    const ask = 'add a green health check to the version badge';
    expect(userAskFromInstruction(ask)).toBe(ask);
  });

  it('strips the host User attachments appendix', () => {
    const ask = 'version badge solid green circle with white check (heartbeat)';
    const full = withAttachmentAppendix(ask);
    expect(userAskFromInstruction(full)).toBe(ask);
    expect(userAskFromInstruction(full)).not.toContain('image.png');
    expect(userAskFromInstruction(full)).not.toContain('code-attachments');
  });

  it('strips a bare attachments heading without the --- fence', () => {
    const full = 'fix auth\n## User attachments (always include)\n### Attached image: `x.png`\n';
    expect(userAskFromInstruction(full)).toBe('fix auth');
  });

  it('strips VS Code mention / active-editor context so path tokens are not ranked', () => {
    const ask = 'where is the help files for the cli';
    const full = [
      ask,
      '',
      '---',
      'Context the user attached:',
      'Files the user pointed at:',
      '- packages/vibgrate-cli-public/src/code/session-store.ts',
    ].join('\n');
    expect(userAskFromInstruction(full)).toBe(ask);
    expect(userAskFromInstruction(full)).not.toContain('packages/');
    expect(userAskFromInstruction(full)).not.toContain('session-store');
  });

  it('strips mention context even when an attachments appendix follows', () => {
    const ask = 'where is the help files for the cli';
    const full = withAttachmentAppendix(
      [
        ask,
        '',
        '---',
        'Context the user attached:',
        'Files the user pointed at:',
        '- packages/foo/src/index.ts',
      ].join('\n'),
    );
    expect(userAskFromInstruction(full)).toBe(ask);
    expect(userAskFromInstruction(full)).not.toContain('packages/');
    expect(userAskFromInstruction(full)).not.toContain('image.png');
  });
});

describe('attachment appendix must not become literal-locate needles', () => {
  it('extractLiteralNeedles ignores host-injected backticks once the ask is stripped', () => {
    const ask = 'show a solid green circle with white check when the endpoint is live';
    const full = withAttachmentAppendix(ask);
    expect(extractLiteralNeedles(userAskFromInstruction(full))).toEqual([]);
    // Without the strip, host backticks would poison pins (the field-report bug).
    expect(extractLiteralNeedles(full)).toEqual([
      'image.png',
      '.vibgrate/code-attachments/msioq2sz-0.png',
    ]);
  });

  it('does not classify a screenshot coding task as locate-only', () => {
    const full = withAttachmentAppendix(
      'we need the version badge to show with a solid green circle with white check icon',
    );
    expect(isLocateOnlyInstruction(full)).toBe(false);
  });

  it('still treats a real URL locate as locate-only when an image is also attached', () => {
    const full = withAttachmentAppendix(
      'https://dash.vibgrate.com/signup does not exist find occurrences',
    );
    expect(isLocateOnlyInstruction(full)).toBe(true);
  });
});

/**
 * `rankingAskFrom` is the name every caller uses for "the ranking input".
 * It is an identity alias of `userAskFromInstruction`: host appendixes
 * stripped, user text intact. Fence-sentence deletion recovered 0 of the
 * −5 pt fenced-ask penalty and is not shipped — a negation can be a fence
 * ("do not change the tax helper") or the defect itself ("the promotion is
 * never applied").
 */
describe('rankingAskFrom', () => {
  it('is an identity alias of userAskFromInstruction — fence sentences stay', () => {
    const ask =
      'Invoice totals ignore promotions. Do not change the tax rates or the money rounding helpers. ' +
      'Fix the promotion so it discounts the subtotal.';
    expect(rankingAskFrom(ask)).toBe(ask);
    expect(rankingAskFrom(ask)).toBe(userAskFromInstruction(ask));
    expect(rankingAskFrom(ask)).toContain('tax rates');
    expect(rankingAskFrom(ask)).toContain('rounding helpers');
  });

  it('does not delete leave-X-alone or out-of-scope sentences', () => {
    const ask =
      'The refund is short by the tax amount. Leave the loyalty programme and the wholesale price book alone. ' +
      'Shipping and packaging surcharges are out of scope.';
    expect(rankingAskFrom(ask)).toBe(ask);
    expect(rankingAskFrom(ask)).toContain('loyalty');
    expect(rankingAskFrom(ask)).toContain('wholesale');
    expect(rankingAskFrom(ask)).toContain('packaging');
  });

  it('does not delete contractions or please/also lead-ins', () => {
    for (const fence of [
      "Don't touch the ledger postings.",
      'Please do not refactor the settlement path.',
      'Also do not modify the quote surface.',
      'Never edit the generated client.',
    ]) {
      const ask = `Totals are wrong. ${fence}`;
      expect(rankingAskFrom(ask), fence).toBe(ask);
    }
  });

  it('KEEPS a negation that describes the defect', () => {
    for (const ask of [
      'The promotion is never applied to the invoice total.',
      'The discount does not reach the subtotal before tax.',
    ]) {
      expect(rankingAskFrom(ask), ask).toBe(ask);
    }
  });

  it('keeps a non-fence imperative that happens to start with "do"', () => {
    const ask = 'Double-check the rounding. Do the conversion in cents.';
    expect(rankingAskFrom(ask)).toBe(ask);
  });

  it('returns an all-fence ask unchanged — there is nothing else to rank on', () => {
    const ask = 'Do not change anything. Do not refactor.';
    expect(rankingAskFrom(ask)).toBe(ask);
  });

  it('strips the host attachment appendix first, like the ranker input it feeds', () => {
    const ask = `Fix the total.\n\n---\n${USER_ATTACHMENTS_HEADING_PREFIX}: image.png`;
    expect(rankingAskFrom(ask)).toBe('Fix the total.');
    expect(rankingAskFrom(ask)).toBe(userAskFromInstruction(ask));
  });

  it('is a no-op on an empty ask', () => {
    expect(rankingAskFrom('')).toBe('');
    expect(userAskFromInstruction('')).toBe('');
  });
});
