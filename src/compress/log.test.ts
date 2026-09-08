import { describe, expect, it } from 'vitest';
import {
  classifyLevel,
  collapseTraceFrames,
  DEFAULT_LOG_CONFIG,
  dedupeSimilar,
  detectLogFormat,
  isRuntimeFrame,
  isSummaryLine,
  LogCompressor,
  normalizeForDedupe,
  parseLogLines,
  scoreLogLine,
  selectLogLines,
  traceFlavorFor,
  traceTerminates,
  type LogLine,
} from './log.js';
import { baseRequest, MemorySink } from './__fixtures__/sink.js';
import { pytestLog } from './__fixtures__/samples.js';

const line = (over: Partial<LogLine> = {}): Omit<LogLine, 'score'> => ({
  lineNumber: 1,
  content: 'x',
  level: 'info',
  isStackTrace: false,
  isSummary: false,
  ...over,
});

describe('log shape detection', () => {
  it('names the runner from its own banner', () => {
    expect(detectLogFormat(pytestLog(20).split('\n'))).toBe('pytest');
    expect(detectLogFormat(['npm ERR! code E404', 'npm WARN deprecated'])).toBe('npm');
    expect(detectLogFormat(['hello', 'world'])).toBe('generic');
    expect(detectLogFormat([])).toBe('generic');
  });

  it('classifies severity from the usual prefixes', () => {
    expect(['ERROR: boom', 'WARN: hm', '[info] ok', 'debug detail', 'FAILED test_x', 'plain'].map(classifyLevel)).toEqual([
      'error',
      'warn',
      'info',
      'debug',
      'fail',
      'unknown',
    ]);
  });

  it('recognises summary lines without swallowing ordinary ones', () => {
    expect(isSummaryLine('=== 3 failed, 5 passed in 1.2s ===')).toBe(true);
    expect(isSummaryLine('12 passed in 0.4s')).toBe(true);
    expect(isSummaryLine('Tests: 4 total')).toBe(true);
    expect(isSummaryLine('TOTAL 91%')).toBe(true);
    expect(isSummaryLine('Build succeeded')).toBe(true);
    expect(isSummaryLine('Testing the parser')).toBe(false);
    expect(isSummaryLine('random line')).toBe(false);
  });
});

describe('stack traces', () => {
  it('identifies the flavour and where it ends', () => {
    expect(traceFlavorFor('Traceback (most recent call last):')).toBe('python');
    expect(traceFlavorFor('    at Object.<anonymous> (/a/b.js:1:2)')).toBe('js');
    expect(traceFlavorFor('goroutine 1 [running]:')).toBe('go_panic');
    expect(traceFlavorFor('hello')).toBeNull();
    // the exception line is the *last* line of a python traceback, so it does
    // not terminate it — the next unindented, non-exception line does
    expect(traceTerminates('python', 'ValueError: bad input', 4)).toBe(false);
    expect(traceTerminates('python', '  File "a.py", line 3', 2)).toBe(false);
    expect(traceTerminates('python', 'back to ordinary output', 5)).toBe(true);
    // a js trace runs while the lines are `at …` frames
    expect(traceTerminates('js', '    at foo (/a/b.js:1:2)', 2)).toBe(false);
    expect(traceTerminates('js', 'done', 3)).toBe(true);
  });

  it('separates library frames from the caller’s own code', () => {
    expect(isRuntimeFrame('    at x (/app/node_modules/foo/index.js:1:2)')).toBe(true);
    expect(isRuntimeFrame('  File "/usr/lib/python3.11/json/__init__.py", line 3')).toBe(true);
    expect(isRuntimeFrame('    at handler (/app/src/index.ts:1:2)')).toBe(false);
  });

  it('keeps the head and the application frames, dropping the runtime middle', () => {
    const stack: LogLine[] = [
      { ...line({ lineNumber: 1, content: 'Traceback (most recent call last):', isStackTrace: true }), score: 1 },
      ...Array.from({ length: 10 }, (_, i) => ({ ...line({ lineNumber: i + 2, content: `  File "/usr/lib/python3.11/lib${i}.py", line ${i}`, isStackTrace: true }), score: 1 })),
      { ...line({ lineNumber: 12, content: '  File "/app/src/handler.py", line 42', isStackTrace: true }), score: 1 },
    ];
    const { kept, dropped } = collapseTraceFrames(stack, 2, 3);
    expect(kept.length).toBeLessThan(stack.length);
    expect(dropped.length).toBeGreaterThan(0);
    // the banner and the app frame are never among the dropped
    expect(kept[0].content).toContain('Traceback');
    expect(kept.some((l) => l.content.includes('/app/src/handler.py'))).toBe(true);
  });
});

