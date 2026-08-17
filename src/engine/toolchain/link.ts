import { edgeId } from '../ids.js';
import type { GraphEdge, GraphNode } from '../../schema.js';
import { imageIdentity, parseImageRef, toPosix } from './util.js';

/**
 * Cross-domain linker — Phase 2.1.
 *
 * The per-file extractors deliberately never resolve across files. This pass
 * runs once over the whole extracted set and joins the domains, which is what
 * turns a pile of parsed manifests into an answer to *"which pipeline deploys
 * the service this code runs in?"*
 *
 * ## Honesty contract
 *
 * Every edge produced here is an **inference**, not a declaration, and is
 * labelled as such:
 *
 *   - `resolution: 'heuristic'` — always. An inferred `deploys` is not a
 *     declared `import` and must never claim to be.
 *   - `epistemic: 'name-matched'` — these joins match on a name (an image tag,
 *     a path), which is exactly what that tier means.
 *   - a calibrated `confidence`, lower where the evidence is weaker.
 *
 * Where the evidence is absent the edge is simply **not emitted**. The graph's
 * value is that it does not guess silently, so a repository that wires its
 * pipeline in a way we cannot see gets fewer edges rather than wrong ones.
 *
 * The pass is a pure function of its inputs — no module state, no filesystem,
 * no clock — so a rebuild produces byte-identical edges.
 */

/** Confidence per join, by how directly the evidence supports it. */
export const LINK_CONFIDENCE = {
  /** Compose names the Dockerfile path outright. */
  composeBuild: 0.95,
  /** A CI job builds tag X; a workload runs tag X. Same string, both sides. */
  imageIdentity: 0.8,
  /** A CI job applies Terraform in a directory that contains these resources. */
  terraformDir: 0.75,
  /** A Dockerfile copies a path that exists in the repository. */
  dockerfileCopy: 0.6,
} as const;

export interface LinkInput {
  /** Toolchain nodes from every extractor. */
  nodes: GraphNode[];
  /** Toolchain edges declared within individual files. */
  edges: GraphEdge[];
  /** Repo-relative source path → its `file` node id, for the Dockerfile join. */
  fileNodes: ReadonlyMap<string, string>;
  /**
   * Dockerfile build stage (by its node `qualifiedName`) → candidate repo paths
   * that stage copies from the build context.
   */
  stageCopySources: ReadonlyMap<string, string[]>;
}

export interface LinkResult {
  edges: GraphEdge[];
  /** Per-join counts, for the build summary. */
  counts: Record<string, number>;
}

