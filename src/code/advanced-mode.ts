/**
 * Discovery-tool gating for capsule-first runs (Fusion Phase 4).
 *
 * Under Task Capsule context the model should solve from source evidence first
 * (ZNS@1 path). Low-level discovery tools remain available as rescue, but we
 * soft-nudge on early overuse and optionally hard-cap discovery until a
 * mutation or inspect_change has run.
 *
 * Pure counters — unit-tested without a model.
 */

export const DISCOVERY_TOOL_NAMES = new Set([
  'search_code',
  'read_file',
  'list_files',
  'graph_impact',
  'library_docs',
]);

export interface DiscoveryGateOptions {
  /**
   * When true (default for non-capsule runs), every tool is free.
   * When false, apply soft/hard discovery limits.
   */
  advancedMode: boolean;
  /** Soft nudge after this many discovery calls (default 2). */
  softLimit?: number;
  /** Hard block discovery after this many calls until progress (default 6). 0 = never hard-block. */
  hardLimit?: number;
}

export interface DiscoveryGateState {
  discoveryCount: number;
  mutations: number;
  inspectChangeUsed: boolean;
}

export type DiscoveryGateDecision =
  | { allow: true; note?: string }
  | { allow: false; reason: string };

export function createDiscoveryGateState(): DiscoveryGateState {
  return { discoveryCount: 0, mutations: 0, inspectChangeUsed: false };
}

/**
 * Decide whether a tool call may proceed under the discovery policy.
 * Call {@link recordDiscoveryGateOutcome} after the tool runs.
 */
export function gateDiscoveryTool(
  name: string,
  state: DiscoveryGateState,
  options: DiscoveryGateOptions,
): DiscoveryGateDecision {
  if (options.advancedMode) return { allow: true };
  if (!DISCOVERY_TOOL_NAMES.has(name)) return { allow: true };

  // After real progress, discovery is unrestricted (repair / follow-up).
  if (state.mutations > 0 || state.inspectChangeUsed) return { allow: true };

  const soft = options.softLimit ?? 2;
  const hard = options.hardLimit ?? 6;

  if (hard > 0 && state.discoveryCount >= hard) {
    return {
      allow: false,
      reason:
        `Discovery tools are limited for capsule-first runs (${hard} free calls used). ` +
        `Use inspect_task / inspect_change / apply_patch / edit_file with the capsule evidence, ` +
        `or re-run with advanced mode if you need free search.`,
    };
  }

  if (state.discoveryCount >= soft) {
    return {
      allow: true,
      note:
        `(capsule-first) Prefer the Task Capsule evidence over further navigation. ` +
        `Call inspect_change before multi-file edits. Discovery calls so far: ${state.discoveryCount + 1}.`,
    };
  }

  return { allow: true };
}

/** Update counters after a tool completes (or is blocked — do not call if blocked). */
export function recordDiscoveryGateOutcome(
  name: string,
  state: DiscoveryGateState,
  result: { mutated: boolean },
): void {
  if (DISCOVERY_TOOL_NAMES.has(name)) state.discoveryCount++;
  if (result.mutated) state.mutations++;
  if (name === 'inspect_change') state.inspectChangeUsed = true;
}
