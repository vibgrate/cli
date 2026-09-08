import { describe, expect, it } from 'vitest';
import { applyAnthropicSteering, applyOpenAIChatSteering, applyResponsesSteering, clampEffort, classifyResponsesInput, classifyTurn, replaceOrAppendSteeringBlock, resolveVerbosityLevel, shapeRequest, steeringText, STEERING_SENTINEL, STEERING_SUFFIX, VERBOSITY_LEVELS } from './output-shaper.js';

describe('verbosity steering text', () => {
  it('keeps the byte-stable level texts and the vg sentinel', () => {
    expect(STEERING_SENTINEL).toBe('<vg_output_shaping>');
    expect(STEERING_SUFFIX).toBe('</vg_output_shaping>');
    expect(VERBOSITY_LEVELS[1]).toBe('Skip preamble and postamble. Do not announce what you are about to do or recap what you just did; start with the substance.');
    expect(VERBOSITY_LEVELS[2].startsWith('Skip preamble and postamble; start with the substance. Never restate code')).toBe(true);
    expect(VERBOSITY_LEVELS[3]).toContain('cite the exact file path and line or symbol instead, always; a reference that omits the location is not a reference.');
    expect(VERBOSITY_LEVELS[3]).toContain('Never drop anything the turn or task needs to be correct, including negations (not, never, no, only, except)');
    expect(VERBOSITY_LEVELS[4].startsWith('Minimum tokens. Fragments fine.')).toBe(true);
    expect(steeringText(0)).toBeNull();
    expect(steeringText(2)).toBe(`${STEERING_SENTINEL}\n${VERBOSITY_LEVELS[2]}\n${STEERING_SUFFIX}`);
    for (const level of [1, 2, 3, 4] as const) expect(VERBOSITY_LEVELS[level]).not.toMatch(/headroom/i);
  });

  it('replaceOrAppendSteeringBlock is idempotent and replaces a stale level', () => {
    const l2 = steeringText(2)!;
    const l3 = steeringText(3)!;
    const once = replaceOrAppendSteeringBlock('You are helpful.  \n', l2);
    expect(once).toBe(`You are helpful.\n\n${l2}`);
    expect(replaceOrAppendSteeringBlock(once, l2)).toBe(once);
    expect(replaceOrAppendSteeringBlock(once, l3)).toBe(`You are helpful.\n\n${l3}`);
    expect(replaceOrAppendSteeringBlock(`${l2}\n\ntrailing rules`, l3)).toBe(`${l3}\n\ntrailing rules`);
    expect(replaceOrAppendSteeringBlock('', l2)).toBe(l2);
  });

  it('injects at the right site for each format', () => {
    const block = steeringText(1)!;
    const a1: Record<string, unknown> = {};
    expect(applyAnthropicSteering(a1, block)).toBe(true);
    expect(a1.system).toEqual([{ type: 'text', text: block }]);
    const a2: Record<string, unknown> = { system: 'sys' };
    applyAnthropicSteering(a2, block);
    expect(a2.system).toEqual([{ type: 'text', text: 'sys' }, { type: 'text', text: block }]);
    const a3: Record<string, unknown> = { system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }] };
    applyAnthropicSteering(a3, block);
    expect((a3.system as unknown[]).length).toBe(2);
    expect((a3.system as Array<Record<string, unknown>>)[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(applyAnthropicSteering(a3, block)).toBe(false); // identical → unchanged
    const o1: Record<string, unknown> = { messages: [{ role: 'user', content: 'hi' }] };
    applyOpenAIChatSteering(o1, block);
    expect((o1.messages as Array<Record<string, unknown>>)[0]).toEqual({ role: 'system', content: block });
    const o2: Record<string, unknown> = { messages: [{ role: 'developer', content: 'dev' }, { role: 'user', content: 'hi' }] };
    applyOpenAIChatSteering(o2, block);
    expect((o2.messages as Array<Record<string, unknown>>)[0].content).toBe(`dev\n\n${block}`);
    const r1: Record<string, unknown> = {};
    applyResponsesSteering(r1, block);
    expect(r1.instructions).toBe(block);
    const r2: Record<string, unknown> = { instructions: 'be nice' };
    applyResponsesSteering(r2, block);
    expect(r2.instructions).toBe(`be nice\n\n${block}`);
  });
});

