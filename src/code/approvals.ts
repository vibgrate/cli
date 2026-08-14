/**
 * Allow-always approval rules (P2 — permission parity).
 *
 * The approval gate exists to review state changes, but reviewing the *same*
 * change shape every time (`pnpm test`, edits to a scratch dir) is friction
 * without safety. A user can promote an approval to a standing rule
 * ("Always allow"); rules live in `.vibgrate/code-approvals.json` at the repo
 * root so the CLI and VS Code honour the same set, and are re-read on every
 * approval so a revocation (from the VG Code manage UI or by editing the
 * file) takes effect immediately — no session restart, no stale cache.
 *
 * Rules never widen safety: {@link dangerousCommand} still screens every rule
 * match, plan mode still denies everything engine-side before rules are
 * consulted, and a rule-approved action is still announced (notice event) and
 * checkpointed like any human-approved change.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureVibgrateGitignore } from '../engine/artifacts.js';
import type { MutatingAction, PatchFileAction } from './tools.js';

/** One standing approval. Discriminated by `kind`, mirroring MutatingAction. */
export type ApprovalRule =
  /** Matches `run` actions whose normalized command starts with these tokens. */
  | { kind: 'run'; prefix: string }
  /** Matches a single-file action of that op when the path matches the glob. */
  | { kind: 'edit' | 'create' | 'delete'; glob: string }
  /** Matches external `tool` calls by tool name. */
  | { kind: 'tool'; tool: string };

export function approvalsPath(root: string): string {
  return path.join(root, '.vibgrate', 'code-approvals.json');
}

/**
 * The stable identity of a rule — used for dedupe and for revocation from
 * hosts that only carry the display string.
 */
export function ruleKey(rule: ApprovalRule): string {
  if (rule.kind === 'run') return `run:${rule.prefix}`;
  if (rule.kind === 'tool') return `tool:${rule.tool}`;
  return `${rule.kind}:${rule.glob}`;
}

/** Human-readable label for notices and manage UIs. */
export function ruleLabel(rule: ApprovalRule): string {
  if (rule.kind === 'run') return `run \`${rule.prefix} …\``;
  if (rule.kind === 'tool') return `call ${rule.tool}`;
  return `${rule.kind} ${rule.glob}`;
}

/**
 * Load the rule set, tolerating absence and malformed JSON (an unreadable file
 * means "no rules", never a crash — same posture as `.vibgrate/code.json`).
 * Unknown shapes are dropped so an untrusted file cannot inject junk.
 */
export function loadApprovalRules(root: string): ApprovalRule[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(approvalsPath(root), 'utf8'));
  } catch {
    return [];
  }
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { rules?: unknown }).rules)
      ? ((raw as { rules: unknown[] }).rules)
      : [];
  const out: ApprovalRule[] = [];
  for (const item of list) {
    const rule = sanitizeRule(item);
    if (rule) out.push(rule);
  }
  return dedupe(out);
}

function sanitizeRule(item: unknown): ApprovalRule | null {
  if (!item || typeof item !== 'object') return null;
  const o = item as Record<string, unknown>;
  if (o.kind === 'run' && typeof o.prefix === 'string' && o.prefix.trim()) {
    return { kind: 'run', prefix: normalizeCommandPrefix(o.prefix) };
  }
  if (o.kind === 'tool' && typeof o.tool === 'string' && o.tool.trim()) {
    return { kind: 'tool', tool: o.tool.trim() };
  }
  if ((o.kind === 'edit' || o.kind === 'create' || o.kind === 'delete') && typeof o.glob === 'string' && o.glob.trim()) {
    return { kind: o.kind, glob: o.glob.trim() };
  }
  return null;
}

