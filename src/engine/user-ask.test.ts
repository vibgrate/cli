import { describe, it, expect } from 'vitest';
import { userAskFromInstruction } from './user-ask.js';
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
