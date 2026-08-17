import {
  LineIndex,
  parseImageRef,
  resolveRelative,
  safeDoc,
  TOOLCHAIN_NODES_PER_FILE_MAX,
  toPosix,
} from './util.js';
import type {
  ToolchainEdgeDraft,
  ToolchainExtraction,
  ToolchainExtractor,
  ToolchainNodeDraft,
} from './types.js';

/**
 * Dockerfile extraction — a deterministic scanner, no grammar.
 *
 * This follows the precedent set by `engine/sql-extract.ts` (a pure
 * deterministic extractor with no tree-sitter grammar) and is a deliberate
 * choice rather than a shortcut:
 *
 *   - The Dockerfile format is line-oriented with a closed instruction set, an
 *     escape-continuation rule and a `# syntax=` / `# escape=` directive
 *     header. That is a scanner's natural shape.
 *   - No Dockerfile grammar is published as a prebuilt `.wasm` by an upstream
 *     we would be willing to add to the supply chain. The one npm package that
 *     ships one is a single-maintainer package unrelated to the tree-sitter
 *     org; adding it to an enterprise scanner's dependency set to save ~120
 *     lines of transparent code is the wrong trade.
 *   - The genuinely hard part of a Dockerfile — the shell inside `RUN` — is not
 *     solved by a Dockerfile grammar either.
 *
 * ## What is extracted
 *
 * Each `FROM` opens a build stage (`image` node). `FROM x AS y` names it;
 * `COPY --from=` links stages. External base images become `image` nodes so the
 * linker can join a Dockerfile to the registry image a workload runs.
 */

/** The instruction set we act on. Others are parsed and ignored. */
const INSTRUCTION = /^([A-Za-z][A-Za-z0-9_]*)\s+([\s\S]*)$/;

interface LogicalLine {
  instruction: string;
  args: string;
  /** 1-based line the instruction starts on. */
  startLine: number;
  /** 1-based line the instruction ends on (after continuations). */
  endLine: number;
}

/**
 * Fold a Dockerfile into logical lines, honouring comments, blank lines and the
 * escape-character continuation (which `# escape=` can change to a backtick for
 * Windows containers).
 */
export function logicalLines(source: string): LogicalLine[] {
  const rawLines = source.split(/\r?\n/);
  let escapeChar = '\\';

  // Parser directives are only valid before the first non-comment line.
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith('#')) break;
    const directive = /^#\s*escape\s*=\s*(\S)/i.exec(trimmed);
    if (directive) escapeChar = directive[1];
  }

  const out: LogicalLine[] = [];
  let buffer: string | null = null;
  let startLine = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const trimmed = raw.trim();

    // Comments and blank lines never continue an instruction: Docker strips
    // them between a continuation and the next fragment.
    if (!trimmed || trimmed.startsWith('#')) continue;

    const continues = trimmed.endsWith(escapeChar);
    const fragment = continues ? trimmed.slice(0, -1).trimEnd() : trimmed;

    if (buffer === null) {
      buffer = fragment;
      startLine = i + 1;
    } else {
      buffer += ` ${fragment}`;
    }

    if (!continues) {
      const match = INSTRUCTION.exec(buffer);
      if (match) {
        out.push({
          instruction: match[1].toUpperCase(),
          args: match[2].trim(),
          startLine,
          endLine: i + 1,
        });
      }
      buffer = null;
    }
  }

  // An unterminated continuation at EOF still yields its instruction.
  if (buffer !== null) {
    const match = INSTRUCTION.exec(buffer);
    if (match) {
      out.push({
        instruction: match[1].toUpperCase(),
        args: match[2].trim(),
        startLine,
        endLine: rawLines.length,
      });
    }
  }

  return out;
}

/** `FROM <image> [AS <name>]`, with `--platform=` flags stripped. */
function parseFrom(args: string): { image: string; stage?: string } | null {
  const tokens = args.split(/\s+/).filter(Boolean);
  const positional: string[] = [];
  for (const token of tokens) {
    if (token.startsWith('--')) continue; // --platform=…, --chmod=… etc.
    positional.push(token);
  }
  if (!positional.length) return null;
  const image = positional[0];
  // `AS name` is case-insensitive.
  const asIdx = positional.findIndex((t) => t.toUpperCase() === 'AS');
  const stage = asIdx > 0 && positional[asIdx + 1] ? positional[asIdx + 1] : undefined;
  return { image, stage };
}

/** `--from=<stage-or-image>` on a COPY instruction. */
function parseCopyFrom(args: string): string | null {
  const match = /--from=(\S+)/i.exec(args);
  return match ? match[1] : null;
}

/** Ports named by an EXPOSE instruction. */
function parseExpose(args: string): string[] {
  return args
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !token.startsWith('--'));
}

/**
 * Concrete source paths a `COPY`/`ADD` reads from the build context.
 *
 * The last positional token is the destination, so it is excluded. Anything
 * that is not a plain path — a glob, a URL, a build-arg expansion, or a bare
 * `.` — is dropped: the cross-domain linker only wants paths it can match
 * exactly against files already in the graph, and a wrong match is worse than
 * no edge.
 */
