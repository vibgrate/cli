import { describe, expect, it } from 'vitest';
import { analyzeCachePrefix, classifyToken, detectVolatileContent, isHexHash, isIso8601, isJwtShape, isUuid } from './cache-aligner.js';

describe('token classifiers', () => {
  it('uuid / iso8601 / jwt / hex / request id', () => {
    expect(isUuid('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(isUuid('123e4567e89b12d3a456426614174000')).toBe(false);
    expect(isIso8601('2026-09-08T04:30:00Z')).toBe(true);
    expect(isIso8601('2026-09-08')).toBe(true);
    expect(isIso8601('2026-13-40')).toBe(false);
    expect(isIso8601('v1.2.3')).toBe(false);
    const jwt = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"sub":"x"}').toString('base64url')}.abcdefghij`;
    expect(isJwtShape(jwt)).toBe(true);
    expect(isJwtShape('a.b.c')).toBe(false);
    expect(isHexHash('d41d8cd98f00b204e9800998ecf8427e')).toBe(true);
    expect(isHexHash('deadbeef')).toBe(false);
    expect(classifyToken('abc12345XYZ', 'request_id:')).toBe('request_id');
    expect(classifyToken('hello', 'request_id:')).toBeNull();
    expect(classifyToken('some-word')).toBeNull();
  });

  it('detectVolatileContent strips punctuation and truncates samples', () => {
    const f = detectVolatileContent('Date: 2026-09-08T04:30:00Z, id (123e4567-e89b-12d3-a456-426614174000).');
    expect(f.map((x) => x.label)).toEqual(['iso8601', 'uuid']);
    expect(f[1].sample).toBe('123e4567...4000');
    expect(detectVolatileContent('')).toEqual([]);
  });
});

describe('analyzeCachePrefix', () => {
  it('warns on volatile system prompts, never mutates, hashes the stable prefix deterministically', () => {
    const msgs = [
      { role: 'system', content: 'You are helpful. Session 123e4567-e89b-12d3-a456-426614174000 started 2026-09-08T04:30:00Z' },
      { role: 'user', content: 'hi' },
    ];
    const snapshot = structuredClone(msgs);
    const a = analyzeCachePrefix(msgs);
    expect(msgs).toEqual(snapshot);
    expect(a.warnings).toHaveLength(1);
    expect(a.warnings[0]).toMatch(/system prompt \(iso8601=1, uuid=1\)/);
    expect(a.findings.map((f) => f.role)).toEqual(['system', 'system']);
    expect(a.alignmentScore).toBe(80);
    expect(a.markersInserted[0]).toMatch(/^stable_prefix_hash:[0-9a-f]{16}$/);
    expect(analyzeCachePrefix(structuredClone(msgs))).toEqual(a);
  });

  it('scans early messages past the frozen prefix and stays quiet on clean prompts', () => {
    const msgs = [
      { role: 'system', content: 'stable' },
      { role: 'user', content: 'trace_id: abc123def456ghi' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: '2026-01-01T00:00:00Z late message, not scanned' },
    ];
    const a = analyzeCachePrefix(msgs);
    expect(a.findings).toHaveLength(1);
    expect(a.warnings[0]).toMatch(/early messages \(request_id=1\)/);
    expect(analyzeCachePrefix(msgs, { frozenMessageCount: 2 }).findings).toEqual([]);
    expect(analyzeCachePrefix([{ role: 'system', content: 'plain prompt' }]).warnings).toEqual([]);
    expect(analyzeCachePrefix([{ role: 'user', content: 'x' }], { system: 'top-level 2026-01-01T00:00:00Z' }).findings[0]).toMatchObject({ label: 'iso8601', messageIndex: -1 });
  });
});
