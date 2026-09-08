import { describe, expect, it } from 'vitest';
import { countTokens } from '../engine/tokens.js';
import { runRetrieveLoop } from './ccr/handler.js';
import { extractHashes } from './ccr/markers.js';
import { CompressionStore } from './ccr/store.js';
import { RETRIEVE_TOOL_NAME } from './ccr/tool.js';
import { detectFormat, fromOpenAI, toOpenAI } from './format.js';
import { CompressionSession, compressMessages, compressMessagesSync, hasAnalysisIntent, hasStrongErrorIndicators, isReadCommand, looksLikeCodeText, mergeHashes, messagesTokens, resolveOptions, type PipelineDeps } from './pipeline.js';
import { codeFixture, FakeRouter, goldenConversation, jsonArrayFixture, logFixture } from './test-double.js';
import { billsPriorThinkingHeuristic } from './thinking.js';
import { isLosslessResult, type BlockOutcome, type CompressOptions, type CompressResult, type Message } from './types.js';

const ENV = {} as NodeJS.ProcessEnv;

const CL100K = { id: 'cl100k', count: countTokens };

function setup(routerOpts: ConstructorParameters<typeof FakeRouter>[0] = {}): { router: FakeRouter; store: CompressionStore; deps: PipelineDeps } {
  const router = new FakeRouter({ keepItems: 3, ...routerOpts });
  const store = new CompressionStore({ now: () => 1_000, ttlSeconds: 1800 });
  return { router, store, deps: { router, store, env: ENV, now: () => 1_000, tokenizer: CL100K, billsThinking: billsPriorThinkingHeuristic } };
}

function outcome(r: CompressResult, messageIndex: number, blockIndex?: number): BlockOutcome | undefined {
  return r.manifest.blockOutcomes.find((o) => o.messageIndex === messageIndex && o.blockIndex === blockIndex);
}

function toolText(r: CompressResult, i: number): string {
  return (r.messages[i] as { content: Array<{ content: string }> }).content[0].content;
}

const TOKEN: CompressOptions = { mode: 'token', minTokensToCompress: 100, minCharsForBlock: 200 };

describe('resolveOptions', () => {
  it('layers explicit > env > profile', () => {
    const d = resolveOptions({}, ENV);
    expect(d).toMatchObject({ mode: 'cache', profile: 'coding', protectRecent: 3, minTokensToCompress: 500, minCharsForBlock: 200, protectReads: true, crossTurnDedup: true, optimize: true, freezeBlockDecision: true, deadlineMs: 2000 });
    expect(d.toolProfiles.Edit).toEqual({ skipCompression: true });
    expect(d.toolProfiles.Read).toEqual({ losslessOnly: true });
    const e = resolveOptions({ profile: 'aggressive' }, { VG_COMPRESS_MIN_TOKENS: '77' } as NodeJS.ProcessEnv);
    expect(e).toMatchObject({ mode: 'token', minTokensToCompress: 77, compressAssistantText: true, thinkingCompact: true });
    const x = resolveOptions({ mode: 'cache', profile: 'aggressive', minTokensToCompress: 5, protectToolResults: ['Slack'], byteExactTools: ['Danger'], targetRatio: 0.05, lossless: true }, ENV);
    expect(x.mode).toBe('cache');
    expect(x.minTokensToCompress).toBe(5);
    expect(x.toolProfiles.Slack).toEqual({ losslessOnly: true });
    expect(x.toolProfiles.Danger).toEqual({ skipCompression: true });
    expect(x.targetRatio).toBe(0.1);
    expect(x.ccr.injectMarker).toBe(false);
    expect(resolveOptions({}, { VG_COMPRESS: '0' } as NodeJS.ProcessEnv).optimize).toBe(false);
  });
});

