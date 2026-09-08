/**
 * Client classification, auth-mode classification and project attribution.
 * Coarse labels only — never identity, never the credential itself.
 */

export type AuthMode = 'payg' | 'oauth' | 'subscription';

const SUBSCRIPTION_UA_PREFIXES = ['claude-cli/', 'claude-code/', 'codex-cli/', 'cursor/', 'grok/', 'claude-vscode/', 'github-copilot/', 'anthropic-cli/', 'antigravity/'];

const CLIENT_UA_MAP: Array<[string, string]> = [
  ['claude-code/', 'claude-code'],
  ['claude-cli/', 'claude-code'],
  ['claude-vscode/', 'claude-vscode'],
  ['anthropic-cli/', 'anthropic-cli'],
  ['codex-cli/', 'codex'],
  ['codex/', 'codex'],
  ['cursor/', 'cursor'],
  ['grok/', 'grok_build'],
  ['zed/', 'zed'],
  ['aider/', 'aider'],
  ['droid/', 'droid'],
  ['opencode/', 'opencode'],
  ['github-copilot/', 'copilot'],
  ['copilot/', 'copilot'],
  ['antigravity/', 'antigravity'],
  ['strands-agents/', 'strands'],
  ['gemini-cli/', 'gemini'],
  ['openai-node', 'openai-sdk'],
  ['openai-python', 'openai-sdk'],
  ['anthropic-sdk', 'anthropic-sdk'],
];

export function classifyAuthMode(headers: Record<string, string>): AuthMode {
  const ua = (headers['user-agent'] ?? '').toLowerCase();
  if (SUBSCRIPTION_UA_PREFIXES.some((p) => ua.includes(p))) return 'subscription';
  const auth = headers.authorization ?? '';
  const m = /^bearer\s+(.+)$/i.exec(auth);
  if (m) {
    const tok = m[1].trim();
    if (tok.startsWith('sk-ant-oat')) return 'oauth';
    if (tok.startsWith('sk-ant-api') || tok.startsWith('sk-')) return 'payg';
    if (tok.split('.').length >= 3) return 'oauth';
    return 'oauth';
  }
  if (auth) return 'oauth';
  return 'payg';
}

/** Explicit `x-client` wins; else the first user-agent match; else `unknown`. */
export function classifyClient(headers: Record<string, string>, override?: string): string {
  if (override && override.trim()) return sanitizeLabel(override);
  const explicit = headers['x-client'] ?? headers['x-vg-agent'];
  if (explicit && explicit.trim()) return sanitizeLabel(explicit);
  const ua = (headers['user-agent'] ?? '').toLowerCase();
  for (const [needle, label] of CLIENT_UA_MAP) if (ua.includes(needle)) return label;
  return 'unknown';
}

export const PROJECT_NAME_MAX_LENGTH = 128;

/** Percent-decode, keep printable characters only, trim, cap length. */
export function sanitizeProjectName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let v = value;
  try {
    v = decodeURIComponent(value);
  } catch {
    /* keep raw */
  }
  v = v.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, PROJECT_NAME_MAX_LENGTH);
  return v || undefined;
}

/** `x-vg-project` header → configured project → workspace basename. */
export function resolveProject(headers: Record<string, string>, configured?: string, workspace?: string): string | undefined {
  return sanitizeProjectName(headers['x-vg-project']) ?? sanitizeProjectName(configured) ?? (workspace ? sanitizeProjectName(workspace.split(/[\\/]/).filter(Boolean).pop()) : undefined);
}

export function sanitizeLabel(v: string): string {
  const s = v
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .slice(0, 64);
  return s || 'unknown';
}
