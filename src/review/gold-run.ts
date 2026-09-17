/**
 * In-process Review gold runner.
 *
 * Loads the shared cli-benchmark review-gold fixtures and calls
 * {@link proposeFindingFix} (the VG Code `runAgent` adapter). There is no
 * second loop. Scripted / mock providers keep this offline; `--live` is opt-in
 * for happy-path fixtures that already have a real Relay or Code Mode.
 *
 * Not a shipped CLI command — invoked by the review-gold tests and by
 * `cli-benchmark review-gold`. `--live --model` applies only to happy-path
 * fixtures; every other family keeps its fixture model id.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureGraph } from '../code/graph-fixture.js';
import { MockProvider, ScriptedProvider } from '../code/providers.js';
import type { CodeFs } from '../code/session.js';
import type { Provider, ToolCall } from '../code/types.js';
import { proposeFindingFix, type ReviewProposeResult } from './propose.js';
import {
  CAPSULE_SCHEMA,
  type AnalysisCapsule,
  type CapsuleEvidence,
  type CapsulePolicyFact,
  type ReviewFinding,
} from './schemas.js';

export interface ReviewGoldFixtureFile {
  id: string;
  family: string;
  title: string;
  modelId: string;
  loop: boolean;
  apply?: boolean;
  consent?: boolean;
  currentRef: string;
  policySnippet: string;
  files: Record<string, string>;
  finding: Partial<ReviewFinding>;
  capsulePolicies: CapsulePolicyFact[];
  capsuleEvidence: CapsuleEvidence[];
  script:
    | { kind: 'none' }
    | { kind: 'one-shot-text'; text: string }
    | { kind: 'tool-turns'; turns: Array<{ toolCalls?: Array<{ id?: string; name: string; args: Record<string, unknown> }>; text?: string }> }
    | { kind: 'fallback-chain' };
  expected: {
    ok: boolean;
    stopReason: string;
    applied: boolean;
    hasPatch: boolean;
    proposedDiffIncludes?: string;
    errorMatches?: string;
    fileUnchanged?: string;
  };
}

export interface ReviewGoldRunRow {
  taskId: string;
  family: string;
  result: ReviewProposeResult;
  filesAfter: Record<string, string | null>;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Shared fixture JSON — lives next to this file so the public CLI replica can run the gold. */
export function defaultReviewGoldFixturesPath(): string {
  const candidates = [
    path.join(HERE, 'gold-fixtures.json'),
    path.resolve(HERE, '../../../cli-benchmark/src/agent-eval/review-gold/fixtures.json'),
    path.resolve(process.cwd(), 'packages/cli-benchmark/src/agent-eval/review-gold/fixtures.json'),
    path.resolve(process.cwd(), 'packages/vibgrate-cli-public/src/review/gold-fixtures.json'),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return candidates[0];
}

export function loadReviewGoldFixtureFile(file = defaultReviewGoldFixturesPath()): ReviewGoldFixtureFile[] {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as ReviewGoldFixtureFile[];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`review-gold fixtures empty or missing: ${file}`);
  }
  return raw;
}

/** Minimal capsule / finding builders — do not import test-fixtures from this file. */
function goldCapsule(policies: CapsulePolicyFact[], evidence: CapsuleEvidence[]): AnalysisCapsule {
  return {
    schema_version: CAPSULE_SCHEMA,
    identity: {
      repo_pseudonym: 'sha256:review-gold',
      language: 'typescript',
      graph_schema: 'vg-graph/1.1',
      analyzer_versions: { graph: '1', scanners: '1' },
      profile: 'interactive-narrow',
    },
    change: {
      base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
      dirty: false,
      dirty_tree_hash: null,
      symbols: [],
      ops: [],
      added_edges: [],
      removed_edges: [],
      contract_changes: [],
    },
    roles: [],
    areas: [],
    patterns: {
      observed_dominant_pattern: 'layered',
      declared_target_pattern: 'layered',
      approved_exceptions: [],
      legacy_pattern: null,
      unknown: false,
    },
    paths: [],
    security: [],
    policies,
    verification: [],
    evidence,
  };
}

function goldFinding(partial: Partial<ReviewFinding>): ReviewFinding {
  return {
    id: 'arch-01',
    kind: 'boundary_bypass',
    severity: 'high',
    confidence: 0.95,
    claim: 'scanDir uses a zero timeout.',
    evidence_ids: ['src:scan'],
    target_alignment: 'regression',
    remediation: 'Raise the timeout through the application service.',
    paths: ['src/scan.ts'],
    source: 'scanner',
    ...partial,
  };
}

function memFs(seed: Record<string, string> = {}): CodeFs & { files: Record<string, string | null> } {
  const files: Record<string, string | null> = { ...seed };
  return {
    files,
    read: (f) => (f in files ? files[f] : null),
    write: (f, c) => {
      files[f] = c;
    },
    remove: (f) => {
      files[f] = null;
    },
    appendAudit: () => undefined,
  };
}

const tc = (name: string, args: Record<string, unknown>, id = 'c'): ToolCall => ({
  id,
  name,
  arguments: args,
});