describe('heuristics', () => {
  it('error indicators need two distinct keywords after scrubbing zero results', () => {
    expect(hasStrongErrorIndicators('Traceback (most recent call last)\nValueError: bad')).toBe(true);
    expect(hasStrongErrorIndicators('0 errors, 0 failed. Build OK')).toBe(false);
    expect(hasStrongErrorIndicators('grep found error_handler.py')).toBe(false);
  });
  it('analysis intent, code detection and read commands', () => {
    expect(hasAnalysisIntent('Please review this function')).toBe(true);
    expect(hasAnalysisIntent('list the files')).toBe(false);
    expect(looksLikeCodeText(codeFixture())).toBe(true);
    expect(looksLikeCodeText('just a sentence. and another one.')).toBe(false);
    expect(isReadCommand('cat src/a.ts')).toBe(true);
    expect(isReadCommand('cd /repo && sed -n 10,20p a.py')).toBe(true);
    expect(isReadCommand('sudo bash -c "head -20 x"')).toBe(true);
    expect(isReadCommand('cat a > b')).toBe(false);
    expect(isReadCommand('cat package-lock.json')).toBe(false);
    expect(isReadCommand('grep -rn foo src')).toBe(false);
  });
});

describe('golden conversation', () => {
  it('cache mode compresses only the live zone (newest delta)', () => {
    const { deps, store } = setup();
    const prefix = goldenConversation().slice(0, 3);
    const r = compressMessagesSync(prefix, { minTokensToCompress: 100 }, deps);
    expect(r.format).toBe('anthropic');
    expect(r.compressed).toBe(true);
    expect(outcome(r, 2, 0)?.action.kind).toBe('compressed');
    expect(outcome(r, 1, 1)?.action).toEqual({ kind: 'excluded', reason: 'above_live_zone' });
    expect(outcome(r, 0)?.action).toEqual({ kind: 'excluded', reason: 'above_live_zone' });
    expect(mergeHashes(['ABCDEF0123456789ABCDEF01', 'abcdef012345', 'ffffffffffff'])).toEqual(['abcdef0123456789abcdef01', 'ffffffffffff']);
    expect(toolText(r, 2)).toMatch(/<<vg-ccr:[0-9a-f]{12} 37_rows_offloaded>>/);
    expect(r.ccrHashes).toHaveLength(1);
    expect(store.exists(r.ccrHashes[0])).toBe(true);
    expect(r.transformsApplied).toEqual([expect.stringMatching(/^router:smart_crusher:0\.\d\d$/)]);
    expect(r.transformsSummary).toEqual({ 'router:smart_crusher': 1 });

    const full = compressMessagesSync(goldenConversation(), { minTokensToCompress: 100 }, deps);
    // Live zone = after the last assistant message (index 9): 10 (Read result) and 11 (user text).
    expect(full.manifest.latestUserMessageIndex).toBe(11);
    for (const o of full.manifest.blockOutcomes.filter((x) => x.messageIndex <= 9)) expect(o.action).toEqual({ kind: 'excluded', reason: 'above_live_zone' });
    expect(outcome(full, 10, 0)?.action).toEqual({ kind: 'excluded', reason: 'protected_read' });
    expect(outcome(full, 11)?.action).toEqual({ kind: 'excluded', reason: 'protected_role' });
    expect(full.compressed).toBe(false);
    expect(full.messages).toEqual(goldenConversation());
    expect(full.transformsApplied).toEqual(['router:noop']);
  });

  it('token mode compresses every eligible block with the full manifest', () => {
    const { deps, store } = setup();
    const original = goldenConversation();
    const r = compressMessagesSync(original, TOKEN, deps);
    expect(r.compressed).toBe(true);
    expect(r.tokensBefore).toBe(messagesTokens(original, { id: 'cl100k', count: countTokens }));
    expect(r.tokensAfter).toBeLessThan(r.tokensBefore);
    expect(r.tokensSaved).toBe(r.tokensBefore - r.tokensAfter);
    expect(r.compressionRatio).toBeCloseTo(r.tokensSaved / r.tokensBefore, 10);
    expect(r.keptRatio).toBeCloseTo(r.tokensAfter / r.tokensBefore, 10);
    expect(r.manifest).toMatchObject({ messagesTotal: 12, messagesBelowFrozenFloor: 0, latestUserMessageIndex: 11 });
    const kinds = Object.fromEntries(r.manifest.blockOutcomes.map((o) => [`${o.messageIndex}:${o.blockIndex ?? '-'}`, o.action.kind === 'excluded' ? o.action.reason : o.action.kind]));
    expect(kinds).toEqual({
      '0:-': 'protected_role',
      '1:0': 'protected_role',
      '1:1': 'hot_zone_block_type',
      '2:0': 'compressed',
      '3:0': 'protected_role',
      '3:1': 'hot_zone_block_type',
      '4:0': 'compressed',
      '5:0': 'protected_role',
      '5:1': 'hot_zone_block_type',
      '6:0': 'compressed',
      '7:-': 'protected_role',
      '8:-': 'protected_role',
      '9:0': 'hot_zone_block_type',
      '10:0': 'protected_read',
      '11:-': 'protected_role',
    });
    const json = outcome(r, 2, 0)!.action as Extract<BlockOutcome['action'], { kind: 'compressed' }>;
    expect(json.strategy).toBe('smart_crusher');
    expect(json.ccrHashes).toHaveLength(1);
    expect(json.compressedTokens).toBeLessThan(json.originalTokens);
    expect((outcome(r, 4, 0)!.action as { strategy: string }).strategy).toBe('log');
    expect((outcome(r, 6, 0)!.action as { strategy: string; chain: string[] })).toMatchObject({ strategy: 'lossless', chain: ['lossless_search'] });
    expect(toolText(r, 4)).toMatch(/ERROR worker-3 connection refused[\s\S]*\[58 lines omitted\]\nRetrieve original: hash=[0-9a-f]{24} \(\d+ → \d+ tokens, tool=Bash\)$/);
    expect(toolText(r, 6).startsWith('@src/services/billing/handlers/\n')).toBe(true);
    expect(r.ccrHashes).toHaveLength(2);
    expect(r.transformsSummary).toEqual({ 'router:log': 1, 'router:lossless': 1, 'router:smart_crusher': 1 });
    for (const h of r.ccrHashes) expect(store.retrieve(h).found).toBe(true);
    expect(original).toEqual(goldenConversation()); // input never mutated
    expect(r.warnings).toEqual([]);
  });

  it('is deterministic: run twice → deep-equal', async () => {
    const a = setup();
    const b = setup();
    const r1 = await compressMessages(goldenConversation(), TOKEN, a.deps);
    const r2 = await compressMessages(goldenConversation(), TOKEN, b.deps);
    expect(r1).toEqual(r2);
    expect(compressMessagesSync(goldenConversation(), TOKEN, setup().deps)).toEqual(r1);
    expect(a.store.list().map((e) => e.hash)).toEqual(b.store.list().map((e) => e.hash));
  });

  it('round-trips a retrieval through a fake response and the same store', async () => {
    const { deps, store } = setup();
    const r = compressMessagesSync(goldenConversation(), TOKEN, deps);
    const marker = extractHashes(toolText(r, 2))[0];
    expect(marker).toHaveLength(12);
    const fake = { content: [{ type: 'text', text: 'Need the full list.' }, { type: 'tool_use', id: 'tu_r', name: RETRIEVE_TOOL_NAME, input: { hash: marker, grep: 'error' } }], stop_reason: 'tool_use' };
    const seen: Message[][] = [];
    const loop = await runRetrieveLoop(fake, r.messages, {
      store,
      format: 'anthropic',
      call: async (msgs) => {
        seen.push(msgs);
        return { content: [{ type: 'text', text: 'service-18 in ap-south-1 is unhealthy.' }], stop_reason: 'end_turn' };
      },
    });
    expect(loop.status).toBe('resolved');
    expect(loop.rounds).toBe(1);
    const result = JSON.parse((seen[0][13] as { content: Array<{ content: string }> }).content[0].content) as Record<string, unknown>;
    expect(result.view).toBe('grep');
    expect(result.original_content).toMatch(/"status": "error"/);
    let fullConvo: Message[] = [];
    await runRetrieveLoop({ content: [{ type: 'tool_use', id: 'x', name: RETRIEVE_TOOL_NAME, input: { hash: marker } }] }, r.messages, {
      store,
      format: 'anthropic',
      call: async (m) => {
        fullConvo = m;
        return { content: [] };
      },
    });
    const full = JSON.parse((fullConvo[13] as { content: Array<{ content: string }> }).content[0].content) as Record<string, unknown>;
    expect(full.original_content).toBe(jsonArrayFixture());
  });

  it('format round-trip: anthropic → openai → anthropic is the identity', () => {
    const msgs = goldenConversation();
    expect(fromOpenAI(toOpenAI(msgs, 'anthropic'), 'anthropic', msgs)).toEqual(msgs);
    const { deps } = setup();
    const oai = toOpenAI(msgs, 'anthropic');
    const r = compressMessagesSync(oai, TOKEN, deps);
    expect(r.format).toBe('openai');
    expect(detectFormat(r.messages)).toBe('openai');
    expect((r.messages[2] as { content: string }).content).toMatch(/rows_offloaded/);
    const back = fromOpenAI(r.messages, 'anthropic', msgs);
    expect((back[2] as { content: Array<{ content: string }> }).content[0].content).toMatch(/rows_offloaded/);
    expect(back[1]).toEqual(msgs[1]);
  });
});

