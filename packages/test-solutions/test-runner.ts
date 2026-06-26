/**
 * Test Solutions Scanner
 * 
 * Runs the vibgrate CLI scanner against the test solution projects
 * and compares results against expected baselines.
 */
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_SOLUTIONS_DIR = __dirname;
const BASELINES_DIR = path.resolve(__dirname, './baselines');

interface TestSolution {
  name: string;
  path: string;
  expectedLanguages: string[];
  expectedMinPackages: number;
  skip?: string; // Reason to skip this test
}

const TEST_SOLUTIONS: TestSolution[] = [
  {
    name: 'dotnet-clean-arch',
    path: 'dotnet-clean-arch',
    expectedLanguages: ['dotnet'],
    expectedMinPackages: 4,
  },
  {
    name: 'node-turborepo',
    path: 'node-turborepo',
    expectedLanguages: ['node'],
    expectedMinPackages: 5,
  },
  {
    name: 'java-spring',
    path: 'java-spring',
    expectedLanguages: ['java'],
    expectedMinPackages: 2,
  },
  {
    name: 'python-fastapi',
    path: 'python-fastapi',
    expectedLanguages: ['python'],
    expectedMinPackages: 3,
  },
];

interface ScanResult {
  success: boolean;
  output?: string;
  error?: string;
  exitCode: number;
  duration: number;
}

interface ProjectSummary {
  languages: string[];
  packageCount: number;
  projects: number;
  driftScore?: number;
}

async function runCliScan(solutionPath: string, outputFormat: 'json' | 'text' = 'json'): Promise<ScanResult> {
  const startTime = Date.now();
  const cliPath = path.resolve(__dirname, '../dist/cli.js');
  
  return new Promise((resolve) => {
    const args = ['scan', solutionPath, '--format', outputFormat, '--offline'];
    const proc = spawn('node', [cliPath, ...args], {
      cwd: path.dirname(solutionPath),
      env: { ...process.env, NO_COLOR: '1' },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({
        success: code === 0,
        output: stdout,
        error: stderr,
        exitCode: code ?? 1,
        duration: Date.now() - startTime,
      });
    });

    proc.on('error', (err) => {
      resolve({
        success: false,
        error: err.message,
        exitCode: 1,
        duration: Date.now() - startTime,
      });
    });
  });
}

function parseJsonOutput(output: string): ProjectSummary | null {
  try {
    // The CLI outputs progress indicators before the JSON
    // Find the JSON block which starts with { on its own line
    const jsonStartIndex = output.indexOf('\n{');
    if (jsonStartIndex === -1) {
      // Try finding { at start of output
      if (output.trim().startsWith('{')) {
        const jsonStr = output.trim();
        const parsed = JSON.parse(jsonStr);
        return extractSummary(parsed);
      }
      return null;
    }
    
    const jsonStr = output.slice(jsonStartIndex + 1).trim();
    const parsed = JSON.parse(jsonStr);
    return extractSummary(parsed);
  } catch (e) {
    return null;
  }
}

function extractSummary(parsed: Record<string, unknown>): ProjectSummary | null {
  if (!parsed.projects && !parsed.solutions) {
    return null;
  }
  
  const languages = new Set<string>();
  let packageCount = 0;
  let projectCount = 0;
  
  // Extract from projects array
  const projects = (parsed.projects || []) as Array<{
    type?: string;
    language?: string;
    dependencies?: unknown[];
  }>;
  
  for (const proj of projects) {
    // Use type as language if language not present
    if (proj.type) {
      languages.add(proj.type);
    }
    if (proj.language) {
      languages.add(proj.language);
    }
    if (proj.dependencies) {
      packageCount += proj.dependencies.length;
    }
    projectCount++;
  }
  
  return {
    languages: [...languages],
    packageCount,
    projects: projectCount,
    driftScore: parsed.driftScore as number | undefined,
  };
}

interface TestResult {
  solution: string;
  passed: boolean;
  scanSuccess: boolean;
  duration: number;
  checks: {
    name: string;
    passed: boolean;
    expected: unknown;
    actual: unknown;
  }[];
  error?: string;
}

