/**
 * Before/after content carried on a mutating action so a host can review a
 * change in a real diff editor (VG-CLI-CODE §18.3).
 *
 * The unified diff on the action is enough to *summarize* a change, but not to
 * open it in an editor's diff view — that needs both whole sides. This is the
 * only reason the sides are carried, so they are bounded: a host that cannot be
 * given the sides falls back to the inline diff it already renders, rather than
 * a multi-megabyte frame stalling the panel.
 *
 * Content is not redacted, deliberately. These sides go to the human reviewing
 * their own files in their own editor — the same trust boundary as the diff
 * already on the action — and redacting would corrupt the very text they are
 * being asked to approve. Nothing here is sent to a model.
 */

/** Per-side cap. Beyond this a host is expected to fall back to the diff. */
export const MAX_PREVIEW_CHARS = 256_000;

export interface PreviewSides {
  /** File content before the change; empty string for a create. */
  before: string;
  /** File content after the change; empty string for a delete. */
  after: string;
}

/**
 * Bound the sides for transport. Returns undefined when either side is too
 * large, so the caller omits the field entirely rather than sending a truncated
 * side — a half-file diff would misrepresent the change being approved.
 */
export function previewSides(
  before: string | null | undefined,
  after: string | null | undefined,
): PreviewSides | undefined {
  const b = before ?? '';
  const a = after ?? '';
  if (b.length > MAX_PREVIEW_CHARS || a.length > MAX_PREVIEW_CHARS) return undefined;
  return { before: b, after: a };
}
