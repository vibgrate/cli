import { describe, expect, it } from 'vitest';
import { canonicalSignature, detectLoops, detectLoopsAcross, errorSignature, formatLoopsForDigest, signatureTokens, DEFAULT_MIN_OCCURRENCES } from './loops.js';
import { makeToolCall } from './shared.js';
import type { Session, ToolCall, Turn } from './types.js';

function session(id: string, calls: ToolCall[]): Session {
  const turns: Turn[] = calls.map((tc, i) => ({ index: i + 1, kind: 'tool_call', toolCall: tc }));
  return { id, agent: 'claude', startedAt: 0, endedAt: 0, turns, path: `/tmp/${id}.jsonl` };
}

const bash = (id: string, command: string, output: string, err = false): ToolCall => makeToolCall('Bash', id, { command }, output, err);
const read = (id: string, file: string, output: string, err = false): ToolCall => makeToolCall('Read', id, { file_path: file }, output, err);
const edit = (id: string, file: string): ToolCall => makeToolCall('Edit', id, { file_path: file }, 'ok edited', false);

describe('canonicalSignature', () => {
  it('collapses pagination fragments and integers for shell commands only', () => {
    expect(canonicalSignature(bash('1', 'grep foo src | head -50', ''))).toBe('bash::grep foo src');
    expect(canonicalSignature(bash('2', 'grep foo src | head -n 100', ''))).toBe('bash::grep foo src');
    expect(canonicalSignature(bash('3', 'git log -n 20 --max-count=5', ''))).toBe('bash::git log');
    expect(canonicalSignature(bash('4', 'SELECT * FROM t LIMIT 10 OFFSET 20', ''))).toBe('bash::select * from t');
    expect(canonicalSignature(bash('5', 'sed 10,20p a.txt', ''))).toBe('bash::sed n,20p a.txt'); // `20p` has no word boundary, so it stays
    expect(canonicalSignature(bash('5b', 'sed -n 10,20p a.txt', ''))).toBe('bash::sed ,20p a.txt'); // `-n N` is a pagination fragment
    expect(canonicalSignature(read('6', '/a/b 12.ts', ''))).toBe('read::/a/b 12.ts');
    expect(errorSignature(bash('7', 'x', 'Error: line 12 failed\nmore', true))).toBe('runtime_error::error: line n failed');
    expect(signatureTokens('bash::grep -rn todo src')).toEqual(new Set(['grep', 'todo', 'src']));
  });
});

describe('detectLoops thresholds', () => {
  it('two repetitions are a retry, three are a loop', () => {
    expect(DEFAULT_MIN_OCCURRENCES).toBe(3);
    const two = session('s', [read('1', '/x', 'ENOENT missing file', true), read('2', '/x', 'ENOENT missing file', true)]);
    expect(detectLoops(two)).toEqual([]);
    const three = session('s', [read('1', '/x', 'ENOENT missing file', true), read('2', '/x', 'ENOENT missing file', true), read('3', '/x', 'ENOENT missing file', true)]);
    const loops = detectLoops(three);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ kind: 'error-loop', tool: 'Read', count: 3, indices: [1, 2, 3], sessions: ['s'] });
    expect(loops[0].wastedTokens).toBe(3 * Math.floor(Buffer.byteLength('ENOENT missing file') / 4)); // every repetition wasted
    expect(detectLoops(two, { minOccurrences: 2 })).toHaveLength(1);
  });

  it('refetch loops waste everything but the largest fetch', () => {
    const s = session('s', [bash('1', 'grep foo | head -50', 'x'.repeat(400)), bash('2', 'grep foo | head -100', 'x'.repeat(800)), bash('3', 'grep foo | head -200', 'x'.repeat(1200))]);
    const [lp] = detectLoops(s);
    expect(lp.kind).toBe('refetch-loop');
    expect(lp.wastedTokens).toBe(100 + 200);
    expect(lp.sample).toBe('grep foo | head -50');
    expect(lp.signature).toBe('bash::grep foo');
  });

  it('a mixed group is an error loop when at least half the calls failed', () => {
    const half = session('s', [bash('1', 'make', 'BUILD FAILED', true), bash('2', 'make', 'BUILD FAILED', true), bash('3', 'make', 'ok built', false), bash('4', 'make', 'ok built', false)]);
    expect(detectLoops(half)[0].kind).toBe('error-loop');
    const mostlyOk = session('s', [bash('1', 'make', 'BUILD FAILED', true), bash('2', 'make', 'ok built', false), bash('3', 'make', 'ok built', false)]);
    expect(detectLoops(mostlyOk)[0].kind).toBe('refetch-loop');
  });

  it('detects edit cycles and same-error repeats across different calls', () => {
    const edits = session('s', [edit('1', '/a.ts'), read('2', '/a.ts', 'contents'), edit('3', '/a.ts'), edit('4', '/A.ts')]);
    const loops = detectLoops(edits);
    expect(loops.map((l) => l.kind)).toEqual(['edit-cycle']);
    expect(loops[0]).toMatchObject({ count: 3, signature: 'edit::/a.ts', indices: [1, 3, 4] });

    const errs = session('s', [bash('1', 'python a.py', "ModuleNotFoundError: No module named 'x'", true), bash('2', 'python b.py', "ModuleNotFoundError: No module named 'x'", true), bash('3', 'python c.py', "ModuleNotFoundError: No module named 'x'", true)]);
    const same = detectLoops(errs);
    expect(same.map((l) => l.kind)).toEqual(['same-error']);
    expect(same[0].count).toBe(3);
    expect(same[0].signature.startsWith('module_not_found::')).toBe(true);
    // The same-error group is not duplicated when it is exactly one error-loop signature.
    const dup = session('s', [bash('1', 'python a.py', 'boom Error: x', true), bash('2', 'python a.py', 'boom Error: x', true), bash('3', 'python a.py', 'boom Error: x', true)]);
    expect(detectLoops(dup).map((l) => l.kind)).toEqual(['error-loop']);
  });

  it('merges the same loop across sessions and never across unrelated ones', () => {
    const a = session('a', [read('1', '/x', 'ENOENT missing file', true), read('2', '/x', 'ENOENT missing file', true), read('3', '/x', 'ENOENT missing file', true)]);
    const b = session('b', [read('1', '/x', 'ENOENT missing file', true), read('2', '/x', 'ENOENT missing file', true), read('3', '/x', 'ENOENT missing file', true)]);
    const c = session('c', [read('1', '/x', 'ENOENT missing file', true)]);
    const merged = detectLoopsAcross([a, b, c]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ count: 6, sessions: ['a', 'b'] });
    expect(detectLoopsAcross([a, b, c])).toEqual(merged);
    expect(detectLoopsAcross([c])).toEqual([]);
  });

  it('orders by waste, then count, then signature, and renders the digest section', () => {
    const s = session('s', [bash('1', 'a', 'x'.repeat(40)), bash('2', 'a', 'x'.repeat(40)), bash('3', 'a', 'x'.repeat(40)), bash('4', 'b', 'y'.repeat(400)), bash('5', 'b', 'y'.repeat(400)), bash('6', 'b', 'y'.repeat(400))]);
    const loops = detectLoops(s);
    expect(loops.map((l) => l.signature)).toEqual(['bash::b', 'bash::a']);
    const text = formatLoopsForDigest(loops);
    expect(text.split('\n')[0]).toBe('=== Detected Loops (HIGHEST PRIORITY) ===');
    expect(text).toContain('- [refetch-loop] Bash: "b" repeated 3x, ~200 tokens wasted (messages [4, 5, 6])');
    expect(formatLoopsForDigest([])).toBe('');
  });
});
