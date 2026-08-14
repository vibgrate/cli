/**
 * Command safety for autonomous agent runs (VG-CLI-CODE §13).
 *
 * Interactively, `run_command` is gated by a human who sees the exact command
 * and says yes. Under `--auto` there is no human in the loop, so a small
 * denylist blocks the handful of commands that are catastrophic or exfiltrating
 * — a filesystem wipe, piping the internet into a shell, a force-push, a fork
 * bomb. This is defense-in-depth for autonomous mode, not a substitute for
 * review: it fails safe (an unrecognised command is still gated/approved), and a
 * project can extend the denylist in `.vibgrate/code.json`.
 *
 * Pure and unit-tested.
 */

const DANGEROUS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(-[a-z]*f[a-z]*\s+)?(-[a-z]*r[a-z]*\s+)?(-[a-z]*\s+)*(\/|~|\$HOME|\.)(\s|$)/i, reason: 'recursive/forced delete of a root or home path' },
  { pattern: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, reason: 'recursive force delete' },
  { pattern: /\bmkfs\b|\bmke2fs\b/i, reason: 'formats a filesystem' },
  { pattern: /\bdd\b[^|]*\bof=\/dev\//i, reason: 'writes raw to a device' },
  { pattern: />\s*\/dev\/(sd|nvme|hd|disk)/i, reason: 'writes raw to a disk device' },
  { pattern: /:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/, reason: 'fork bomb' },
  { pattern: /\b(curl|wget|fetch)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|python|node|ruby|perl)\b/i, reason: 'pipes a download straight into a shell/interpreter' },
  { pattern: /\bgit\s+push\b[^\n]*(--force\b|-f\b)/i, reason: 'force-push (rewrites remote history)' },
  { pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/i, reason: 'destroys uncommitted work' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: 'powers off / reboots the machine' },
  { pattern: /\bchmod\s+-R\s+0*777\s+(\/|~)/i, reason: 'world-writable on a root/home path' },
  { pattern: /\bsudo\b/i, reason: 'runs as root (never automatic)' },
  { pattern: /\beval\b\s+["'`]?\$\(/i, reason: 'evaluates dynamically-constructed shell' },
];

/**
 * Return a reason string when `command` is too dangerous to run autonomously, or
 * null when it is allowed. `extraDeny` are project-configured substrings/regex
 * sources to also block. Matching is deliberately conservative — only clearly
 * destructive shapes trip it, so ordinary build/test commands run freely.
 */
export function dangerousCommand(command: string, extraDeny: string[] = []): string | null {
  const cmd = command.trim();
  for (const { pattern, reason } of DANGEROUS) {
    if (pattern.test(cmd)) return reason;
  }
  for (const raw of extraDeny) {
    if (!raw) continue;
    try {
      if (new RegExp(raw, 'i').test(cmd)) return `matches a project denylist rule (${raw})`;
    } catch {
      // Not a valid regex → treat as a literal substring.
      if (cmd.toLowerCase().includes(raw.toLowerCase())) return `matches a project denylist rule (${raw})`;
    }
  }
  return null;
}

/* ── read-only command classification (P2) ──────────────────────────────────
 *
 * `run_command` prompts for every command in Agent mode, even `git status`.
 * That is the top daily friction against comparable agent UIs, and the human
 * gate exists to review *state changes* — a pure read is not one. This
 * classifier recognises a small allowlist of commands that cannot write to the
 * tree, the repo, or remote state, so callers may skip the approval card for
 * them (the command row remains the visible record).
 *
 * The design is fail-safe: anything the classifier does not positively
 * recognise stays gated. Shell metacharacters that could smuggle a write
 * (redirects, command substitution, sequencing, background) disqualify the
 * whole line; pipes are allowed only when every segment is itself read-only.
 * Per-command guards catch write-capable flags on otherwise read-only tools
 * (`sort -o`, `find -exec`, `git log --output=…`).
 */

/** Commands that are read-only with any flags (no write-capable options). */
const READ_ONLY_ANY_ARGS = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'cut', 'tr', 'nl', 'column',
  'grep', 'egrep', 'fgrep', 'rg',
  'file', 'stat', 'du', 'df', 'tree',
  'which', 'whereis', 'whoami', 'id', 'uname', 'hostname', 'uptime',
  'basename', 'dirname', 'realpath', 'readlink',
  'echo', 'printf', 'true', 'false',
  'diff', 'cmp', 'strings',
  'md5sum', 'sha1sum', 'sha256sum', 'shasum', 'cksum',
  // jq has no write-to-file flag of its own; file writes need a redirect,
  // which the metacharacter screen already disqualifies. Membership here also
  // applies the shared `--output` screen, unlike the old always-true guard.
  'jq',
]);

