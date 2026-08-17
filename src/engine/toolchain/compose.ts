import {
  LineIndex,
  parseImageRef,
  resolveRelative,
  safeDoc,
  TOOLCHAIN_NODES_PER_FILE_MAX,
} from './util.js';
import { getArray, getPath, getRecordEntries, getString, parseYamlStream, spanAt } from './yaml.js';
import type {
  ToolchainEdgeDraft,
  ToolchainExtraction,
  ToolchainExtractor,
  ToolchainNodeDraft,
} from './types.js';

/**
 * Docker Compose extraction.
 *
 * Each entry under `services:` becomes a `resource` node. A service either
 * `builds_from` an image reference (`image:`) or points at a Dockerfile
 * (`build.context` + `build.dockerfile`) — the latter is the join the linker
 * uses to connect a Compose service to the Dockerfile node, and through it to
 * the source files that Dockerfile copies in.
 *
 * `depends_on` accepts both Compose forms: the short list form and the long
 * map form with `condition:`.
 */

/** Default Dockerfile name when `build.dockerfile` is omitted. */
const DEFAULT_DOCKERFILE = 'Dockerfile';

export const composeExtractor: ToolchainExtractor = {
  format: 'compose',

  matches(rel, category) {
    if (category === 'compose') return true;
    return /(^|\/)(docker-)?compose([.-][\w.-]+)?\.ya?ml$/i.test(rel);
  },

  extract(rel, source): ToolchainExtraction {
    const { docs, warnings } = parseYamlStream(rel, source);
    const lines = new LineIndex(source);
    const nodes: ToolchainNodeDraft[] = [];
    const edges: ToolchainEdgeDraft[] = [];

    const doc = docs[0];
    if (!doc) return { nodes, edges, warnings };

    const services = getRecordEntries(doc.value, ['services']);
    const declared = new Set(services.map(([name]) => `service:${name}`));

    for (const [name, service] of services) {
      if (nodes.length >= TOOLCHAIN_NODES_PER_FILE_MAX) {
        warnings.push(`${rel}: stopped at ${TOOLCHAIN_NODES_PER_FILE_MAX} nodes`);
        break;
      }
      const address = `service:${name}`;
      const image = getString(service, ['image']);
      const ports = getArray(service, ['ports']).map(String);

      nodes.push({
        kind: 'resource',
        name,
        qualifiedName: address,
        span: spanAt(doc, lines, ['services', name]),
        signature: 'compose.service',
        doc: safeDoc(
          [image && `image ${image}`, ports.length && `ports ${ports.join(', ')}`]
            .filter(Boolean)
            .join(', '),
        ),
        importance: 0.5,
      });

      // An `image:` reference — the join to a workload or a CI-built tag.
      if (image) {
        const ref = parseImageRef(image);
        if (ref) {
          nodes.push({
            kind: 'image',
            name: ref.repository.split('/').pop() ?? ref.repository,
            qualifiedName: `image:${ref.raw}`,
            span: spanAt(doc, lines, ['services', name, 'image']),
            signature: 'compose.image',
            doc: safeDoc(ref.tag ? `${ref.repository} tag ${ref.tag}` : ref.repository),
            importance: 0.3,
          });
          edges.push({ kind: 'builds_from', from: address, to: `image:${ref.raw}`, confidence: 1 });
        }
      }

      // A `build:` stanza — string shorthand or the long object form.
      const dockerfileRel = composeDockerfilePath(rel, service);
      if (dockerfileRel) {
        nodes.push({
          kind: 'image',
          name: dockerfileRel.split('/').pop() ?? dockerfileRel,
          qualifiedName: `dockerfile:${dockerfileRel}`,
          span: spanAt(doc, lines, ['services', name, 'build']),
          signature: 'compose.build',
          doc: safeDoc(`builds from ${dockerfileRel}`),
          importance: 0.4,
        });
        edges.push({
          kind: 'builds_from',
          from: address,
          to: `dockerfile:${dockerfileRel}`,
          confidence: 1,
        });
      }

      // `depends_on`: list form and map form.
      for (const target of composeDependsOn(service)) {
        const to = `service:${target}`;
        if (declared.has(to)) edges.push({ kind: 'depends_on', from: address, to, confidence: 1 });
      }

      // Published ports.
      for (const port of ports) {
        edges.push({ kind: 'exposes', from: address, to: `port:${port}`, confidence: 1 });
      }
    }

    // Port nodes for whatever `exposes` edges were emitted, so no edge dangles.
    const portTargets = new Set(
      edges.filter((e) => e.kind === 'exposes').map((e) => e.to),
    );
    for (const target of [...portTargets].sort()) {
      nodes.push({
        kind: 'property',
        name: target.slice('port:'.length),
        qualifiedName: target,
        span: { start: 1, end: 1 },
        signature: 'compose.port',
        importance: 0.1,
      });
    }

    return { nodes, edges, warnings };
  },
};

/** Repo-relative Dockerfile path for a service's `build:` stanza, if any. */
function composeDockerfilePath(rel: string, service: unknown): string | null {
  const build = getPath(service, ['build']);
  if (build === undefined || build === null) return null;

  // Shorthand: `build: ./dir`
  if (typeof build === 'string') {
    return resolveRelative(rel, `${build}/${DEFAULT_DOCKERFILE}`);
  }
  if (typeof build !== 'object') return null;

  const context = getString(build, ['context']) ?? '.';
  const dockerfile = getString(build, ['dockerfile']) ?? DEFAULT_DOCKERFILE;
  // `dockerfile` is resolved relative to `context`, not to the compose file.
  return resolveRelative(rel, `${context}/${dockerfile}`);
}

/** Service names in a `depends_on`, in both supported shapes. */
function composeDependsOn(service: unknown): string[] {
  const raw = getPath(service, ['depends_on']);
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string').sort();
  }
  if (raw && typeof raw === 'object') {
    return Object.keys(raw as Record<string, unknown>).sort();
  }
  return [];
}