describe('protections and gates', () => {
  const base = (): Message[] => goldenConversation().slice(0, 3);

  it('frozen prefix, cache_control, retrieve results, errors, already-compressed, thresholds', () => {
    const { deps } = setup();
    const frozen = compressMessagesSync(goldenConversation(), { ...TOKEN, frozenMessageCount: 3 }, deps);
    expect(frozen.manifest.messagesBelowFrozenFloor).toBe(3);
    expect(outcome(frozen, 2, 0)?.action).toEqual({ kind: 'excluded', reason: 'below_frozen_floor' });
    expect(outcome(frozen, 4, 0)?.action.kind).toBe('compressed');

    const cc = base();
    (cc[2] as { content: Array<Record<string, unknown>> }).content[0].cache_control = { type: 'ephemeral' };
    expect(outcome(compressMessagesSync(cc, TOKEN, deps), 2, 0)?.action).toEqual({ kind: 'excluded', reason: 'cache_control' });

    const rr = base();
    (rr[1] as { content: Array<Record<string, unknown>> }).content[1].name = RETRIEVE_TOOL_NAME;
    expect(outcome(compressMessagesSync(rr, TOKEN, deps), 2, 0)?.action).toEqual({ kind: 'excluded', reason: 'retrieve_result' });

    const err = base();
    (err[2] as { content: Array<Record<string, unknown>> }).content[0].is_error = true;
    expect(outcome(compressMessagesSync(err, TOKEN, deps), 2, 0)?.action).toEqual({ kind: 'excluded', reason: 'protected_error_output' });
    const err2 = base();
    (err2[2] as { content: Array<Record<string, unknown>> }).content[0].content = `Traceback (most recent call last)\nException: boom\n${logFixture(30)}`;
    expect(outcome(compressMessagesSync(err2, TOKEN, deps), 2, 0)?.action).toEqual({ kind: 'excluded', reason: 'protected_error_output' });

    const already = base();
    (already[2] as { content: Array<Record<string, unknown>> }).content[0].content = `${jsonArrayFixture(10)}\nRetrieve original: hash=abcdef0123456789abcdef01 (1 → 1 tokens)`;
    expect(outcome(compressMessagesSync(already, TOKEN, deps), 2, 0)?.action).toEqual({ kind: 'excluded', reason: 'already_compressed' });

    const small = base();
    (small[2] as { content: Array<Record<string, unknown>> }).content[0].content = '[1,2,3]';
    expect(outcome(compressMessagesSync(small, TOKEN, deps), 2, 0)?.action).toEqual({ kind: 'below_threshold', bytes: 7, threshold: 200 });
    const belowTokens = compressMessagesSync(base(), { mode: 'token', minTokensToCompress: 100_000 }, deps);
    expect(outcome(belowTokens, 2, 0)?.action).toMatchObject({ kind: 'below_threshold', threshold: 100_000 });
  });

  it('tool profiles: byte-exact and lossless-only; read protection releases structured content', () => {
    const { deps } = setup();
    expect(outcome(compressMessagesSync(base(), { ...TOKEN, byteExactTools: ['list_services'] }, deps), 2, 0)?.action).toEqual({ kind: 'excluded', reason: 'protected_tool' });
    const lossless = compressMessagesSync(base(), { ...TOKEN, protectToolResults: ['list_services'] }, deps);
    expect((outcome(lossless, 2, 0)?.action as { strategy: string }).strategy).toBe('lossless');
    expect(toolText(lossless, 2)).not.toContain('<<vg-ccr');
    // A Read of a JSON array is releasable (lossless only under the coding profile).
    const read = base();
    (read[1] as { content: Array<Record<string, unknown>> }).content[1].name = 'Read';
    (read[1] as { content: Array<Record<string, unknown>> }).content[1].input = { file_path: 'services.json' };
    const rr = compressMessagesSync(read, TOKEN, deps);
    expect((outcome(rr, 2, 0)?.action as { strategy: string }).strategy).toBe('lossless');
    const bashCat = base();
    (bashCat[1] as { content: Array<Record<string, unknown>> }).content[1].name = 'Bash';
    (bashCat[1] as { content: Array<Record<string, unknown>> }).content[1].input = { command: 'cat src/a.ts' };
    (bashCat[2] as { content: Array<Record<string, unknown>> }).content[0].content = `${codeFixture()}\n${codeFixture()}`;
    expect(outcome(compressMessagesSync(bashCat, TOKEN, deps), 2, 0)?.action).toEqual({ kind: 'excluded', reason: 'protected_read' });
    expect(outcome(compressMessagesSync(read, { ...TOKEN, protectReads: false }, deps), 2, 0)?.action.kind).toBe('compressed');
  });

  it('role gating, recent-code and analysis-context protection', () => {
    const { deps } = setup({ textKeep: 1 });
    const msgs: Message[] = [
      { role: 'system', content: 'Sentence one is here. Sentence two is here. Sentence three is here. '.repeat(8) },
      { role: 'user', content: 'Sentence one is here. Sentence two is here. Sentence three is here. '.repeat(8) },
      { role: 'assistant', content: 'Sentence one is here. Sentence two is here. Sentence three is here. '.repeat(8) },
      { role: 'user', content: 'go' },
    ];
    const r = compressMessagesSync(msgs, TOKEN, deps);
    expect(r.manifest.blockOutcomes.map((o) => (o.action as { reason?: string }).reason)).toEqual(['protected_role', 'protected_role', 'protected_role', 'protected_role']);
    const open = compressMessagesSync(msgs, { ...TOKEN, compressSystemMessages: true, compressUserMessages: true, compressAssistantText: true, protectRecent: 0 }, deps);
    expect(open.manifest.blockOutcomes.slice(0, 3).map((o) => o.action.kind)).toEqual(['compressed', 'compressed', 'compressed']);

    const code = base();
    (code[2] as { content: Array<Record<string, unknown>> }).content[0].content = codeFixture();
    expect(outcome(compressMessagesSync(code, { ...TOKEN, protectRecent: 3 }, deps), 2, 0)?.action).toEqual({ kind: 'excluded', reason: 'protected_recent_code' });
    const analysis = [...code, { role: 'user', content: 'Please review this code for bugs' }];
    expect(outcome(compressMessagesSync(analysis, { ...TOKEN, protectRecent: 0 }, deps), 2, 0)?.action).toEqual({ kind: 'excluded', reason: 'protected_analysis_context' });
    expect(outcome(compressMessagesSync(analysis, { ...TOKEN, protectRecent: 0, protectAnalysisContext: false }, deps), 2, 0)?.action.kind).toBe('no_compression');
  });

  it('biases scale the keep budget (options and hooks) and the profile bias applies', () => {
    const { deps } = setup();
    const plain = toolText(compressMessagesSync(base(), TOKEN, deps), 2);
    const biased = toolText(compressMessagesSync(base(), { ...TOKEN, biases: { 2: 3 } }, deps), 2);
    expect((biased.match(/"id":/g) ?? []).length).toBe(9);
    expect((plain.match(/"id":/g) ?? []).length).toBe(3);
    const hooked = toolText(compressMessagesSync(base(), { ...TOKEN, hooks: { computeBiases: () => ({ 2: 2 }) } }, deps), 2);
    expect((hooked.match(/"id":/g) ?? []).length).toBe(6);
  });
});

