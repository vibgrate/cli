/**
 * node-llama-cpp binding adapter — pure glue so embedded + process hosts share
 * one code path. The module is injected (from ensurePackage); never imported
 * statically so the published CLI stays free of native deps.
 */

import type { LlmChatMessage, LlmGenerateOptions } from './types.js';

export interface LlamaBindingGenerateInput {
  /** Loaded node-llama-cpp module (dynamic). */
  lib: unknown;
  modelPath: string;
  messages: LlmChatMessage[];
  opts?: LlmGenerateOptions;
}

/**
 * Run one chat completion via node-llama-cpp. Throws on binding/model errors
 * (callers wrap with redaction).
 */
export async function generateWithLlamaBinding(input: LlamaBindingGenerateInput): Promise<string> {
  const lib: any = input.lib;
  if (!lib || typeof lib.getLlama !== 'function') {
    throw new Error('llm-host: invalid node-llama-cpp module (getLlama missing)');
  }
  const llama = await lib.getLlama();
  const model = await llama.loadModel({ modelPath: input.modelPath });
  const ctx = await model.createContext();
  const { LlamaChatSession } = lib;
  if (typeof LlamaChatSession !== 'function') {
    throw new Error('llm-host: LlamaChatSession missing from node-llama-cpp module');
  }
  const chat = new LlamaChatSession({ contextSequence: ctx.getSequence() });
  const prompt = input.messages.map((m) => `${m.role}: ${m.content}`).join('\n\n');
  const temperature = input.opts?.temperature ?? 0;
  const maxTokens = input.opts?.maxTokens;
  // Grammar: pass through when binding supports it (future constrained PatchIR).
  const promptOpts: Record<string, unknown> = { temperature };
  if (typeof maxTokens === 'number') promptOpts.maxTokens = maxTokens;
  if (input.opts?.grammar) {
    // Best-effort: node-llama-cpp versions differ on the grammar API surface.
    promptOpts.grammar = input.opts.grammar;
  }
  const text: string = await chat.prompt(prompt, promptOpts);
  return typeof text === 'string' ? text : String(text ?? '');
}
