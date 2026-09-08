import { env as knobs } from '../compress/config.js';
import { analyze, renderAnalyzerPrompt } from './analyzer.js';
import { runCliAnalyzer } from './cli-analyzer.js';
import { parseDuration, scanSessions } from './scan.js';
import { extractLearnBlock, renderLearnBlock, resolveLearnTarget, writeLearnBlock } from './writer.js';
import { learnVerbosity, saveVerbosityProfile } from './verbosity.js';
import { recordLearnRun } from './state.js';
import { AGENT_IDS, isAgentId, type Digest, type VerbosityProfile } from './types.js';
import { projectKey } from '../memory/project.js';
import { readTextTolerant } from './shared.js';
import { usageError } from '../util/exit.js';

/**
 * The engine behind `vg install <agent> --learn`.
 *
 * It reads the coding-agent session logs already on this machine, finds what
 * actually wasted tokens (loops, repeatedly failing commands, paths that do not
 * exist, user corrections), and renders those as guardrails for the assistant's
 * own instructions file. Nothing is written unless `apply` is set, and the block
 * is delimited so a re-run replaces it rather than appending forever.
 *
 * Lives in `src/learn/` rather than in a command file because `vg install` owns
 * the outcome ("agent config written") and no verb of its own is warranted
 * (FEATURE-DESIGN-PRINCIPLES P1).
 */
export interface LearnOptions {
  /** Assistant ids named on the install command; empty means every known agent. */
  assistants: readonly string[];
  root: string;
  apply: boolean;
  since: string;
  minEvidence?: string;
  target?: string;
  allProjects: boolean;
  now?: number;
  env?: NodeJS.ProcessEnv;
}

export interface LearnResult {
  target: string;
  applied: boolean;
  changed: boolean;
  created: boolean;
  sessions: number;
  agents: string[];
  since: number;
  project: string | null;
  analyzer?: string;
  analyzerError: string | null;
  scanErrors: string[];
  digest: Digest;
  rules: Digest['rules'];
  block: string;
  diff: string;
  verbosity: VerbosityProfile | null;
  verbosityFile: string | null;
}

/**
 * Assistant ids (what `vg install` takes) mapped onto session-log agent ids
 * (what the scanners know). An assistant with no known session format simply
 * contributes nothing to the filter, so naming it never narrows the scan to
 * zero by accident.
 */
export function sessionAgentsFor(assistants: readonly string[]): string[] {
  const mapped = assistants
    .map((id) => ASSISTANT_TO_SESSION_AGENT[id] ?? id)
    .filter((id): id is string => isAgentId(id));
  return mapped.length ? [...new Set(mapped)].sort() : [...AGENT_IDS];
}

const ASSISTANT_TO_SESSION_AGENT: Readonly<Record<string, string>> = {
  vscode: 'claude',
  factory: 'droid',
};

export async function learnFromSessions(opts: LearnOptions): Promise<LearnResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const agents = sessionAgentsFor(opts.assistants);
  const sinceMs = parseSince(opts.since, now);
  const project = opts.allProjects ? undefined : opts.root;
  const minEvidence = Math.max(1, Number(opts.minEvidence) || 2);

  const scanErrors: string[] = [];
  const sessions = scanSessions({
    agents,
    sinceMs,
    project,
    now,
    env,
    onError: (agent, e) => scanErrors.push(`${agent}: ${e instanceof Error ? e.message : String(e)}`),
  });
  const target = resolveLearnTarget(opts.target, project ?? opts.root, env);
  const agentsSeen = [...new Set(sessions.map((s) => s.agent))].sort();

  let digest: Digest = analyze(sessions, { minEvidence });
  let analyzerError: string | null = null;
  const cli = knobs.string('VG_LEARN_CLI', env);
  if (sessions.length && cli) {
    try {
      const prior = extractLearnBlock(readTextTolerant(target));
      const prompt = renderAnalyzerPrompt(sessions, { project, priorBlock: prior });
      const res = await runCliAnalyzer(prompt, {
        cli,
        env,
        loops: digest.loops,
        timeoutMs: knobs.int('VG_LEARN_CLI_TIMEOUT_SECS', env, { min: 1 }) * 1000,
        idleTimeoutMs: knobs.int('VG_LEARN_CLI_IDLE_TIMEOUT_SECS', env, { min: 1 }) * 1000,
      });
      digest = { ...digest, rules: res.rules, analyzer: cli };
    } catch (e) {
      analyzerError = e instanceof Error ? e.message : String(e);
    }
  }

  const block = sessions.length ? renderLearnBlock(digest, { now }) : '';
  const write =
    sessions.length && digest.rules.length
      ? writeLearnBlock(target, block, { dryRun: !opts.apply })
      : { changed: false, created: false, diff: '', content: '', path: target };

  // The verbosity profile is a by-product of the same scan, so it is always
  // computed and only persisted alongside an --apply.
  const verbosity = sessions.length ? learnVerbosity(sessions, { projectPath: project ?? null }) : null;
  const verbosityFile = verbosity && opts.apply ? saveVerbosityProfile(verbosity, env, now) : null;

  if (opts.apply && sessions.length) {
    recordLearnRun(
      projectKey(project ?? opts.root),
      { lastRunAt: now, target, sessions: sessions.length, applied: write.changed, rules: digest.rules.length, agents: agentsSeen },
      env,
    );
  }

  return {
    target,
    applied: opts.apply,
    changed: write.changed,
    created: write.created,
    sessions: sessions.length,
    agents: agentsSeen,
    since: sinceMs,
    project: project ?? null,
    analyzer: digest.analyzer,
    analyzerError,
    scanErrors,
    digest,
    rules: digest.rules,
    block,
    diff: write.diff,
    verbosity,
    verbosityFile,
  };
}

function parseSince(spec: string, now: number): number {
  const ms = parseDuration(spec);
  if (ms === null) throw usageError(`cannot parse --since ${JSON.stringify(spec)}; use e.g. 7d, 48h, 2w`);
  return now - ms;
}
