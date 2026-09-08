/**
 * Model routing.
 *
 *  - `VG_PROXY_MODEL_ROUTES` (`requested=served,…`, `*` glob suffix allowed)
 *    rewrites the `model` field before forwarding.
 *  - `VG_PROXY_MODEL_ROUTER=true` enables rule-based routing; rules are a JSON
 *    array parsed strictly, fail-closed per rule (an unknown key rejects the
 *    rule rather than silently widening it). First match wins; a rule whose
 *    `to_model` equals the current model is an explicit exemption.
 */

import type { Message } from '../compress/types.js';

export interface ModelRoute {
  toModel: string;
  maxInputTokens?: number;
  minInputTokens?: number;
  requireNoTools?: boolean;
  fromModels?: string[];
  name?: string;
}

export interface ModelDecision {
  originalModel: string;
  routedModel: string;
  matched: boolean;
  reason: string;
  ruleName?: string;
  changed: boolean;
}

const ALLOWED_KEYS = new Set(['to_model', 'max_input_tokens', 'min_input_tokens', 'require_no_tools', 'from_models', 'name']);

function nonNegInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/** Strict, fail-closed per rule. Returns the accepted rules and the rejection reasons. */
export function parseModelRoutes(raw: string | undefined): { routes: ModelRoute[]; problems: string[] } {
  const problems: string[] = [];
  if (!raw || !raw.trim()) return { routes: [], problems };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { routes: [], problems: ['model router rules: invalid JSON'] };
  }
  if (!Array.isArray(parsed)) return { routes: [], problems: ['model router rules: expected an array'] };
  const routes: ModelRoute[] = [];
  parsed.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return void problems.push(`rule ${i}: not an object`);
    const o = entry as Record<string, unknown>;
    const unknown = Object.keys(o).filter((k) => !ALLOWED_KEYS.has(k));
    if (unknown.length) return void problems.push(`rule ${i}: unknown keys ${unknown.join(', ')}`);
    if (typeof o.to_model !== 'string' || !o.to_model.trim()) return void problems.push(`rule ${i}: to_model must be a non-empty string`);
    const route: ModelRoute = { toModel: o.to_model.trim() };
    if (o.max_input_tokens !== undefined) {
      const n = nonNegInt(o.max_input_tokens);
      if (n === null) return void problems.push(`rule ${i}: max_input_tokens must be a non-negative integer`);
      route.maxInputTokens = n;
    }
    if (o.min_input_tokens !== undefined) {
      const n = nonNegInt(o.min_input_tokens);
      if (n === null) return void problems.push(`rule ${i}: min_input_tokens must be a non-negative integer`);
      route.minInputTokens = n;
    }
    if (o.require_no_tools !== undefined) {
      if (typeof o.require_no_tools !== 'boolean') return void problems.push(`rule ${i}: require_no_tools must be a boolean`);
      route.requireNoTools = o.require_no_tools;
    }
    if (o.from_models !== undefined) {
      if (!Array.isArray(o.from_models) || !o.from_models.every((m) => typeof m === 'string')) return void problems.push(`rule ${i}: from_models must be a list of strings`);
      route.fromModels = o.from_models as string[];
    }
    if (o.name !== undefined) {
      if (typeof o.name !== 'string') return void problems.push(`rule ${i}: name must be a string`);
      route.name = o.name;
    }
    routes.push(route);
  });
  return { routes, problems };
}

/** chars/4 over messages + tools + system — never throws. */
export function estimateInputTokens(body: Record<string, unknown>): number {
  let chars = 0;
  const add = (v: unknown): void => {
    if (v === undefined || v === null) return;
    try {
      chars += typeof v === 'string' ? v.length : JSON.stringify(v).length;
    } catch {
      /* ignore */
    }
  };
  add(body.messages as Message[] | undefined);
  add(body.input);
  add(body.tools);
  add(body.system);
  add(body.instructions);
  return Math.floor(chars / 4);
}

function globMatch(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1));
  return false;
}

/** Apply the static route map (exact, then glob). */
export function applyModelRoutes(model: string, routes: Record<string, string>): string {
  if (!model) return model;
  if (routes[model]) return routes[model];
  for (const [k, v] of Object.entries(routes).sort(([a], [b]) => b.length - a.length)) if (globMatch(k, model)) return v;
  return model;
}

export class ModelRouter {
  constructor(readonly routes: ModelRoute[]) {}

  select(body: Record<string, unknown>): ModelDecision {
    const model = String(body.model ?? '');
    const tokens = estimateInputTokens(body);
    const hasTools = Array.isArray(body.tools) && (body.tools as unknown[]).length > 0;
    for (const r of this.routes) {
      if (r.fromModels && !r.fromModels.some((m) => globMatch(m, model))) continue;
      if (r.maxInputTokens !== undefined && tokens > r.maxInputTokens) continue;
      if (r.minInputTokens !== undefined && tokens < r.minInputTokens) continue;
      if (r.requireNoTools && hasTools) continue;
      const changed = r.toModel !== model;
      return { originalModel: model, routedModel: r.toModel, matched: true, reason: changed ? 'rule' : 'exempt', ruleName: r.name, changed };
    }
    return { originalModel: model, routedModel: model, matched: false, reason: 'no_match', changed: false };
  }
}
