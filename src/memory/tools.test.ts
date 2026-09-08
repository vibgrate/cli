import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from './store.js';
import { handleMemoryTool, inferKind, isMemoryTool, mcpMemorySave, mcpMemorySearch, memoryTools, MCP_MEMORY_SAVE_SCHEMA, MCP_MEMORY_SEARCH_SCHEMA, MEMORY_TOOL_NAMES } from './tools.js';

let dir: string;
let store: MemoryStore;
let clock = 1_700_000_000_000;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-memtools-'));
  store = new MemoryStore({ cwd: dir, env: { VG_MEMORY_DIR: path.join(dir, 'mem') }, git: (_a, cwd) => cwd, now: () => clock });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const parse = (r: { content: string }): Record<string, unknown> => JSON.parse(r.content) as Record<string, unknown>;

describe('memoryTools', () => {
  it('emits every tool in each wire shape with stable ordering', () => {
    const openai = memoryTools('openai');
    expect(openai.map((t) => (t.function as { name: string }).name)).toEqual([...MEMORY_TOOL_NAMES]);
    expect(openai[0]).toMatchObject({ type: 'function', function: { name: 'memory_save', parameters: { required: ['content', 'importance'] } } });
    const anthropic = memoryTools('anthropic');
    expect(anthropic[1]).toMatchObject({ name: 'memory_search', input_schema: { required: ['query'] } });
    expect(anthropic[1]).not.toHaveProperty('type');
    const responses = memoryTools('responses');
    expect(responses[2]).toMatchObject({ type: 'function', name: 'memory_update', parameters: { required: ['memory_id', 'new_content'] } });
    expect(memoryTools('gemini')[3]).toMatchObject({ name: 'memory_delete', parameters: { required: ['memory_id'] } });
    expect(JSON.stringify(memoryTools('openai'))).toBe(JSON.stringify(memoryTools('vercel')));
    const save = (openai[0].function as { description: string }).description;
    expect(save).toContain('passwords, API keys, or private credentials');
    expect(save).toContain('0.9-1.0: Critical facts');
    expect((openai[1].function as { description: string }).description).toContain('Search BEFORE saving to avoid duplicates');
    expect(isMemoryTool('memory_list')).toBe(true);
    expect(isMemoryTool('vg_retrieve')).toBe(false);
  });
});

