import { beforeEach, describe, expect, it } from 'vitest';
import { billsPriorThinkingHeuristic, compactReasoningText, compactThinking, compactThinkingBlocks, resetThinkingMemo, THINKING_MARKER } from './thinking.js';
import type { Message } from './types.js';

const LONG = Array.from({ length: 60 }, (_, i) => `reasoning${i}`).join(' ');

describe('billsPriorThinkingHeuristic', () => {
  it('is conservative: only Claude 4.6+ / 5.x', () => {
    expect(billsPriorThinkingHeuristic('claude-opus-4-6')).toBe(true);
    expect(billsPriorThinkingHeuristic('claude-sonnet-5')).toBe(true);
    expect(billsPriorThinkingHeuristic('claude-sonnet-4-5-20250929')).toBe(false);
    expect(billsPriorThinkingHeuristic('claude-3-5-sonnet-20241022')).toBe(false);
    expect(billsPriorThinkingHeuristic('gpt-5')).toBe(false);
  });
});

describe('compactThinkingBlocks', () => {
  beforeEach(() => resetThinkingMemo());
  const msgs = (): Message[] => [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: LONG, signature: 's1', cache_control: { type: 'ephemeral' } }, { type: 'tool_use', id: 't1', name: 'calc', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: LONG, signature: 's2' }] },
  ];

  it('converts old turns to marked text, keeps the last turn, preserves tool_use and cache_control, memoises', () => {
    let calls = 0;
    const compact = (): string => (calls += 1, 'short summary');
    const m = msgs();
    const stats = compactThinkingBlocks(m, { compact, keepLast: 1 });
    expect(stats).toEqual({ turnsCompacted: 1, blocks: 1, wordsBefore: 60, wordsAfter: 2 });
    expect((m[1] as { content: unknown[] }).content[0]).toEqual({ type: 'text', text: `${THINKING_MARKER} short summary`, cache_control: { type: 'ephemeral' } });
    expect((m[1] as { content: Array<{ type: string }> }).content[1].type).toBe('tool_use');
    expect((m[3] as { content: Array<{ type: string }> }).content[0].type).toBe('thinking');
    const m2 = msgs();
    compactThinkingBlocks(m2, { compact, keepLast: 1 });
    expect(calls).toBe(1);
    expect(m2[1]).toEqual(m[1]);
    const all = msgs();
    expect(compactThinkingBlocks(all, { compact, keepLast: 0 }).turnsCompacted).toBe(2);
  });

  it('skips short blocks, failures and non-shrinking output', () => {
    const m = msgs();
    (m[1] as { content: Array<{ thinking?: string }> }).content[0].thinking = 'brief';
    expect(compactThinkingBlocks(m, { compact: () => 'x', keepLast: 0 }).blocks).toBe(1);
    resetThinkingMemo();
    const m2 = msgs();
    expect(compactThinkingBlocks(m2, { compact: () => { throw new Error('no'); }, keepLast: 0 }).blocks).toBe(0);
    resetThinkingMemo();
    expect(compactThinkingBlocks(msgs(), { compact: (t) => `${t} more`, keepLast: 0 }).blocks).toBe(0);
  });
});

describe('compactReasoningText', () => {
  beforeEach(() => resetThinkingMemo());
  it('handles reasoning_content and inline <think> spans', () => {
    const m: Message[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'kimi answer', reasoning_content: LONG },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: `<think>${LONG}</think> glm answer` },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'plain answer' },
    ];
    const stats = compactReasoningText(m, { compact: () => 'short summary', keepLast: 1 });
    expect(stats.turnsCompacted).toBe(2);
    expect(m[1].reasoning_content).toBe('short summary');
    expect(m[3].content).toBe('<think>short summary</think> glm answer');
    expect(m[5].content).toBe('plain answer');
    const keep: Message[] = [{ role: 'assistant', content: 'a', reasoning_content: LONG }];
    compactReasoningText(keep, { compact: () => 's', keepLast: 1 });
    expect(keep[0].reasoning_content).toBe(LONG);
    expect(compactThinking([{ role: 'assistant', content: '<think>unterminated' }], { compact: () => 's', keepLast: 0 }).blocks).toBe(0);
  });
});
