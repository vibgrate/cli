/**
 * Which boundary policy pack the architecture module evaluates. Read from
 * `.vibgrate/architecture.toml` (`policy = "layered-v1"`), overridden by
 * `VIBGRATE_ARCHITECTURE_POLICY`, then by an explicit `--policy` on the
 * command. Unknown values fall back to `hexagonal-v1` with no error: a typo
 * must never turn a build red. The chosen id is stamped on the sidecar so a
 * reader always knows which rules produced its findings.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { DEFAULT_POLICY, POLICIES, type HailePolicy } from './types.js';

export const ARCHITECTURE_CONFIG_FILE = path.join('.vibgrate', 'architecture.toml');

export function isHailePolicy(value: unknown): value is HailePolicy {
  return typeof value === 'string' && (POLICIES as readonly string[]).includes(value);
}

/** The configured policy for a repository root, or the default. */
export function architecturePolicyFor(root: string, explicit?: string): HailePolicy {
  if (isHailePolicy(explicit)) return explicit;
  const env = process.env.VIBGRATE_ARCHITECTURE_POLICY;
  if (isHailePolicy(env)) return env;
  try {
    const file = path.join(root, ARCHITECTURE_CONFIG_FILE);
    if (!fs.existsSync(file)) return DEFAULT_POLICY;
    const doc = parseToml(fs.readFileSync(file, 'utf8')) as { policy?: unknown };
    return isHailePolicy(doc.policy) ? doc.policy : DEFAULT_POLICY;
  } catch {
    return DEFAULT_POLICY;
  }
}
