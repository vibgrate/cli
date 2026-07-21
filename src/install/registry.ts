import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  skillMarkdown,
  nudgeMarkdown,
  mcpServerEntry,
  installedContentVersion,
  INSTALL_CONTENT_VERSION,
  NUDGE_BEGIN,
  NUDGE_END,
  type ServeLaunch,
} from './content.js';
import { CliError, ExitCode } from '../util/exit.js';
import { ensureVibgrateGitignore } from '../engine/artifacts.js';
import { whichOnPath, isInstalledOwnBinary } from '../util/cli-invocation.js';
import { navigationToolsetConfig, HOT_TOOLS, deferredToolNames } from '../mcp/tools.js';

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
  /**
   * Signs this assistant is in use, checked by `detectAssistants`:
   * `markers` are project-relative paths, `homeMarkers` are relative to the
   * user's home folder, `bin` are executables looked up on PATH. Detection is
   * best-effort presence-checking only — nothing is read or executed.
   */
  markers?: string[];
  homeMarkers?: string[];
  bin?: string[];
}

export const ASSISTANTS: Assistant[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    skill: '.claude/skills/vg/SKILL.md',
    mcp: { file: '.mcp.json', key: 'mcpServers' },
    nudge: { file: 'CLAUDE.md', kind: 'block' },
    markers: ['CLAUDE.md', '.claude'],
    homeMarkers: ['.claude', '.claude.json'],
    bin: ['claude'],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    mcp: { file: '.cursor/mcp.json', key: 'mcpServers' },
    nudge: { file: '.cursor/rules/vg.mdc', kind: 'file' },
    markers: ['.cursor', '.cursorrules'],
    homeMarkers: ['.cursor'],
    bin: ['cursor-agent'],
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    mcp: { file: '.windsurf/mcp.json', key: 'mcpServers' },
    nudge: { file: '.windsurf/rules/vg.md', kind: 'file' },
    markers: ['.windsurf', '.windsurfrules'],
    homeMarkers: ['.codeium/windsurf'],
  },
  {
    id: 'vscode',
    label: 'VS Code (Copilot Chat)',
    mcp: { file: '.vscode/mcp.json', key: 'servers', vscode: true },
    nudge: { file: '.github/copilot-instructions.md', kind: 'block' },
    markers: ['.github/copilot-instructions.md'],
  },
  {
    id: 'codex',
    label: 'Codex',
    skill: '.codex/skills/vg/SKILL.md',
    nudge: { file: 'AGENTS.md', kind: 'block' },
    markers: ['.codex'],
    homeMarkers: ['.codex'],
    bin: ['codex'],
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    skill: '.gemini/skills/vg/SKILL.md',
    nudge: { file: 'GEMINI.md', kind: 'block' },
    markers: ['GEMINI.md', '.gemini'],
    homeMarkers: ['.gemini'],
    bin: ['gemini'],
  },
  // Skill + advisory AGENTS.md nudge (the broad-reach common denominator). MCP
  // registration for these hosts is host-specific and added as their formats
  // stabilise; the skill + nudge work today.
  { id: 'grok', label: 'Grok CLI', skill: '.grok/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' }, markers: ['.grok', 'GROK.md'], homeMarkers: ['.grok'], bin: ['grok'] },
  { id: 'opencode', label: 'OpenCode', skill: '.opencode/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' }, markers: ['.opencode', 'opencode.json'], homeMarkers: ['.config/opencode'], bin: ['opencode'] },
  { id: 'kilo', label: 'Kilo Code', skill: '.kilo/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' }, markers: ['.kilo', '.kilocode'], homeMarkers: ['.kilocode'] },
  { id: 'aider', label: 'Aider', skill: '.aider/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' }, markers: ['.aider', '.aider.conf.yml'], homeMarkers: ['.aider.conf.yml'], bin: ['aider'] },
  { id: 'factory', label: 'Factory Droid', skill: '.factory/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' }, markers: ['.factory'], homeMarkers: ['.factory'], bin: ['droid'] },
  { id: 'trae', label: 'Trae', skill: '.trae/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' }, markers: ['.trae'], homeMarkers: ['.trae'] },
  { id: 'kiro', label: 'Kiro', skill: '.kiro/skills/vg/SKILL.md', nudge: { file: '.kiro/steering/vg.md', kind: 'file' }, markers: ['.kiro'], homeMarkers: ['.kiro'] },
  { id: 'amp', label: 'Amp', skill: '.agents/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' }, homeMarkers: ['.config/amp'], bin: ['amp'] },
  { id: 'kimi', label: 'Kimi Code', skill: '.kimi/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' }, markers: ['.kimi'], homeMarkers: ['.kimi'] },
  { id: 'codebuddy', label: 'CodeBuddy', skill: '.codebuddy/skills/vg/SKILL.md', nudge: { file: 'CODEBUDDY.md', kind: 'block' }, markers: ['CODEBUDDY.md', '.codebuddy'], homeMarkers: ['.codebuddy'] },
  { id: 'copilot-cli', label: 'GitHub Copilot CLI', skill: '.copilot/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' }, markers: ['.copilot'], homeMarkers: ['.copilot'], bin: ['copilot'] },
  { id: 'pi', label: 'Pi', skill: '.pi/agent/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' }, markers: ['.pi'], homeMarkers: ['.pi'] },
  { id: 'devin', label: 'Devin CLI', skill: '.devin/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' }, markers: ['.devin'], homeMarkers: ['.devin'] },
  { id: 'hermes', label: 'Hermes', skill: '.hermes/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' }, markers: ['.hermes'], homeMarkers: ['.hermes'] },
  { id: 'openclaw', label: 'OpenClaw', skill: '.openclaw/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' }, markers: ['.openclaw'], homeMarkers: ['.openclaw'], bin: ['openclaw'] },
  { id: 'agents', label: 'Agent-Skills (generic)', skill: '.agents/skills/vg/SKILL.md', nudge: { file: 'AGENTS.md', kind: 'block' }, markers: ['AGENTS.md', '.agents'] },
];

