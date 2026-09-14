import { LineIndex, parseImageRef, safeDoc, TOOLCHAIN_NODES_PER_FILE_MAX } from './util.js';
import {
  getArray,
  getPath,
  getRecordEntries,
  getString,
  looksTemplated,
  parseYamlStream,
  spanAt,
  type YamlDoc,
} from './yaml.js';
import type {
  ToolchainEdgeDraft,
  ToolchainExtraction,
  ToolchainExtractor,
  ToolchainNodeDraft,
} from './types.js';

/**
 * Kubernetes manifest extraction.
 *
 * Every document in the stream that carries both `apiVersion` and `kind`
 * becomes a node. Workload kinds (those with a pod template) additionally yield
 * `image` nodes for each container, which is what lets the linker join a
 * Deployment to the CI job that built its image.
 *
 * Selector→workload edges are matched *within the file*: a Service whose
 * `spec.selector` is a subset of a workload's pod labels `exposes` it. That is
 * a structural match on declared labels, not a guess, so it carries full
 * confidence — but only same-file, because a cross-file label match without
 * namespace resolution produces false pairs in a monorepo of many charts.
 */

/** Workload kinds that own a pod template, and where that template lives. */
const WORKLOAD_TEMPLATE_PATHS: Record<string, (string | number)[]> = {
  Deployment: ['spec', 'template'],
  StatefulSet: ['spec', 'template'],
  DaemonSet: ['spec', 'template'],
  ReplicaSet: ['spec', 'template'],
  ReplicationController: ['spec', 'template'],
  Job: ['spec', 'template'],
  CronJob: ['spec', 'jobTemplate', 'spec', 'template'],
  Pod: [],
};

/** Container list paths within a pod spec, in extraction order. */
const CONTAINER_FIELDS = ['initContainers', 'containers', 'ephemeralContainers'] as const;

function isKubernetesDoc(value: unknown): boolean {
  return typeof getString(value, ['apiVersion']) === 'string' && typeof getString(value, ['kind']) === 'string';
}

/** `namespace/kind/name` — unique within a cluster, and stable across edits. */
function objectAddress(value: unknown): string | null {
  const kind = getString(value, ['kind']);
  const name = getString(value, ['metadata', 'name']);
  if (!kind || !name) return null;
  const namespace = getString(value, ['metadata', 'namespace']) ?? 'default';
  return `${namespace}/${kind}/${name}`;
}

/** The pod spec of a workload document, or null for non-workload kinds. */
function podSpecPath(kind: string): (string | number)[] | null {
  const templatePath = WORKLOAD_TEMPLATE_PATHS[kind];
  if (!templatePath) return null;
  return [...templatePath, 'spec'];
}

