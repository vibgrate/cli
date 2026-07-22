/**
 * Discover external MCP server config (VG-CLI-CODE §17.1).
 *
 * The ecosystem has converged on one shape — an `mcpServers` object of
 * `{ command, args, env }` (or `{ url, type }` for remote) — written to a few
 * standard files: `.mcp.json` (Claude Code's project config), `.cursor/mcp.json`
 * (Cursor), and `.vscode/mcp.json` (VS Code, which uses a `servers` key). So a
 * developer who already wired MCP tools for one of those tools gets them in
 * VG Code for free: we read those files and merge them with the `mcpServers` in
 * `.vibgrate/code.json`, which — being our explicit surface — wins on any name
 * collision.
 *
 * Pure file reads over an injected root; tolerant of missing/malformed files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseMcpServers, type McpServerConfig } from './config.js';

/**
 * The standard project files we read, **lowest precedence first** so later
 * entries override earlier ones by name. `.vibgrate/code.json` (our own) is
 * applied last, above all of these.
 */
export const MCP_CONFIG_FILES = ['.cursor/mcp.json', '.vscode/mcp.json', '.mcp.json'] as const;

/** Read one MCP config file into validated server entries (accepts `mcpServers` or `servers`). */
export function readMcpServersFile(file: string): Record<string, McpServerConfig> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: unknown; servers?: unknown };
    const map = (raw.mcpServers ?? raw.servers) as Record<string, unknown> | undefined;
    return map && typeof map === 'object' ? parseMcpServers(map) : {};
  } catch {
    return {};
  }
}

export interface McpDiscovery {
  servers: Record<string, McpServerConfig>;
  /** Which files/sources contributed servers (for a transparent status line). */
  sources: string[];
}

/**
 * Merge MCP servers from the standard config files plus our own `ownServers`
 * (highest precedence). Returns the effective map and the list of sources that
 * contributed at least one server.
 */
export function discoverMcpServers(root: string, ownServers?: Record<string, McpServerConfig>): McpDiscovery {
  const servers: Record<string, McpServerConfig> = {};
  const sources: string[] = [];
  for (const rel of MCP_CONFIG_FILES) {
    const found = readMcpServersFile(path.join(root, rel));
    const names = Object.keys(found);
    if (names.length) {
      sources.push(rel);
      for (const n of names) servers[n] = found[n];
    }
  }
  if (ownServers && Object.keys(ownServers).length) {
    sources.push('.vibgrate/code.json');
    for (const [n, cfg] of Object.entries(ownServers)) servers[n] = cfg; // ours wins
  }
  return { servers, sources };
}
