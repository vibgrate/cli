/**
 * The `vg code` guided provider/model wizard (VG-CLI-CODE §8).
 *
 * Walks the developer from "I want to code" to a concrete (provider, model)
 * choice: run locally, or pick one of the current top hosted providers
 * (Claude / GPT / Grok / Gemini / …) surfaced live from the model catalog — with
 * an "enter a slug myself" escape hatch at every step. Pure over an injected
 * {@link Prompter} + catalog + local fleet, so the whole decision tree is
 * unit-tested with a scripted prompter and no network or TTY.
 */

import type { Prompter } from './ui.js';
import type { Catalog } from './catalog.js';
import { topProviders } from './catalog.js';
import type { LocalModel } from '../engine/models.js';

export interface WizardResult {
  kind: 'hosted' | 'local';
  /** The router `--provider` value: `openrouter` for hosted picks, `ollama` for local. */
  provider: 'openrouter' | 'ollama';
  /** The concrete model slug/tag to run. */
  model: string;
  /** The display provider for per-model savings attribution (e.g. `anthropic`, `ollama`). */
  providerSlug: string;
  /** For a local model not yet present on the machine → pull it first. */
  needsPull?: boolean;
}

const ENTER_SLUG = '__enter_slug__';
const LOCAL = '__local__';
const BROWSE = '__browse__';

export interface WizardDeps {
  catalog: Catalog;
  localModels: LocalModel[];
  topN?: number;
}

/** Run the guided selection and return the resolved provider + model. */
export async function runProviderWizard(prompter: Prompter, deps: WizardDeps): Promise<WizardResult> {
  const providers = topProviders(deps.catalog, deps.topN ?? 6);

  // Screen 1 — where should the model run?
  const choice = await prompter.select<string>('Where should the model run?', [
    { label: 'Local model (on your machine)', value: LOCAL, hint: deps.localModels.length ? `${deps.localModels.length} found` : 'nothing installed yet' },
    ...providers.map((p) => ({ label: p.label, value: p.id, hint: 'via OpenRouter' })),
    { label: 'Enter a provider or model slug myself', value: ENTER_SLUG },
  ]);

  if (choice === LOCAL) return pickLocal(prompter, deps);
  if (choice === ENTER_SLUG) {
    const slug = (await prompter.input('Model slug (e.g. anthropic/claude-3.5-sonnet, or a provider like openai)')).trim();
    // A full `provider/model` slug is a hosted pick; a bare provider name → show its models.
    if (slug.includes('/')) return { kind: 'hosted', provider: 'openrouter', model: slug, providerSlug: slug.split('/')[0] };
    const group = deps.catalog.providers.find((p) => p.id === slug);
    if (group && group.models.length) return pickHostedModel(prompter, group.id, group.models);
    // Unknown provider → let them type the full model slug.
    const model = (await prompter.input(`Model id for "${slug}"`)).trim();
    return { kind: 'hosted', provider: 'openrouter', model: model || slug, providerSlug: slug };
  }

  // A hosted provider was chosen → pick one of its models.
  const group = providers.find((p) => p.id === choice)!;
  return pickHostedModel(prompter, group.id, group.models);
}

async function pickHostedModel(prompter: Prompter, providerSlug: string, models: Catalog['providers'][number]['models']) {
  if (models.length === 0) {
    const model = (await prompter.input(`Enter a ${providerSlug} model id`)).trim();
    return { kind: 'hosted' as const, provider: 'openrouter' as const, model, providerSlug };
  }
  const model = await prompter.select<string>('Choose a model', [
    ...models.slice(0, 12).map((m) => ({ label: m.name, value: m.id, hint: modelHint(m.contextLength, m.promptPricePerM) })),
    { label: 'Enter a model slug myself', value: ENTER_SLUG },
  ]);
  if (model === ENTER_SLUG) {
    const typed = (await prompter.input(`Enter a ${providerSlug} model id`)).trim();
    return { kind: 'hosted' as const, provider: 'openrouter' as const, model: typed, providerSlug };
  }
  return { kind: 'hosted' as const, provider: 'openrouter' as const, model, providerSlug };
}

async function pickLocal(prompter: Prompter, deps: WizardDeps): Promise<WizardResult> {
  const installed = deps.localModels.filter((m) => m.runtime === 'ollama');
  const choices = [
    ...installed.map((m) => ({ label: m.name, value: m.name, hint: 'installed' })),
    { label: 'Browse coding models to pull (Ollama)', value: BROWSE },
    { label: 'Enter a model name to pull', value: ENTER_SLUG },
  ];
  const picked = await prompter.select<string>('Local model', choices);

  if (picked === ENTER_SLUG) {
    const name = (await prompter.input('Ollama model to pull (e.g. qwen2.5-coder:7b)')).trim();
    return { kind: 'local', provider: 'ollama', model: name, providerSlug: 'ollama', needsPull: true };
  }
  if (picked === BROWSE) {
    // Suggest coding models from the catalog, mapped to a likely Ollama tag.
    const coding = deps.catalog.providers
      .flatMap((p) => p.models)
      .filter((m) => /cod(e|er|ing)/i.test(m.id))
      .slice(0, 10);
    if (coding.length === 0) {
      const name = (await prompter.input('Ollama model to pull (e.g. qwen2.5-coder:7b)')).trim();
      return { kind: 'local', provider: 'ollama', model: name, providerSlug: 'ollama', needsPull: true };
    }
    const slug = await prompter.select<string>('Coding model to pull', [
      ...coding.map((m) => ({ label: m.name, value: toOllamaTag(m.id), hint: m.id })),
      { label: 'Enter a model name myself', value: ENTER_SLUG },
    ]);
    if (slug === ENTER_SLUG) {
      const name = (await prompter.input('Ollama model to pull (e.g. qwen2.5-coder:7b)')).trim();
      return { kind: 'local', provider: 'ollama', model: name, providerSlug: 'ollama', needsPull: true };
    }
    return { kind: 'local', provider: 'ollama', model: slug, providerSlug: 'ollama', needsPull: true };
  }
  // An already-installed model — no pull needed.
  return { kind: 'local', provider: 'ollama', model: picked, providerSlug: 'ollama', needsPull: false };
}

/** Best-effort map an OpenRouter slug to a likely Ollama tag (`qwen/qwen-2.5-coder-7b` → `qwen2.5-coder:7b`). */
export function toOllamaTag(slug: string): string {
  const tail = slug.split('/').pop() ?? slug;
  const size = tail.match(/(\d+(?:\.\d+)?)b\b/i);
  const base = tail
    .replace(/-instruct\b/i, '')
    .replace(/(\d+(?:\.\d+)?)b\b/i, '')
    .replace(/[-.]+$/g, '')
    .replace(/\s+/g, '-');
  return size ? `${base}:${size[1]}b` : base;
}

function modelHint(contextLength?: number, pricePerM?: number): string {
  const parts: string[] = [];
  if (contextLength) parts.push(`${Math.round(contextLength / 1000)}k ctx`);
  if (typeof pricePerM === 'number') parts.push(pricePerM === 0 ? 'free' : `$${pricePerM}/M in`);
  return parts.join(' · ');
}
