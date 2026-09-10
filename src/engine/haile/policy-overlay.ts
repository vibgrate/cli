/**
 * `vg.arch.policy.v1` — the user's side of the architecture policy.
 *
 * `.vibgrate/architecture.toml` names one baked pack (`policy = "…"`, read by
 * `policy-config.ts`) and may add `[[overlay]]` tables on top of it. An
 * overlay attaches to what the module discovered about a symbol — its role
 * and its purposes — under an optional path prefix, never to a folder the
 * user drew:
 *
 *   [[overlay]]
 *   id = "team/handlers-may-not-persist"   # team/ or org/ prefix, unique
 *   path = "src/"                          # optional repo-relative prefix
 *   when.role = "controller"               # optional, one of the 20 roles
 *   when.purpose = "persist"               # optional, one of the 26 purposes
 *   action = "deny"                        # deny | allow | remap
 *   severity = "hard"                      # hard | warn (deny default hard)
 *   message = "…"                          # optional finding text
 *
 *   [[overlay]]
 *   id = "team/legacy-catalog-may-persist"
 *   path = "src/Legacy/"
 *   rule = "controller-persists"           # baked rule name or full id
 *   action = "allow"                       # remap needs severity as well
 *
 * `deny` adds a finding carrying the overlay id as its rule. `allow` drops
 * the baked rule's findings on the matched symbols. `remap` changes their
 * severity. Overlays never change a role or a purpose.
 *
 * Fail loud: a table that does not validate throws ArchitecturePolicyError
 * listing every problem, and the caller fails the architecture step. The
 * baked `policy` key keeps its warn-and-fall-back (an unknown id must never
 * turn a build red), and a file with no overlays keeps today's contract.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { ARCHITECTURE_CONFIG_FILE, isHailePolicy } from './policy-config.js';
import type { HaileFinding, HailePolicy, HaileSidecar } from './types.js';
import { ARCH_POLICY_SCHEMA, DEFAULT_POLICY, PURPOSES, ROLES } from './types.js';

export type OverlayAction = 'deny' | 'allow' | 'remap';
export type OverlaySeverity = 'hard' | 'warn';

export interface ArchitectureOverlay {
  id: string;
  action: OverlayAction;
  path?: string;
  role?: string;
  purpose?: string;
  rule?: string;
  severity?: OverlaySeverity;
  message?: string;
}

export interface ArchitecturePolicyDocument {
  /** The baked pack in force from the file alone (flag and environment are applied by `architecturePolicyFor`). */
  policy: HailePolicy;
  /** The raw `policy` value when it was not a known pack (the fall-back is reported, not hidden). */
  unknownPolicy?: string;
  overlays: ArchitectureOverlay[];
  /** Repo-relative path of the file, or null when there is none. */
  file: string | null;
}

export class ArchitecturePolicyError extends Error {
  readonly problems: string[];
  readonly file: string;
  constructor(file: string, problems: string[]) {
    super(`${file}: ${problems.length} problem${problems.length === 1 ? '' : 's'} in the architecture policy\n  - ${problems.join('\n  - ')}`);
    this.name = 'ArchitecturePolicyError';
    this.file = file;
    this.problems = problems;
  }
}

const ACTIONS: readonly OverlayAction[] = ['deny', 'allow', 'remap'];
const SEVERITIES: readonly OverlaySeverity[] = ['hard', 'warn'];
const OVERLAY_KEYS = new Set(['id', 'path', 'when', 'action', 'severity', 'message', 'rule']);
const WHEN_KEYS = new Set(['role', 'purpose']);
const ID_RE = /^(team|org)\/[a-z0-9][a-z0-9-]*$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalisePrefix(p: string): string {
  let s = p.replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  while (s.startsWith('/')) s = s.slice(1);
  return s;
}

function normaliseRule(rule: string): { name: string; pack: string | null } {
  const slash = rule.lastIndexOf('/');
  return slash >= 0 ? { name: rule.slice(slash + 1), pack: rule.slice(0, slash) } : { name: rule, pack: null };
}