describe('turn classification', () => {
  it('classifies Anthropic turns structurally', () => {
    expect(classifyTurn([])).toBe('unknown');
    expect(classifyTurn([{ role: 'assistant', content: 'x' }])).toBe('unknown');
    expect(classifyTurn([{ role: 'user', content: 'ask' }])).toBe('new_user_ask');
    expect(classifyTurn([{ role: 'user', content: '   ' }])).toBe('unknown');
    expect(classifyTurn([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] }])).toBe('mechanical_continuation');
    expect(classifyTurn([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x', is_error: true }] }])).toBe('error_continuation');
    expect(classifyTurn([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }, { type: 'text', text: 'and?' }] }])).toBe('new_user_ask');
    expect(classifyTurn([{ role: 'user', content: [{ type: 'image', source: {} }] }])).toBe('new_user_ask');
  });

  it('classifies Responses input, sniffing errors only from JSON fields', () => {
    expect(classifyResponsesInput('hello')).toBe('new_user_ask');
    expect(classifyResponsesInput([{ type: 'function_call_output', call_id: 'c', output: '{"exit_code":0}' }])).toBe('mechanical_continuation');
    expect(classifyResponsesInput([{ type: 'function_call_output', call_id: 'c', output: '{"exit_code":2}' }])).toBe('error_continuation');
    expect(classifyResponsesInput([{ type: 'function_call_output', call_id: 'c', output: 'Error: prose is not an error signal' }])).toBe('mechanical_continuation');
    expect(classifyResponsesInput([{ type: 'function_call_output', call_id: 'c', output: '{}' }, { role: 'user', content: 'now?' }])).toBe('new_user_ask');
    expect(classifyResponsesInput([{ type: 'weird' }])).toBe('unknown');
  });
});

describe('effort clamp-only invariant', () => {
  it('lowers explicit effort only on mechanical continuations and never injects', () => {
    const mech: Record<string, unknown> = { output_config: { effort: 'high' }, thinking: { type: 'enabled', budget_tokens: 8000 } };
    expect(clampEffort(mech, 'anthropic', 'mechanical_continuation')).toEqual(['output_shaper:effort:low', 'output_shaper:thinking_budget:1024']);
    expect((mech.output_config as Record<string, unknown>).effort).toBe('low');
    expect((mech.thinking as Record<string, unknown>).type).toBe('enabled');
    expect((mech.thinking as Record<string, unknown>).budget_tokens).toBe(1024);
    const absent: Record<string, unknown> = {};
    expect(clampEffort(absent, 'anthropic', 'mechanical_continuation')).toEqual([]);
    expect(absent.output_config).toBeUndefined();
    const ask: Record<string, unknown> = { output_config: { effort: 'high' } };
    expect(clampEffort(ask, 'anthropic', 'new_user_ask')).toEqual([]);
    expect((ask.output_config as Record<string, unknown>).effort).toBe('high');
    const low: Record<string, unknown> = { output_config: { effort: 'low' } };
    expect(clampEffort(low, 'anthropic', 'mechanical_continuation')).toEqual([]);
    const resp: Record<string, unknown> = { reasoning: { effort: 'medium' } };
    expect(clampEffort(resp, 'responses', 'mechanical_continuation')).toEqual(['output_shaper:effort:low']);
  });

  it('shapeRequest respects steeringAllowed and emits labels', () => {
    const body: Record<string, unknown> = { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] }], output_config: { effort: 'high' } };
    expect(shapeRequest(body, 'anthropic', { level: 3, effortRouting: true, steeringAllowed: false })).toEqual(['output_shaper:effort:low']);
    expect(body.system).toBeUndefined();
    expect(shapeRequest(body, 'anthropic', { level: 3, effortRouting: false, steeringAllowed: true })).toEqual(['output_shaper:verbosity:L3']);
    expect(shapeRequest(body, 'anthropic', { level: 3, effortRouting: false, steeringAllowed: true })).toEqual([]); // idempotent
  });

  it('resolves the verbosity level with cache mode outranking everything', () => {
    expect(resolveVerbosityLevel({ steeringAllowed: false, envLevel: 4, envExplicit: true, defaultLevel: 2 })).toEqual({ level: 0, source: 'cache_mode' });
    expect(resolveVerbosityLevel({ steeringAllowed: true, envLevel: 4, envExplicit: true, learnedLevel: 1, defaultLevel: 2 })).toEqual({ level: 4, source: 'env' });
    expect(resolveVerbosityLevel({ steeringAllowed: true, envLevel: 2, envExplicit: false, learnedLevel: 1, defaultLevel: 2 })).toEqual({ level: 1, source: 'learned' });
    expect(resolveVerbosityLevel({ steeringAllowed: true, envExplicit: false, defaultLevel: 9 })).toEqual({ level: 4, source: 'default' });
  });
});