describe('lossless results are not mistaken for unrecoverable ones', () => {
  it('classifies a chain by its leading step', () => {
    // A lossless step leads the chain and the compressor that produced it
    // follows, so `['lossless_json','smart_crusher']` is a csv-schema table with
    // every row intact — not a sample.
    expect(isLosslessResult(['lossless_json', 'smart_crusher'], 'smart_crusher')).toBe(true);
    expect(isLosslessResult(['lossless_search'], 'lossless')).toBe(true);
    expect(isLosslessResult([], 'lossless')).toBe(true);
    expect(isLosslessResult(['smart_crusher'], 'smart_crusher')).toBe(false);
    expect(isLosslessResult(['html', 'text'], 'html')).toBe(false);
    expect(isLosslessResult([], 'passthrough')).toBe(false);
  });

  it('keeps a lossless compaction that carries no marker', () => {
    // Judging that chain lossy would reject it as unrecoverable — it has no
    // marker precisely because nothing was dropped — so the commonest payload of
    // all, a large uniform JSON array, would stop compressing the moment
    // retrieval markers were wanted, which is the default.
    const router = new FakeRouter({ losslessTable: true });
    const store = new CompressionStore({ now: () => 1_000 });
    const deps: PipelineDeps = { router, store, env: ENV, now: () => 1_000, tokenizer: CL100K };
    const r = compressMessagesSync(goldenConversation().slice(0, 3), TOKEN, deps);
    const outcomeJson = outcome(r, 2, 0)!.action;
    expect(outcomeJson.kind).toBe('compressed');
    expect((outcomeJson as Extract<BlockOutcome['action'], { kind: 'compressed' }>).chain).toEqual(['lossless_json', 'smart_crusher']);
    expect(r.compressed).toBe(true);
    expect(r.tokensAfter).toBeLessThan(r.tokensBefore);
    // nothing was dropped, so nothing was stored — and that is not a reason to refuse it
    expect(r.ccrHashes).toEqual([]);
    expect(store.stats().entries).toBe(0);
    expect(toolText(r, 2)).not.toContain('<<vg-ccr:');
  });
});

