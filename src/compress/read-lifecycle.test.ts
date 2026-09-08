import { describe, expect, it } from 'vitest';
import { CompressionStore } from './ccr/store.js';
import { applyReadLifecycle, classifyReads, lifecycleMarker, readCovers, ReadMaturation, relocateCacheBreakpoint } from './read-lifecycle.js';
import type { Message } from './types.js';

const BIG = Array.from({ length: 80 }, (_, i) => `${i + 1}\tconst value${i} = compute(${i});`).join('\n');

function anthropicConvo(): Message[] {
  return [
    { role: 'user', content: 'edit the file' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/p/a.ts' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: BIG }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/p/a.ts', old_string: 'x', new_string: 'y' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: '/p/b.ts', offset: 0, limit: 50 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r2', content: BIG }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r3', name: 'Read', input: { file_path: '/p/b.ts' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r3', content: BIG }] },
    { role: 'user', content: 'now what?' },
  ];
}

describe('classifyReads', () => {
  it('stale wins over superseded; superseded is opt-in; frozen prefix stays fresh', () => {
    const msgs = anthropicConvo();
    expect(classifyReads(msgs).map((c) => [c.filePath, c.state, c.supersededBy])).toEqual([
      ['/p/a.ts', 'stale', 3],
      ['/p/b.ts', 'fresh', undefined],
      ['/p/b.ts', 'fresh', undefined],
    ]);
    expect(classifyReads(msgs, { compressSuperseded: true }).map((c) => c.state)).toEqual(['stale', 'superseded', 'fresh']);
    expect(classifyReads(msgs, { frozenMessageCount: 4 }).map((c) => c.state)).toEqual(['fresh', 'fresh', 'fresh']);
    expect(classifyReads(msgs, { compressStale: false }).map((c) => c.state)).toEqual(['fresh', 'fresh', 'fresh']);
  });

  it('readCovers range logic (default limit 2000)', () => {
    const full = { messageIndex: 0, toolCallId: 'a', toolName: 'Read', filePath: 'f', operation: 'read' as const };
    const part = { ...full, offset: 100, limit: 50 };
    const other = { ...full, offset: 200, limit: 50 };
    expect(readCovers(full, part)).toBe(true);
    expect(readCovers(part, full)).toBe(false);
    expect(readCovers(other, part)).toBe(false);
    expect(readCovers({ ...full, offset: 50, limit: 200 }, part)).toBe(true);
  });
});

describe('applyReadLifecycle', () => {
  it('replaces the stale read with the marker + retrieval hint and stores the original', () => {
    const msgs = anthropicConvo();
    const store = new CompressionStore({ now: () => 1 });
    const r = applyReadLifecycle(msgs, { store });
    expect(r).toMatchObject({ reads: 3, stale: 1, superseded: 0, replaced: 1 });
    expect(r.transforms).toEqual(['read_lifecycle:stale:/p/a.ts']);
    const text = (msgs[2] as { content: Array<{ content: string }> }).content[0].content;
    expect(text.startsWith(lifecycleMarker('stale', '/p/a.ts', 3))).toBe(true);
    expect(text).toBe(`[file /p/a.ts read here; superseded by an edit at message #3. Re-read if needed.]\nRetrieve original: hash=${r.ccrHashes[0]} (${store.get(r.ccrHashes[0])!.originalTokens} → ${store.get(r.ccrHashes[0])!.compressedTokens} tokens)`);
    expect(store.get(r.ccrHashes[0])?.original).toBe(BIG);
    expect(store.get(r.ccrHashes[0])?.strategy).toBe('read_lifecycle:stale');
    expect(r.bytesBefore).toBeGreaterThan(r.bytesAfter);
  });

  it('works on OpenAI shapes, honours min size and never touches already-marked content', () => {
    const oai: Message[] = [
      { role: 'assistant', tool_calls: [{ id: 'r', type: 'function', function: { name: 'read_file', arguments: '{"path":"x.py"}' } }] },
      { role: 'tool', tool_call_id: 'r', content: 'tiny' },
      { role: 'assistant', tool_calls: [{ id: 'w', type: 'function', function: { name: 'write_file', arguments: '{"path":"x.py"}' } }] },
      { role: 'tool', tool_call_id: 'w', content: 'ok' },
    ];
    expect(applyReadLifecycle(oai, { store: null }).replaced).toBe(0);
    (oai[1] as Record<string, unknown>).content = BIG;
    const r = applyReadLifecycle(oai, { store: null });
    expect(r.replaced).toBe(1);
    expect(r.ccrHashes).toEqual([]);
    expect(oai[1].content).toBe('[file x.py read here; superseded by an edit at message #2. Re-read if needed.]');
    expect(applyReadLifecycle(oai, { store: null }).replaced).toBe(0);
  });

  it('superseded marker when enabled', () => {
    const msgs = anthropicConvo();
    applyReadLifecycle(msgs, { compressSuperseded: true, store: null });
    expect((msgs[6] as { content: Array<{ content: string }> }).content[0].content).toBe('[file /p/b.ts read here; superseded by a later read at message #7. Re-read if needed.]');
  });
});

describe('ReadMaturation', () => {
  function convo(turnsAfter: number): Message[] {
    const msgs: Message[] = [{ role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/p/a.ts' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: BIG }] }];
    for (let i = 0; i < turnsAfter; i++) {
      msgs.push({ role: 'assistant', content: `turn ${i}` });
      msgs.push({ role: 'user', content: `ok ${i}` });
    }
    return msgs;
  }

  it('holds an active read, matures after quiesce turns, then replays deterministically', () => {
    const m = new ReadMaturation({ quiesceTurns: 2, maxHoldTurns: 6, minSizeBytes: 100 });
    const store = new CompressionStore({ now: () => 1 });
    const t0 = convo(0);
    const r0 = m.apply(t0, { store });
    expect(r0).toMatchObject({ holding: 1, newlyMatured: 0, holdingMessageIndices: [2] });
    const t2 = convo(2);
    const r2 = m.apply(t2, { store });
    expect(r2.newlyMatured).toBe(1);
    const marker = (t2[2] as { content: Array<{ content: string }> }).content[0].content;
    expect(marker.startsWith('[file /p/a.ts read here; compressed after use. Re-read if needed.]\nRetrieve original: hash=')).toBe(true);
    expect(store.get(r2.ccrHashes[0])?.original).toBe(BIG);
    const t3 = convo(3);
    const r3 = m.apply(t3, { store });
    expect(r3.replaced).toBe(1);
    expect((t3[2] as { content: Array<{ content: string }> }).content[0].content).toBe(marker);
    expect(m.maturedCount).toBe(1);
  });

  it('edits reset the quiet clock; max hold caps it; small reads are ignored', () => {
    const m = new ReadMaturation({ quiesceTurns: 2, maxHoldTurns: 3, minSizeBytes: 100 });
    const msgs = convo(2);
    msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'e', name: 'Edit', input: { file_path: '/p/a.ts' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e', content: 'ok' }] });
    // Read at assistant turn 1, edit at turn 4: quiet = 0, held = 3 → max hold hit.
    expect(m.apply(msgs, { store: null }).newlyMatured).toBe(1);
    const small = new ReadMaturation({ quiesceTurns: 1, maxHoldTurns: 1, minSizeBytes: 10_000 });
    expect(small.apply(convo(5), { store: null })).toMatchObject({ holding: 0, newlyMatured: 0 });
  });
});

describe('relocateCacheBreakpoint', () => {
  it('moves the trailing breakpoint before the held region carrying the TTL', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r', content: 'held', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    ];
    const out = relocateCacheBreakpoint(msgs, [2]);
    expect((out[2] as { content: Array<Record<string, unknown>> }).content[0].cache_control).toBeUndefined();
    expect((out[1] as { content: Array<Record<string, unknown>> }).content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(msgs[2]).toMatchObject({ content: [{ cache_control: { ttl: '1h' } }] });
    expect(relocateCacheBreakpoint(msgs, [])).toBe(msgs);
    const none = relocateCacheBreakpoint([{ role: 'user', content: [{ type: 'text', text: 'x' }] }], [0]);
    expect(none).toEqual([{ role: 'user', content: [{ type: 'text', text: 'x' }] }]);
  });
});
