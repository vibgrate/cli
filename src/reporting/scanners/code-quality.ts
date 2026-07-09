import * as path from 'node:path';
import type * as TS from 'typescript';
import type { CodeQualityResult, GodFile } from '../../core-open/index.js';
import { FileCache, findFiles, readTextFile } from '../../core-open/index.js';

// TypeScript is loaded LAZILY, only when we actually parse source for the
// code-quality scan. A static `import * as ts from 'typescript'` is evaluated at
// module-init and drags TS's Node system probe (getNodeSystem →
// isFileSystemCaseSensitive, which touches `__filename`) into startup. In a
// bundled/Worker-style host (no `__filename`) that crashes with
// "ReferenceError: __filename is not defined". Deferring the import keeps that
// code path off module-init entirely — it runs only on a real filesystem when
// this scanner is invoked. Mirrors the same guard in core-open/config.ts.
let ts!: typeof import('typescript');
let tsLoading: Promise<void> | null = null;
async function ensureTypeScript(): Promise<void> {
  if (ts) return;
  tsLoading ??= import('typescript').then((m) => {
    const mod = m as unknown as { default?: typeof import('typescript') };
    ts = mod.default ?? (m as unknown as typeof import('typescript'));
  });
  await tsLoading;
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const DEFAULT_RESULT: CodeQualityResult = {
  filesAnalyzed: 0,
  functionsAnalyzed: 0,
  avgCyclomaticComplexity: 0,
  avgFunctionLength: 0,
  maxNestingDepth: 0,
  godFiles: [],
  circularDependencies: 0,
  deadCodePercent: 0,
};

export async function scanCodeQuality(rootDir: string, cache?: FileCache): Promise<CodeQualityResult> {
  const filePaths = await findSourceFiles(rootDir, cache);
  if (filePaths.length === 0) return { ...DEFAULT_RESULT };

  await ensureTypeScript();

  let totalFunctions = 0;
  let totalComplexity = 0;
  let totalFunctionLength = 0;
  let maxNestingDepth = 0;
  let deadFunctions = 0;
  const godFiles: GodFile[] = [];
  const depGraph = new Map<string, string[]>();

  for (const filePath of filePaths) {
    let raw = '';
    try {
      raw = cache ? await cache.readTextFile(filePath) : await readTextFile(filePath);
    } catch {
      continue;
    }
    if (!raw.trim()) continue;

    const rel = normalizeModuleId(path.relative(rootDir, filePath));
    const source = ts.createSourceFile(filePath, raw, ts.ScriptTarget.Latest, true);

    const imports = collectLocalImports(source, path.dirname(filePath), rootDir);
    depGraph.set(rel, imports);

    const fileMetrics = computeFileMetrics(source, raw);
    totalFunctions += fileMetrics.functionsAnalyzed;
    totalComplexity += fileMetrics.totalComplexity;
    totalFunctionLength += fileMetrics.totalFunctionLength;
    maxNestingDepth = Math.max(maxNestingDepth, fileMetrics.maxNestingDepth);
    deadFunctions += fileMetrics.deadFunctionCount;

    const fileAvgComplexity = fileMetrics.functionsAnalyzed > 0
      ? fileMetrics.totalComplexity / fileMetrics.functionsAnalyzed
      : 0;

    if (
      fileMetrics.lines >= 450
      || fileMetrics.functionsAnalyzed >= 25
      || (fileMetrics.functionsAnalyzed >= 10 && fileAvgComplexity >= 8)
    ) {
      godFiles.push({
        path: rel,
        lines: fileMetrics.lines,
        functionCount: fileMetrics.functionsAnalyzed,
        averageComplexity: round2(fileAvgComplexity),
      });
    }
  }

  const circularDependencies = countCircularDependencyChains(depGraph);
  const deadCodePercent = totalFunctions > 0 ? (deadFunctions / totalFunctions) * 100 : 0;

  return {
    filesAnalyzed: depGraph.size,
    functionsAnalyzed: totalFunctions,
    avgCyclomaticComplexity: totalFunctions > 0 ? round2(totalComplexity / totalFunctions) : 0,
    avgFunctionLength: totalFunctions > 0 ? round2(totalFunctionLength / totalFunctions) : 0,
    maxNestingDepth,
    godFiles: godFiles
      .sort((a, b) => b.lines - a.lines || b.functionCount - a.functionCount)
      .slice(0, 10),
    circularDependencies,
    deadCodePercent: round2(deadCodePercent),
  };
}

async function findSourceFiles(rootDir: string, cache?: FileCache): Promise<string[]> {
  if (cache) {
    const entries = await cache.walkDir(rootDir);
    return entries
      .filter((entry) => entry.isFile && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => entry.absPath);
  }

  const files = await findFiles(rootDir, (name) => SOURCE_EXTENSIONS.has(path.extname(name).toLowerCase()));
  return files;
}

function collectLocalImports(source: TS.SourceFile, fileDir: string, rootDir: string): string[] {
  const deps = new Set<string>();

  const visit = (node: TS.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = resolveLocalImport(node.moduleSpecifier.text, fileDir, rootDir);
      if (target) deps.add(target);
    }
    if (ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0]
      && ts.isStringLiteral(node.arguments[0])) {
      const target = resolveLocalImport(node.arguments[0].text, fileDir, rootDir);
      if (target) deps.add(target);
    }
    visitEach(node, visit);
  };

  visit(source);
  return [...deps];
}