describe('handleMemoryTool', () => {
  it('save → search → update → delete → list round trip', () => {
    const saved = parse(handleMemoryTool(store, 'memory_save', { content: 'User prefers dark mode in all applications', importance: 0.8, entities: ['UI'] }));
    expect(saved.status).toBe('saved');
    const id = saved.memory_id as string;
    expect(store.get(id)?.kind).toBe('preference');
    expect(store.get(id)?.scope).toBe('project');
    expect(store.get(id)?.tags).toEqual(['ui']);

    const found = parse(handleMemoryTool(store, 'memory_search', { query: 'dark mode preference', top_k: 5 }));
    expect(found.status).toBe('found');
    expect(found.count).toBe(1);
    const hit = (found.memories as Array<Record<string, unknown>>)[0];
    expect(hit.id).toBe(id);
    expect(hit.entities).toEqual(['ui']);
    expect(typeof hit.score).toBe('number');
    expect(parse(handleMemoryTool(store, 'memory_search', { query: 'dark', entities: ['Nope'] })).count).toBe(0);

    const upd = parse(handleMemoryTool(store, 'memory_update', { memory_id: id, new_content: 'User prefers light mode' }));
    expect(upd.status).toBe('updated');
    expect(upd.previous_id).toBe(id);
    const newId = upd.memory_id as string;
    expect(store.get(id)).toBeNull();

    const listed = parse(handleMemoryTool(store, 'memory_list', { limit: '5' }));
    expect(listed.count).toBe(1);
    expect((listed.memories as Array<Record<string, unknown>>)[0]).toMatchObject({ id: newId, content: 'User prefers light mode' });
    expect(typeof (listed.memories as Array<Record<string, unknown>>)[0].created_at).toBe('string');

    expect(parse(handleMemoryTool(store, 'memory_delete', { memory_id: newId }))).toEqual({ status: 'deleted', memory_id: newId });
    expect(parse(handleMemoryTool(store, 'memory_delete', { memory_id: newId }))).toEqual({ status: 'not_found', memory_id: newId });
  });

  it('validates arguments and reports errors as tool errors', () => {
    expect(handleMemoryTool(store, 'memory_save', {})).toEqual({ content: JSON.stringify({ status: 'error', error: 'content is required' }), isError: true });
    expect(parse(handleMemoryTool(store, 'memory_save', { content: 'x', importance: 7 })).error).toBe('importance must be between 0.0 and 1.0');
    expect(parse(handleMemoryTool(store, 'memory_search', {})).error).toBe('query is required');
    expect(parse(handleMemoryTool(store, 'memory_update', { memory_id: 'a' })).error).toBe('new_content is required');
    expect(parse(handleMemoryTool(store, 'memory_update', { new_content: 'a' })).error).toBe('memory_id is required');
    expect(parse(handleMemoryTool(store, 'memory_update', { memory_id: 'missing', new_content: 'a' })).error).toBe('Memory not found: missing');
    expect(parse(handleMemoryTool(store, 'memory_delete', {})).error).toBe('memory_id is required');
    expect(parse(handleMemoryTool(store, 'nope', {})).error).toBe('Unknown tool: nope');
  });

  it('notes a similar existing memory on save and reinforces exact repeats', () => {
    handleMemoryTool(store, 'memory_save', { content: 'Deploys run from the main branch only', importance: 0.7 });
    const near = parse(handleMemoryTool(store, 'memory_save', { content: 'Deploys run from the main branch only please', importance: 0.7 }));
    expect(String(near.note ?? '')).toContain('Similar memory exists');
    const same = parse(handleMemoryTool(store, 'memory_save', { content: 'Deploys run from the main branch only', importance: 0.7 }));
    expect(same.evidence).toBe(2);
    expect(same.note).toBeUndefined();
  });

  it('falls back to user scope when the project is unresolved', () => {
    const noProject = new MemoryStore({ cwd: dir, env: { VG_MEMORY_DIR: path.join(dir, 'mem') }, git: () => null, now: () => clock });
    const r = parse(handleMemoryTool(noProject, 'memory_save', { content: 'fact', importance: 0.5 }));
    expect(noProject.get(r.memory_id as string)?.scope).toBe('user');
  });

  it('inferKind maps common phrasings', () => {
    expect(inferKind('User prefers tabs')).toBe('preference');
    expect(inferKind('Never commit directly to main')).toBe('rule');
    expect(inferKind('We decided to use Postgres')).toBe('decision');
    expect(inferKind('File `a` does not exist. The correct path is `b`.')).toBe('gotcha');
    expect(inferKind('Working test command: `pnpm test`')).toBe('command');
    expect(inferKind('The repo owner is Alice')).toBe('fact');
  });
});

describe('MCP helpers', () => {
  it('memory_save saves atomic facts and reports counts', () => {
    expect(mcpMemorySave(store, {})).toBe('Error: facts array is required');
    const out = mcpMemorySave(store, { facts: ['Repo owner is Alice', ' ', 'User prefers dark mode'], importance: 0.7 });
    expect(out.split('\n')[0]).toBe('Saved 2 new, updated 0 existing (2 total)');
    expect(out).toMatch(/ {2}saved \[[0-9a-f]{8}\]: Repo owner is Alice/);
    expect(mcpMemorySave(store, { content: 'Repo owner is Alice' }).split('\n')[0]).toBe('Saved 0 new, updated 1 existing (1 total)');
    expect(MCP_MEMORY_SAVE_SCHEMA).toMatchObject({ required: [] });
  });

  it('memory_search renders relevance rows or a no-hit message', () => {
    expect(mcpMemorySearch(store, {})).toBe('Error: query is required');
    expect(mcpMemorySearch(store, { query: 'anything' })).toBe('No memories found.');
    store.add({ scope: 'project', kind: 'fact', text: 'The auth module lives in src/auth', tags: ['auth', 'layout'], source: 'user' });
    const text = mcpMemorySearch(store, { query: 'where is auth', top_k: 3 });
    expect(text).toMatch(/^1\. \[relevance=\d\.\d\d\] The auth module lives in src\/auth\n {3}Related: auth, layout$/);
    expect(MCP_MEMORY_SEARCH_SCHEMA).toMatchObject({ required: ['query'] });
  });
});
