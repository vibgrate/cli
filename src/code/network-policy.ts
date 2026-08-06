/**
 * Agent network policy (Fusion Runtime Phase 7).
 *
 * schemaVersion: network-policy/0
 *
 * Outbound network for **agent shell commands** is default-deny. Hosted model
 * calls and library-catalog fetches are separate channels (providers /
 * catalog) and are not gated here — only `run_command` strings the model
 * proposes. Allowlisted host suffixes document what engine-level HTTP may
 * touch when a future wire-up routes agent fetches through this policy.
 *
 * Pure and unit-tested — no I/O.
 */

export const NETWORK_POLICY_SCHEMA_VERSION = 'network-policy/0' as const;

/**
 * Pinned network policy id for this release train. Bump with maintainer
 * sign-off when allowlists change materially.
 */
export const NETWORK_POLICY_VERSION = 'network-policy@2026.07.0' as const;

export interface NetworkPolicy {
  schemaVersion: typeof NETWORK_POLICY_SCHEMA_VERSION;
  policyVersion: string;
  /** Always true for v0 — agent shell is closed unless a detector says local. */
  denyOutboundByDefault: true;
  /**
   * Host suffixes the engine may contact for docs / model catalog / pulls
   * (not a free pass for arbitrary `curl` from `run_command`).
   */
  allowHostSuffixes: string[];
}

/** Default policy: deny agent shell egress; engine HTTP allowlist only. */
export const DEFAULT_NETWORK_POLICY: NetworkPolicy = {
  schemaVersion: NETWORK_POLICY_SCHEMA_VERSION,
  policyVersion: NETWORK_POLICY_VERSION,
  denyOutboundByDefault: true,
  allowHostSuffixes: [
    'openrouter.ai',
    'api.openrouter.ai',
    'registry.npmjs.org',
    'npmjs.org',
    'ollama.com',
    'huggingface.co',
    'github.com',
    'raw.githubusercontent.com',
    'vibgrate.com',
    'api.vibgrate.com',
    // Governed web_search (DuckDuckGo HTML) — engine tool, not free agent shell egress.
    'duckduckgo.com',
    'html.duckduckgo.com',
  ],
};

/**
 * True when a shell command looks like it opens the network (download, reverse
 * shell, SSH tunnel, raw socket tools, …). Conservative: ordinary package
 * managers without explicit remote flags are **not** flagged (they may use
 * cache offline).
 */
export function commandSuggestsNetwork(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  // Explicit network clients / tunnels.
  if (
    /\b(curl|wget|fetch|httpie|aria2c|nc|ncat|netcat|socat|telnet|ftp|sftp|scp|rsync|ssh|nmap|masscan)\b/i.test(
      cmd,
    )
  ) {
    return true;
  }
  // Node/Python one-liners that open sockets.
  if (/\b(node|nodejs)\b[^\n]*\b(fetch|https?\.get|http\.request|net\.connect)\b/i.test(cmd)) return true;
  if (/\bpython[23]?\b[^\n]*\b(urllib|requests|http\.client|socket)\b/i.test(cmd)) return true;
  // URL in command line (http/https).
  if (/https?:\/\//i.test(cmd)) return true;
  // Package managers with explicit online install of remote packages.
  if (/\b(npm|pnpm|yarn|bun)\s+(install|add|update)\b/i.test(cmd) && !/\s--offline\b/i.test(cmd)) {
    // Local path installs (npm install ./pkg) are not network.
    if (!/\s(\.\/|\/|\.\.\/)/.test(cmd) && !/\sfile:/i.test(cmd)) return true;
  }
  if (/\bpip[23]?\s+install\b/i.test(cmd) && !/\s--no-index\b/i.test(cmd) && !/\s\.\/|\/|\.\.\//.test(cmd)) {
    return true;
  }
  return false;
}

/** True when `host` matches an allowlisted suffix (exact or dotted suffix). */
export function hostAllowed(host: string, policy: NetworkPolicy = DEFAULT_NETWORK_POLICY): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  for (const suffix of policy.allowHostSuffixes) {
    const s = suffix.toLowerCase();
    if (h === s || h.endsWith(`.${s}`)) return true;
  }
  return false;
}

/**
 * Decide whether `run_command` may proceed under the network policy.
 * Returns null when allowed, or an actionable refusal reason.
 *
 * When `enforce` is false (interactive L0 with a human reviewing each
 * command), network-looking commands are still allowed — the human is the gate.
 * When `enforce` is true (`--auto`, or L1+ intent without a real sandbox),
 * network-looking shell is refused.
 */
export function networkCommandRefusal(
  command: string,
  options: { enforce: boolean; policy?: NetworkPolicy } = { enforce: true },
): string | null {
  if (!options.enforce) return null;
  if (!commandSuggestsNetwork(command)) return null;
  const ver = options.policy?.policyVersion ?? NETWORK_POLICY_VERSION;
  return (
    `network policy ${ver} denies outbound network from agent shell commands ` +
    `(default-deny). Run the command yourself outside the agent, or re-run ` +
    `interactively without --auto if a human should approve it.`
  );
}
