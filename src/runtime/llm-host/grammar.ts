/**
 * Grammar construction for constrained decoding (Approach B / B2).
 *
 * Fail-closed policy: when a pack requires constrained decoding
 * (`requireGrammar: true`), generation must not proceed with free text if the
 * binding cannot attach a grammar object (or an accepted string form).
 */

export type GrammarAttachMethod = 'LlamaGrammar' | 'createGrammar' | 'string-fallback' | 'none';

export interface GrammarAttachResult {
  /** Object or string passed to the chat API as `grammar`. */
  value: unknown | null;
  method: GrammarAttachMethod;
  /** True when decoding is actually constrained (not a silent free-text fallback). */
  applied: boolean;
  /** Human reason when not applied. */
  reason?: string;
}

export interface AttachGrammarOptions {
  /**
   * Prefer this llama instance (from the warm session that loaded the model).
   * node-llama-cpp requires LlamaGrammar and the model to share the same instance.
   */
  llama?: unknown;
}

/**
 * Try to build a grammar object for the injected node-llama-cpp module.
 * Pure best-effort; callers enforce fail-closed via {@link assertGrammarOrThrow}.
 */
export async function attachGrammar(
  lib: unknown,
  gbnf: string | undefined,
  options: AttachGrammarOptions = {},
): Promise<GrammarAttachResult> {
  if (!gbnf?.trim()) {
    return { value: null, method: 'none', applied: false, reason: 'no GBNF provided' };
  }
  const l: any = lib;
  if (!l) {
    return { value: null, method: 'none', applied: false, reason: 'no llama binding loaded' };
  }

  // Preferred: LlamaGrammar class (node-llama-cpp 3.x patterns).
  const ctorErrors: string[] = [];
  if (l.LlamaGrammar) {
    try {
      if (typeof l.LlamaGrammar === 'function') {
        let llama: unknown = options.llama;
        if (llama === undefined) {
          try {
            llama = typeof l.getLlama === 'function' ? await l.getLlama() : undefined;
          } catch {
            llama = undefined;
          }
        }
        // Common ctor shapes across versions.
        const attempts: Array<() => unknown> = [
          () => new l.LlamaGrammar(llama, { grammar: gbnf }),
          () => new l.LlamaGrammar({ grammar: gbnf }),
          () => new l.LlamaGrammar(gbnf),
        ];
        for (const attempt of attempts) {
          try {
            const g = attempt();
            if (g) return { value: g, method: 'LlamaGrammar', applied: true };
          } catch (e) {
            ctorErrors.push(e instanceof Error ? e.message : String(e));
          }
        }
      }
      if (typeof l.LlamaGrammar.fromString === 'function') {
        try {
          const g = await l.LlamaGrammar.fromString(gbnf);
          if (g) return { value: g, method: 'LlamaGrammar', applied: true };
        } catch (e) {
          ctorErrors.push(e instanceof Error ? e.message : String(e));
        }
      }
    } catch (e) {
      return {
        value: null,
        method: 'none',
        applied: false,
        reason: `LlamaGrammar failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  if (typeof l.createGrammar === 'function') {
    try {
      const g = await l.createGrammar(gbnf);
      if (g) return { value: g, method: 'createGrammar', applied: true };
    } catch (e) {
      ctorErrors.push(`createGrammar: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Last resort: some bindings accept a raw GBNF string on prompt opts.
  // We mark applied=true only when the caller opts into string fallback for tests
  // or known-good bindings — production fail-closed should not rely on this alone.
  const hadApi = !!(l?.LlamaGrammar || typeof l?.createGrammar === 'function');
  const reason = hadApi
    ? `LlamaGrammar/createGrammar present but GBNF was rejected` +
      (ctorErrors[0] ? ` (${ctorErrors[0].split('\n')[0]})` : '')
    : 'binding has no LlamaGrammar/createGrammar; raw GBNF string is available but not verified as constrained';
  return {
    value: gbnf,
    method: 'string-fallback',
    applied: false,
    reason,
  };
}

/**
 * Fail-closed: throw when constrained decoding is required but grammar did not attach.
 */
export function assertGrammarOrThrow(
  result: GrammarAttachResult,
  opts: { requireGrammar?: boolean; allowStringFallback?: boolean } = {},
): void {
  if (!opts.requireGrammar) return;
  if (result.applied) return;
  if (opts.allowStringFallback && result.method === 'string-fallback' && result.value) {
    // Explicit opt-in for environments that document string GBNF support.
    return;
  }
  throw new Error(
    `constrained decoding required but grammar could not be attached (${result.method}` +
      `${result.reason ? `: ${result.reason}` : ''}). ` +
      `Use a node-llama-cpp build with LlamaGrammar, or choose a Code Mode without constrainedDecoding (e.g. Flow), ` +
      `or set VG_ALLOW_GRAMMAR_STRING_FALLBACK=1 only if your binding documents raw GBNF support.`,
  );
}

/** Env gate for string GBNF fallback (off by default — fail-closed). */
export function allowGrammarStringFallback(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VG_ALLOW_GRAMMAR_STRING_FALLBACK === '1' || env.VIBGRATE_ALLOW_GRAMMAR_STRING_FALLBACK === '1';
}