function providersFor(fixture: ReviewGoldFixtureFile): Provider[] | undefined {
  const script = fixture.script;
  if (script.kind === 'none') return undefined;
  if (script.kind === 'one-shot-text') {
    return [new MockProvider('hosted-coder', script.text)];
  }
  if (script.kind === 'tool-turns') {
    const turns = script.turns.map((turn) => ({
      text: turn.text,
      toolCalls: turn.toolCalls?.map((c) => tc(c.name, c.args, c.id ?? 'c')),
    }));
    return [new ScriptedProvider('forge-pack', turns)];
  }
  const relay: Provider = {
    id: 'vibgrate-relay',
    label: 'Vibgrate Relay',
    local: false,
    model: 'hosted-coder',
    chat: async () => {
      throw new Error('ECONNRESET');
    },
  };
  const local = new ScriptedProvider('local-coder', [
    {
      toolCalls: [
        tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5;' }, 'e1'),
      ],
    },
    { toolCalls: [tc('finish', { summary: 'answered on the fallback' }, 'f1')] },
  ]);
  return [relay, local];
}

/**
 * CLI `--model` / `--live` only swap the backend on happy-path fixtures.
 * Refuse / plan / invalid-model / default-branch keep their fixture model id
 * and scripted providers — a global override would call a real backend on
 * `mystery` and miss the invalid-model contract.
 */
export function isLiveHappyPath(
  fixture: Pick<ReviewGoldFixtureFile, 'family'>,
  opts: { live?: boolean } = {},
): boolean {
  return opts.live === true && fixture.family === 'happy-path';
}

export function reviewGoldResolvedModelId(
  fixture: Pick<ReviewGoldFixtureFile, 'family' | 'modelId'>,
  opts: { live?: boolean; modelId?: string } = {},
): string {
  return isLiveHappyPath(fixture, opts) && opts.modelId ? opts.modelId : fixture.modelId;
}

export async function runReviewGoldFixture(
  fixture: ReviewGoldFixtureFile,
  opts: { live?: boolean; modelId?: string; providers?: Provider[] } = {},
): Promise<ReviewGoldRunRow> {
  const fsImpl = memFs({ ...fixture.files });
  const liveHappy = isLiveHappyPath(fixture, opts);
  const providers = opts.providers ?? (liveHappy ? undefined : providersFor(fixture));
  const result = await proposeFindingFix({
    capsule: goldCapsule(fixture.capsulePolicies ?? [], fixture.capsuleEvidence ?? []),
    finding: goldFinding(fixture.finding),
    policySnippet: fixture.policySnippet,
    modelId: reviewGoldResolvedModelId(fixture, opts),
    root: '/repo',
    graph: fixtureGraph(),
    fsImpl,
    currentRef: fixture.currentRef,
    apply: fixture.apply === true,
    consent: fixture.consent === true,
    loop: fixture.loop,
    providers,
    noCheckpoint: true,
    correlationId: `rp-gold-${fixture.id}`,
  });
  return { taskId: fixture.id, family: fixture.family, result, filesAfter: { ...fsImpl.files } };
}

/** Run every fixture. `--live` uses real providers on happy-path only. */
export async function runReviewGoldFixtures(
  opts: { fixturesPath?: string; live?: boolean; modelId?: string; ids?: string[] } = {},
): Promise<ReviewGoldRunRow[]> {
  const all = loadReviewGoldFixtureFile(opts.fixturesPath);
  const selected = opts.ids?.length ? all.filter((f) => opts.ids!.includes(f.id)) : all;
  const rows: ReviewGoldRunRow[] = [];
  for (const fixture of selected) {
    rows.push(await runReviewGoldFixture(fixture, { live: opts.live, modelId: opts.modelId }));
  }
  return rows;
}

function asCliJson(rows: ReviewGoldRunRow[]) {
  return rows.map((row) => ({
    taskId: row.taskId,
    family: row.family,
    ok: row.result.ok,
    stopReason: row.result.stopReason,
    applied: row.result.applied,
    hasPatch: row.result.patch !== null,
    proposedDiff: row.result.proposedDiff,
    error: row.result.error,
    correlationId: row.result.correlationId,
    steps: row.result.steps,
    provider: row.result.provider.id,
    model: row.result.provider.model,
    fellBack: row.result.provider.fellBack,
    promptTokens: row.result.usage?.promptTokens,
    completionTokens: row.result.usage?.completionTokens,
    tokens: row.result.usage
      ? row.result.usage.promptTokens + row.result.usage.completionTokens
      : undefined,
    filesAfter: row.filesAfter,
  }));
}

const isMain = Boolean(process.argv[1] && path.basename(process.argv[1]).startsWith('gold-run'));
if (isMain) {
  const live = process.argv.includes('--live');
  const jsonAt = process.argv.indexOf('--json');
  const fixturesAt = process.argv.indexOf('--fixtures');
  const modelAt = process.argv.indexOf('--model');
  runReviewGoldFixtures({
    live,
    fixturesPath: fixturesAt >= 0 ? process.argv[fixturesAt + 1] : undefined,
    modelId: modelAt >= 0 ? process.argv[modelAt + 1] : undefined,
  })
    .then((rows) => {
      const payload = { track: 'review-gold', live, results: asCliJson(rows) };
      const text = JSON.stringify(payload, null, 2);
      if (jsonAt >= 0 && process.argv[jsonAt + 1]) fs.writeFileSync(process.argv[jsonAt + 1], text);
      else process.stdout.write(text + '\n');
    })
    .catch((e) => {
      process.stderr.write(`review-gold: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    });
}