describe('scoring, dedupe and selection', () => {
  it('scores errors above warnings above chatter, and boosts the query', () => {
    const err = scoreLogLine(line({ level: 'error' }));
    const warn = scoreLogLine(line({ level: 'warn' }));
    const info = scoreLogLine(line({ level: 'info' }));
    const debug = scoreLogLine(line({ level: 'debug' }));
    expect(err).toBeGreaterThan(warn);
    expect(warn).toBeGreaterThan(info);
    expect(info).toBeGreaterThan(debug);
    expect(scoreLogLine(line({ level: 'info', isSummary: true }))).toBeGreaterThan(info);
    expect(scoreLogLine(line({ content: 'connection timeout on db' }), ['timeout'])).toBeGreaterThan(scoreLogLine(line({ content: 'connection timeout on db' })));
  });

  it('normalises the variable half of a key: value line before comparing', () => {
    // the key stays intact so different messages never collapse together;
    // ids, addresses and paths in the value are masked so repeats do
    expect(normalizeForDedupe('worker: handled request 4821 in 91ms')).toBe(normalizeForDedupe('worker: handled request 77 in 3ms'));
    expect(normalizeForDedupe('cache: miss at 0xdeadbeef')).toBe(normalizeForDedupe('cache: miss at 0x1234'));
    expect(normalizeForDedupe('worker: ok')).not.toBe(normalizeForDedupe('reaper: ok'));
  });

  it('collapses exact and near-duplicate lines', () => {
    const lines = parseLogLines([
      'worker: handled request 1 in 10ms',
      'worker: handled request 2 in 11ms',
      'worker: handled request 3 in 12ms',
      'ERROR: disk full on node-7',
    ]);
    const deduped = dedupeSimilar(lines);
    expect(deduped.length).toBeLessThan(lines.length);
    // the error is never deduped away
    expect(deduped.some((l) => l.content.includes('disk full'))).toBe(true);
  });

  it('selects around what is interesting: the error and its surrounding lines', () => {
    const raw = [...Array.from({ length: 200 }, (_, i) => `INFO step ${i} completed cleanly`), 'ERROR: disk full on node-7', 'INFO shutting down'];
    const parsed = parseLogLines(raw);
    const sel = selectLogLines(parsed, 1, DEFAULT_LOG_CONFIG);
    expect(sel.selected.length).toBeLessThan(parsed.length);
    const error = sel.selected.find((l) => l.content.includes('disk full'));
    expect(error).toBeDefined();
    // uneventful chatter is dropped; what is kept is the error plus context
    // within `errorContextLines` of it, in original order
    const numbers = sel.selected.map((l) => l.lineNumber);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    for (const n of numbers) expect(Math.abs(n - error!.lineNumber)).toBeLessThanOrEqual(DEFAULT_LOG_CONFIG.errorContextLines + 1);
    // a larger bias may keep more, never fewer
    expect(selectLogLines(parsed, 3, DEFAULT_LOG_CONFIG).selected.length).toBeGreaterThanOrEqual(sel.selected.length);
  });
});

describe('LogCompressor', () => {
  it('compresses a test run, reporting the line counts it kept', () => {
    const log = pytestLog(300);
    const r = new LogCompressor().compress(baseRequest(log, { ccr: new MemorySink(), injectMarker: true }));
    expect(r.strategy).toBe('log');
    expect(r.chain).toEqual(['log']);
    expect(r.info).toMatch(/^log:pytest\(\d+->\d+ lines\)$/);
    expect(r.content.length).toBeLessThan(log.length);
    // the session banner survives, so the model still knows what ran
    expect(r.content).toContain('test session starts');
  });

  it('is deterministic and fails open on nothing to do', () => {
    const log = pytestLog(120);
    const a = new LogCompressor().compress(baseRequest(log));
    const b = new LogCompressor().compress(baseRequest(log));
    expect(b).toEqual(a);
    for (const empty of ['', '   ']) {
      const r = new LogCompressor().compress(baseRequest(empty));
      expect(r.strategy).toBe('passthrough');
      expect(r.content).toBe(empty);
    }
    // a log too short to be worth touching comes back untouched
    const short = new LogCompressor().compress(baseRequest('one line\ntwo lines'));
    expect(short.content).toBe('one line\ntwo lines');
  });
});
