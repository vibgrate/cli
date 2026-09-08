import { describe, expect, it } from 'vitest';
import { parseInput } from './compress.js';
import { normalizeHash } from './retrieve.js';

describe('vg compress input detection', () => {
  it('routes a JSON message array through the message pipeline', () => {
    const parsed = parseInput(JSON.stringify([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }]));
    expect(parsed.kind).toBe('messages');
    if (parsed.kind === 'messages') expect(parsed.messages).toHaveLength(2);
  });

  it('routes a request body with messages and keeps the rest of the body', () => {
    const parsed = parseInput(JSON.stringify({ model: 'claude-sonnet-4-5', system: 'x', messages: [{ role: 'user', content: 'hi' }] }));
    expect(parsed.kind).toBe('request');
    if (parsed.kind === 'request') {
      expect(parsed.body.model).toBe('claude-sonnet-4-5');
      expect(parsed.messages).toHaveLength(1);
    }
  });

  it('treats a JSON array of records (a tool output) as text, not messages', () => {
    const parsed = parseInput(JSON.stringify([{ id: 1, status: 'ok' }, { id: 2, status: 'error' }]));
    expect(parsed.kind).toBe('text');
  });

  it('treats invalid JSON and plain logs as text', () => {
    expect(parseInput('{not json').kind).toBe('text');
    expect(parseInput('2024-01-01 INFO started\n2024-01-01 ERROR boom').kind).toBe('text');
  });
});

describe('vg retrieve hash normalisation', () => {
  it('accepts a bare 12- or 24-char hash', () => {
    expect(normalizeHash('3f9a1c2b7e4d')).toBe('3f9a1c2b7e4d');
    expect(normalizeHash('3F9A1C2B7E4D0123456789AB')).toBe('3f9a1c2b7e4d0123456789ab');
  });

  it('extracts the hash from a marker or a hash= fragment', () => {
    expect(normalizeHash('<<vg-ccr:3f9a1c2b7e4d 120_rows_offloaded>>')).toBe('3f9a1c2b7e4d');
    expect(normalizeHash('Retrieve original: hash=3f9a1c2b7e4d0123456789ab (900 → 120 tokens)')).toBe('3f9a1c2b7e4d0123456789ab');
  });

  it('rejects things that are not hashes', () => {
    expect(normalizeHash('hello')).toBeNull();
    expect(normalizeHash('abc123')).toBeNull();
  });
});
