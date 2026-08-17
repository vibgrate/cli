import { LineIndex, parseImageRef, safeDoc, toPosix } from './util.js';
import { getArray, getRecordEntries, getString, parseYamlStream, spanAt } from './yaml.js';
import type {
  ToolchainEdgeDraft,
  ToolchainExtraction,
  ToolchainExtractor,
  ToolchainNodeDraft,
} from './types.js';

/**
 * Helm chart extraction.
 *
 * Helm templates under `templates/` are Go templates, not YAML — they do not
 * parse before rendering, and rendering them would mean running Helm. So this
 * extractor deliberately reads only the two files that *are* well-formed YAML
 * and carry the chart's identity:
 *
 *   - `Chart.yaml` → the `chart` node, its version, and `depends_on` edges to
 *     declared subchart dependencies;
 *   - `values.yaml` → image references, which is what connects a chart to the
 *     images a CI pipeline builds.
 *
 * That is a deliberate scope limit, not an oversight: claiming to understand an
 * unrendered template would mean inventing structure. What is extracted here is
 * declared fact.
 */

/**
 * Common `values.yaml` shapes for an image. Helm has no schema, but these three
 * cover the overwhelming majority of charts in the wild, including the
 * `bitnami`/`stable` conventions.
 */
function collectValuesImages(value: unknown, prefix: string[], out: Map<string, string[]>): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;

  const repository = getString(value, ['repository']);
  const tag = getString(value, ['tag']);
  const registry = getString(value, ['registry']);
  if (repository) {
    const full = [registry, repository].filter(Boolean).join('/');
    const raw = tag ? `${full}:${tag}` : full;
    if (!out.has(raw)) out.set(raw, prefix);
  }

  // A plain `image: repo:tag` string.
  const direct = getString(value, ['image']);
  if (direct && parseImageRef(direct)) {
    if (!out.has(direct)) out.set(direct, [...prefix, 'image']);
  }

  for (const [key, child] of getRecordEntries(value, [])) {
    if (key === 'repository' || key === 'tag' || key === 'registry') continue;
    collectValuesImages(child, [...prefix, key], out);
  }
}

export const helmExtractor: ToolchainExtractor = {
  format: 'helm',

  matches(rel) {
    const base = toPosix(rel).split('/').pop()?.toLowerCase() ?? '';
    if (base === 'chart.yaml' || base === 'chart.yml') return true;
    // Only a `values.yaml` that sits next to a chart is a Helm values file;
    // a bare `values.yaml` elsewhere is just config.
    return /(^|\/)values([.-][\w.-]+)?\.ya?ml$/i.test(rel) && /(^|\/)charts?\//i.test(rel);
  },

  extract(rel, source): ToolchainExtraction {
    const { docs, warnings } = parseYamlStream(rel, source);
    const lines = new LineIndex(source);
    const nodes: ToolchainNodeDraft[] = [];
    const edges: ToolchainEdgeDraft[] = [];

    const doc = docs[0];
    if (!doc) return { nodes, edges, warnings };

    const base = toPosix(rel).split('/').pop()?.toLowerCase() ?? '';
    const isChartFile = base === 'chart.yaml' || base === 'chart.yml';

    if (isChartFile) {
      const name = getString(doc.value, ['name']);
      if (!name) return { nodes, edges, warnings };
      const version = getString(doc.value, ['version']);
      const appVersion = getString(doc.value, ['appVersion']);
      const address = `chart:${name}`;

      nodes.push({
        kind: 'chart',
        name,
        qualifiedName: address,
        span: spanAt(doc, lines, []),
        signature: 'helm.chart',
        doc: safeDoc(
          [version && `version ${version}`, appVersion && `app ${appVersion}`]
            .filter(Boolean)
            .join(', '),
        ),
        importance: 0.7,
      });

      // Declared subchart dependencies.
      for (const dependency of getArray(doc.value, ['dependencies'])) {
        const depName = getString(dependency, ['name']);
        if (!depName) continue;
        const depVersion = getString(dependency, ['version']);
        const depAddress = `chart:${depName}`;
        nodes.push({
          kind: 'chart',
          name: depName,
          qualifiedName: depAddress,
          span: spanAt(doc, lines, ['dependencies']),
          signature: 'helm.dependency',
          doc: safeDoc(depVersion ? `version ${depVersion}` : undefined),
          importance: 0.4,
        });
        edges.push({ kind: 'depends_on', from: address, to: depAddress, confidence: 1 });
      }

      return { nodes, edges, warnings };
    }

    // values.yaml — image references only.
    const images = new Map<string, string[]>();
    collectValuesImages(doc.value, [], images);
    for (const raw of [...images.keys()].sort()) {
      const ref = parseImageRef(raw);
      if (!ref) continue;
      nodes.push({
        kind: 'image',
        name: ref.repository.split('/').pop() ?? ref.repository,
        qualifiedName: `image:${ref.raw}`,
        span: spanAt(doc, lines, images.get(raw) ?? []),
        signature: 'helm.values.image',
        doc: safeDoc(ref.tag ? `${ref.repository} tag ${ref.tag}` : ref.repository),
        importance: 0.3,
      });
    }

    return { nodes, edges, warnings };
  },
};