describe('fail-open', () => {
  it('passthrough when optimize is off or the input is empty', () => {
    const { deps } = setup();
    const msgs = goldenConversation();
    const off = compressMessagesSync(msgs, { ...TOKEN, optimize: false }, deps);
    expect(off.messages).toBe(msgs);
    expect(off.transformsApplied).toEqual(['passthrough:optimize_off']);
    expect(compressMessagesSync([], TOKEN, deps).tokensBefore).toBe(0);
  });

  it('router errors and empty output are recorded, bytes forwarded', () => {
    const boom = compressMessagesSync(goldenConversation(), TOKEN, setup({ throwOn: true }).deps);
    expect(boom.compressed).toBe(false);
    expect(outcome(boom, 2, 0)?.action).toEqual({ kind: 'compressor_error', strategy: 'passthrough', error: 'boom' });
    expect(boom.messages).toEqual(goldenConversation());
    const empty = compressMessagesSync(goldenConversation(), TOKEN, setup({ emptyOn: true }).deps);
    expect(outcome(empty, 2, 0)?.action).toEqual({ kind: 'compressor_error', strategy: 'text', error: 'empty output for non-empty input' });
  });

  it('larger output is rejected per block (rejected_not_smaller) and the bytes are forwarded', () => {
    const r = compressMessagesSync(goldenConversation(), { ...TOKEN, crossTurnDedup: false }, setup({ inflate: true }).deps);
    expect(r.transformsApplied).toEqual(['router:noop']);
    expect(r.messages).toEqual(goldenConversation());
    expect(r.compressed).toBe(false);
    expect(outcome(r, 2, 0)?.action).toMatchObject({ kind: 'rejected_not_smaller', strategy: 'text' });
  });

  it('reversibility: lossy tool output needs a marker when CCR is wanted; unmarked lossy is allowed only with CCR off', () => {
    const { deps } = setup();
    const off = compressMessagesSync(goldenConversation().slice(0, 3), { ...TOKEN, ccr: { enabled: false } }, deps);
    expect(outcome(off, 2, 0)?.action).toMatchObject({ kind: 'compressed', strategy: 'smart_crusher', ccrHashes: [] });
    expect(toolText(off, 2)).not.toContain('<<vg-ccr');
    const noStore = compressMessagesSync(goldenConversation().slice(0, 3), TOKEN, { ...deps, store: null });
    expect(outcome(noStore, 2, 0)?.action).toEqual({ kind: 'rejected_unrecoverable', strategy: 'smart_crusher' });
    expect(noStore.compressed).toBe(false);
  });

  it('no router → no compression, still a full manifest', () => {
    const r = compressMessagesSync(goldenConversation(), TOKEN, { store: null, env: ENV });
    expect(r.compressed).toBe(false);
    expect(outcome(r, 2, 0)?.action).toEqual({ kind: 'no_compression', contentType: 'plain_text' });
    expect(r.manifest.blockOutcomes).toHaveLength(15);
  });

  it('deadline overrun forwards the original', () => {
    let t = 0;
    const deps = { ...setup().deps, now: () => (t += 50) };
    const r = compressMessagesSync(goldenConversation(), TOKEN, { ...deps, env: { VG_COMPRESS_DEADLINE_MS: '10' } as NodeJS.ProcessEnv });
    expect(r.transformsApplied).toEqual(['deadline:reverted']);
    expect(r.messages).toEqual(goldenConversation());
    expect(r.warnings[0]).toMatch(/deadline/);
  });

  it('hook failures never break the request', async () => {
    const { deps } = setup();
    const r = await compressMessages(goldenConversation(), { ...TOKEN, hooks: { preCompress: () => { throw new Error('pre'); }, postCompress: () => { throw new Error('post'); } } }, deps);
    expect(r.compressed).toBe(true);
    expect(r.warnings).toEqual(['hook:preCompress threw: pre', 'hook:postCompress threw: post']);
  });
});

