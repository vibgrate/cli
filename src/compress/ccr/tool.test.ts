import { describe, expect, it } from 'vitest';
import { hasRetrieveTool, historyReferencesRetrieveTool, injectRetrieveTool, isRetrieveToolCall, messagesHaveMarkers, RETRIEVE_TOOL_NAME, retrieveToolAnthropic, retrieveToolGemini, retrieveToolGoldenBytes, retrieveToolOpenAI, retrieveToolResponses } from './tool.js';
import { makeMarker } from './markers.js';

describe('retrieve tool schemas', () => {
  it('OpenAI function shape', () => {
    const t = retrieveToolOpenAI() as { type: string; function: { name: string; parameters: { required: string[]; properties: Record<string, unknown> } } };
    expect(t.type).toBe('function');
    expect(t.function.name).toBe('vg_retrieve');
    expect(t.function.parameters.required).toEqual(['hash']);
    expect(Object.keys(t.function.parameters.properties)).toEqual(['hash', 'grep', 'lines', 'head', 'tail', 'json_path', 'max_tokens']);
  });

  it('Anthropic input_schema shape', () => {
    const t = retrieveToolAnthropic() as { name: string; input_schema: { type: string; required: string[] } };
    expect(t.name).toBe(RETRIEVE_TOOL_NAME);
    expect(t.input_schema.type).toBe('object');
    expect(t.input_schema.required).toEqual(['hash']);
  });

  it('Responses flat shape and Gemini declaration', () => {
    expect(retrieveToolResponses()).toMatchObject({ type: 'function', name: 'vg_retrieve' });
    const g = retrieveToolGemini() as { description: string; parameters: { properties: { hash: { description: string } } } };
    expect(g.description).not.toContain('<<vg-ccr');
    expect(g.parameters.properties.hash.description).toBe('Hash from the compression marker');
  });

  it('golden bytes are stable', () => {
    expect(retrieveToolGoldenBytes('anthropic')).toBe(retrieveToolGoldenBytes('anthropic'));
    expect(JSON.parse(retrieveToolGoldenBytes('openai'))).toEqual(retrieveToolOpenAI());
  });

  it('isRetrieveToolCall', () => {
    expect(isRetrieveToolCall('vg_retrieve')).toBe(true);
    expect(isRetrieveToolCall('retrieve')).toBe(false);
  });
});

describe('injectRetrieveTool', () => {
  const marker = makeMarker('rows', 'abcdef0123456789abcdef01', 3);
  it('injects only when markers are present or sticky', () => {
    expect(injectRetrieveTool({ model: 'm' }, 'openai', { hasMarkers: false }).injected).toBe(false);
    const r = injectRetrieveTool({ model: 'm', tools: [{ type: 'function', function: { name: 'other' } }] }, 'openai', { hasMarkers: true });
    expect(r.injected).toBe(true);
    expect((r.body.tools as unknown[]).length).toBe(2);
    expect(injectRetrieveTool({ model: 'm' }, 'anthropic', { hasMarkers: false, sticky: true }).injected).toBe(true);
  });

  it('never duplicates an existing registration (MCP wins) and never mutates the input', () => {
    const body = { tools: [retrieveToolAnthropic()] };
    const r = injectRetrieveTool(body, 'anthropic', { hasMarkers: true });
    expect(r.injected).toBe(false);
    expect(r.body).toBe(body);
    const body2 = { tools: [] as unknown[] };
    injectRetrieveTool(body2, 'anthropic', { hasMarkers: true });
    expect(body2.tools).toEqual([]);
  });

  it('nests into Gemini functionDeclarations', () => {
    const r = injectRetrieveTool({ tools: [{ functionDeclarations: [{ name: 'a' }] }] }, 'gemini', { hasMarkers: true });
    expect(r.injected).toBe(true);
    const decls = (r.body.tools as Array<{ functionDeclarations: Array<{ name: string }> }>)[0].functionDeclarations;
    expect(decls.map((d) => d.name)).toEqual(['a', 'vg_retrieve']);
    expect(hasRetrieveTool(r.body.tools)).toBe(true);
    expect(injectRetrieveTool({}, 'gemini', { hasMarkers: true }).body.tools).toEqual([{ functionDeclarations: [retrieveToolGemini()] }]);
  });

  it('detects markers and history references across formats', () => {
    expect(messagesHaveMarkers([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: `x ${marker}` }] }])).toBe(true);
    expect(messagesHaveMarkers([{ role: 'user', content: 'nothing' }])).toBe(false);
    expect(historyReferencesRetrieveTool([{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'vg_retrieve', input: {} }] }])).toBe(true);
    expect(historyReferencesRetrieveTool([{ role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'vg_retrieve', arguments: '{}' } }] }])).toBe(true);
    expect(historyReferencesRetrieveTool([{ type: 'function_call', call_id: 'c', name: 'vg_retrieve', arguments: '{}' }])).toBe(true);
    expect(historyReferencesRetrieveTool([{ role: 'model', parts: [{ functionCall: { name: 'vg_retrieve', args: {} } }] }])).toBe(true);
    expect(historyReferencesRetrieveTool([{ role: 'user', content: 'hi' }])).toBe(false);
  });
});