/** Parse and validate a policy document. Throws ArchitecturePolicyError on any overlay problem. */
export function parseArchitecturePolicy(text: string, file: string): ArchitecturePolicyDocument {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch (err) {
    // A pack-only file that does not parse keeps the silent fall-back the
    // `policy` key has always had. A file that tried to declare overlays or
    // the schema is a policy document, and a syntax error in it must be seen.
    if (/\[\[\s*overlay\s*\]\]|^\s*schema\s*=/m.test(text)) {
      throw new ArchitecturePolicyError(file, [`TOML syntax: ${err instanceof Error ? err.message : String(err)}`]);
    }
    return { policy: DEFAULT_POLICY, overlays: [], file };
  }
  const problems: string[] = [];
  if (doc.schema !== undefined && doc.schema !== ARCH_POLICY_SCHEMA) {
    problems.push(`schema must be "${ARCH_POLICY_SCHEMA}" (got ${JSON.stringify(doc.schema)})`);
  }
  const policy = isHailePolicy(doc.policy) ? doc.policy : DEFAULT_POLICY;
  const unknownPolicy = doc.policy !== undefined && !isHailePolicy(doc.policy) ? String(doc.policy) : undefined;

  const overlays: ArchitectureOverlay[] = [];
  const raw = doc.overlay;
  if (raw !== undefined) {
    if (!Array.isArray(raw)) problems.push('overlay must be a list of [[overlay]] tables');
    else {
      const seen = new Set<string>();
      raw.forEach((entry, i) => {
        const at = `overlay[${i}]`;
        if (!isRecord(entry)) {
          problems.push(`${at}: must be a table`);
          return;
        }
        for (const k of Object.keys(entry)) if (!OVERLAY_KEYS.has(k)) problems.push(`${at}: unknown key "${k}" (allowed: ${[...OVERLAY_KEYS].join(', ')})`);
        const id = entry.id;
        const label = typeof id === 'string' && id ? id : at;
        if (typeof id !== 'string' || !ID_RE.test(id)) problems.push(`${label}: id must be "team/<name>" or "org/<name>" (lower-case letters, digits, dashes)`);
        else if (seen.has(id)) problems.push(`${label}: duplicate id`);
        else seen.add(id);
        const action = entry.action;
        if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) problems.push(`${label}: action must be one of ${ACTIONS.join(' | ')}`);
        let role: string | undefined;
        let purpose: string | undefined;
        if (entry.when !== undefined) {
          if (!isRecord(entry.when)) problems.push(`${label}: when must be a table with role and/or purpose`);
          else {
            for (const k of Object.keys(entry.when)) if (!WHEN_KEYS.has(k)) problems.push(`${label}: unknown key when.${k} (allowed: role, purpose)`);
            if (entry.when.role !== undefined) {
              if (typeof entry.when.role !== 'string' || !(ROLES as readonly string[]).includes(entry.when.role)) problems.push(`${label}: when.role must be one of the ${ROLES.length} roles (got ${JSON.stringify(entry.when.role)})`);
              else role = entry.when.role;
            }
            if (entry.when.purpose !== undefined) {
              if (typeof entry.when.purpose !== 'string' || !(PURPOSES as readonly string[]).includes(entry.when.purpose)) problems.push(`${label}: when.purpose must be one of the ${PURPOSES.length} purposes (got ${JSON.stringify(entry.when.purpose)})`);
              else purpose = entry.when.purpose;
            }
          }
        }
        let severity: OverlaySeverity | undefined;
        if (entry.severity !== undefined) {
          if (typeof entry.severity !== 'string' || !(SEVERITIES as readonly string[]).includes(entry.severity)) problems.push(`${label}: severity must be hard | warn`);
          else severity = entry.severity as OverlaySeverity;
        }
        let prefix: string | undefined;
        if (entry.path !== undefined) {
          if (typeof entry.path !== 'string' || !entry.path.trim()) problems.push(`${label}: path must be a non-empty repo-relative prefix`);
          else prefix = normalisePrefix(entry.path.trim());
        }
        let rule: string | undefined;
        if (entry.rule !== undefined) {
          if (typeof entry.rule !== 'string' || !entry.rule.trim()) problems.push(`${label}: rule must be a baked rule name or id`);
          else rule = entry.rule.trim();
        }
        if (entry.message !== undefined && typeof entry.message !== 'string') problems.push(`${label}: message must be a string`);
        if (action === 'deny') {
          if (!role && !purpose) problems.push(`${label}: deny needs when.role and/or when.purpose`);
          if (rule) problems.push(`${label}: deny does not take rule (it creates a finding named after the id)`);
          severity ??= 'hard';
        }
        if (action === 'allow' || action === 'remap') {
          if (!rule) problems.push(`${label}: ${action} needs rule (the baked rule to ${action === 'allow' ? 'drop' : 'remap'})`);
          if (purpose) problems.push(`${label}: ${action} matches by rule, not when.purpose`);
          if (rule && rule.startsWith('team/')) problems.push(`${label}: rule must name a baked pack rule, not another overlay`);
          if (rule && rule.startsWith('org/')) problems.push(`${label}: rule must name a baked pack rule, not another overlay`);
        }
        if (action === 'allow' && severity) problems.push(`${label}: allow does not take severity (use remap)`);
        if (action === 'remap' && !severity) problems.push(`${label}: remap needs severity (hard | warn)`);
        if (typeof id === 'string' && typeof action === 'string' && (ACTIONS as readonly string[]).includes(action)) {
          overlays.push({
            id,
            action: action as OverlayAction,
            ...(prefix !== undefined ? { path: prefix } : {}),
            ...(role ? { role } : {}),
            ...(purpose ? { purpose } : {}),
            ...(rule ? { rule } : {}),
            ...(severity ? { severity } : {}),
            ...(typeof entry.message === 'string' ? { message: entry.message } : {}),
          });
        }
      });
    }
  }
  if (problems.length) throw new ArchitecturePolicyError(file, problems);
  return { policy, ...(unknownPolicy !== undefined ? { unknownPolicy } : {}), overlays, file };
}

