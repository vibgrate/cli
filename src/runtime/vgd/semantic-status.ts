/**
 * Human-readable semantic-index progress, shared by `vg ask` (live line) and
 * `vg` / `vg daemon status` (a snapshot). Kept pure so tests do not need a
 * daemon.
 */

export interface SemanticSlotView {
  state: string;
  vectors: number;
  nodeCount?: number;
  pending?: number;
  model?: string;
  error?: string;
}

/** One short sentence: what the index is doing right now. */
export function formatSemanticProgress(slot: SemanticSlotView): string {
  const total = slot.nodeCount && slot.nodeCount > 0 ? slot.nodeCount : slot.vectors + (slot.pending ?? 0);
  const counts =
    total > 0 ? `${slot.vectors.toLocaleString()}/${total.toLocaleString()}` : `${slot.vectors.toLocaleString()} vector(s)`;
  switch (slot.state) {
    case 'ready':
      return `semantic index ready · ${slot.vectors.toLocaleString()} vector(s)${slot.model ? ` · ${slot.model}` : ''}`;
    case 'building':
      return `building semantic index · ${counts}${slot.model ? ` · ${slot.model}` : ''}`;
    case 'stale':
      return slot.vectors > 0
        ? `semantic index stale · ${slot.vectors.toLocaleString()} vector(s) still rankable`
        : 'waiting for the semantic index · warming';
    case 'absent':
      return 'waiting for the semantic index · not built yet';
    case 'failed':
      return slot.error ? `semantic index failed — ${slot.error}` : 'semantic index failed';
    default:
      return `semantic · ${slot.state} · ${counts}`;
  }
}
