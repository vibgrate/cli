/**
 * Worktree-scoped subagent runs under the parent's governance gate.
 *
 * A subagent is a bounded `runAgent` call with:
 * - optional ephemeral git worktree (isolated dirty tree)
 * - mutating actions re-approved by the parent `approve` callback
 * - no nested subagents (depth 0 only)
 * - result summary returned to the parent model
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Provider } from './types.js';
import type { VgGraph } from '../schema.js';
import type { CodeFs } from './session.js';
import type { MutatingAction, ShellResult } from './tools.js';
import type { AgentEvent } from './agent.js';

export interface SubagentRequest {
  instruction: string;
  /** When true (default), use a git worktree under os.tmpdir. */
  worktree?: boolean;
  maxSteps?: number;
}

export interface SubagentHost {
  root: string;
  graph: VgGraph;
  providers: Provider[];
  fsImpl: CodeFs;
  run: (command: string) => ShellResult | Promise<ShellResult>;
  approve: (action: MutatingAction) => Promise<boolean>;
  auto?: boolean;
  plan?: boolean;
  denyCommands?: string[];
  onEvent?: (e: AgentEvent) => void;
  /** Prevent nested spawn_subagent. */
  depth?: number;
}

export interface SubagentResult {
  content: string;
  mutated: boolean;
  worktreePath?: string;
  cleaned?: boolean;
}

function git(root: string, args: string[]): { ok: boolean; stdout: string } {
  const res = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 5 * 1024 * 1024,
  });
  return {
    ok: (res.status ?? 1) === 0,
    stdout: (res.stdout || '') + (res.stderr || ''),
  };
}

function isGitRepo(root: string): boolean {
  return git(root, ['rev-parse', '--is-inside-work-tree']).ok;
}

function createWorktree(root: string): { path: string; branch: string } | { error: string } {
  if (!isGitRepo(root)) {
    return { error: 'spawn_subagent worktree requires a git repository; pass worktree:false to run in-place (not recommended).' };
  }
  const id = `vg-sa-${process.pid}-${Date.now().toString(36)}`;
  const wt = path.join(os.tmpdir(), id);
  const branch = `vg-subagent/${id}`;
  // Prefer detached worktree from HEAD to avoid touching user branches.
  const add = git(root, ['worktree', 'add', '--detach', wt, 'HEAD']);
  if (!add.ok) {
    return { error: `git worktree add failed: ${add.stdout.slice(0, 400)}` };
  }
  return { path: wt, branch };
}

function removeWorktree(root: string, wt: string): void {
  try {
    git(root, ['worktree', 'remove', '--force', wt]);
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(wt, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Run a child agent. Dynamically imports runAgent to avoid circular init issues.
 */
export async function runSubagent(host: SubagentHost, req: SubagentRequest): Promise<SubagentResult> {
  if ((host.depth ?? 0) > 0) {
    return {
      content: 'spawn_subagent refused: nested subagents are not allowed (depth limit 1).',
      mutated: false,
    };
  }
  if (host.plan) {
    return {
      content: 'spawn_subagent refused in plan mode — present a plan for parallel work instead.',
      mutated: false,
    };
  }
  const instruction = (req.instruction || '').trim();
  if (!instruction) {
    return { content: 'spawn_subagent needs a non-empty instruction.', mutated: false };
  }

  const useWt = req.worktree !== false;
  let worktreePath: string | undefined;
  let childRoot = host.root;

  if (useWt) {
    const wt = createWorktree(host.root);
    if ('error' in wt) {
      return { content: wt.error, mutated: false };
    }
    worktreePath = wt.path;
    childRoot = wt.path;
  }

  host.onEvent?.({
    type: 'notice',
    text: `Subagent starting${worktreePath ? ` in worktree ${worktreePath}` : ' in-place'}…`,
  });

  try {
    const { runAgent } = await import('./agent.js');
    const { nodeCodeFs } = await import('./session.js');
    const childFs = childRoot === host.root ? host.fsImpl : nodeCodeFs(childRoot);

    // Parent gate: every child mutation re-uses parent approve (single audit story).
    const childApprove = async (action: MutatingAction): Promise<boolean> => {
      host.onEvent?.({
        type: 'notice',
        text: `Subagent requests approval: ${action.kind}${'file' in action && action.file ? ` ${action.file}` : ''}${'command' in action && action.command ? ` ${String(action.command).slice(0, 80)}` : ''}`,
      });
      return host.approve(action);
    };

    const result = await runAgent({
      graph: host.graph,
      root: childRoot,
      instruction:
        `[Subagent task — stay scoped; call finish with a concise summary of changes and evidence.]\n\n${instruction}`,
      providers: host.providers,
      fsImpl: childFs,
      run: (cmd) => host.run(cmd),
      approve: childApprove,
      auto: host.auto,
      plan: false,
      denyCommands: host.denyCommands,
      maxSteps: Math.min(Math.max(req.maxSteps ?? 12, 1), 24),
      // Subagents do not nest.
      allowSubagents: false,
      streamShell: false,
      onEvent: (e) => {
        if (e.type === 'token' || e.type === 'assistant') return; // keep parent transcript quiet
        if (e.type === 'tool-call' || e.type === 'tool-result' || e.type === 'change' || e.type === 'notice') {
          host.onEvent?.(e);
        }
      },
    });

    const summary = result.finalText?.trim() || `Subagent stopped (${result.stopped}).`;
    const mutated = (result.changes?.length ?? 0) > 0;
    const content = [
      'Subagent finished.',
      worktreePath ? `Worktree: ${worktreePath}` : 'Mode: in-place (same tree as parent).',
      mutated
        ? `Files changed: ${(result.changes || []).map((c) => c.file).join(', ')}`
        : 'No file mutations recorded.',
      '---',
      summary.slice(0, 8000),
      worktreePath
        ? '\nNote: worktree is left on disk for review when mutations occurred; empty worktrees are removed.'
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    let cleaned = false;
    if (worktreePath && !mutated) {
      removeWorktree(host.root, worktreePath);
      cleaned = true;
    }

    return { content, mutated, worktreePath: cleaned ? undefined : worktreePath, cleaned };
  } catch (e) {
    if (worktreePath) removeWorktree(host.root, worktreePath);
    return {
      content: `spawn_subagent failed: ${(e as Error).message}`,
      mutated: false,
      cleaned: true,
    };
  }
}
