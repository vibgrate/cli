/**
 * VG Code parity check — run the 4-prompt parity set against two or more
 * `vg code` backends and compare them (logic: src/code/parity.ts).
 *
 * Real comparison (needs the agents installed and signed in):
 *
 *   npx tsx scripts/parity-check.ts --repo ~/src/my-repo \
 *     --arm 'reference=--acp-command "<reference agent> acp"' \
 *     --arm 'grok-build=--provider grok-build --inject-capsule' \
 *     --arm 'native=--provider openrouter --model <id>' \
 *     --baseline reference --runs 3
 *
 * Harness self-test (no model, no network; drives the scripted fake ACP agent):
 *
 *   npx tsx scripts/parity-check.ts --self-test
 *
 * Flags:
 *   --repo <dir>          git repository to run in (each run gets a fresh detached worktree)
 *   --arm <name>=<flags>  an arm: extra `vg code` flags (repeatable, ≥ 2)
 *   --baseline <name>     the arm the others are compared with (default: first arm)
 *   --runs <n>            repeats per prompt per arm (default 1; medians are reported)
 *   --prompts <ids>       comma-separated subset of: timeout-flag, extract-gate, no-progress-retry, plan-worktree
 *   --out <dir>           results directory (default .vibgrate/parity/<timestamp> under --repo)
 *   --timeout <sec>       per-run cap (default 900)
 *   --max-slowdown <f>    allowed latency regression vs baseline (default 0.2 = 20%)
 *   --vg "<cmd>"          how to run vg (default: node dist/cli.js when built, else tsx src/cli.ts)
 *   --keep                keep each run's worktree (path written next to its artifacts)
 *
 * Output (in --out): results.jsonl (one record per run), summary.json, summary.md,
 * and per run: <arm>.<prompt>.<n>.{profile.jsonl,trace.ndjson,acp.ndjson,stderr.txt}.
 * All files are redacted at write time. Exit 0 = every arm passes, 1 = a criterion failed, 2 = usage.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { splitCommandLine } from '../src/code/acp-client.js';
import {
  PARITY_PROMPTS,
  renderParityMarkdown,
  runParityOnce,
  summarizeParity,
  type ParityArm,
  type ParityRun,
} from '../src/code/parity.js';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Args {
  repo: string;
  arms: ParityArm[];
  baseline?: string;
  runs: number;
  prompts?: string[];
  out?: string;
  timeoutSec: number;
  maxSlowdown: number;
  vg?: string;
  keep: boolean;
  selfTest: boolean;
}

function usage(msg: string): never {
  process.stderr.write(`parity-check: ${msg}\n(see the header of scripts/parity-check.ts for usage)\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const a: Args = { repo: process.cwd(), arms: [], runs: 1, timeoutSec: 900, maxSlowdown: 0.2, keep: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = (): string => {
      const x = argv[++i];
      if (x === undefined) usage(`${k} needs a value`);
      return x;
    };
    if (k === '--repo') a.repo = path.resolve(v());
    else if (k === '--arm') {
      const raw = v();
      const eq = raw.indexOf('=');
      if (eq <= 0) usage(`--arm expects name=<flags>, got "${raw}"`);
      a.arms.push({ name: raw.slice(0, eq), args: splitCommandLine(raw.slice(eq + 1)) });
    } else if (k === '--baseline') a.baseline = v();
    else if (k === '--runs') a.runs = Math.max(1, Number(v()) || 1);
    else if (k === '--prompts') a.prompts = v().split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--out') a.out = path.resolve(v());
    else if (k === '--timeout') a.timeoutSec = Math.max(10, Number(v()) || 900);
    else if (k === '--max-slowdown') a.maxSlowdown = Number(v());
    else if (k === '--vg') a.vg = v();
    else if (k === '--keep') a.keep = true;
    else if (k === '--self-test') a.selfTest = true;
    else usage(`unknown flag ${k}`);
  }
  return a;
}

function defaultVg(): string[] {
  const built = path.join(PKG, 'dist', 'cli.js');
  if (fs.existsSync(built)) return [process.execPath, built];
  const tsx = path.join(PKG, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (fs.existsSync(tsx)) return [process.execPath, tsx, path.join(PKG, 'src', 'cli.ts')];
  usage('could not find dist/cli.js or tsx — build the CLI (pnpm build) or pass --vg');
}

/** A small git repo shaped like the prompts expect, plus a fake-agent scenario per prompt. */
async function selfTestFixture(): Promise<{ repo: string; arms: ParityArm[]; cleanup: () => void }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-parity-selftest-'));
  const repo = path.join(root, 'repo');
  const files: Record<string, string> = {
    'README.md': '# demo-cli\n\nScan a project.\n\n## Flags\n\n- `--format`: output format\n',
    'src/commands/scan.ts':
      "export interface ScanOptions { format: string }\n\nexport function registerScan(program: { option(f: string, d: string): unknown }): void {\n  program.option('--format <fmt>', 'output format');\n}\n",
    'src/code/agent.ts':
      "export async function runAgent(approve: (a: string) => Promise<boolean>): Promise<void> {\n  // approval gate\n  const ok = await approve('edit');\n  if (!ok) return;\n}\n",
    'src/code/loop.ts':
      'export const NO_PROGRESS_STOP_AT = 3;\nexport function shouldStop(repeats: number): boolean {\n  return repeats >= NO_PROGRESS_STOP_AT;\n}\n',
  };
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), c);
  }
  const g = (args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  g(['init', '-q']);
  g(['add', '-A']);
  g(['-c', 'user.email=parity@example.invalid', '-c', 'user.name=parity', 'commit', '-qm', 'fixture']);

  const scenario = (stepDelayMs: number) => ({
    agentInfo: { name: 'fake-acp-agent', version: 'selftest' },
    stepDelayMs,
    turnsByPrompt: [
      {
        match: 'timeout',
        steps: [
          { type: 'search', id: 's1', title: 'grep --format', output: 'src/commands/scan.ts:4' },
          { type: 'read', id: 'r1', path: 'src/commands/scan.ts' },
          {
            type: 'edit',
            id: 'e1',
            path: 'src/commands/scan.ts',
            search: "  program.option('--format <fmt>', 'output format');",
            replace: "  program.option('--format <fmt>', 'output format');\n  program.option('--timeout <ms>', 'abort the scan after <ms> milliseconds');",
          },
          { type: 'edit', id: 'e2', path: 'README.md', search: '- `--format`: output format', replace: '- `--format`: output format\n- `--timeout`: abort the scan after N milliseconds' },
          { type: 'message', text: 'Added `--timeout` to the scan command and documented it in README.md.' },
        ],
      },
      {
        match: 'approval gate',
        steps: [
          { type: 'read', id: 'r1', path: 'src/code/agent.ts' },
          { type: 'create', id: 'c1', path: 'src/code/approval-gate.ts', content: "export async function gate(approve: (a: string) => Promise<boolean>, action: string): Promise<boolean> {\n  return approve(action);\n}\n" },
          { type: 'edit', id: 'e1', path: 'src/code/agent.ts', search: "  const ok = await approve('edit');", replace: "  const ok = await gate(approve, 'edit');" },
          { type: 'message', text: 'Moved the approval gate into src/code/approval-gate.ts.' },
        ],
      },
      {
        match: 'no-progress',
        steps: [
          { type: 'read', id: 'r1', path: 'src/code/loop.ts' },
          { type: 'edit', id: 'e1', path: 'src/code/loop.ts', search: 'return repeats >= NO_PROGRESS_STOP_AT;', replace: 'return repeats > NO_PROGRESS_STOP_AT;' },
          { type: 'create', id: 'c1', path: 'src/code/loop.test.ts', content: "import { shouldStop } from './loop';\n// a legitimate retry at the threshold is allowed\nconsole.assert(!shouldStop(3));\n" },
          { type: 'execute', id: 'x1', command: 'node --version', output: 'v24' },
          { type: 'message', text: 'Legitimate retries at the threshold are allowed now; added src/code/loop.test.ts.' },
        ],
      },
      {
        match: 'worktree',
        steps: [
          { type: 'search', id: 's1', title: 'grep worktree', output: '(no matches)' },
          { type: 'read', id: 'r1', path: 'src/code/agent.ts' },
          { type: 'message', text: 'Plan: 1) detect non-git folders, 2) copy into a temp dir, 3) diff back on apply. No files changed.' },
        ],
      },
    ],
  });
  // The native arm: the real VG Code loop against a scripted OpenAI-compatible
  // server (LM Studio provider), mirroring the ACP scenario step for step.
  const nativeScript = {
    byPrompt: [
      {
        match: 'timeout',
        steps: [
          { tool_calls: [{ name: 'search_code', arguments: { query: '--format' } }] },
          { tool_calls: [{ name: 'read_file', arguments: { path: 'src/commands/scan.ts' } }] },
          {
            tool_calls: [
              { name: 'edit_file', arguments: { path: 'src/commands/scan.ts', search: "  program.option('--format <fmt>', 'output format');", replace: "  program.option('--format <fmt>', 'output format');\n  program.option('--timeout <ms>', 'abort the scan after <ms> milliseconds');" } },
              { name: 'edit_file', arguments: { path: 'README.md', search: '- `--format`: output format', replace: '- `--format`: output format\n- `--timeout`: abort the scan after N milliseconds' } },
            ],
          },
          { tool_calls: [{ name: 'finish', arguments: { summary: 'Added `--timeout` to the scan command and documented it in README.md.' } }] },
        ],
      },
      {
        match: 'approval gate',
        steps: [
          { tool_calls: [{ name: 'read_file', arguments: { path: 'src/code/agent.ts' } }] },
          {
            tool_calls: [
              { name: 'create_file', arguments: { path: 'src/code/approval-gate.ts', content: 'export async function gate(approve: (a: string) => Promise<boolean>, action: string): Promise<boolean> {\n  return approve(action);\n}\n' } },
              { name: 'edit_file', arguments: { path: 'src/code/agent.ts', search: "  const ok = await approve('edit');", replace: "  const ok = await gate(approve, 'edit');" } },
            ],
          },
          { tool_calls: [{ name: 'finish', arguments: { summary: 'Moved the approval gate into src/code/approval-gate.ts.' } }] },
        ],
      },
      {
        match: 'no-progress',
        steps: [
          { tool_calls: [{ name: 'read_file', arguments: { path: 'src/code/loop.ts' } }] },
          {
            tool_calls: [
              { name: 'edit_file', arguments: { path: 'src/code/loop.ts', search: 'return repeats >= NO_PROGRESS_STOP_AT;', replace: 'return repeats > NO_PROGRESS_STOP_AT;' } },
              { name: 'create_file', arguments: { path: 'src/code/loop.test.ts', content: "import { shouldStop } from './loop';\nconsole.assert(!shouldStop(3));\n" } },
            ],
          },
          { tool_calls: [{ name: 'finish', arguments: { summary: 'Legitimate retries at the threshold are allowed now; added src/code/loop.test.ts.' } }] },
        ],
      },
      {
        match: 'worktree',
        steps: [
          { tool_calls: [{ name: 'search_code', arguments: { query: 'worktree' } }] },
          { tool_calls: [{ name: 'finish', arguments: { summary: 'Plan: 1) detect non-git folders, 2) copy into a temp dir, 3) diff back on apply. No files changed.' } }] },
        ],
      },
    ],
  };
  const nativeScriptFile = path.join(root, 'native.script.json');
  fs.writeFileSync(nativeScriptFile, JSON.stringify(nativeScript));
  const server = spawn(process.execPath, [path.join(PKG, 'test', '__fixtures__', 'openai', 'fake-openai-server.mjs'), nativeScriptFile, '0'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port: number = await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => {
      const m = /listening (\d+)/.exec(String(d));
      if (m) resolve(Number(m[1]));
    });
    server.on('exit', () => reject(new Error('the fake OpenAI server exited before listening')));
  });

  const fake = path.join(PKG, 'test', '__fixtures__', 'acp', 'fake-acp-agent.mjs');
  const arms: ParityArm[] = [];
  for (const [name, delay] of [
    ['sim-baseline', 15],
    ['sim-grok-build', 15],
  ] as const) {
    const file = path.join(root, `${name}.scenario.json`);
    fs.writeFileSync(file, JSON.stringify(scenario(delay)));
    arms.push({ name, args: ['--acp-command', `"${process.execPath}" "${fake}" "${file}"`, '--no-acp-mcp'], simulated: true });
  }
  arms.push({
    name: 'sim-native',
    args: ['--provider', 'lmstudio', '--model', 'fake-model'],
    env: { LMSTUDIO_BASE_URL: `http://127.0.0.1:${port}/v1`, VIBGRATE_NO_KERNEL: '1' },
    simulated: true,
  });
  return {
    repo,
    arms,
    cleanup: () => {
      server.kill();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let { repo, arms } = args;
  let cleanup = (): void => {};
  if (args.selfTest) {
    const fx = await selfTestFixture();
    repo = fx.repo;
    arms = fx.arms;
    cleanup = fx.cleanup;
    if (!args.out) args.out = path.join(os.tmpdir(), `vg-parity-selftest-results-${Date.now().toString(36)}`);
  }
  try {
    await runAll(args, repo, arms);
  } finally {
    cleanup();
  }
}

async function runAll(args: Args, repo: string, arms: ParityArm[]): Promise<void> {
  if (arms.length < 2) usage('pass at least two --arm name=<flags> (or --self-test)');
  const baseline = args.baseline ?? arms[0].name;
  if (!arms.some((a) => a.name === baseline)) usage(`--baseline ${baseline} is not one of the arms`);
  const prompts = args.prompts ? PARITY_PROMPTS.filter((p) => args.prompts!.includes(p.id)) : [...PARITY_PROMPTS];
  if (!prompts.length) usage('--prompts selected nothing');
  const outDir = args.out ?? path.join(repo, '.vibgrate', 'parity', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(outDir, { recursive: true });
  const vg = args.vg ? splitCommandLine(args.vg) : defaultVg();
  const resultsFile = path.join(outDir, 'results.jsonl');

  process.stderr.write(`parity-check: ${arms.length} arms × ${prompts.length} prompts × ${args.runs} run(s) → ${outDir}\n`);
  const runs: ParityRun[] = [];
  // Interleave arms per prompt so drift in machine load hits every arm alike.
  for (let n = 1; n <= args.runs; n++) {
    for (const prompt of prompts) {
      for (const arm of arms) {
        const r = await runParityOnce({ vg, arm, prompt, run: n, repo, outDir, timeoutMs: args.timeoutSec * 1000, keepWorkspace: args.keep });
        runs.push(r);
        fs.appendFileSync(resultsFile, JSON.stringify(r) + '\n');
        process.stderr.write(
          `  ${arm.name.padEnd(16)} ${prompt.id.padEnd(18)} #${n} stop=${r.stopReason ?? '-'} turn=${r.turnMs === null ? '-' : `${(r.turnMs / 1000).toFixed(2)}s`} activity=${r.activityLines} cards=${r.changesCards} clean=${r.concludedCleanly ? 'yes' : 'no'}${r.error ? ` error=${r.error.slice(0, 80)}` : ''}\n`,
        );
      }
    }
  }
  const summary = summarizeParity(runs, arms, baseline, prompts, args.maxSlowdown);
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  const md = renderParityMarkdown(summary, runs);
  fs.writeFileSync(path.join(outDir, 'summary.md'), md);
  process.stdout.write(md);
  process.exitCode = summary.pass ? 0 : 1;
}

main().catch((e) => {
  process.stderr.write(`parity-check: ${(e as Error).message}\n`);
  process.exit(1);
});
