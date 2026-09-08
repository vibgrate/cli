import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installFixtures, removeFixtures, type InstalledFixtures } from './__fixtures__/install.js';
import {
  analyze,
  applyLoopWeighting,
  parseAnalyzerOutput,
  renderAnalyzerPrompt,
  renderDigestText,
  stripFencedJson,
  validateAnalyzerOutput,
  ANALYZER_SYSTEM_PROMPT,
  ANALYZER_USER_PREFIX,
  ANALYZER_OUTPUT_SCHEMA,
  SECTION_ENVIRONMENT,
  SECTION_LOOPS,
  SECTION_PATHS,
  SECTION_PREFERENCES,
  SECTION_RETRIES,
} from './analyzer.js';
import { scanSessions } from './scan.js';
import type { Loop, Rule, Session } from './types.js';

let fx: InstalledFixtures;
let sessions: Session[];
const NOW = Date.parse('2026-09-08T00:00:00Z');

beforeAll(() => {
  fx = installFixtures();
  sessions = scanSessions({ now: NOW, env: fx.env, home: fx.home });
});
afterAll(() => removeFixtures(fx));

describe('analyze (heuristic)', () => {
  it('produces measured loops, recoveries, corrections and sectioned rules from the fixtures', () => {
    const d = analyze(sessions);
    expect(d.analyzer).toBe('heuristic');
    expect(d.sessions).toBe(sessions.length);
    expect(d.toolCalls).toBe(27);
    expect(d.failures).toBe(13);
    expect(d.failureRate).toBeCloseTo(13 / 27, 3);
    expect(d.loops.map((l) => [l.kind, l.count])).toEqual([
      ['refetch-loop', 3],
      ['error-loop', 3],
    ]);
    expect(d.loops[0].wastedTokens).toBeGreaterThan(d.loops[1].wastedTokens);
    expect(d.recoveries.find((r) => r.tool === 'Bash' && r.failed === 'npm test')).toMatchObject({ success: 'pnpm test', category: 'command_not_found', count: 2 });
    expect(d.recoveries.find((r) => r.tool === 'Read')).toMatchObject({ failed: '/home/user/demo/src/confg.ts', success: '/home/user/demo/src/config.ts', count: 2 });
    expect(d.missingPaths).toEqual([{ path: '/home/user/demo/src/confg.ts', count: 4 }]);
    expect(d.failingCommands[0]).toMatchObject({ command: 'npm test', count: 2, category: 'command_not_found' });
    expect(d.corrections.map((c) => c.text)).toEqual(["User preference: don't use npm, use pnpm for everything in this repo", 'User preference: never edit generated files under dist, only the sources']);
    expect(d.verbosity.responses).toBeGreaterThan(0);

    const sections = d.rules.map((r) => r.section);
    expect(sections).toEqual([SECTION_LOOPS, SECTION_PATHS, SECTION_ENVIRONMENT, SECTION_PREFERENCES]);
    const loops = d.rules[0];
    expect(loops).toMatchObject({ target: 'context', confidence: 0.9, isLoopGuardrail: true, loopOccurrences: 3, evidenceCount: 6 });
    expect(loops.estimatedTokensSaved).toBe(d.loops[0].wastedTokens + d.loops[1].wastedTokens);
    expect(loops.content.split('\n')).toHaveLength(2);
    expect(loops.content).toContain('`grep -rn TODO src | head -50` was re-run 3x with different output limits');
    expect(loops.content).toContain('`Read: /home/user/demo/src/confg.ts` failed 3x in a row');
    expect(d.rules[1].content).toBe('- File `/home/user/demo/src/confg.ts` does not exist. The correct path is `/home/user/demo/src/config.ts`.');
    expect(d.rules[2].content).toBe('- Command `npm test` fails (command_not_found). Use `pnpm test` instead.');
    expect(d.rules[3]).toMatchObject({ target: 'memory', confidence: 0.7, evidenceCount: 2 });
    // Single-occurrence failures never become rules at the default evidence bar.
    expect(sections).not.toContain(SECTION_RETRIES);
  });

  it('is deterministic and pure', () => {
    const snapshot = JSON.stringify(sessions);
    const a = analyze(sessions);
    const b = analyze(sessions);
    expect(a).toEqual(b);
    expect(JSON.stringify(sessions)).toBe(snapshot);
    expect(analyze([])).toMatchObject({ sessions: 0, toolCalls: 0, failures: 0, failureRate: 0, loops: [], rules: [] });
  });

  it('minEvidence gates non-loop rules; loops need no extra evidence', () => {
    const strict = analyze(sessions, { minEvidence: 3 });
    expect(strict.rules.map((r) => r.section)).toEqual([SECTION_LOOPS, SECTION_PREFERENCES]);
    const loose = analyze(sessions, { minEvidence: 1 });
    expect(loose.rules.map((r) => r.section)).toContain(SECTION_RETRIES);
    const retries = loose.rules.find((r) => r.section === SECTION_RETRIES)?.content ?? '';
    expect(retries).toContain('- `cat README.md` failed 1x (file_not_found): cat: README.md: No such file or directory exit code 1');
    expect(retries).not.toContain('`make build`'); // recovered by `make all`, so it is not a retry pattern
    expect(retries).not.toContain('`npm test`');
  });
});

