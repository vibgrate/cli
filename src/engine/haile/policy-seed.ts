/**
 * `vg build --init-policy` — write a first-draft `.vibgrate/architecture.toml`
 * from what the current classify file already observed. Never overwrites a
 * file the user may have edited. Unknown / missing evidence falls back to
 * hexagonal-v1; `vertical-v1` is never inferred, because a role histogram
 * cannot tell a slice from a layer — a team picks it by hand.
 *
 * The document is `vg.arch.policy.v1`: a baked pack plus optional
 * `[[overlay]]` tables (see `policy-overlay.ts`). The overlay tables are
 * written as commented stubs so the shape is in front of the reader.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARCHITECTURE_CONFIG_FILE } from './policy-config.js';
import type { HaileSidecar } from './types.js';
import { ARCH_POLICY_SCHEMA, DEFAULT_POLICY, POLICIES, type HailePolicy } from './types.js';

export interface SeedArchitecturePolicyOptions {
  root: string;
  sidecar?: HaileSidecar | null;
  /** Force a pack instead of inferring one from the sidecar. */
  policy?: HailePolicy;
}

export interface SeedArchitecturePolicyResult {
  written: boolean;
  path: string;
  policy: HailePolicy;
  /** Classified symbols the inference saw (0 without a sidecar or under an explicit pack). */
  observed: number;
  reason: 'written' | 'already-present';
}

const HEX_ROLES = new Set(['port', 'adapter', 'domain_model', 'use_case', 'domain_service']);
const LAYERED_ROLES = new Set(['controller', 'application_service', 'repository', 'persistence']);

export function inferArchitecturePolicy(sidecar: HaileSidecar | null | undefined): HailePolicy {
  if (!sidecar?.symbols?.length) return DEFAULT_POLICY;
  let hex = 0;
  let layered = 0;
  for (const symbol of sidecar.symbols) {
    const role = symbol.role?.primary;
    if (typeof role !== 'string') continue;
    if (HEX_ROLES.has(role)) hex += 1;
    if (LAYERED_ROLES.has(role)) layered += 1;
  }
  if (layered > hex && layered >= 3) return 'layered-v1';
  return DEFAULT_POLICY;
}

export function renderArchitecturePolicy(policy: HailePolicy): string {
  return [
    '# Architecture module policy — written by `vg build --init-policy`.',
    '# Commit this file. Every classify file stamps the pack it was judged under.',
    `# Schema ${ARCH_POLICY_SCHEMA}. Baked packs: ${POLICIES.join(' | ')}.`,
    '#',
    '# Overlays attach to the role and purpose the module discovered for a symbol,',
    '# not to folders you drew. Rule ids must start with team/ or org/. An overlay',
    '# that fails validation fails the architecture step of the next build; an',
    '# unknown baked pack id warns and falls back to hexagonal-v1.',
    '',
    `schema = "${ARCH_POLICY_SCHEMA}"`,
    `policy = "${policy}"`,
    '',
    '# Deny: add a finding wherever a symbol under `path` has this role and purpose.',
    '# [[overlay]]',
    '# id = "team/handlers-may-not-persist"',
    '# path = "src/"',
    '# when.role = "controller"',
    '# when.purpose = "persist"',
    '# action = "deny"',
    '# severity = "hard"',
    '# message = "handlers hand writes to the service layer"',
    '',
    '# Allow: drop a baked rule under `path`. Remap: change its severity instead.',
    '# [[overlay]]',
    '# id = "team/legacy-catalog-may-persist"',
    '# path = "src/Legacy/"',
    '# rule = "controller-persists"',
    '# action = "allow"',
    '',
  ].join('\n');
}

/** Write the starter file. Never overwrites. */
export function seedArchitecturePolicy(opts: SeedArchitecturePolicyOptions): SeedArchitecturePolicyResult {
  const target = path.join(opts.root, ARCHITECTURE_CONFIG_FILE);
  const observed = opts.policy ? 0 : (opts.sidecar?.symbols?.length ?? 0);
  const policy = opts.policy ?? inferArchitecturePolicy(opts.sidecar);
  if (fs.existsSync(target)) {
    return { written: false, path: ARCHITECTURE_CONFIG_FILE, policy, observed, reason: 'already-present' };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, renderArchitecturePolicy(policy), 'utf8');
  return { written: true, path: ARCHITECTURE_CONFIG_FILE, policy, observed, reason: 'written' };
}
