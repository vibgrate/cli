/**
 * Embedded llm-host (Approach B default) — same address space as the agent.
 *
 * Production path: warm session pool ({@link acquireHostSession}) so models are
 * not reloaded every chat turn. Binding is injected via {@link setBinding}.
 */

import { annotateUnknownIdentifiers } from '../identifier-mask.js';
import { generateWithLlamaBinding } from './binding.js';
import {
  acquireHostSession,
  generateOnSession,
  type HostGenerateReport,
} from './session.js';
import type {
  LlmChatMessage,
  LlmGenerateOptions,
  LlmGenerateResult,
  LlmHost,
  LlmMemoryReport,
} from './types.js';

export class EmbeddedLlmHost implements LlmHost {
  readonly isolation = 'embedded' as const;
  private modelRef: string | null = null;
  private loaded = false;
  private binding: unknown | null = null;
  private preferGrammar = false;
  private lastReport: HostGenerateReport | null = null;

  /** Attach the dynamically loaded node-llama-cpp module. */
  setBinding(lib: unknown): void {
    this.binding = lib;
  }

  /** Hint from MEP: attempt constrained decoding when grammar is supplied. */
  setPreferGrammar(on: boolean): void {
    this.preferGrammar = on;
  }

  /** Last generate metrics (KV plan, draft accept, warm start). */
  lastGenerateReport(): HostGenerateReport | null {
    return this.lastReport;
  }

  async load(modelRef: string): Promise<void> {
    this.modelRef = modelRef;
    this.loaded = true;
    // Eagerly warm the session when binding is already available.
    if (this.binding) {
      await acquireHostSession(this.binding, modelRef);
    }
  }

  async unload(): Promise<void> {
    this.modelRef = null;
    this.loaded = false;
    this.lastReport = null;
  }

  supportsConstrainedDecoding(): boolean {
    return this.preferGrammar && this.binding != null;
  }

  memoryReport(): LlmMemoryReport {
    return {
      isolation: this.isolation,
      modelRef: this.modelRef,
      loaded: this.loaded,
    };
  }

  async generate(messages: LlmChatMessage[], opts: LlmGenerateOptions = {}): Promise<LlmGenerateResult> {
    if (!this.loaded || !this.modelRef) {
      throw new Error('llm-host: no model loaded — orchestrator must call load() after resolve/install');
    }
    if (!this.binding) {
      throw new Error(
        'llm-host: node-llama-cpp binding not attached — run `vg models install` for the llama-cpp provider, then retry',
      );
    }

    // Production path: pooled warm session.
    try {
      const session = await acquireHostSession(this.binding, this.modelRef);
      const report = await generateOnSession(session, messages, {
        grammar: opts.grammar,
        requireGrammar: opts.requireGrammar,
        identifierTrie: opts.identifierTrie,
        annotateUnknownIdentifiers: opts.annotateUnknownIdentifiers,
        draftCandidates: opts.draftCandidates,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        promptSegments: opts.promptSegments,
      });
      this.lastReport = report;
      return {
        text: report.text,
        model: report.model,
        isolation: report.isolation,
        constrained: report.constrained || !!(opts.grammar && this.preferGrammar),
        unknownIdentifiers: report.unknownIdentifiers,
      };
    } catch {
      // Fallback one-shot (tests / minimal bindings).
      let text = await generateWithLlamaBinding({
        lib: this.binding,
        modelPath: this.modelRef,
        messages,
        opts,
      });
      let unknownIdentifiers: string[] | undefined;
      if (opts.identifierTrie && opts.annotateUnknownIdentifiers !== false) {
        const ann = annotateUnknownIdentifiers(text, opts.identifierTrie);
        text = ann.text;
        unknownIdentifiers = ann.unknown.length ? ann.unknown : undefined;
      }
      return {
        text,
        model: this.modelRef,
        isolation: this.isolation,
        constrained: !!(opts.grammar && this.supportsConstrainedDecoding()),
        unknownIdentifiers,
      };
    }
  }
}