function resolveLocalImport(specifier: string, fileDir: string, rootDir: string): string | null {
  if (!specifier.startsWith('.')) return null;

  const rawTarget = path.resolve(fileDir, specifier);
  const normalized = path.relative(rootDir, rawTarget).replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('..')) return null;

  return normalizeModuleId(normalized);
}

function normalizeModuleId(relPath: string): string {
  return relPath
    .replace(/\\/g, '/')
    .replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '')
    .replace(/\/index$/, '');
}

type FileMetrics = {
  lines: number;
  functionsAnalyzed: number;
  totalComplexity: number;
  totalFunctionLength: number;
  maxNestingDepth: number;
  deadFunctionCount: number;
};

function computeFileMetrics(source: TS.SourceFile, raw: string): FileMetrics {
  let functionsAnalyzed = 0;
  let totalComplexity = 0;
  let totalFunctionLength = 0;
  let maxNestingDepth = 0;
  let deadFunctionCount = 0;

  const functionDecls: TS.FunctionDeclaration[] = [];

  const visit = (node: TS.Node): void => {
    if (isFunctionLike(node)) {
      const complexity = computeCyclomatic(node);
      const lineLength = computeNodeLineLength(source, node);
      const nestingDepth = computeMaxNestingDepth(node);

      functionsAnalyzed++;
      totalComplexity += complexity;
      totalFunctionLength += lineLength;
      maxNestingDepth = Math.max(maxNestingDepth, nestingDepth);
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      functionDecls.push(node);
    }

    visitEach(node, visit);
  };

  visit(source);

  const functionBodies = raw;
  for (const fn of functionDecls) {
    if (isExported(fn)) continue;
    const name = fn.name?.text;
    if (!name) continue;
    const refs = countWholeWord(functionBodies, name);
    if (refs <= 1) deadFunctionCount++;
  }

  return {
    lines: raw.split(/\r?\n/).length,
    functionsAnalyzed,
    totalComplexity,
    totalFunctionLength,
    maxNestingDepth,
    deadFunctionCount,
  };
}

function computeCyclomatic(fn: TS.Node): number {
  let complexity = 1;

  const visit = (node: TS.Node): void => {
    switch (node.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.ConditionalExpression:
        complexity++;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const be = node as TS.BinaryExpression;
        if (
          be.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
          || be.operatorToken.kind === ts.SyntaxKind.BarBarToken
          || be.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ) {
          complexity++;
        }
        break;
      }
      default:
        break;
    }
    visitEach(node, visit);
  };

  visit(fn);
  return complexity;
}

function computeMaxNestingDepth(node: TS.Node): number {
  let maxDepth = 0;

  const walk = (current: TS.Node, depth: number): void => {
    const nextDepth = isNestingNode(current) ? depth + 1 : depth;
    maxDepth = Math.max(maxDepth, nextDepth);
    visitEach(current, (child) => walk(child, nextDepth));
  };

  walk(node, 0);
  return Math.max(0, maxDepth - 1);
}

function countCircularDependencyChains(graph: Map<string, string[]>): number {
  let cycles = 0;
  const visited = new Set<string>();
  const inStack = new Set<string>();

  const dfs = (node: string): void => {
    visited.add(node);
    inStack.add(node);

    const deps = graph.get(node) ?? [];
    for (const dep of deps) {
      if (!graph.has(dep)) continue;
      if (!visited.has(dep)) {
        dfs(dep);
      } else if (inStack.has(dep)) {
        cycles++;
      }
    }

    inStack.delete(node);
  };

  for (const node of graph.keys()) {
    if (!visited.has(node)) dfs(node);
  }

  return cycles;
}

function computeNodeLineLength(source: TS.SourceFile, node: TS.Node): number {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
  const end = source.getLineAndCharacterOfPosition(node.getEnd()).line;
  return end - start + 1;
}

function isFunctionLike(node: TS.Node): boolean {
  return ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isConstructorDeclaration(node);
}

function isNestingNode(node: TS.Node): boolean {
  return node.kind === ts.SyntaxKind.IfStatement
    || node.kind === ts.SyntaxKind.ForStatement
    || node.kind === ts.SyntaxKind.ForOfStatement
    || node.kind === ts.SyntaxKind.ForInStatement
    || node.kind === ts.SyntaxKind.WhileStatement
    || node.kind === ts.SyntaxKind.DoStatement
    || node.kind === ts.SyntaxKind.SwitchStatement
    || node.kind === ts.SyntaxKind.TryStatement
    || node.kind === ts.SyntaxKind.CatchClause;
}

function isExported(node: TS.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function countWholeWord(input: string, word: string): number {
  const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'g');
  return input.match(re)?.length ?? 0;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function visitEach(node: TS.Node, cb: (child: TS.Node) => void): void {
  node.forEachChild(cb);
}
