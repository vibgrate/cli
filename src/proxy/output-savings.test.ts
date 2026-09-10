import * as fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { outputSavingsPath } from '../compress/paths.js';
import { Accum, assignArm, BaselineModel, conversationKey, echoRatio, estimateRequestSavings, inputBucket, modelFamily, OutputSavingsRecorder, parseStratumLabel, registerModelledFactors, SavingsLedger, stratumKey, stratumLabel, MODELLED_REDUCTION } from './output-savings.js';
import { tempEnv } from './test-util.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('stratification + holdout', () => {
  it('buckets inputs and model families', () => {
    expect([1999, 2000, 7999, 8000, 31999, 32000, 127999, 128000].map(inputBucket)).toEqual(['xs', 's', 's', 'm', 'm', 'l', 'l', 'xl']);
    expect(modelFamily('claude-opus-4-1')).toBe('opus');
    expect(modelFamily('gpt-5.1-codex')).toBe('gpt');
    expect(modelFamily('claude-fable-5')).toBe('fable');
    expect(modelFamily('llama-3')).toBe('llama');
    expect(modelFamily('grok-4.6')).toBe('grok');
    expect(modelFamily('o4-mini')).toBe('gpt');
    expect(modelFamily('some-custom')).toBe('other');
    expect(stratumKey({ turnKind: 'new_user_ask', inputTokens: 5000, model: 'claude-sonnet-4-5', hasTools: true })).toBe('sonnet|new_user_ask|s|tools');
    expect(parseStratumLabel(stratumLabel('control', 'a|b|c|d'))).toEqual({ arm: 'control', key: 'a|b|c|d' });
    expect(parseStratumLabel('router:x')).toBeNull();
  });

  it('assigns arms deterministically from the conversation key', () => {
    expect(assignArm('k', 0)).toBe('treatment');
    expect(assignArm('k', 1)).toBe('control');
    const keys = Array.from({ length: 200 }, (_, i) => `conversation-${i}`);
    const first = keys.map((k) => assignArm(k, 0.3));
    const second = keys.map((k) => assignArm(k, 0.3));
    expect(second).toEqual(first);
    const controls = first.filter((a) => a === 'control').length;
    expect(controls).toBeGreaterThan(30);
    expect(controls).toBeLessThan(90);
  });

  it('derives a conversation-stable key from model + first user text (+ Responses identifiers)', () => {
    const a = conversationKey({ model: 'm', messages: [{ role: 'user', content: 'first' }, { role: 'user', content: 'second' }] }, 'anthropic');
    const b = conversationKey({ model: 'm', messages: [{ role: 'user', content: 'first' }, { role: 'user', content: 'third' }] }, 'anthropic');
    expect(a).toBe(b);
    expect(conversationKey({ model: 'm', messages: [{ role: 'user', content: 'other' }] }, 'anthropic')).not.toBe(a);
    const r1 = conversationKey({ model: 'm', input: 'x', conversation: { id: 'conv_1' } }, 'responses');
    const r2 = conversationKey({ model: 'm', input: 'x', conversation: { id: 'conv_2' } }, 'responses');
    expect(r1).not.toBe(r2);
    expect(conversationKey({ model: 'm', input: 'x', conversation: 'auto', metadata: { session_id: 's9' } }, 'responses')).toBe(conversationKey({ model: 'm', input: 'x', metadata: { session_id: 's9' } }, 'responses'));
  });
});

