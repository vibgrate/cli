/**
 * `vg scan --fail-on-epss` and the `failOnEpss` project-config mirror.
 *
 * A present EPSS probability is compared as a number in `[0, 1]`. An omitted
 * score is not a number, so it is not compared and it is never treated as 0.
 * A present 0 is a real score. The flag replaces the config value, the same
 * way `--drift-budget` replaces `driftBudget`.
 */
import { compareCodeUnits } from '../core-open/utils/code-unit.js';
import { CliError, ExitCode, usageError } from '../util/exit.js';

const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

export type EpssGateSource = 'flag' | 'config';

export interface EpssGatePackage {
  ecosystem: string;
  package: string;
  version: string;
  advisories: readonly { id: string; epss?: number | null }[];
}

export interface EpssGateVulnerabilities {
  source: string;
  packages: readonly EpssGatePackage[];
}

export interface EpssGateJudgement {
  exitCode: 0 | 2;
  status: 'pass' | 'failure' | 'skipped';
  /** Stderr line. Null when the gate passes. */
  message: string | null;
  /** Advisory rows, already sorted. Empty unless the gate failed. */
  rows: string[];
}

/** `--fail-on-epss`. Missing means the flag was not passed. */
export function parseFailOnEpssFlag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!NUMERIC.test(trimmed) || !Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw usageError('--fail-on-epss must be a number from 0 to 1.');
  }
  return parsed;
}

/**
 * `failOnEpss` from a loaded project config. `undefined` means the key is
 * absent. A present value that is not a probability is a config error: the
 * message names the file and the key, and it does not include the value.
 */
export function parseConfiguredFailOnEpss(raw: unknown, fileLabel: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw;
  throw new CliError(
    `${fileLabel}: \`failOnEpss\` must be a number from 0 to 1. Fix that key and run the command again.`,
    ExitCode.ERROR,
  );
}

export function formatProbability(value: number): string {
  return Object.is(value, -0) ? '0' : String(value);
}

function gateLabel(threshold: number, source: EpssGateSource): string {
  const rendered = formatProbability(threshold);
  return source === 'flag' ? `--fail-on-epss ${rendered}` : `failOnEpss ${rendered}`;
}

function absentMessage(threshold: number, source: EpssGateSource): string {
  return `EPSS scores are absent; ${gateLabel(threshold, source)} was not compared.`;
}

interface MatchedAdvisory {
  ecosystem: string;
  packageName: string;
  version: string;
  id: string;
  epss: number;
}

function compareMatched(a: MatchedAdvisory, b: MatchedAdvisory): number {
  return compareCodeUnits(a.ecosystem, b.ecosystem)
    || compareCodeUnits(a.packageName, b.packageName)
    || compareCodeUnits(a.version, b.version)
    || compareCodeUnits(a.id, b.id)
    || (a.epss - b.epss);
}

/**
 * Judge advisories from a finished vulnerability scan.
 *
 * `scanned` is false when `--vulns` / `--full` did not run. `unreachable`
 * means the advisory source was not checked. Both skip the gate: there is no
 * score, and a missing score is not 0. A scan that ran and found no advisory
 * at or above the threshold passes, including when every advisory omitted EPSS.
 */
export function judgeEpssGate(input: {
  threshold: number;
  source: EpssGateSource;
  scanned: boolean;
  vulnerabilities?: EpssGateVulnerabilities;
}): EpssGateJudgement {
  if (!input.scanned || input.vulnerabilities?.source === 'unreachable') {
    return {
      exitCode: 0,
      status: 'skipped',
      message: absentMessage(input.threshold, input.source),
      rows: [],
    };
  }

  const matched: MatchedAdvisory[] = [];
  for (const pkg of input.vulnerabilities?.packages ?? []) {
    for (const advisory of pkg.advisories) {
      const epss = advisory.epss;
      if (typeof epss !== 'number' || !Number.isFinite(epss)) continue;
      if (epss >= input.threshold) {
        matched.push({
          ecosystem: pkg.ecosystem,
          packageName: pkg.package,
          version: pkg.version,
          id: advisory.id,
          epss,
        });
      }
    }
  }
  matched.sort(compareMatched);

  if (matched.length === 0) {
    return { exitCode: 0, status: 'pass', message: null, rows: [] };
  }

  const noun = matched.length === 1 ? 'advisory' : 'advisories';
  const message = `Failing: ${matched.length} ${noun} with EPSS at or above ${gateLabel(input.threshold, input.source)}.`;
  const rows = matched.map(
    (row) => `${row.ecosystem} ${row.packageName}@${row.version}  ${row.id}  epss ${formatProbability(row.epss)}`,
  );
  return { exitCode: 2, status: 'failure', message, rows };
}