function dedupe(rules: ApprovalRule[]): ApprovalRule[] {
  const seen = new Set<string>();
  const out: ApprovalRule[] = [];
  for (const r of rules) {
    const key = ruleKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Persist the rule set, deterministically sorted so identical sets produce an
 * identical file. Best-effort like other `.vibgrate/` writers — a read-only
 * checkout means no standing rules, never a thrown error mid-approval.
 */
export function saveApprovalRules(root: string, rules: ApprovalRule[]): boolean {
  try {
    const dir = path.join(root, '.vibgrate');
    fs.mkdirSync(dir, { recursive: true });
    // First writer into .vibgrate/ creates its .gitignore (create-once): one
    // developer's standing consents must not ride into the team's repo.
    ensureVibgrateGitignore(root);
    const sorted = dedupe(rules).slice().sort((a, b) => ruleKey(a).localeCompare(ruleKey(b)));
    fs.writeFileSync(approvalsPath(root), `${JSON.stringify({ rules: sorted }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Add one rule (deduped). Returns the saved rule, or null when nothing was written. */
export function addApprovalRule(root: string, rule: ApprovalRule): ApprovalRule | null {
  const rules = loadApprovalRules(root);
  if (rules.some((r) => ruleKey(r) === ruleKey(rule))) return rule;
  rules.push(rule);
  return saveApprovalRules(root, rules) ? rule : null;
}

/** Remove the rule with this {@link ruleKey}. Returns true when one was removed and saved. */
export function removeApprovalRule(root: string, key: string): boolean {
  const rules = loadApprovalRules(root);
  const kept = rules.filter((r) => ruleKey(r) !== key);
  if (kept.length === rules.length) return false;
  return saveApprovalRules(root, kept);
}

/**
 * Normalize a shell command to its rule prefix: the first two tokens for the
 * `cmd subcommand [flags…]` shape (`git status`, `pnpm test --watch`), the
 * single token for a one-word command, and the *whole* command
 * (whitespace-normalized) in every other case. Collapsing `rm -f temp.log` to
 * bare `rm` — or `rm foo.log secrets.env` to `rm foo.log` — would turn one
 * blessed invocation into a standing grant covering paths the user never saw
 * (2026-08 audit, D2), so a command with a flag second-token or positional
 * arguments beyond the subcommand keeps its exact form.
 */
export function normalizeCommandPrefix(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const head = tokens[0] ?? '';
  const second = tokens[1];
  if (!second) return head;
  if (second.startsWith('-')) return tokens.join(' ');
  // Extra positionals after `cmd subcommand` make the rule exact; trailing
  // flags still collapse to the extensible two-token prefix.
  if (tokens.slice(2).some((t) => !t.startsWith('-'))) return tokens.join(' ');
  return `${head} ${second}`;
}

/** True when a rule prefix is the extensible `cmd [subcommand]` shape (no flags). */
function extensiblePrefix(prefix: string): boolean {
  return !prefix.split(' ').some((t) => t.startsWith('-'));
}

/**
 * Shell constructs that can smuggle a second command into what looks like a
 * flag: command substitution, redirects, sequencing, backgrounding, subshells.
 * A `pnpm test` rule must not bless `pnpm test --reporter=$(curl … | sh)` —
 * the appended token is flag-shaped, but its *value* is another program the
 * user never saw. Same screen {@link readOnlyCommand} applies; kept local so
 * safety and approvals stay independent modules.
 */
const SHELL_METACHARS = /[><;&|`\n(){}$]/;

/**
 * Derive the standing rule an "Always allow" on this action should create.
 * Patch actions return null — an atomic multi-file transaction has no single
 * honest generalisation, so hosts do not offer Always on patch cards.
 */
export function ruleForAction(action: MutatingAction): ApprovalRule | null {
  switch (action.kind) {
    case 'run':
      return { kind: 'run', prefix: normalizeCommandPrefix(action.command) };
    case 'tool':
      return { kind: 'tool', tool: action.name };
    case 'edit':
    case 'create':
    case 'delete':
      return { kind: action.kind, glob: action.file };
    case 'patch':
      return null;
  }
}

/**
 * Minimal glob match for rule paths: `*` matches within a segment, `**`
 * across segments, `?` one character. Deterministic, no dependency, and
 * conservative — a malformed pattern simply never matches.
 */
export function globMatch(glob: string, file: string): boolean {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` or trailing `**` — match across segments.
        re += '.*';
        i += glob[i + 2] === '/' ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  try {
    return new RegExp(`^${re}$`).test(file);
  } catch {
    return false;
  }
}

function fileRuleMatches(rules: ApprovalRule[], op: 'edit' | 'create' | 'delete', file: string): ApprovalRule | null {
  for (const r of rules) {
    if (r.kind === op && globMatch(r.glob, file)) return r;
  }
  return null;
}

/**
 * The first rule matching this action, or null. A `patch` matches only when
 * *every* file in the transaction is covered by a matching file rule — an
 * atomic approval must never be half-earned.
 */
export function findMatchingRule(action: MutatingAction, rules: ApprovalRule[]): ApprovalRule | null {
  if (!rules.length) return null;
  switch (action.kind) {
    case 'run': {
      // Match the FULL whitespace-normalized command, never a truncated form:
      // collapsing `rm foo.log secrets.env` to its first two tokens before
      // comparing would silently discard the appended argument and let a rule
      // saved for `rm foo.log` bless it (2026-08 audit, D2).
      const full = action.command.trim().split(/\s+/).filter(Boolean).join(' ');
      for (const r of rules) {
        if (r.kind !== 'run') continue;
        if (full === r.prefix) return r;
        // A `cmd [subcommand]` prefix extends to longer commands only when
        // every appended token is a flag (`git status --short`). Appended
        // positionals (extra paths, script arguments) are new state the user
        // never blessed — they re-prompt, and can be Always-allowed exactly.
        if (extensiblePrefix(r.prefix) && full.startsWith(`${r.prefix} `)) {
          const tail = full.slice(r.prefix.length + 1);
          // A flag whose value is a subshell is not an extension of the blessed
          // command, it is a different one — screen the appended text before
          // the flag-shape check, never after.
          if (SHELL_METACHARS.test(tail)) continue;
          const extension = tail.split(' ');
          if (extension.every((t) => t.startsWith('-'))) return r;
        }
      }
      return null;
    }
    case 'tool':
      return rules.find((r) => r.kind === 'tool' && r.tool === action.name) ?? null;
    case 'edit':
    case 'create':
    case 'delete':
      return fileRuleMatches(rules, action.kind, action.file);
    case 'patch': {
      const covered = action.files.every((f: PatchFileAction) => fileRuleMatches(rules, f.op, f.file));
      if (!covered) return null;
      return fileRuleMatches(rules, action.files[0]!.op, action.files[0]!.file);
    }
  }
}