/** Commands allowed only with a per-command guard on their arguments. */
const GUARDED: Record<string, (args: string[]) => boolean> = {
  // find can write via -exec/-delete/-ok and the f* output actions.
  find: (args) => !args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fprint0|fls)$/.test(a)),
  // date -s / --set sets the clock. Prefix match catches the attached getopt
  // form too (`-s2020-01-01`).
  date: (args) => !args.some((a) => a.startsWith('-s') || a.startsWith('--set')),
  // sort -o / --output writes a file — including the attached form (`-oFILE`).
  sort: (args) => !args.some((a) => a.startsWith('-o') || a.startsWith('--output')),
  // uniq's second positional argument is an output file.
  uniq: (args) => args.filter((a) => !a.startsWith('-')).length <= 1,
};

/** Read-only git subcommands (any further flags allowed except --output…). */
const GIT_READ_ONLY = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'shortlog', 'describe',
  'ls-files', 'rev-parse', 'grep', 'show-ref', 'cat-file', 'count-objects',
  'reflog',
]);

/** npm/pnpm/yarn subcommands that only read (no script execution, no installs). */
const PKG_READ_ONLY = new Set(['ls', 'list', 'll', 'why', 'view', 'info', 'outdated']);

/** True when a single pipeline segment is positively read-only. */
function readOnlySegment(segment: string): boolean {
  const tokens = segment.split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  const head = tokens[0];
  const args = tokens.slice(1);
  // `FOO=bar cmd`-style env prefixes are not modelled — stay gated.
  if (head.includes('=')) return false;
  // A bare `--version` / `--help` probe is read-only — but ONLY for a bare
  // binary name with the long-form flag. A path (`./deploy.sh --help`) still
  // *executes that script*, which may ignore the flag entirely, and short
  // flags are not a version contract (`sh -v` starts a verbose shell). The
  // probe branch must never become an execute-anything hole.
  if (
    args.length === 1 &&
    /^(--version|--help)$/.test(args[0]) &&
    /^[\w@-][\w.@-]*$/.test(head) &&
    !head.includes('/') &&
    !head.includes('\\')
  ) {
    return true;
  }
  if (READ_ONLY_ANY_ARGS.has(head)) {
    // A stray write-flag style `--output=` on any of these stays gated.
    if (args.some((a) => a.startsWith('--output'))) return false;
    return true;
  }
  const guard = GUARDED[head];
  if (guard) return guard(args);
  if (head === 'git') {
    const sub = args[0];
    if (!sub || sub.startsWith('-')) return false; // `git -C x …` etc. not modelled
    const rest = args.slice(1);
    if (rest.some((a) => a.startsWith('--output'))) return false; // git log/diff --output writes
    if (GIT_READ_ONLY.has(sub)) return true;
    if (sub === 'branch') return rest.every((a) => /^(-a|-r|-v|-vv|-l|--list|--all|--verbose)$/.test(a));
    if (sub === 'remote') return rest.every((a) => a === '-v' || a === '--verbose');
    if (sub === 'tag') return rest.every((a) => /^(-l|--list|-n\d*)$/.test(a));
    if (sub === 'stash') return rest[0] === 'list' || rest[0] === 'show';
    if (sub === 'config') return rest[0] === '-l' || rest[0] === '--list' || rest[0] === '--get' || rest[0] === '--get-all' || rest[0] === '--get-regexp';
    return false;
  }
  if (head === 'npm' || head === 'pnpm' || head === 'yarn') {
    const sub = args[0];
    return !!sub && PKG_READ_ONLY.has(sub);
  }
  return false;
}

/**
 * True when `command` is positively classified as read-only — it cannot write
 * to the working tree, the repository, or remote state — and is therefore safe
 * to run without an approval card in Agent mode. Fail-safe: unrecognised
 * commands, chained/sequenced commands, redirects, command substitution and
 * env-prefixed invocations all return false and stay gated. Callers must still
 * screen with {@link dangerousCommand} — this function classifies, it does not
 * authorise.
 */
export function readOnlyCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  // Any construct that can write or chain disqualifies the whole line:
  // redirects (> >> < <<), command substitution ($() and backticks), process
  // substitution, sequencing (; &&, ||), background (&), subshells, newlines.
  if (/[><;&`\n(){}]|\$\(/.test(cmd)) return false;
  // Pipes are fine only when every segment is read-only (`git log | head`).
  return cmd.split('|').every((seg) => readOnlySegment(seg));
}
