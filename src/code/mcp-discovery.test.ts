import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readMcpServersFile, discoverMcpServers } from './mcp-discovery.js';

function tmp(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-mcp-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

describe('readMcpServersFile', () => {
  it('reads the standard mcpServers key (stdio + remote)', () => {
    const root = tmp({ '.mcp.json': JSON.stringify({ mcpServers: { pw: { command: 'npx', args: ['-y', '@playwright/mcp'] }, api: { url: 'https://x/mcp', type: 'http' } } }) });
    try {
      const servers = readMcpServersFile(path.join(root, '.mcp.json'));
      expect(servers.pw.command).toBe('npx');
      expect(servers.api.url).toBe('https://x/mcp');
      expect(servers.api.type).toBe('http');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads the VS Code `servers` key too', () => {
    const root = tmp({ '.vscode/mcp.json': JSON.stringify({ servers: { db: { command: 'mcp-db' } } }) });
    try {
      expect(readMcpServersFile(path.join(root, '.vscode/mcp.json')).db.command).toBe('mcp-db');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns {} for missing or malformed files', () => {
    expect(readMcpServersFile('/nope/.mcp.json')).toEqual({});
    const root = tmp({ '.mcp.json': '{ not json' });
    try {
      expect(readMcpServersFile(path.join(root, '.mcp.json'))).toEqual({});
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('discoverMcpServers', () => {
  it('merges standard files with our config; ours wins on a name clash', () => {
    const root = tmp({
      '.cursor/mcp.json': JSON.stringify({ mcpServers: { pw: { command: 'cursor-pw' }, cursorOnly: { command: 'c' } } }),
      '.mcp.json': JSON.stringify({ mcpServers: { pw: { command: 'claude-pw' }, claudeOnly: { command: 'x' } } }),
    });
    try {
      const own = { pw: { command: 'vibgrate-pw' }, vibOnly: { command: 'v' } };
      const { servers, sources } = discoverMcpServers(root, own);
      // every server present
      expect(Object.keys(servers).sort()).toEqual(['claudeOnly', 'cursorOnly', 'pw', 'vibOnly']);
      // ours wins the `pw` collision (highest precedence)
      expect(servers.pw.command).toBe('vibgrate-pw');
      expect(sources).toEqual(['.cursor/mcp.json', '.mcp.json', '.vibgrate/code.json']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('.mcp.json overrides .cursor on a clash (later file wins)', () => {
    const root = tmp({
      '.cursor/mcp.json': JSON.stringify({ mcpServers: { s: { command: 'cursor' } } }),
      '.mcp.json': JSON.stringify({ mcpServers: { s: { command: 'claude' } } }),
    });
    try {
      expect(discoverMcpServers(root).servers.s.command).toBe('claude');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns empty with no config anywhere', () => {
    const root = tmp({});
    try {
      expect(discoverMcpServers(root)).toEqual({ servers: {}, sources: [] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
