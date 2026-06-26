import * as fs from 'node:fs';
import * as path from 'node:path';
import { skillMarkdown, nudgeMarkdown, mcpServerEntry, NUDGE_BEGIN, NUDGE_END } from './content.js';

/**
 * Per-assistant install registry (a focused subset of VG-ASSISTANT-INSTALL §2;
 * the remaining 20+ assistants are added in Phase 3). All paths are repo-local
 * (the team-shareable, safe default); writes are idempotent.
 */

export interface McpTarget {
  file: string; // project-relative
  key: 'mcpServers' | 'servers';
  vscode?: boolean; // VS Code uses { servers: { vg: { type:'stdio', ... } } }
}
export interface NudgeTarget {
  file: string;
  kind: 'block' | 'file';
}
export interface Assistant {
  id: string;
  label: string;
  skill?: string; // project-relative SKILL.md path
  mcp?: McpTarget;
  nudge?: NudgeTarget;
}

export const ASSISTANTS: Assistant[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    skill: '.claude/skills/vg/SKILL.md',
    mcp: { file: '.mcp.json', key: 'mcpServers' },
    nudge: { file: 'CLAUDE.md', kind: 'block' },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    mcp: { file: '.cursor/mcp.json', key: 'mcpServers' },
    nudge: { file: '.cursor/rules/vg.mdc', kind: 'file' },
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    mcp: { file: '.windsurf/mcp.json', key: 'mcpServers' },
    nudge: { file: '.windsurf/rules/vg.md', kind: 'file' },
  },
  {
    id: 'vscode',
    label: 'VS Code (Copilot Chat)',
    mcp: { file: '.vscode/mcp.json', key: 'servers', vscode: true },
    nudge: { file: '.github/copilot-instructions.md', kind: 'block' },
  },
  {
    id: 'codex',
    label: 'Codex',
    skill: '.codex/skills/vg/SKILL.md',
    nudge: { file: 'AGENTS.md', kind: 'block' },
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    skill: '.gemini/skills/vg/SKILL.md',
    nudge: { file: 'GEMINI.md', kind: 'block' },
  },
  // Skill + advisory AGENTS.md nudge (the broad-reach common denominator). MCP
  // registration for these hosts is host-specific and added as their formats
  // stabilise; the skill + nudge work today.
  { id: 'opencode', label: 'OpenCode', skill: '.opencode/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' } },
  { id: 'kilo', label: 'Kilo Code', skill: '.kilo/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' } },
  { id: 'aider', label: 'Aider', skill: '.aider/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' } },
  { id: 'factory', label: 'Factory Droid', skill: '.factory/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' } },
  { id: 'trae', label: 'Trae', skill: '.trae/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' } },
  { id: 'kiro', label: 'Kiro', skill: '.kiro/skills/vg/SKILL.md', nudge: { file: '.kiro/steering/vg.md', kind: 'file' } },
  { id: 'amp', label: 'Amp', skill: '.agents/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' } },
  { id: 'kimi', label: 'Kimi Code', skill: '.kimi/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' } },
  { id: 'codebuddy', label: 'CodeBuddy', skill: '.codebuddy/skills/vg/SKILL.md', nudge: { file: 'CODEBUDDY.md', kind: 'block' } },
  { id: 'copilot-cli', label: 'GitHub Copilot CLI', skill: '.copilot/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' } },
  { id: 'pi', label: 'Pi', skill: '.pi/agent/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' } },
  { id: 'devin', label: 'Devin CLI', skill: '.devin/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' } },
  { id: 'hermes', label: 'Hermes', skill: '.hermes/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' } },
  { id: 'openclaw', label: 'OpenClaw', skill: '.openclaw/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' } },
  { id: 'agents', label: 'Agent-Skills (generic)', skill: '.agents/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' } },
];

export function assistantById(id: string): Assistant | undefined {
  return ASSISTANTS.find((a) => a.id === id);
}

export interface InstallOptions {
  root: string;
  hook?: boolean; // write the advisory nudge (default true)
  smallRepo: boolean;
}