async function runTestSolution(solution: TestSolution): Promise<TestResult> {
  const solutionPath = path.join(TEST_SOLUTIONS_DIR, solution.path);
  
  // Check if solution exists
  try {
    await fs.access(solutionPath);
  } catch {
    return {
      solution: solution.name,
      passed: false,
      scanSuccess: false,
      duration: 0,
      checks: [],
      error: `Solution directory not found: ${solutionPath}`,
    };
  }
  
  const result = await runCliScan(solutionPath, 'json');
  const checks: TestResult['checks'] = [];
  
  if (!result.success) {
    return {
      solution: solution.name,
      passed: false,
      scanSuccess: false,
      duration: result.duration,
      checks,
      error: result.error || `Scan failed with exit code ${result.exitCode}`,
    };
  }
  
  const summary = parseJsonOutput(result.output || '');
  
  if (!summary) {
    return {
      solution: solution.name,
      passed: false,
      scanSuccess: true,
      duration: result.duration,
      checks,
      error: 'Failed to parse scan output',
    };
  }
  
  // Check expected languages
  const languageCheck = solution.expectedLanguages.every((lang) =>
    summary.languages.some((l) => l.toLowerCase().includes(lang.toLowerCase()))
  );
  checks.push({
    name: 'Expected languages detected',
    passed: languageCheck,
    expected: solution.expectedLanguages,
    actual: summary.languages,
  });
  
  // Check minimum packages
  const packageCheck = summary.packageCount >= solution.expectedMinPackages;
  checks.push({
    name: 'Minimum packages detected',
    passed: packageCheck,
    expected: `>= ${solution.expectedMinPackages}`,
    actual: summary.packageCount,
  });
  
  // Check projects found
  const projectCheck = summary.projects > 0;
  checks.push({
    name: 'Projects detected',
    passed: projectCheck,
    expected: '> 0',
    actual: summary.projects,
  });
  
  const allPassed = checks.every((c) => c.passed);
  
  return {
    solution: solution.name,
    passed: allPassed,
    scanSuccess: true,
    duration: result.duration,
    checks,
  };
}

async function ensureBaselineDir(): Promise<void> {
  try {
    await fs.mkdir(BASELINES_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

async function saveBaseline(solution: string, output: string): Promise<void> {
  await ensureBaselineDir();
  const baselinePath = path.join(BASELINES_DIR, `${solution}.json`);
  await fs.writeFile(baselinePath, output, 'utf-8');
}

async function loadBaseline(solution: string): Promise<string | null> {
  try {
    const baselinePath = path.join(BASELINES_DIR, `${solution}.json`);
    return await fs.readFile(baselinePath, 'utf-8');
  } catch {
    return null;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const updateBaselines = args.includes('--update-baselines');
  const verbose = args.includes('--verbose') || args.includes('-v');
  
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║         Vibgrate CLI Test Solutions Scanner              ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  
  const results: TestResult[] = [];
  let skipped = 0;
  
  for (const solution of TEST_SOLUTIONS) {
    process.stdout.write(`Testing ${solution.name}... `);
    
    if (solution.skip) {
      console.log(`⊘ SKIP (${solution.skip})`);
      skipped++;
      console.log('');
      continue;
    }
    
    const result = await runTestSolution(solution);
    results.push(result);
    
    if (result.passed) {
      console.log(`✓ PASS (${formatDuration(result.duration)})`);
    } else {
      console.log(`✗ FAIL (${formatDuration(result.duration)})`);
    }
    
    if (verbose || !result.passed) {
      for (const check of result.checks) {
        const icon = check.passed ? '  ✓' : '  ✗';
        console.log(`${icon} ${check.name}`);
        if (!check.passed || verbose) {
          console.log(`      Expected: ${JSON.stringify(check.expected)}`);
          console.log(`      Actual:   ${JSON.stringify(check.actual)}`);
        }
      }
      if (result.error) {
        console.log(`  Error: ${result.error}`);
      }
    }
    console.log('');
  }
  
  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalDuration = results.reduce((acc, r) => acc + r.duration, 0);
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Summary: ${passed}/${results.length} passed, ${failed} failed, ${skipped} skipped`);
  console.log(`Total time: ${formatDuration(totalDuration)}`);
  console.log('═══════════════════════════════════════════════════════════');
  
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
