/**
 * Project config for VG Code (VG-CLI-CODE §14) — `.vibgrate/code.json`.
 *
 * The point is that an indie dev sets their model + preferences once and then
 * just runs `vg code`. Flags always win over the file; the file wins over the
 * built-in defaults. Everything is optional and the loader is tolerant — a
 * missing or malformed file is simply "no config", never an error.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CodeConfig {
  /** Default backend id (ollama, openrouter, …). */
  provider?: string;
  /** Default model id/slug. */
  model?: string;
  /** Run autonomously (auto-approve) by default. */
  auto?: boolean;
  /** The project's test/verify command, surfaced to the agent. */
  testCommand?: string;
  /** Extra command-denylist rules (regex or substring) for autonomous mode. */
  denyCommands?: string[];
  /** Override the model's usable context window (tokens) for compaction sizing. */
  contextWindow?: number;
  /** Default step cap. */
  maxSteps?: number;
  /** External MCP servers whose tools the agent may call (name → launch spec). */
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * An MCP server entry, in the ecosystem-standard shape used by Claude Code
 * (`.mcp.json`), Cursor, and others: a local stdio server (`command`/`args`/
 * `env`) or a remote server (`url`, optional `type`). A valid entry has one or
 * the other.
 */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Remote server endpoint (streamable-HTTP or SSE). */
  url?: string;
  type?: 'http' | 'sse' | 'stdio';
  headers?: Record<string, string>;
}

export function codeConfigPath(root: string): string {
  return path.join(root, '.vibgrate', 'code.json');
}

/** Load `.vibgrate/code.json`, tolerating absence and malformed JSON. */
export function loadCodeConfig(root: string): CodeConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(codeConfigPath(root), 'utf8')) as Record<string, unknown>;
    return sanitize(raw);
  } catch {
    return {};
  }
}

/** Keep only recognised, well-typed keys (an untrusted file never injects junk). */
function sanitize(raw: Record<string, unknown>): CodeConfig {
  const out: CodeConfig = {};
  if (typeof raw.provider === 'string') out.provider = raw.provider;
  if (typeof raw.model === 'string') out.model = raw.model;
  if (typeof raw.auto === 'boolean') out.auto = raw.auto;
  if (typeof raw.testCommand === 'string') out.testCommand = raw.testCommand;
  if (Array.isArray(raw.denyCommands)) out.denyCommands = raw.denyCommands.filter((x): x is string => typeof x === 'string');
  if (typeof raw.contextWindow === 'number' && raw.contextWindow > 0) out.contextWindow = raw.contextWindow;
  if (typeof raw.maxSteps === 'number' && raw.maxSteps > 0) out.maxSteps = Math.floor(raw.maxSteps);
  if (raw.mcpServers && typeof raw.mcpServers === 'object') {
    const servers = parseMcpServers(raw.mcpServers as Record<string, unknown>);
    if (Object.keys(servers).length) out.mcpServers = servers;
  }
  return out;
}

/**
 * Parse an `mcpServers` (or VS Code `servers`) map into validated entries.
 * Accepts the standard stdio (`command`) and remote (`url`) shapes; an entry
 * with neither is dropped. Shared by the code-config loader and the discovery
 * of external MCP config files.
 */
export function parseMcpServers(raw: Record<string, unknown>): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object') continue;
    const s = v as { command?: unknown; args?: unknown; env?: unknown; url?: unknown; type?: unknown; headers?: unknown };
    const hasCommand = typeof s.command === 'string';
    const hasUrl = typeof s.url === 'string';
    if (!hasCommand && !hasUrl) continue;
    servers[name] = {
      command: hasCommand ? (s.command as string) : undefined,
      args: Array.isArray(s.args) ? s.args.filter((x): x is string => typeof x === 'string') : undefined,
      env: s.env && typeof s.env === 'object' ? (s.env as Record<string, string>) : undefined,
      url: hasUrl ? (s.url as string) : undefined,
      type: s.type === 'http' || s.type === 'sse' || s.type === 'stdio' ? s.type : undefined,
      headers: s.headers && typeof s.headers === 'object' ? (s.headers as Record<string, string>) : undefined,
    };
  }
  return servers;
}

/**
 * The compaction token budget for a run: an explicit config value wins; else
 * ~60% of the model's context window (leaving room for the reply); else a safe
 * default for models whose window we don't know.
 */
export function contextBudgetFor(config: CodeConfig, modelContextWindow?: number): number {
  if (config.contextWindow) return Math.floor(config.contextWindow * 0.6);
  if (modelContextWindow && modelContextWindow > 0) return Math.floor(modelContextWindow * 0.6);
  return 16_000;
}