describe('estimator math', () => {
  it('Accum mean/var/merge', () => {
    const a = new Accum();
    [10, 20, 30].forEach((x) => a.add(x));
    expect(a.mean).toBe(20);
    expect(a.var).toBe(100);
    const b = Accum.from({ n: 1, sum: 40, sumsq: 1600 });
    a.merge(b);
    expect(a.n).toBe(4);
    expect(a.mean).toBe(25);
    expect(new Accum().var).toBe(0);
  });

  it('baseline lookup backs off by trimming fields, then global', () => {
    const m = new BaselineModel();
    m.observe('sonnet|new_user_ask|s|tools', 100);
    m.observe('sonnet|new_user_ask|s|tools', 120);
    m.observe('gpt|unknown|xl|notools', 900);
    expect(m.lookup('sonnet|new_user_ask|s|tools').mean).toBe(110);
    expect(m.lookup('sonnet|new_user_ask|s|notools').mean).toBe(110);
    expect(m.lookup('sonnet|mechanical_continuation|m|notools').mean).toBe(110);
    expect(m.lookup('opus|x|y|z').mean).toBeCloseTo((100 + 120 + 900) / 3, 6);
    expect(m.totalSamples).toBe(3);
  });

  it('tier 1 (synthetic control) sums signed deltas and propagates variance', () => {
    const l = new SavingsLedger();
    l.baseline.observe('k', 100);
    l.baseline.observe('k', 100);
    l.record('treatment', 'k', 60);
    l.record('treatment', 'k', 80);
    const e = l.estimateFromBaseline();
    expect(e.kind).toBe('estimated');
    expect(e.nRequests).toBe(2);
    expect(e.tokensSaved).toBe(2 * (100 - 70));
    expect(e.baselineTokens).toBe(200);
    expect(e.pct).toBe(30);
    expect(e.ciLowPct).toBeLessThan(e.pct);
    expect(e.ciHighPct).toBeGreaterThan(e.pct);
    // Chattier-than-baseline turns pull the aggregate down (signed).
    l.record('treatment', 'k', 200);
    expect(l.estimateFromBaseline().tokensSaved).toBeLessThan(60);
  });

  it('tier 2 (holdout) needs both arms and outranks tier 1; tier 3 ships empty', () => {
    const l = new SavingsLedger();
    expect(l.estimateFromHoldout()).toBeNull();
    l.record('control', 'k', 100);
    l.record('control', 'k', 120);
    l.record('treatment', 'k', 70);
    l.record('treatment', 'k', 50);
    const m = l.estimateFromHoldout()!;
    expect(m.kind).toBe('measured');
    expect(m.tokensSaved).toBe(2 * (110 - 60));
    expect(m.pct).toBeCloseTo((100 / 220) * 100, 6);
    expect(l.bestEstimate().kind).toBe('measured');
    expect(MODELLED_REDUCTION.size).toBe(0);
    expect(l.estimateFromModel(3)).toBeNull();
    registerModelledFactors(3, 0.2, 0.4);
    const mod = l.estimateFromModel(3)!;
    expect(mod.kind).toBe('modelled');
    expect(mod.bandIsCi).toBe(false);
    expect(mod.tokensSaved).toBeCloseTo((120 * 0.2) / 0.8, 6);
    expect(() => registerModelledFactors(3, 0.5, 0.4)).toThrow();
    expect(() => registerModelledFactors(3, 0, 0.4)).toThrow();
    MODELLED_REDUCTION.clear();
  });

  it('per-request estimate is clamped, treatment-only; echo ratio measures direct waste', () => {
    const l = new SavingsLedger();
    l.baseline.observe('k', 100);
    expect(estimateRequestSavings(l, ['output_shaper:stratum:k'], 60)).toBe(40);
    expect(estimateRequestSavings(l, ['output_shaper:stratum:k'], 160)).toBe(0);
    expect(estimateRequestSavings(l, ['output_shaper:control:k'], 60)).toBe(0);
    expect(estimateRequestSavings(l, ['other'], 60)).toBe(0);
    const ctx = 'the quick brown fox jumps over the lazy dog again and again today';
    expect(echoRatio('the quick brown fox jumps over the lazy dog', ctx)).toBe(1);
    expect(echoRatio('completely different words here now ok yes no maybe', ctx)).toBe(0);
    expect(echoRatio('short', ctx)).toBe(0);
  });

  it('recorder persists 0600 atomically, flushes every 25, and adopts a changed on-disk baseline', () => {
    const t = tempEnv();
    cleanups.push(t.cleanup);
    const rec = new OutputSavingsRecorder(t.env, { flushEvery: 2 });
    rec.recordFromLabels(['output_shaper:stratum:k'], 50);
    expect(fs.existsSync(outputSavingsPath(t.env))).toBe(false);
    rec.recordFromLabels(['output_shaper:stratum:k'], 70);
    const file = outputSavingsPath(t.env);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
    expect(saved.treatment.k).toEqual({ n: 2, sum: 120, sumsq: 7400 });
    // `vg install <agent> --learn --apply` writes a baseline; the recorder adopts it without restart.
    fs.writeFileSync(file, JSON.stringify({ ...saved, baseline: { strata: { k: { n: 3, sum: 300, sumsq: 30000 } }, glob: { n: 3, sum: 300, sumsq: 30000 } } }));
    expect(rec.reloadBaseline()).toBe(true);
    expect(rec.summary().kind).toBe('estimated');
    expect(rec.summary().tokensSaved).toBe(2 * (100 - 60));
    const stateless = new OutputSavingsRecorder({ ...t.env, VG_OUTPUT_SAVINGS_PATH: `${t.dir}/none.json` }, { stateless: true, flushEvery: 1 });
    stateless.recordFromLabels(['output_shaper:stratum:k'], 1);
    expect(fs.existsSync(`${t.dir}/none.json`)).toBe(false);
  });
});