/** Join the extracted toolchain nodes across files. */
export function linkToolchain(input: LinkInput): LinkResult {
  const { nodes, edges, fileNodes, stageCopySources } = input;
  const out = new Map<string, GraphEdge>();
  const counts: Record<string, number> = {};

  const add = (
    kind: GraphEdge['kind'],
    src: string,
    dst: string,
    confidence: number,
    join: string,
  ): void => {
    if (src === dst) return;
    const id = edgeId(kind, src, dst);
    if (out.has(id)) return;
    out.set(id, {
      id,
      kind,
      src,
      dst,
      resolution: 'heuristic',
      confidence,
      epistemic: 'name-matched',
    });
    counts[join] = (counts[join] ?? 0) + 1;
  };

  // Already-declared edges, so we never emit a weaker duplicate of something an
  // extractor saw declared outright in one file.
  const declared = new Set(edges.map((e) => `${e.kind} ${e.src} ${e.dst}`));

  // ── Index the extracted nodes ────────────────────────────────────────────

  const dockerfileByPath = new Map<string, GraphNode>();
  const dockerfileRefs: GraphNode[] = [];
  const imageSites = new Map<string, GraphNode[]>();
  const terraformDirMarkers: GraphNode[] = [];
  const terraformNodesByDir = new Map<string, GraphNode[]>();
  const stagesByDockerfile = new Map<string, GraphNode[]>();

  for (const node of nodes) {
    const qn = node.qualifiedName;

    if (qn.startsWith('dockerfile:')) {
      const target = qn.slice('dockerfile:'.length);
      if (target.includes('#')) {
        push(stagesByDockerfile, target.split('#')[0], node);
        continue;
      }
      // The Dockerfile's own node lives *in* that file; anything else is a
      // reference to it (a Compose `build:` stanza, say).
      if (toPosix(node.file) === target) dockerfileByPath.set(target, node);
      else dockerfileRefs.push(node);
      continue;
    }

    if (qn.startsWith('image:')) {
      const ref = parseImageRef(qn.slice('image:'.length));
      if (ref) push(imageSites, imageIdentity(ref), node);
      continue;
    }

    if (qn.startsWith('tfdir:')) {
      terraformDirMarkers.push(node);
      continue;
    }

    if (node.lang === 'terraform') push(terraformNodesByDir, dirOf(toPosix(node.file)), node);
  }

  // ── Join 1: a Compose build reference → the real Dockerfile ──────────────

  for (const ref of dockerfileRefs) {
    const target = dockerfileByPath.get(ref.qualifiedName.slice('dockerfile:'.length));
    if (!target) continue; // the referenced Dockerfile is not in the corpus
    add('builds_from', ref.id, target.id, LINK_CONFIDENCE.composeBuild, 'compose→dockerfile');
  }

  // ── Join 2: image identity across files ─────────────────────────────────
  //
  // A CI job that builds `ghcr.io/acme/web:1.2.3` and a Deployment that runs
  // `ghcr.io/acme/web:1.2.3` are talking about the same artifact. The producer
  // side is whatever a `provisions` edge points at; the consumer side is
  // whatever a `builds_from` points at.

  const producerOf = new Map<string, string[]>();
  const consumerOf = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind === 'provisions') push(producerOf, edge.dst, edge.src);
    else if (edge.kind === 'builds_from') push(consumerOf, edge.dst, edge.src);
  }

  for (const identity of [...imageSites.keys()].sort((a, b) => a.localeCompare(b, 'en'))) {
    const sites = imageSites.get(identity) ?? [];
    if (sites.length < 2) continue; // a single mention is not a join

    const producers = new Set<string>();
    const consumers = new Set<string>();
    for (const site of sites) {
      for (const id of producerOf.get(site.id) ?? []) producers.add(id);
      for (const id of consumerOf.get(site.id) ?? []) consumers.add(id);
    }
    for (const producer of [...producers].sort()) {
      for (const consumer of [...consumers].sort()) {
        if (declared.has(`deploys ${producer} ${consumer}`)) continue;
        add('deploys', producer, consumer, LINK_CONFIDENCE.imageIdentity, 'ci→workload');
      }
    }

    // Join the image sites themselves, so navigating from a Compose mention of
    // an image reaches the Kubernetes one.
    const ordered = [...sites].sort((a, b) => a.id.localeCompare(b.id, 'en'));
    for (let i = 1; i < ordered.length; i++) {
      add('references', ordered[0].id, ordered[i].id, LINK_CONFIDENCE.imageIdentity, 'image↔image');
    }
  }

  // ── Join 3: a CI job that applies Terraform → the resources in that dir ──

  const terraformDirs = [...terraformNodesByDir.keys()].sort((a, b) => a.localeCompare(b, 'en'));
  for (const marker of [...terraformDirMarkers].sort((a, b) => a.id.localeCompare(b.id, 'en'))) {
    const dir = marker.qualifiedName.slice('tfdir:'.length);
    for (const resourceDir of terraformDirs) {
      // A root module's apply covers its own directory and below — never the
      // whole repository.
      if (resourceDir !== dir && !resourceDir.startsWith(`${dir}/`)) continue;
      for (const resource of terraformNodesByDir.get(resourceDir) ?? []) {
        // Only declarations that actually create infrastructure: a `variable`
        // or an `output` is not something a pipeline deploys.
        if (resource.signature !== 'terraform.resource' && resource.signature !== 'terraform.module') {
          continue;
        }
        add('deploys', marker.id, resource.id, LINK_CONFIDENCE.terraformDir, 'ci→terraform');
      }
    }
  }

  // ── Join 4: a Dockerfile stage → repository files it copies in ───────────
  //
  // The weakest join, and scoped accordingly: only paths that resolve to a file
  // already in the graph produce an edge. A bare `COPY . .` yields nothing — it
  // is true but says nothing.

  for (const file of [...stagesByDockerfile.keys()].sort((a, b) => a.localeCompare(b, 'en'))) {
    const stages = [...(stagesByDockerfile.get(file) ?? [])].sort((a, b) =>
      a.qualifiedName.localeCompare(b.qualifiedName, 'en'),
    );
    for (const stage of stages) {
      // Per-stage: a stage whose only COPY is `--from=` another stage reads
      // nothing from the repository and must get no source edges.
      const copied = stageCopySources.get(stage.qualifiedName);
      if (!copied?.length) continue;
      for (const path of copied) {
        const fileNodeId = fileNodes.get(toPosix(path));
        if (!fileNodeId) continue;
        add('depends_on', stage.id, fileNodeId, LINK_CONFIDENCE.dockerfileCopy, 'dockerfile→source');
      }
    }
  }

  return {
    edges: [...out.values()].sort(
      (a, b) =>
        a.kind.localeCompare(b.kind, 'en') ||
        a.src.localeCompare(b.src, 'en') ||
        a.dst.localeCompare(b.dst, 'en'),
    ),
    counts,
  };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Directory portion of a POSIX path, or `'.'` at the root. */
function dirOf(rel: string): string {
  const idx = rel.lastIndexOf('/');
  return idx === -1 ? '.' : rel.slice(0, idx);
}