export function assistantById(id: string): Assistant | undefined {
  return ASSISTANTS.find((a) => a.id === id);
}

// --- detection ---

export interface DetectedAssistant {
  assistant: Assistant;
  /** Where the sign was found — in the repo, in the user's home folder, or on PATH. */
  via: 'repo' | 'home' | 'path';
  /** The specific marker path or executable name that matched. */
  marker: string;
}

export interface DetectOptions {
  /** Home folder override (tests). Defaults to `os.homedir()`. */
  home?: string;
  /** PATH lookup override (tests). Defaults to `whichOnPath`. */
  which?: (cmd: string) => string | null;
}

/**
 * Best-effort detection of which AI assistants are in use — by their footprint
 * in the repo (rules files, config dirs), their per-user config in the home
 * folder, or their CLI on PATH. Pure presence checks: nothing is read,
 * parsed, or executed, and a miss is always safe (it only means "not
 * auto-selected"). First match per assistant wins, repo before home before
 * PATH, so the reported marker is the most local evidence.
 */
export function detectAssistants(root: string, opts: DetectOptions = {}): DetectedAssistant[] {
  const home = opts.home ?? os.homedir();
  const which = opts.which ?? whichOnPath;
  const found: DetectedAssistant[] = [];
  for (const assistant of ASSISTANTS) {
    const repoHit = (assistant.markers ?? []).find((m) => fs.existsSync(path.join(root, m)));
    if (repoHit) {
      found.push({ assistant, via: 'repo', marker: repoHit });
      continue;
    }
    const homeHit = (assistant.homeMarkers ?? []).find((m) => fs.existsSync(path.join(home, m)));
    if (homeHit) {
      found.push({ assistant, via: 'home', marker: homeHit });
      continue;
    }
    const binHit = (assistant.bin ?? []).find((b) => which(b) !== null);
    if (binHit) found.push({ assistant, via: 'path', marker: binHit });
  }
  return found;
}

export interface InstallOptions {
  root: string;
  hook?: boolean; // write the advisory nudge (default true)
  smallRepo: boolean;
  /** Resolved MCP launch command; defaults to detectServeLaunch(). */
  launch?: ServeLaunch;
}

export interface InstallAction {
  wrote: string[];
  skipped: string[];
  /** Explanation when the MCP entry is not the plain `vg serve` (e.g. PATH fallback). */
  note?: string;
}