export const kubernetesExtractor: ToolchainExtractor = {
  format: 'kubernetes',

  matches(rel, category, head) {
    if (!/\.ya?ml$/i.test(rel)) return false;
    // Helm templates are Go templates, not YAML — the Helm extractor owns them.
    if (looksTemplated(head)) return false;
    if (/(^|\/)templates\//i.test(rel)) return false;
    // The signature of a manifest, wherever it lives. Directory conventions
    // (`k8s/`, `deploy/`) are a hint, never the test: plenty of manifests live
    // elsewhere, and plenty of `deploy/*.yml` files are not manifests.
    return /(^|\n)apiVersion:\s*\S/.test(head) && /(^|\n)kind:\s*\S/.test(head);
  },

  extract(rel, source): ToolchainExtraction {
    const { docs, warnings } = parseYamlStream(rel, source);
    const lines = new LineIndex(source);
    const nodes: ToolchainNodeDraft[] = [];
    const edges: ToolchainEdgeDraft[] = [];

    /** address → pod-template labels, for same-file selector matching. */
    const workloadLabels = new Map<string, Record<string, string>>();

    for (const doc of docs) {
      if (nodes.length >= TOOLCHAIN_NODES_PER_FILE_MAX) {
        warnings.push(`${rel}: stopped at ${TOOLCHAIN_NODES_PER_FILE_MAX} nodes`);
        break;
      }
      if (!isKubernetesDoc(doc.value)) continue;
      const address = objectAddress(doc.value);
      if (!address) continue;

      const kind = getString(doc.value, ['kind']) as string;
      const name = getString(doc.value, ['metadata', 'name']) as string;
      const podPath = podSpecPath(kind);
      const isWorkload = podPath !== null;

      nodes.push({
        kind: isWorkload ? 'workload' : 'resource',
        name,
        qualifiedName: address,
        span: spanAt(doc, lines, []),
        signature: `k8s.${kind}`,
        doc: safeDoc(describeObject(doc.value, kind)),
        importance: isWorkload ? 0.6 : 0.4,
        attrs: projectObjectAttrs(doc.value, kind, name, podPath),
      });

      if (isWorkload) {
        const labels = readLabels(doc.value, [...(WORKLOAD_TEMPLATE_PATHS[kind] ?? []), 'metadata', 'labels']);
        if (Object.keys(labels).length) workloadLabels.set(address, labels);
        extractContainers(doc, lines, address, podPath, nodes, edges);
      }

      // Volume, ConfigMap and Secret *references* — names only, never values.
      for (const reference of referencedConfig(doc.value, podPath)) {
        edges.push({ kind: 'mounts', from: address, to: reference, confidence: 1 });
      }
    }

    // Service → workload, matched on declared labels within this file.
    for (const doc of docs) {
      if (getString(doc.value, ['kind']) !== 'Service') continue;
      const from = objectAddress(doc.value);
      if (!from) continue;
      const selector = readLabels(doc.value, ['spec', 'selector']);
      if (!Object.keys(selector).length) continue;
      for (const [address, labels] of [...workloadLabels].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
        if (isSubset(selector, labels)) {
          edges.push({ kind: 'exposes', from, to: address, confidence: 1 });
        }
      }
    }

    return { nodes, edges, warnings };
  },
};

// ── `attrs` projection (packages/vibgrate-haile/docs/facts.md §2.2) ─────────
//
// The closed view of a manifest the security fact builder hands to the
// Architecture module. Only declared keys are projected — an absent key means
// "not declared", never a default — and an environment variable is recorded
// by name plus *where* its value comes from, never the value itself.

/** Caps the host enforces on a projection (facts.md §2 "Caps"). */
const ATTRS_MAX_ITEMS = 64;
const ATTRS_MAX_STRING = 256;

function capString(value: string): string {
  return value.length > ATTRS_MAX_STRING ? value.slice(0, ATTRS_MAX_STRING) : value;
}

/** A declared boolean at `path`, or undefined. */
function boolAt(value: unknown, path: (string | number)[]): boolean | undefined {
  const found = getPath(value, path);
  return typeof found === 'boolean' ? found : undefined;
}

/** A declared finite number at `path`, or undefined. */
function numberAt(value: unknown, path: (string | number)[]): number | undefined {
  const found = getPath(value, path);
  return typeof found === 'number' && Number.isFinite(found) ? found : undefined;
}

/** A declared string at `path` (numbers/booleans stringified), capped, or undefined. */
function stringAt(value: unknown, path: (string | number)[]): string | undefined {
  const found = getString(value, path);
  return found === undefined ? undefined : capString(found);
}

/** A declared array of strings at `path`, scalars stringified, capped, or undefined. */
function stringArrayAt(value: unknown, path: (string | number)[]): string[] | undefined {
  const found = getPath(value, path);
  if (!Array.isArray(found)) return undefined;
  return found
    .filter((item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
    .slice(0, ATTRS_MAX_ITEMS)
    .map((item) => capString(String(item)));
}

/** Copy the declared subset of keys from `value` into a fresh object; undefined when none is declared. */
function declared(entries: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(entries)) {
    if (val !== undefined) out[key] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

/** `{ apiVersion, kind, name, namespace, spec }` for every emitted object. */
function projectObjectAttrs(
  value: unknown,
  kind: string,
  name: string,
  podPath: (string | number)[] | null,
): Record<string, unknown> {
  return {
    apiVersion: capString(getString(value, ['apiVersion']) ?? ''),
    kind: capString(kind),
    name: capString(name),
    namespace: capString(getString(value, ['metadata', 'namespace']) ?? 'default'),
    spec: projectSpec(value, kind, podPath),
  };
}

function projectSpec(value: unknown, kind: string, podPath: (string | number)[] | null): Record<string, unknown> {
  if (podPath) return projectPodSpec(value, podPath);
  if (kind === 'Role' || kind === 'ClusterRole') {
    const rules = getArray(value, ['rules']).slice(0, ATTRS_MAX_ITEMS).map((rule) =>
      declared({
        apiGroups: stringArrayAt(rule, ['apiGroups']),
        resources: stringArrayAt(rule, ['resources']),
        verbs: stringArrayAt(rule, ['verbs']),
        nonResourceURLs: stringArrayAt(rule, ['nonResourceURLs']),
      }) ?? {},
    );
    return { rules };
  }
  if (kind === 'RoleBinding' || kind === 'ClusterRoleBinding') {
    const roleRef = declared({
      kind: stringAt(value, ['roleRef', 'kind']),
      name: stringAt(value, ['roleRef', 'name']),
    });
    const subjects = getArray(value, ['subjects']).slice(0, ATTRS_MAX_ITEMS).map((subject) =>
      declared({
        kind: stringAt(subject, ['kind']),
        name: stringAt(subject, ['name']),
        namespace: stringAt(subject, ['namespace']),
      }) ?? {},
    );
    return { ...(roleRef ? { roleRef } : {}), subjects };
  }
  if (kind === 'Service') {
    const ports = getArray(value, ['spec', 'ports'])
      .map((p) => numberAt(p, ['port']))
      .filter((p): p is number => p !== undefined)
      .slice(0, ATTRS_MAX_ITEMS);
    return declared({ type: stringAt(value, ['spec', 'type']), ports }) ?? {};
  }
  return {};
}

/** The workload projection: host namespaces, pod security context, service account, containers. */
function projectPodSpec(value: unknown, podPath: (string | number)[]): Record<string, unknown> {
  const pod = getPath(value, podPath);
  const containers: Record<string, unknown>[] = [];
  for (const field of CONTAINER_FIELDS) {
    const kind = field === 'containers' ? 'container' : field === 'initContainers' ? 'initContainer' : 'ephemeralContainer';
    for (const container of getArray(pod, [field])) {
      if (containers.length >= ATTRS_MAX_ITEMS) break;
      containers.push(projectContainer(container, kind));
    }
  }
  return (
    declared({
      hostNetwork: boolAt(pod, ['hostNetwork']),
      hostPID: boolAt(pod, ['hostPID']),
      hostIPC: boolAt(pod, ['hostIPC']),
      securityContext: declared({
        runAsNonRoot: boolAt(pod, ['securityContext', 'runAsNonRoot']),
        runAsUser: numberAt(pod, ['securityContext', 'runAsUser']),
        runAsGroup: numberAt(pod, ['securityContext', 'runAsGroup']),
        fsGroup: numberAt(pod, ['securityContext', 'fsGroup']),
      }),
      serviceAccountName: stringAt(pod, ['serviceAccountName']),
      automountServiceAccountToken: boolAt(pod, ['automountServiceAccountToken']),
      containers,
    }) ?? { containers }
  );
}

function projectContainer(container: unknown, kind: string): Record<string, unknown> {
  const securityContext = declared({
    privileged: boolAt(container, ['securityContext', 'privileged']),
    runAsNonRoot: boolAt(container, ['securityContext', 'runAsNonRoot']),
    runAsUser: numberAt(container, ['securityContext', 'runAsUser']),
    runAsGroup: numberAt(container, ['securityContext', 'runAsGroup']),
    allowPrivilegeEscalation: boolAt(container, ['securityContext', 'allowPrivilegeEscalation']),
    readOnlyRootFilesystem: boolAt(container, ['securityContext', 'readOnlyRootFilesystem']),
    capabilities: declared({
      add: stringArrayAt(container, ['securityContext', 'capabilities', 'add']),
      drop: stringArrayAt(container, ['securityContext', 'capabilities', 'drop']),
    }),
  });
  const resources = declared({
    limits: declared({
      cpu: stringAt(container, ['resources', 'limits', 'cpu']),
      memory: stringAt(container, ['resources', 'limits', 'memory']),
    }),
    requests: declared({
      cpu: stringAt(container, ['resources', 'requests', 'cpu']),
      memory: stringAt(container, ['resources', 'requests', 'memory']),
    }),
  });
  const envList = getPath(container, ['env']);
  const env = Array.isArray(envList) ? projectEnv(envList) : undefined;
  const portList = getPath(container, ['ports']);
  const ports = Array.isArray(portList)
    ? portList
        .map((p) => numberAt(p, ['containerPort']))
        .filter((p): p is number => p !== undefined)
        .slice(0, ATTRS_MAX_ITEMS)
    : undefined;
  return (
    declared({
      name: stringAt(container, ['name']),
      image: stringAt(container, ['image']),
      kind,
      securityContext,
      resources,
      env,
      ports,
    }) ?? { kind }
  );
}

/**
 * Environment entries by name and *source* only. `literal: true` records that
 * a `value:` was declared — the value itself is never projected, so a
 * plaintext secret in a manifest is reported by its key and nothing else.
 */
function projectEnv(entries: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const entry of entries) {
    if (out.length >= ATTRS_MAX_ITEMS) break;
    const name = stringAt(entry, ['name']);
    if (name === undefined) continue;
    const row: Record<string, unknown> = { name };
    if (entry && typeof entry === 'object' && Object.hasOwn(entry, 'value')) row.literal = true;
    else if (getPath(entry, ['valueFrom', 'secretKeyRef']) !== undefined) row.fromSecret = true;
    else if (getPath(entry, ['valueFrom', 'configMapKeyRef']) !== undefined) row.fromConfigMap = true;
    else if (
      getPath(entry, ['valueFrom', 'fieldRef']) !== undefined ||
      getPath(entry, ['valueFrom', 'resourceFieldRef']) !== undefined
    ) {
      row.fromField = true;
    }
    out.push(row);
  }
  return out;
}

/** Container nodes plus their `builds_from` image edges. */
function extractContainers(
  doc: YamlDoc,
  lines: LineIndex,
  workloadAddress: string,
  podPath: (string | number)[],
  nodes: ToolchainNodeDraft[],
  edges: ToolchainEdgeDraft[],
): void {
  const seenImages = new Set<string>();
  for (const field of CONTAINER_FIELDS) {
    const containers = getArray(doc.value, [...podPath, field]);
    containers.forEach((container, index) => {
      const image = getString(container, ['image']);
      if (!image) return;
      const ref = parseImageRef(image);
      // A templated or malformed image reference is skipped rather than
      // recorded: a node named `${{ env.IMAGE }}` matches nothing and only
      // adds noise to the graph.
      if (!ref) return;
      if (seenImages.has(ref.raw)) return;
      seenImages.add(ref.raw);

      nodes.push({
        kind: 'image',
        name: ref.repository.split('/').pop() ?? ref.repository,
        qualifiedName: `image:${ref.raw}`,
        span: spanAt(doc, lines, [...podPath, field, index, 'image']),
        signature: 'k8s.image',
        doc: safeDoc(ref.tag ? `${ref.repository} tag ${ref.tag}` : ref.repository),
        importance: 0.3,
      });
      edges.push({
        kind: 'builds_from',
        from: workloadAddress,
        to: `image:${ref.raw}`,
        confidence: 1,
      });
    });
  }
}

/** ConfigMap/Secret/PVC names a pod spec references. Names only — never values. */
function referencedConfig(value: unknown, podPath: (string | number)[] | null): string[] {
  if (!podPath) return [];
  const out = new Set<string>();

  for (const volume of getArray(value, [...podPath, 'volumes'])) {
    const configMap = getString(volume, ['configMap', 'name']);
    if (configMap) out.add(`ConfigMap/${configMap}`);
    const secret = getString(volume, ['secret', 'secretName']);
    if (secret) out.add(`Secret/${secret}`);
    const claim = getString(volume, ['persistentVolumeClaim', 'claimName']);
    if (claim) out.add(`PersistentVolumeClaim/${claim}`);
  }

  for (const field of CONTAINER_FIELDS) {
    for (const container of getArray(value, [...podPath, field])) {
      for (const envFrom of getArray(container, ['envFrom'])) {
        const configMap = getString(envFrom, ['configMapRef', 'name']);
        if (configMap) out.add(`ConfigMap/${configMap}`);
        const secret = getString(envFrom, ['secretRef', 'name']);
        if (secret) out.add(`Secret/${secret}`);
      }
      for (const env of getArray(container, ['env'])) {
        const configMap = getString(env, ['valueFrom', 'configMapKeyRef', 'name']);
        if (configMap) out.add(`ConfigMap/${configMap}`);
        const secret = getString(env, ['valueFrom', 'secretKeyRef', 'name']);
        if (secret) out.add(`Secret/${secret}`);
      }
    }
  }

  return [...out].sort();
}

function readLabels(value: unknown, path: (string | number)[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of getRecordEntries(value, path)) {
    if (typeof raw === 'string') out[key] = raw;
    else if (typeof raw === 'number' || typeof raw === 'boolean') out[key] = String(raw);
  }
  return out;
}

function isSubset(selector: Record<string, string>, labels: Record<string, string>): boolean {
  const keys = Object.keys(selector);
  if (!keys.length) return false;
  return keys.every((key) => labels[key] === selector[key]);
}

/** A one-line human summary: replicas, container count, exposed ports. */
function describeObject(value: unknown, kind: string): string {
  const parts: string[] = [];
  const replicas = getPath(value, ['spec', 'replicas']);
  if (typeof replicas === 'number') parts.push(`${replicas} replica${replicas === 1 ? '' : 's'}`);

  const podPath = podSpecPath(kind);
  if (podPath) {
    const count = CONTAINER_FIELDS.reduce(
      (sum, field) => sum + getArray(value, [...podPath, field]).length,
      0,
    );
    if (count) parts.push(`${count} container${count === 1 ? '' : 's'}`);
  }

  if (kind === 'Service') {
    const type = getString(value, ['spec', 'type']);
    if (type) parts.push(type);
    const ports = getArray(value, ['spec', 'ports'])
      .map((p) => getString(p, ['port']))
      .filter(Boolean);
    if (ports.length) parts.push(`port ${ports.join(', ')}`);
  }

  return parts.join(', ');
}