export interface InstallAction {
  wrote: string[];
  skipped: string[];
}

export function installAssistant(a: Assistant, opts: InstallOptions): InstallAction {
  const wrote: string[] = [];
  const skipped: string[] = [];

  if (a.skill) {
    writeFileEnsured(path.join(opts.root, a.skill), skillMarkdown());
    wrote.push(a.skill);
  }
  if (a.mcp) {
    upsertMcp(path.join(opts.root, a.mcp.file), a.mcp);
    wrote.push(a.mcp.file);
  } else {
    skipped.push('mcp (host-specific setup)');
  }
  if (a.nudge && opts.hook !== false) {
    writeNudge(path.join(opts.root, a.nudge.file), a.nudge, opts.smallRepo);
    wrote.push(a.nudge.file);
  } else if (a.nudge) {
    skipped.push('nudge (--no-hook)');
  }

  return { wrote, skipped };
}

export function uninstallAssistant(a: Assistant, root: string, purge: boolean): string[] {
  const removed: string[] = [];
  if (a.mcp) {
    const file = path.join(root, a.mcp.file);
    if (removeMcp(file, a.mcp)) removed.push(a.mcp.file);
  }
  if (a.nudge) {
    const file = path.join(root, a.nudge.file);
    if (a.nudge.kind === 'block') {
      if (removeBlock(file)) removed.push(a.nudge.file);
    } else if (fs.existsSync(file)) {
      fs.rmSync(file);
      removed.push(a.nudge.file);
    }
  }
  if (purge && a.skill) {
    const file = path.join(root, a.skill);
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      removed.push(a.skill);
    }
  }
  return removed;
}

// --- writers ---

function writeFileEnsured(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function upsertMcp(file: string, target: McpTarget): void {
  const config = readJson(file);
  const entry = mcpServerEntry();
  const value = target.vscode ? { type: 'stdio', ...entry } : entry;
  const bag = (config[target.key] && typeof config[target.key] === 'object'
    ? config[target.key]
    : {}) as Record<string, unknown>;
  bag.vg = value;
  config[target.key] = bag;
  writeFileEnsured(file, `${JSON.stringify(config, null, 2)}\n`);
}

function removeMcp(file: string, target: McpTarget): boolean {
  if (!fs.existsSync(file)) return false;
  const config = readJson(file);
  const bag = config[target.key] as Record<string, unknown> | undefined;
  if (!bag || !(bag.vg !== undefined)) return false;
  delete bag.vg;
  writeFileEnsured(file, `${JSON.stringify(config, null, 2)}\n`);
  return true;
}

function writeNudge(file: string, target: NudgeTarget, smallRepo: boolean): void {
  if (target.kind === 'file') {
    // Dedicated rule file owned by vg (Cursor .mdc needs frontmatter).
    const body = file.endsWith('.mdc')
      ? `---\ndescription: vg code graph\nalwaysApply: true\n---\n${stripMarkers(nudgeMarkdown(smallRepo))}`
      : stripMarkers(nudgeMarkdown(smallRepo));
    writeFileEnsured(file, `${body}\n`);
    return;
  }
  upsertBlock(file, nudgeMarkdown(smallRepo));
}

function upsertBlock(file: string, block: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`${escapeRe(NUDGE_BEGIN)}[\\s\\S]*?${escapeRe(NUDGE_END)}`);
  if (re.test(existing)) existing = existing.replace(re, block);
  else existing = existing.length ? `${existing.replace(/\s*$/, '')}\n\n${block}\n` : `${block}\n`;
  fs.writeFileSync(file, existing);
}

function removeBlock(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const existing = fs.readFileSync(file, 'utf8');
  const re = new RegExp(`\\n*${escapeRe(NUDGE_BEGIN)}[\\s\\S]*?${escapeRe(NUDGE_END)}\\n*`);
  if (!re.test(existing)) return false;
  fs.writeFileSync(file, existing.replace(re, '\n'));
  return true;
}

function readJson(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stripMarkers(s: string): string {
  return s.replace(NUDGE_BEGIN, '').replace(NUDGE_END, '').trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
