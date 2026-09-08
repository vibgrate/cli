/**
 * System-prompt compaction (layer 3 of the tool/system pipeline).
 *
 * Only `text` blocks at or above `minChars` are eligible. Whitespace
 * boilerplate is collapsed deterministically; an optional text compressor
 * (the router, when bound) may shrink further, and every result is kept
 * only when strictly shorter. `cache_control` and every other block field
 * are preserved; a string `system` is reassembled with `\n`.
 */

export interface SystemCompactResult {
  system: unknown;
  changed: boolean;
  beforeChars: number;
  afterChars: number;
}

/** Deterministic whitespace compaction: trailing spaces, 3+ blank lines → 1, tabs → 2 spaces at line starts. */
export function compactWhitespace(text: string): string {
  return text
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\t+/gm, (m) => '  '.repeat(m.length))
    .replace(/[ ]{4,}/g, (m) => ' '.repeat(Math.min(m.length, 4)))
    .replace(/^\s+|\s+$/g, '');
}

function compactOne(text: string, minChars: number, compress?: (t: string) => string | null): string {
  if (text.length < minChars) return text;
  let best = compactWhitespace(text);
  if (best.length >= text.length) best = text;
  if (compress) {
    try {
      const c = compress(best);
      if (typeof c === 'string' && c.length > 0 && c.length < best.length) best = c;
    } catch {
      /* fail open */
    }
  }
  return best;
}

export function compactSystemPrompt(system: unknown, opts: { minChars: number; compress?: (text: string) => string | null }): SystemCompactResult {
  if (typeof system === 'string') {
    const after = compactOne(system, opts.minChars, opts.compress);
    return { system: after.length < system.length ? after : system, changed: after.length < system.length, beforeChars: system.length, afterChars: Math.min(after.length, system.length) };
  }
  if (!Array.isArray(system)) return { system, changed: false, beforeChars: 0, afterChars: 0 };
  let before = 0;
  let after = 0;
  let changed = false;
  const out = (system as Array<Record<string, unknown>>).map((b) => {
    if (!b || typeof b !== 'object' || b.type !== 'text' || typeof b.text !== 'string') return b;
    before += b.text.length;
    const next = compactOne(b.text, opts.minChars, opts.compress);
    if (next.length < b.text.length) {
      changed = true;
      after += next.length;
      return { ...b, text: next };
    }
    after += b.text.length;
    return b;
  });
  return { system: changed ? out : system, changed, beforeChars: before, afterChars: after };
}

/** OpenAI chat: compact system/developer messages in place. */
export function compactOpenAISystemMessages(messages: Array<Record<string, unknown>>, opts: { minChars: number; compress?: (text: string) => string | null }): { messages: Array<Record<string, unknown>>; changed: boolean; beforeChars: number; afterChars: number } {
  let before = 0;
  let after = 0;
  let changed = false;
  const out = messages.map((m) => {
    if (m.role !== 'system' && m.role !== 'developer') return m;
    if (typeof m.content === 'string') {
      before += m.content.length;
      const next = compactOne(m.content, opts.minChars, opts.compress);
      after += Math.min(next.length, m.content.length);
      if (next.length < m.content.length) {
        changed = true;
        return { ...m, content: next };
      }
      return m;
    }
    if (Array.isArray(m.content)) {
      const r = compactSystemPrompt(m.content, opts);
      before += r.beforeChars;
      after += r.afterChars;
      if (r.changed) {
        changed = true;
        return { ...m, content: r.system };
      }
    }
    return m;
  });
  return { messages: changed ? out : messages, changed, beforeChars: before, afterChars: after };
}
