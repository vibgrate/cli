import { describe, it, expect } from 'vitest';
import { runProviderWizard, toOllamaTag, type WizardResult } from './wizard.js';
import type { Prompter, SelectChoice, Spinner } from './ui.js';
import type { Catalog } from './catalog.js';
import type { LocalModel } from '../engine/models.js';

/** A deterministic prompter that replays queued answers — no TTY, no network. */
class ScriptedPrompter implements Prompter {
  constructor(
    private selects: unknown[] = [],
    private inputs: string[] = [],
    private confirms: boolean[] = [],
  ) {}
  intro(): void {}
  outro(): void {}
  note(): void {}
  async select<T>(_message: string, choices: SelectChoice<T>[]): Promise<T> {
    const answer = this.selects.shift();
    const match = choices.find((c) => c.value === answer);
    if (!match) throw new Error(`scripted select had no matching choice for ${String(answer)}`);
    return match.value;
  }
  async input(): Promise<string> {
    return this.inputs.shift() ?? '';
  }
  async confirm(): Promise<boolean> {
    return this.confirms.shift() ?? false;
  }
  spinner(): Spinner {
    return { update() {}, stop() {}, fail() {} };
  }
}

const catalog: Catalog = {
  source: 'network',
  fresh: true,
  providers: [
    { id: 'anthropic', label: 'Anthropic (Claude)', models: [{ id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'anthropic', contextLength: 200000, promptPricePerM: 3 }] },
    { id: 'openai', label: 'OpenAI (GPT)', models: [{ id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'openai' }] },
    { id: 'qwen', label: 'Qwen', models: [{ id: 'qwen/qwen-2.5-coder-7b', name: 'Qwen2.5 Coder 7B', provider: 'qwen' }] },
  ],
};

const installed: LocalModel[] = [{ runtime: 'ollama', name: 'qwen2.5-coder:7b', path: '/x' }];

describe('runProviderWizard', () => {
  it('hosted: pick a provider then a model', async () => {
    const prompter = new ScriptedPrompter(['anthropic', 'anthropic/claude-3.5-sonnet']);
    const r = await runProviderWizard(prompter, { catalog, localModels: [] });
    expect(r).toMatchObject<Partial<WizardResult>>({ kind: 'hosted', provider: 'openrouter', model: 'anthropic/claude-3.5-sonnet', providerSlug: 'anthropic' });
  });

  it('local: pick an already-installed model (no pull)', async () => {
    const prompter = new ScriptedPrompter(['__local__', 'qwen2.5-coder:7b']);
    const r = await runProviderWizard(prompter, { catalog, localModels: installed });
    expect(r).toMatchObject<Partial<WizardResult>>({ kind: 'local', provider: 'ollama', model: 'qwen2.5-coder:7b', needsPull: false });
  });

  it('local: enter a model name to pull', async () => {
    const prompter = new ScriptedPrompter(['__local__', '__enter_slug__'], ['llama3:8b']);
    const r = await runProviderWizard(prompter, { catalog, localModels: [] });
    expect(r).toMatchObject<Partial<WizardResult>>({ kind: 'local', model: 'llama3:8b', needsPull: true });
  });

  it('enter-slug: a full provider/model slug is a hosted pick', async () => {
    const prompter = new ScriptedPrompter(['__enter_slug__'], ['openai/gpt-4o-mini']);
    const r = await runProviderWizard(prompter, { catalog, localModels: [] });
    expect(r).toMatchObject<Partial<WizardResult>>({ kind: 'hosted', model: 'openai/gpt-4o-mini', providerSlug: 'openai' });
  });

  it('local browse: pick a catalog coding model → mapped to an ollama tag to pull', async () => {
    const prompter = new ScriptedPrompter(['__local__', '__browse__', 'qwen-2.5-coder:7b']);
    const r = await runProviderWizard(prompter, { catalog, localModels: [] });
    expect(r.kind).toBe('local');
    expect(r.needsPull).toBe(true);
    expect(r.model).toBe('qwen-2.5-coder:7b');
  });
});

describe('toOllamaTag', () => {
  it('maps an OpenRouter slug to a likely ollama tag', () => {
    expect(toOllamaTag('qwen/qwen-2.5-coder-7b')).toBe('qwen-2.5-coder:7b');
    expect(toOllamaTag('meta-llama/llama-3.1-8b-instruct')).toBe('llama-3.1:8b');
  });
});
