/**
 * `vg review --explain` — the optional local model layer (spec §1, §7).
 *
 * The model may add **implications, purpose, unsure-band judgement, and
 * remediation intent**. It may not:
 *   - write a `decision` (there is nowhere to put one; the verifier rejects it)
 *   - invent evidence (every citation is checked against the capsule)
 *   - claim something is secure, safe, approved, or vulnerability-free
 *
 * Output is constrained at sample time by a GBNF grammar and then re-checked by
 * {@link verifyFindings}. Constrained decoding is a convenience; the verifier is
 * the contract.
 *
 * Slice 0 ships no custom weights. `--explain` runs on an already-installed
 * local coder GGUF and records that id in `versions.model`. With no local model
 * — or with the binding missing — it **fails closed** (exit 6). It never
 * silently degrades to deterministic-only while the receipt claims a model ran.
 */

import { ensurePackage } from '../code/ensure.js';
import { discoverModels, type LocalModel } from '../engine/models.js';
import { EmbeddedLlmHost } from '../runtime/llm-host/index.js';
import { CliError, ExitCode } from '../util/exit.js';
import type { AnalysisCapsule, ReviewFinding, ReviewFindings } from './schemas.js';

/**
 * GBNF for the model's contribution. Note what is *absent*: no `decision`, no
 * `severity` escalation, no new evidence ids — the model annotates findings the
 * scanners already produced and adds unknowns.
 */
export const EXPLAIN_GRAMMAR = String.raw`
root        ::= "{" ws "\"implications\"" ws ":" ws implications ws "," ws "\"unknowns\"" ws ":" ws strings ws "}"
implications ::= "[" ws (implication (ws "," ws implication)*)? ws "]"
implication ::= "{" ws "\"finding_id\"" ws ":" ws string ws "," ws "\"implication\"" ws ":" ws string ws "," ws "\"remediation_intent\"" ws ":" ws string ws "}"
strings     ::= "[" ws (string (ws "," ws string)*)? ws "]"
string      ::= "\"" ([^"\\] | "\\" ["\\/bfnrt])* "\""
ws          ::= [ \t\n]*
`;

export interface ExplainResult {
  /** The model id recorded in `versions.model`. */
  model: string;
  quantization: string | null;
  findings: ReviewFindings;
}

/** A local coder model suitable for `task: analysis`. */
export function pickExplainModel(models: LocalModel[] = discoverModels()): LocalModel | null {
  // Prefer a coder-tuned GGUF; the spec's bake-off candidates first.
  const preferred = [/qwen.*coder/i, /granite/i, /coder/i, /instruct/i];
  for (const pattern of preferred) {
    const hit = models.find((m) => pattern.test(m.name));
    if (hit) return hit;
  }
  return models[0] ?? null;
}

function quantizationOf(name: string): string | null {
  const m = name.match(/\b(Q\d(?:_K)?(?:_[SML])?|F16|BF16|Q\d)\b/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * The capsule as a prompt. Bounded by construction — the capsule compiler has
 * already enforced the token budget, so this is a serialization, not a packer.
 */
function buildPrompt(capsule: AnalysisCapsule, findings: ReviewFindings): string {
  const findingLines = [...findings.architecture_findings, ...findings.security_findings].map(
    (f) => `- ${f.id} (${f.kind}, ${f.severity}): ${f.claim}`,
  );
  return [
    'Analysis capsule (facts only — every fact below was produced by a deterministic analyzer):',
    JSON.stringify(capsule),
    '',
    'Deterministic findings:',
    findingLines.join('\n') || '(none)',
    '',
    'For each finding, state the implication the author may not have accounted for, and the',
    'intent behind a fix. Add any unknown that the facts above do not settle.',
    'You are not deciding whether this change merges. Do not claim anything is secure, safe,',
    'approved, or free of vulnerabilities. Cite only finding ids listed above.',
  ].join('\n');
}

/**
 * Run the explain pass. Throws {@link CliError} with exit 6 when a model or the
 * inference binding is unavailable — never returns un-explained findings while
 * claiming otherwise.
 */
export async function explainFindings(
  capsule: AnalysisCapsule,
  findings: ReviewFindings,
  opts: { offline?: boolean; model?: LocalModel | null } = {},
): Promise<ExplainResult> {
  const model = opts.model ?? pickExplainModel();
  if (!model) {
    throw new CliError(
      '`--explain` needs a local model and none was found — install one (`vg models install`) or drop `--explain` to run the deterministic review',
      ExitCode.ENGINE_UNAVAILABLE,
    );
  }

  const ensured = await ensurePackage('node-llama-cpp@^3', {
    consent: false,
    local: opts.offline === true,
    interactive: false,
  });
  if (!ensured.module) {
    throw new CliError(
      '`--explain` needs the local inference binding (node-llama-cpp) and it is not installed — run `vg models install`, or drop `--explain`',
      ExitCode.ENGINE_UNAVAILABLE,
    );
  }

  const host = new EmbeddedLlmHost();
  host.setBinding(ensured.module);
  host.setPreferGrammar(true);
  await host.load(model.path);

  let raw: string;
  try {
    const result = await host.generate(
      [
        {
          role: 'system',
          content:
            'You are the explanation layer of an architecture review. You annotate deterministic findings. You never decide, never invent evidence, and never assert that code is secure.',
        },
        { role: 'user', content: buildPrompt(capsule, findings) },
      ],
      { grammar: EXPLAIN_GRAMMAR, requireGrammar: true, temperature: 0, maxTokens: 1024 },
    );
    raw = result.text;
  } finally {
    await host.unload();
  }

  return {
    model: model.name,
    quantization: quantizationOf(model.name),
    findings: mergeExplanations(findings, raw),
  };
}

/**
 * Fold the model's annotations into the findings document. Unparseable output
 * is dropped, not guessed at — the deterministic findings stand on their own,
 * and the receipt still records which model was consulted.
 */
export function mergeExplanations(findings: ReviewFindings, raw: string): ReviewFindings {
  let parsed: { implications?: { finding_id: string; implication: string; remediation_intent: string }[]; unknowns?: string[] };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return findings;
  }
  const byId = new Map((parsed.implications ?? []).map((i) => [i.finding_id, i]));
  const annotate = (f: ReviewFinding): ReviewFinding => {
    const hit = byId.get(f.id);
    if (!hit) return f;
    return {
      ...f,
      claim: `${f.claim} ${hit.implication}`.trim(),
      remediation: hit.remediation_intent?.trim() ? hit.remediation_intent.trim() : f.remediation,
      source: 'model',
    };
  };
  const modelUnknowns = (parsed.unknowns ?? []).filter((u) => typeof u === 'string' && u.trim());
  return {
    ...findings,
    architecture_findings: findings.architecture_findings.map(annotate),
    security_findings: findings.security_findings.map(annotate),
    unknowns: [...new Set([...findings.unknowns, ...modelUnknowns])],
  };
}
