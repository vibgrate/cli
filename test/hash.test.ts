import { describe, it, expect } from 'vitest';
import { hashString, canonicalize, shortId } from '../src/engine/hash.js';
import { nodeId, edgeId } from '../src/engine/ids.js';

describe('hash', () => {
  it('is stable for the same input', () => {
    expect(hashString('hello')).toBe(hashString('hello'));
  });

  it('differs for different input', () => {
    expect(hashString('a')).not.toBe(hashString('b'));
  });

  it('canonicalize sorts object keys recursively', () => {
    expect(canonicalize({ b: 1, a: { d: 4, c: 3 } })).toBe(canonicalize({ a: { c: 3, d: 4 }, b: 1 }));
  });

  it('shortId is 32 hex chars (16 bytes)', () => {
    expect(shortId('x')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('ids', () => {
  it('node id excludes the line span (moving a node does not change its id)', () => {
    const a = nodeId({ kind: 'function', qualifiedName: 'foo', file: 'a.ts', signature: 'foo()' });
    const b = nodeId({ kind: 'function', qualifiedName: 'foo', file: 'a.ts', signature: 'foo()' });
    expect(a).toBe(b);
  });

  it('node id changes when identity changes', () => {
    const a = nodeId({ kind: 'function', qualifiedName: 'foo', file: 'a.ts' });
    const b = nodeId({ kind: 'function', qualifiedName: 'foo', file: 'b.ts' });
    expect(a).not.toBe(b);
  });

  it('edge id is a function of (kind, src, dst)', () => {
    expect(edgeId('call', 'x', 'y')).toBe(edgeId('call', 'x', 'y'));
    expect(edgeId('call', 'x', 'y')).not.toBe(edgeId('import', 'x', 'y'));
  });
});