describe('digest text and analyzer prompt', () => {
  it('renders the reference digest shape and respects the token budget', () => {
    const text = renderDigestText(sessions);
    const lines = text.split('\n');
    expect(lines[0]).toBe('Project: /home/user/demo');
    expect(lines[1]).toMatch(/^Total: \d+ sessions, 27 tool calls, 13 failures \(48\.1%\)$/);
    expect(lines[2]).toMatch(/^Tokens used: [\d,]+ in \/ [\d,]+ out$/);
    expect(text).toContain('=== Detected Loops (HIGHEST PRIORITY) ===');
    expect(text).toContain('=== Session main-session (9 calls, 4 failures, 19,000 input tokens) ===');
    expect(text).toContain('  [3] Read: /home/user/demo/src/confg.ts → ERROR(file_not_found): Error: ENOENT');
    expect(text).toContain('  [9] Read: /home/user/demo/src/config.ts → OK (75 bytes)');
    expect(text).toContain('  [1] USER: "Please fix the failing tests.');
    expect(text).toContain('  [23] INTERRUPTED: [Request interrupted by user]');
    const tiny = renderDigestText(sessions, { maxTokens: 100 });
    expect(tiny).toMatch(/\.\.\. \(remaining \d+ sessions truncated\)/);
    expect(renderDigestText([])).toContain('Total: 0 sessions, 0 tool calls');
  });

  it('builds the CLI prompt: system prompt + user prefix + digest (+ prior block before sessions)', () => {
    const prompt = renderAnalyzerPrompt(sessions, { project: '/home/user/demo', priorBlock: '<!-- vg:learn:begin -->\n### Old\n- x\n<!-- vg:learn:end -->' });
    expect(prompt.startsWith(ANALYZER_SYSTEM_PROMPT)).toBe(true);
    expect(prompt).toContain(`\n\n${ANALYZER_USER_PREFIX}Project: /home/user/demo`);
    const prior = prompt.indexOf('=== Prior Learned Patterns ===');
    const firstSession = prompt.indexOf('=== Session ');
    expect(prior).toBeGreaterThan(0);
    expect(prior).toBeLessThan(firstSession);
    expect(prompt).toContain('<!-- vg:learn:begin -->');
    expect(renderAnalyzerPrompt(sessions)).not.toContain('=== Prior Learned Patterns ===');
    expect(ANALYZER_SYSTEM_PROMPT).toContain('"context_file_rules"');
    expect(ANALYZER_OUTPUT_SCHEMA).toMatchObject({ type: 'object', definitions: { rule: { required: ['section', 'content'] } } });
  });
});

describe('parsing analyzer output', () => {
  const good = { context_file_rules: [{ section: 'Environment', content: '- use uv', estimated_tokens_saved: 120, evidence_count: 3 }], memory_file_rules: [{ section: 'Prefs', content: '- terse', estimated_tokens_saved: '10' }] };

  it('strips fences and prose, validates, and sorts by savings', () => {
    expect(stripFencedJson(`Here you go:\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\`\nthanks`)).toEqual(good);
    expect(stripFencedJson(`prose ${JSON.stringify(good)} more`)).toEqual(good);
    expect(stripFencedJson('[1,2]')).toBeNull();
    expect(stripFencedJson('nothing')).toBeNull();
    const rules = parseAnalyzerOutput(JSON.stringify(good));
    expect(rules.map((r) => [r.section, r.target, r.estimatedTokensSaved, r.evidenceCount, r.confidence])).toEqual([
      ['Environment', 'context', 120, 3, 0.9],
      ['Prefs', 'memory', 10, 1, 0.7],
    ]);
  });

  it('rejects malformed output with actionable problems', () => {
    expect(validateAnalyzerOutput({ context_file_rules: 'x' })).toMatchObject({ ok: false, problems: ['context_file_rules: expected an array', 'neither context_file_rules nor memory_file_rules present'] });
    expect(validateAnalyzerOutput({}).problems).toEqual(['neither context_file_rules nor memory_file_rules present']);
    expect(validateAnalyzerOutput({ memory_file_rules: [{ section: '', content: 'x', evidence_count: -1 }] }).problems).toEqual(['memory_file_rules[0].section: expected a non-empty string', 'memory_file_rules[0].evidence_count: expected a non-negative integer']);
    expect(validateAnalyzerOutput(null).ok).toBe(false);
    expect(() => parseAnalyzerOutput('not json')).toThrow(/no JSON object/);
    expect(() => parseAnalyzerOutput('{"context_file_rules":[{"section":"x"}]}')).toThrow(/failed validation/);
  });

  it('applyLoopWeighting lifts rules that overlap a detected loop', () => {
    const loop: Loop = { kind: 'refetch-loop', tool: 'Bash', signature: 'bash::grep -rn todo src', sample: 'grep -rn TODO src | head -50', count: 4, wastedTokens: 900, indices: [1, 2, 3, 4], sessions: ['s'] };
    const rules: Rule[] = [
      { target: 'context', section: 'Search Scope', content: '- run `grep -rn TODO src` once without head', confidence: 0.9, evidenceCount: 1, estimatedTokensSaved: 10, isLoopGuardrail: false, loopOccurrences: 0 },
      { target: 'context', section: 'Other', content: '- unrelated advice', confidence: 0.9, evidenceCount: 1, estimatedTokensSaved: 50, isLoopGuardrail: false, loopOccurrences: 0 },
    ];
    applyLoopWeighting(rules, [loop]);
    expect(rules[0]).toMatchObject({ estimatedTokensSaved: 900, isLoopGuardrail: true, loopOccurrences: 4 });
    expect(rules[1]).toMatchObject({ estimatedTokensSaved: 50, isLoopGuardrail: false });
    const parsed = parseAnalyzerOutput(JSON.stringify({ context_file_rules: [{ section: 'Search Scope', content: 'grep todo src once' }] }), [loop]);
    expect(parsed[0].estimatedTokensSaved).toBe(900);
  });
});