/**
 * Resolve how the assistant host should launch the MCP server. `command: "vg"`
 * only works when `vg` on PATH is a *persistent install* of this CLI — a user
 * who ran via npx (whose `vg` is a throwaway npx-cache binary that disappears
 * after the run), or whose `vg` belongs to another tool (see
 * scripts/postinstall.mjs), would get a server that silently fails to start or,
 * worse, launches the wrong binary. Detection is best-effort and never throws;
 * the fallbacks keep the entry working: installed `vg` → installed `vibgrate` →
 * `npx -y -p @vibgrate/cli vg`.
 */
export function detectServeLaunch(which: (cmd: string) => string | null = whichOnPath): ServeLaunch {
  const vg = which('vg');
  if (vg && isInstalledOwnBinary(vg)) return { command: 'vg', args: ['serve'] };
  const vibgrate = which('vibgrate');
  if (vibgrate && isInstalledOwnBinary(vibgrate)) {
    return {
      command: 'vibgrate',
      args: ['serve'],
      note: vg
        ? '`vg` on PATH belongs to another tool — registered the identical `vibgrate serve` instead'
        : '`vg` is not on PATH — registered the identical `vibgrate serve` instead',
    };
  }
  return {
    command: 'npx',
    args: ['-y', '-p', '@vibgrate/cli', 'vg', 'serve'],
    note: 'vg is not installed on PATH — registered an npx launcher. Install globally (`npm i -g @vibgrate/cli`) and rerun `vg install` for a faster startup.',
  };
}