export function copySourcePaths(args: string, hasFromFlag: boolean): string[] {
  if (hasFromFlag) return []; // sources come from another stage, not the repo
  const tokens = args.split(/\s+/).filter(Boolean).filter((t) => !t.startsWith('--'));
  if (tokens.length < 2) return [];
  const sources = tokens.slice(0, -1);
  return sources
    .filter(
      (source) =>
        source !== '.' &&
        !source.includes('*') &&
        !source.includes('?') &&
        !source.includes('[') &&
        !source.includes('$') &&
        !/^https?:\/\//i.test(source),
    )
    .map((source) => source.replace(/^\.\//, ''))
    .sort();
}

export const dockerfileExtractor: ToolchainExtractor = {
  format: 'dockerfile',

  matches(rel, category) {
    if (category === 'docker') return true;
    const base = toPosix(rel).split('/').pop()?.toLowerCase() ?? '';
    return base === 'dockerfile' || base === 'containerfile' || base.startsWith('dockerfile.');
  },

  extract(rel, source): ToolchainExtraction {
    const lines = new LineIndex(source);
    const nodes: ToolchainNodeDraft[] = [];
    const edges: ToolchainEdgeDraft[] = [];
    const warnings: string[] = [];

    const posixRel = toPosix(rel);
    const fileAddress = `dockerfile:${posixRel}`;

    // The Dockerfile itself — the anchor a Compose `build:` edge points at.
    nodes.push({
      kind: 'image',
      name: posixRel.split('/').pop() ?? posixRel,
      qualifiedName: fileAddress,
      span: { start: 1, end: Math.max(1, lines.lineCount) },
      signature: 'dockerfile',
      importance: 0.5,
    });

    const stages = new Map<string, string>(); // stage name (lowercased) → address
    /** stage address → candidate repo paths that stage copies from the context. */
    const copySources = new Map<string, Set<string>>();
    let stageIndex = 0;
    let currentStage: string | null = null;

    for (const line of logicalLines(source)) {
      if (nodes.length >= TOOLCHAIN_NODES_PER_FILE_MAX) {
        warnings.push(`${rel}: stopped at ${TOOLCHAIN_NODES_PER_FILE_MAX} nodes`);
        break;
      }

      switch (line.instruction) {
        case 'FROM': {
          const from = parseFrom(line.args);
          if (!from) break;
          const stageName = from.stage ?? String(stageIndex);
          const stageAddress = `${fileAddress}#${stageName}`;
          stages.set(stageName.toLowerCase(), stageAddress);
          currentStage = stageAddress;
          stageIndex++;

          nodes.push({
            kind: 'image',
            name: from.stage ?? `stage ${stageIndex - 1}`,
            qualifiedName: stageAddress,
            span: { start: line.startLine, end: line.endLine },
            signature: 'dockerfile.stage',
            doc: safeDoc(`from ${from.image}`),
            importance: 0.4,
          });
          edges.push({ kind: 'contains', from: fileAddress, to: stageAddress, confidence: 1 });

          // A base image that is another stage in this file is a stage edge;
          // otherwise it is an external registry image.
          const baseStage = stages.get(from.image.toLowerCase());
          if (baseStage && baseStage !== stageAddress) {
            edges.push({
              kind: 'builds_from',
              from: stageAddress,
              to: baseStage,
              confidence: 1,
            });
          } else {
            const ref = parseImageRef(from.image);
            // `FROM $BASE` / `FROM ${REGISTRY}/x` is a build-arg indirection we
            // cannot resolve without the build invocation — skip rather than
            // record a node that matches nothing.
            if (ref) {
              const imageAddress = `image:${ref.raw}`;
              nodes.push({
                kind: 'image',
                name: ref.repository.split('/').pop() ?? ref.repository,
                qualifiedName: imageAddress,
                span: { start: line.startLine, end: line.endLine },
                signature: 'dockerfile.base',
                doc: safeDoc(ref.tag ? `${ref.repository} tag ${ref.tag}` : ref.repository),
                importance: 0.3,
              });
              edges.push({
                kind: 'builds_from',
                from: stageAddress,
                to: imageAddress,
                confidence: 1,
              });
            }
          }
          break;
        }

        case 'COPY':
        case 'ADD': {
          const fromRef = parseCopyFrom(line.args);
          if (fromRef) {
            if (!currentStage) break;
            const target = stages.get(fromRef.toLowerCase());
            if (target && target !== currentStage) {
              edges.push({ kind: 'depends_on', from: currentStage, to: target, confidence: 1 });
            }
            break;
          }
          // Sources are read from the *build context*, which the Dockerfile
          // itself never states — it is chosen by whoever invokes the build.
          // The two conventions in the wild are "context is the Dockerfile's
          // directory" (`build: ./api`) and "context is the repository root"
          // (`docker build -f api/Dockerfile .`). Rather than guess, emit both
          // candidates: the linker keeps only paths that resolve to a file
          // already in the graph, so the wrong candidate costs nothing and the
          // right one is never missed.
          if (!currentStage) break;
          const forStage = copySources.get(currentStage) ?? new Set<string>();
          for (const source of copySourcePaths(line.args, false)) {
            const relativeToDockerfile = resolveRelative(posixRel, source);
            if (relativeToDockerfile) forStage.add(relativeToDockerfile);
            forStage.add(toPosix(source).replace(/^\.\//, ''));
          }
          if (forStage.size) copySources.set(currentStage, forStage);
          break;
        }

        case 'EXPOSE': {
          if (!currentStage) break;
          for (const port of parseExpose(line.args)) {
            const portAddress = `port:${port}`;
            nodes.push({
              kind: 'property',
              name: port,
              qualifiedName: portAddress,
              span: { start: line.startLine, end: line.endLine },
              signature: 'dockerfile.expose',
              importance: 0.1,
            });
            edges.push({ kind: 'exposes', from: currentStage, to: portAddress, confidence: 1 });
          }
          break;
        }

        default:
          break;
      }
    }

    const copySourcesByStage: Record<string, string[]> = {};
    for (const stage of [...copySources.keys()].sort()) {
      copySourcesByStage[stage] = [...(copySources.get(stage) ?? [])].sort();
    }

    return { nodes, edges, warnings, linkHints: { copySourcesByStage } };
  },
};