/** The repository's policy document. No file → the default pack and no overlays. */
export function loadArchitecturePolicy(root: string): ArchitecturePolicyDocument {
  const file = path.join(root, ARCHITECTURE_CONFIG_FILE);
  let text: string;
  try {
    if (!fs.existsSync(file)) return { policy: DEFAULT_POLICY, overlays: [], file: null };
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { policy: DEFAULT_POLICY, overlays: [], file: null };
  }
  return parseArchitecturePolicy(text, ARCHITECTURE_CONFIG_FILE);
}

export interface OverlayApplication {
  /** Findings added, dropped or remapped per overlay id (0 when nothing matched). */
  applied: Record<string, number>;
}

function underPath(filePath: string, prefix: string | undefined): boolean {
  if (!prefix) return true;
  return normalisePrefix(filePath).startsWith(prefix);
}

function ruleMatches(finding: HaileFinding, rule: string): boolean {
  const want = normaliseRule(rule);
  const got = normaliseRule(finding.rule);
  if (want.pack) return finding.rule === rule;
  return got.name === want.name && got.pack !== null && !got.pack.startsWith('team') && !got.pack.startsWith('org');
}

/**
 * Apply overlays to a classify document in place: deny adds findings, allow
 * drops, remap re-severities. Stamps `overlays` with the ids in file order.
 * Roles and purposes are never touched.
 */
export function applyArchitectureOverlays(sidecar: HaileSidecar, overlays: ArchitectureOverlay[]): OverlayApplication {
  const applied: Record<string, number> = Object.fromEntries(overlays.map((o) => [o.id, 0]));
  if (!overlays.length) return { applied };
  for (const symbol of sidecar.symbols) {
    if (!symbol || typeof symbol.file_path !== 'string') continue;
    const role = symbol.role?.primary;
    const purposes = new Set((symbol.purposes ?? []).map((p) => p?.purpose).filter((p): p is string => typeof p === 'string'));
    for (const overlay of overlays) {
      if (!underPath(symbol.file_path, overlay.path)) continue;
      if (overlay.role && role !== overlay.role) continue;
      if (overlay.action === 'deny') {
        if (overlay.purpose && !purposes.has(overlay.purpose)) continue;
        const findings = (symbol.findings ??= []);
        if (findings.some((f) => f && f.rule === overlay.id)) continue;
        const what = [overlay.role ? `${overlay.role.replace(/_/g, ' ')}` : 'symbol', overlay.purpose ? `with purpose ${overlay.purpose}` : ''].filter(Boolean).join(' ');
        findings.push({
          rule: overlay.id,
          severity: overlay.severity ?? 'hard',
          message: overlay.message ?? `${what} is denied by ${overlay.id}${overlay.path ? ` under ${overlay.path}` : ''}`,
        });
        applied[overlay.id] = (applied[overlay.id] ?? 0) + 1;
        continue;
      }
      const findings = symbol.findings;
      if (!findings?.length || !overlay.rule) continue;
      if (overlay.action === 'allow') {
        const kept = findings.filter((f) => !(f && ruleMatches(f, overlay.rule as string)));
        const dropped = findings.length - kept.length;
        if (dropped) {
          applied[overlay.id] = (applied[overlay.id] ?? 0) + dropped;
          if (kept.length) symbol.findings = kept;
          else delete symbol.findings;
        }
        continue;
      }
      for (const f of findings) {
        if (f && ruleMatches(f, overlay.rule) && f.severity !== overlay.severity) {
          f.severity = overlay.severity as OverlaySeverity;
          applied[overlay.id] = (applied[overlay.id] ?? 0) + 1;
        }
      }
    }
  }
  sidecar.overlays = overlays.map((o) => o.id);
  return { applied };
}