export function installAssistant(a: Assistant, opts: InstallOptions): InstallAction {
  const wrote: string[] = [];
  const skipped: string[] = [];
  let note: string | undefined;

  if (a.skill) {
    // Pass the assistant id as the --client value so the installed skill tells
    // this AI to identify itself on CLI calls (the MCP path detects it itself).
    writeFileEnsured(path.join(opts.root, a.skill), skillMarkdown(a.id));
    wrote.push(a.skill);
  }
  if (a.mcp) {
    const launch = opts.launch ?? detectServeLaunch();
    upsertMcp(path.join(opts.root, a.mcp.file), a.mcp, launch);
    wrote.push(a.mcp.file);
    note = launch.note;
  } else {
    skipped.push('mcp (host-specific setup)');
  }
  if (a.nudge && opts.hook !== false) {
    writeNudge(path.join(opts.root, a.nudge.file), a.nudge, opts.smallRepo, a.id);
    wrote.push(a.nudge.file);
  } else if (a.nudge) {
    skipped.push('nudge (--no-hook)');
  }

  return { wrote, skipped, note };
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

/**
 * Write the deferred-loading navigation config once per project (plan P3,
 * VG-NAVIGATION-PROFILE.md). `vg serve` always exposes the one optimized tool
 * set; this file is the CLIENT loading configuration for agents built on the
 * Claude API that support `defer_loading` + tool-search — it keeps the hot
 * navigation core in context and defers the rest, cutting the per-step schema
 * bill to ~350–450 tokens (vs ~1,881 for the full set). Hosts that don't
 * support deferral ignore it and serve the whole optimized set. Returns the
 * repo-relative path written.
 */
export function writeNavigationConfig(root: string): string {
  // `vg install` may be the first thing to create `.vibgrate/` — make sure the
  // default ignore file lands with it so the install never dirties the branch.
  ensureVibgrateGitignore(root);
  const rel = path.join('.vibgrate', 'mcp-navigation.json');
  const doc = {
    _readme:
      'Deferred-loading config for agents embedding `vg serve` via the Claude API ' +
      '(defer_loading + tool-search). The hot navigation core stays in context; the rest ' +
      'load on demand — ~350-450 schema tokens/step vs ~1,881 for the full set. Hosts without ' +
      'defer_loading ignore this and serve the whole (already optimized) tool set. See ' +
      'docs/graph/VG-NAVIGATION-PROFILE.md.',
    hot_core: [...HOT_TOOLS],
    deferred: deferredToolNames(),
    toolset: navigationToolsetConfig(),
  };
  writeFileEnsured(path.join(root, rel), `${JSON.stringify(doc, null, 2)}\n`);
  return rel;
}

function upsertMcp(file: string, target: McpTarget, launch: ServeLaunch): void {
  const config = readJson(file);
  const entry = mcpServerEntry(launch);
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

/**
 * Below this many mapped files the nudge honestly says searching is fine.
 * Shared by `vg install` and the post-build instruction refresh so both write
 * the same variant.
 */
export const SMALL_REPO_FILES = 150;

/** One instruction file brought up to the current content version. */
export interface RefreshedInstruction {
  /** Repo-relative path of the refreshed file. */
  file: string;
  /** The version it carried (0 = pre-versioning legacy content). */
  from: number;
  to: number;
}

/**
 * Bring previously-installed assistant instructions up to the current content
 * version (INSTALL_CONTENT_VERSION). Called after every successful `vg` build,
 * so evolved instructions reach existing repos the first time a new CLI
 * version builds there — no re-run of `vg install` needed.
 *
 * Ownership rules — this must never clobber user-authored content:
 *  - a file with a `vg:v<N>` marker is ours; refreshed when N is older.
 *    Removing the marker line opts the file out permanently.
 *  - a marker-less file at a known install path is refreshed ONLY when it
 *    still carries the generated headings (legacy pre-versioning copies),
 *    and treated as version 0.
 *  - nudge blocks refresh only the vg:begin…vg:end region; the rest of the
 *    host file (CLAUDE.md, AGENTS.md, …) is untouched.
 */
export function refreshInstalledInstructions(root: string, smallRepo: boolean): RefreshedInstruction[] {
  const out: RefreshedInstruction[] = [];
  const staleVersion = (text: string, legacySignature: string): number | null => {
    const v = installedContentVersion(text);
    if (v !== null) return v < INSTALL_CONTENT_VERSION ? v : null;
    return text.includes(legacySignature) ? 0 : null; // marker-less: legacy ours, or not ours at all
  };

  for (const a of ASSISTANTS) {
    if (a.skill) {
      const file = path.join(root, a.skill);
      if (fs.existsSync(file)) {
        const text = readTextSafe(file);
        const from = text === null ? null : staleVersion(text, '# vg — the code map');
        if (from !== null) {
          writeFileEnsured(file, skillMarkdown(a.id));
          out.push({ file: a.skill, from, to: INSTALL_CONTENT_VERSION });
        }
      }
    }
    if (a.nudge) {
      const file = path.join(root, a.nudge.file);
      if (!fs.existsSync(file)) continue;
      const text = readTextSafe(file);
      if (text === null) continue;
      if (a.nudge.kind === 'block') {
        const block = new RegExp(`${escapeRe(NUDGE_BEGIN)}[\\s\\S]*?${escapeRe(NUDGE_END)}`).exec(text);
        if (!block) continue; // no vg block in this host file — nothing of ours to refresh
        const from = staleVersion(block[0], '## Code navigation (vg)');
        if (from !== null) {
          writeNudge(file, a.nudge, smallRepo, a.id);
          out.push({ file: a.nudge.file, from, to: INSTALL_CONTENT_VERSION });
        }
      } else {
        const from = staleVersion(text, '## Code navigation (vg)');
        if (from !== null) {
          writeNudge(file, a.nudge, smallRepo, a.id);
          out.push({ file: a.nudge.file, from, to: INSTALL_CONTENT_VERSION });
        }
      }
    }
  }
  return out;
}

function readTextSafe(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null; // unreadable — leave it alone
  }
}

function writeNudge(file: string, target: NudgeTarget, smallRepo: boolean, client?: string): void {
  if (target.kind === 'file') {
    // Dedicated rule file owned by vg (Cursor .mdc needs frontmatter).
    const body = file.endsWith('.mdc')
      ? `---\ndescription: vg code graph\nalwaysApply: true\n---\n${stripMarkers(nudgeMarkdown(smallRepo, client))}`
      : stripMarkers(nudgeMarkdown(smallRepo, client));
    writeFileEnsured(file, `${body}\n`);
    return;
  }
  upsertBlock(file, nudgeMarkdown(smallRepo, client));
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

/**
 * Read a JSON config we are about to merge into. A *missing* file is an empty
 * config; a *malformed* file must abort — silently treating it as empty would
 * rewrite the file and destroy the user's other MCP server entries.
 */
function readJson(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error('not a JSON object');
  } catch {
    throw new CliError(
      `${file} exists but is not valid JSON — fix or remove it, then rerun. Refusing to overwrite it (that would lose your existing entries).`,
      ExitCode.ERROR,
    );
  }
}

function stripMarkers(s: string): string {
  return s.replace(NUDGE_BEGIN, '').replace(NUDGE_END, '').trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
