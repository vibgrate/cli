import { describe, it, expect, vi } from 'vitest';
import { McpToolset, type McpClientLike, type McpConnect } from './mcp-tools.js';
import type { MutatingAction } from './tools.js';
import type { ToolCall } from './types.js';

/** A fake MCP client with a read-only and a destructive tool. */
function fakeClient(calls: string[]): McpClientLike {
  return {
    async listTools() {
      return {
        tools: [
          { name: 'get_weather', description: 'read weather', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { city: { type: 'string' } } } },
          { name: 'send_email', description: 'send an email', annotations: { readOnlyHint: false } },
        ],
      };
    },
    async callTool(args) {
      calls.push(args.name);
      return { content: [{ type: 'text', text: `ran ${args.name}` }] };
    },
    async close() {},
  };
}

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: 'c1', name, arguments: args });
const allow = async (): Promise<boolean> => true;
const deny = async (): Promise<boolean> => false;

describe('McpToolset', () => {
  it('namespaces external tools and lists them', async () => {
    const connect: McpConnect = async () => fakeClient([]);
    const { toolset } = await McpToolset.connect({ acme: { command: 'x' } }, connect);
    const names = toolset.specs().map((s) => s.name);
    expect(names).toEqual(['mcp__acme__get_weather', 'mcp__acme__send_email']);
    expect(toolset.owns('mcp__acme__get_weather')).toBe(true);
    expect(toolset.owns('read_file')).toBe(false);
  });

  it('runs a read-only tool without approval', async () => {
    const calls: string[] = [];
    const { toolset } = await McpToolset.connect({ acme: { command: 'x' } }, async () => fakeClient(calls));
    const r = await toolset.execute(call('mcp__acme__get_weather', { city: 'NYC' }), deny); // deny would block a gated tool
    expect(r.content).toContain('ran get_weather');
    expect(calls).toEqual(['get_weather']);
  });

  it('gates a non-read-only tool through approval', async () => {
    const calls: string[] = [];
    const { toolset } = await McpToolset.connect({ acme: { command: 'x' } }, async () => fakeClient(calls));
    const denied = await toolset.execute(call('mcp__acme__send_email'), deny);
    expect(denied.content).toMatch(/declined/);
    expect(calls).toEqual([]); // not run
    const approved = await toolset.execute(call('mcp__acme__send_email'), allow);
    expect(approved.content).toContain('ran send_email');
    expect(calls).toEqual(['send_email']);
  });

  it('skips a server that fails to connect, with a warning', async () => {
    const connect: McpConnect = async (name) => {
      if (name === 'broken') throw new Error('spawn failed');
      return fakeClient([]);
    };
    const { toolset, warnings } = await McpToolset.connect({ acme: { command: 'x' }, broken: { command: 'y' } }, connect);
    expect(warnings.join(' ')).toContain('broken');
    expect(toolset.specs().every((s) => s.name.startsWith('mcp__acme__'))).toBe(true);
  });

  it('dispose closes clients', async () => {
    const close = vi.fn(async () => {});
    const client: McpClientLike = { ...fakeClient([]), close };
    const { toolset } = await McpToolset.connect({ acme: { command: 'x' } }, async () => client);
    await toolset.dispose();
    expect(close).toHaveBeenCalled();
  });
});

// A generic mutating action passes typecheck for the gate signature used above.
const _typecheck: MutatingAction = { kind: 'tool', name: 'x', args: {} };
void _typecheck;
