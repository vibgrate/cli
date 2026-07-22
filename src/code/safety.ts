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