describe('wiring', () => {
  it('hooks shape the input and observe the outcome', async () => {
    const { deps } = setup();
    const events: unknown[] = [];
    const r = await compressMessages(goldenConversation(), { ...TOKEN, model: 'claude-x', hooks: { preCompress: (m) => m.slice(0, 3), postCompress: (e) => void events.push(e) } }, deps);
    expect(r.messages).toHaveLength(3);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tokensSaved: r.tokensSaved, model: 'claude-x', provider: 'anthropic', userQuery: 'Check the service inventory and tell me which region is unhealthy.' });
  });

  it('read lifecycle replaces stale reads before compression', () => {
    const { deps, store } = setup();
    const msgs: Message[] = [
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: codeFixture() }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'a.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] },
      { role: 'user', content: 'thanks' },
    ];
    const r = compressMessagesSync(msgs, TOKEN, deps);
    expect(r.transformsApplied).toEqual(['read_lifecycle:stale:a.ts']);
    expect(toolText(r, 2)).toMatch(/^\[file a\.ts read here; superseded by an edit at message #3\. Re-read if needed\.\]\nRetrieve original: hash=/);
    expect(r.ccrHashes).toHaveLength(1);
    expect(store.retrieve(r.ccrHashes[0]).content).toBe(codeFixture());
    expect(r.compressed).toBe(true);
    expect(outcome(r, 2, 0)?.action).toEqual({ kind: 'excluded', reason: 'already_compressed' });
    expect(compressMessagesSync(msgs, { ...TOKEN, readLifecycle: { enabled: false } }, deps).transformsApplied).toEqual(['router:noop']);
  });

  it('cross-turn dedup folds a repeated tool result into a pointer', () => {
    const { deps } = setup();
    const msgs: Message[] = [
      { role: 'user', content: 'show logs twice' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'tail x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: codeFixture() }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'tail x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: codeFixture() }] },
      { role: 'user', content: 'ok' },
    ];
    const r = compressMessagesSync(msgs, { ...TOKEN, protectRecent: 0 }, deps);
    expect(toolText(r, 2)).toBe(codeFixture());
    expect(toolText(r, 4)).toMatch(/^\[duplicate of tool result #2 — \d+ tokens omitted\]$/);
    expect(r.transformsApplied).toEqual(['dedup:verbatim:2']);
    expect(outcome(r, 4, 0)?.action).toMatchObject({ kind: 'compressed', strategy: 'lossless', chain: ['dedup_verbatim'] });
    expect(compressMessagesSync(msgs, { ...TOKEN, protectRecent: 0, crossTurnDedup: false }, deps).compressed).toBe(false);
  });

  it('thinking compaction runs only on models that bill prior reasoning', () => {
    const { deps } = setup({ textKeep: 1 });
    const long = 'First thought is long enough. Second thought continues here. Third thought concludes the reasoning. '.repeat(3);
    const msgs: Message[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: long, signature: 's' }, { type: 'text', text: 'a' }] },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: long, signature: 's2' }, { type: 'text', text: 'b' }] },
      { role: 'user', content: 'q3' },
    ];
    const r = compressMessagesSync(msgs, { ...TOKEN, model: 'claude-opus-4-6', thinkingCompact: true }, deps);
    expect(r.transformsApplied).toEqual(['thinking:compacted:1']);
    expect((r.messages[1] as { content: Array<{ type: string; text?: string }> }).content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/^\[prior reasoning, compressed\] First thought/) });
    expect((r.messages[3] as { content: Array<{ type: string }> }).content[0].type).toBe('thinking');
    const old = compressMessagesSync(msgs, { ...TOKEN, model: 'claude-sonnet-4-5', thinkingCompact: true }, deps);
    expect(old.transformsApplied).toEqual(['router:noop']);
  });

  it('cache aligner surfaces volatile-prefix warnings without rewriting', () => {
    const { deps } = setup();
    const msgs: Message[] = [{ role: 'system', content: 'Session 123e4567-e89b-12d3-a456-426614174000 at 2026-09-08T04:30:00Z' }, ...goldenConversation().slice(0, 3)];
    const r = compressMessagesSync(msgs, TOKEN, deps);
    expect(r.warnings).toEqual([expect.stringMatching(/cache_aligner: volatile content in the system prompt \(iso8601=1, uuid=1\)/)]);
    expect(r.messages[0]).toEqual(msgs[0]);
    expect(r.markersInserted).toEqual([expect.stringMatching(/^stable_prefix_hash:/)]);
  });

  it('CompressionSession freezes verdicts across turns and tracks hashes', async () => {
    const { deps, router } = setup();
    const session = new CompressionSession({ id: 's1', now: () => 1_000 });
    const t1 = await session.compress(goldenConversation().slice(0, 3), TOKEN, deps);
    const callsAfterFirst = router.calls;
    const t2 = await session.compress([...goldenConversation().slice(0, 3), { role: 'assistant', content: 'noted' }, { role: 'user', content: 'and?' }], { ...TOKEN, protectRecent: 0 }, deps);
    expect(router.calls).toBe(callsAfterFirst); // replayed from the frozen verdict
    expect(toolText(t2, 2)).toBe(toolText(t1, 2));
    expect(session.turn).toBe(2);
    expect(session.stats()).toMatchObject({ id: 's1', requests: 2, frozenVerdicts: 1, trackedHashes: 1 });
    expect(session.tracker.proactiveHashes('which service has an error status?')).toEqual(t1.ccrHashes);
    session.reset();
    expect(session.stats()).toMatchObject({ requests: 0, frozenVerdicts: 0, trackedHashes: 0 });
    const noFreeze = new CompressionSession({ now: () => 1_000 });
    noFreeze.compressSync(goldenConversation().slice(0, 3), TOKEN, { ...deps, env: { VG_COMPRESS_FREEZE_BLOCK_DECISION: '0' } as NodeJS.ProcessEnv });
    expect(noFreeze.verdicts.size).toBe(0);
  });

  it('read maturation holds then matures inside a session', () => {
    const { deps } = setup();
    const env = { VG_COMPRESS_READ_MATURATION: '1', VG_COMPRESS_READ_MATURATION_QUIESCE_TURNS: '1', VG_COMPRESS_READ_MATURATION_MIN_SIZE_BYTES: '100' } as NodeJS.ProcessEnv;
    const session = new CompressionSession({ now: () => 1_000 });
    const start: Message[] = [{ role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.ts' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: codeFixture() }] }];
    const first = session.compressSync(start, TOKEN, { ...deps, env });
    expect(first.markersInserted).toContain('read_hold:2');
    expect(toolText(first, 2)).toBe(codeFixture());
    const later = session.compressSync([...start, { role: 'assistant', content: 'done' }, { role: 'user', content: 'next' }], TOKEN, { ...deps, env });
    expect(later.transformsApplied).toEqual(['read_maturation:matured:a.ts']);
    expect(toolText(later, 2)).toMatch(/^\[file a\.ts read here; compressed after use\. Re-read if needed\.\]/);
  });
});
