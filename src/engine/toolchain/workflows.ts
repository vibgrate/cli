import {
  LineIndex,
  parseImageRef,
  safeDoc,
  TOOLCHAIN_NODES_PER_FILE_MAX,
  toPosix,
} from './util.js';
import { getArray, getPath, getRecordEntries, getString, parseYamlStream, spanAt } from './yaml.js';
import type {
  ToolchainEdgeDraft,
  ToolchainExtraction,
  ToolchainExtractor,
  ToolchainNodeDraft,
} from './types.js';

/**
 * CI workflow extraction — GitHub Actions and GitLab CI.
 *
 * Jobs and steps become nodes; `needs` (Actions) and `needs`/`dependencies`
 * (GitLab) become `depends_on` edges; workflow triggers become `triggers`
 * edges from an event node.
 *
 * ## Secrets
 *
 * CI files are the single most common place a live credential is committed, so
 * this extractor is deliberately conservative (GUARDRAILS §1.1): it records the
 * *name* of a referenced secret (`secrets.NPM_TOKEN` → `secret:NPM_TOKEN`) and
 * never the value of anything. Literal `env:` values are not extracted at all —
 * only keys — because a literal is exactly the case where a token gets pasted.
 */

/** Steps beyond this per job are summarised rather than enumerated. */
const MAX_STEPS_PER_JOB = 100;

/** GitLab reserved top-level keys that are not jobs. */
const GITLAB_RESERVED = new Set([
  'stages',
  'variables',
  'default',
  'include',
  'workflow',
  'image',
  'services',
  'before_script',
  'after_script',
  'cache',
  'pages',
]);

function isGitHubWorkflowPath(rel: string): boolean {
  return /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(toPosix(rel));
}

function isGitLabCiPath(rel: string): boolean {
  const base = toPosix(rel).split('/').pop()?.toLowerCase() ?? '';
  return base === '.gitlab-ci.yml' || base === '.gitlab-ci.yaml';
}

/**
 * Image tags a shell script builds or pushes.
 *
 * Recognises `docker build -t X`, `docker buildx build --tag X`, `podman build
 * -t X` and `docker push X`. Only concrete tags are returned — a tag carrying a
 * `${…}` expansion is unresolvable without the runner's environment, and
 * recording it would create a node that matches nothing.
 */
export function imagesBuiltBy(script: string): string[] {
  const out = new Set<string>();
  const buildTag = /\b(?:docker|podman)\s+(?:buildx\s+)?build\b[^\n]*?(?:-t|--tag)[=\s]+(\S+)/g;
  for (const match of script.matchAll(buildTag)) out.add(match[1]);
  const push = /\b(?:docker|podman)\s+push\s+(\S+)/g;
  for (const match of script.matchAll(push)) out.add(match[1]);
  return [...out].filter((tag) => !tag.includes('${') && !tag.includes('{{')).sort();
}

/**
 * Terraform working directories a shell script applies.
 *
 * `terraform apply` acts on the step's working directory unless `-chdir` says
 * otherwise, so an apply with neither yields `'.'` — the linker resolves that
 * against the step's declared `working-directory`.
 */
export function terraformAppliedDirs(script: string, workingDirectory?: string): string[] {
  const out = new Set<string>();
  const apply = /\b(?:terraform|tofu)\s+(?:-chdir=(\S+)\s+)?(?:apply|destroy)\b/g;
  for (const match of script.matchAll(apply)) {
    out.add(match[1] ?? workingDirectory ?? '.');
  }
  return [...out].sort();
}

/** Does this script hand a Kubernetes manifest to the cluster? */
export function appliesKubernetes(script: string): boolean {
  return /\bkubectl\s+apply\b/.test(script) || /\bhelm\s+(?:upgrade|install)\b/.test(script);
}

/** Secret references inside an arbitrary subtree, as `secret:NAME`. */
function collectSecretReferences(value: unknown, out: Set<string>): void {
  const stack: unknown[] = [value];
  while (stack.length) {
    const current = stack.pop();
    if (typeof current === 'string') {
      // `${{ secrets.NAME }}` — the name is the useful fact; the value never appears here.
      for (const match of current.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
        out.add(`secret:${match[1]}`);
      }
      continue;
    }
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (current && typeof current === 'object') {
      stack.push(...Object.values(current as Record<string, unknown>));
    }
  }
}

export const githubActionsExtractor: ToolchainExtractor = {
  format: 'github-actions',

  matches(rel) {
    return isGitHubWorkflowPath(rel);
  },

  extract(rel, source): ToolchainExtraction {
    const { docs, warnings } = parseYamlStream(rel, source);
    const lines = new LineIndex(source);
    const nodes: ToolchainNodeDraft[] = [];
    const edges: ToolchainEdgeDraft[] = [];

    const doc = docs[0];
    if (!doc) return { nodes, edges, warnings };

    const workflowName = getString(doc.value, ['name']) ?? toPosix(rel).split('/').pop() ?? rel;
    const workflowAddress = `workflow:${toPosix(rel)}`;

    nodes.push({
      kind: 'job',
      name: workflowName,
      qualifiedName: workflowAddress,
      span: spanAt(doc, lines, []),
      signature: 'gha.workflow',
      doc: safeDoc(`GitHub Actions workflow`),
      importance: 0.6,
    });

    // Triggers. `on:` is either a string, a list, or a map of event → filter.
    // NB: YAML 1.1 parses a bare `on` key as the boolean `true`; the `yaml`
    // package follows the 1.2 core schema so `on` stays a string, but we accept
    // both so a 1.1-flavoured file still yields triggers.
    const onValue = getPath(doc.value, ['on']) ?? getPath(doc.value, [true as unknown as string]);
    for (const event of triggerEvents(onValue)) {
      const eventAddress = `event:${event}`;
      nodes.push({
        kind: 'property',
        name: event,
        qualifiedName: eventAddress,
        span: spanAt(doc, lines, ['on']),
        signature: 'gha.event',
        importance: 0.2,
      });
      edges.push({ kind: 'triggers', from: eventAddress, to: workflowAddress, confidence: 1 });
    }

    const jobs = getRecordEntries(doc.value, ['jobs']);
    const jobAddresses = new Set(jobs.map(([id]) => `job:${id}`));

    for (const [jobId, job] of jobs) {
      if (nodes.length >= TOOLCHAIN_NODES_PER_FILE_MAX) {
        warnings.push(`${rel}: stopped at ${TOOLCHAIN_NODES_PER_FILE_MAX} nodes`);
        break;
      }
      const jobAddress = `job:${jobId}`;
      const runsOn = getPath(job, ['runs-on']);
      const steps = getArray(job, ['steps']);

      nodes.push({
        kind: 'job',
        name: getString(job, ['name']) ?? jobId,
        qualifiedName: jobAddress,
        span: spanAt(doc, lines, ['jobs', jobId]),
        signature: 'gha.job',
        doc: safeDoc(
          [
            typeof runsOn === 'string' ? `runs-on ${runsOn}` : null,
            steps.length ? `${steps.length} step${steps.length === 1 ? '' : 's'}` : null,
          ]
            .filter(Boolean)
            .join(', '),
        ),
        importance: 0.5,
      });
      edges.push({ kind: 'contains', from: workflowAddress, to: jobAddress, confidence: 1 });

      // `needs:` — string or list.
      for (const need of asStringList(getPath(job, ['needs']))) {
        const to = `job:${need}`;
        if (jobAddresses.has(to)) {
          edges.push({ kind: 'depends_on', from: jobAddress, to, confidence: 1 });
        }
      }

      // Steps. `uses:` is the reusable-action reference; `run:` is a script the
      // linker later mines for `terraform apply` / `docker build`.
      steps.slice(0, MAX_STEPS_PER_JOB).forEach((step, index) => {
        const uses = getString(step, ['uses']);
        const run = getString(step, ['run']);
        const stepName =
          getString(step, ['name']) ?? uses ?? (run ? run.split('\n')[0] : `step ${index + 1}`);
        const stepAddress = `${jobAddress}#${index}`;
        nodes.push({
          kind: 'step',
          name: stepName.slice(0, 80),
          qualifiedName: stepAddress,
          span: spanAt(doc, lines, ['jobs', jobId, 'steps', index]),
          signature: uses ? 'gha.step.uses' : 'gha.step.run',
          // `run:` bodies are shell scripts and are exactly where a token gets
          // pasted — safeDoc redacts, and we keep only the first line.
          doc: safeDoc(uses ? `uses ${uses}` : run?.split('\n')[0]),
          importance: 0.2,
        });
        edges.push({ kind: 'contains', from: jobAddress, to: stepAddress, confidence: 1 });

        if (uses) {
          const actionAddress = `action:${uses}`;
          nodes.push({
            kind: 'external',
            name: uses.split('@')[0],
            qualifiedName: actionAddress,
            span: spanAt(doc, lines, ['jobs', jobId, 'steps', index, 'uses']),
            signature: 'gha.action',
            importance: 0.2,
          });
          edges.push({ kind: 'depends_on', from: stepAddress, to: actionAddress, confidence: 1 });
        }

        if (run) {
          const stepSpan = spanAt(doc, lines, ['jobs', jobId, 'steps', index]);
          const workingDirectory =
            getString(step, ['working-directory']) ?? getString(job, ['defaults', 'run', 'working-directory']);
          emitScriptEffects(rel, run, workingDirectory, jobAddress, stepSpan, nodes, edges);
        }
      });

      if (steps.length > MAX_STEPS_PER_JOB) {
        warnings.push(`${rel}: job ${jobId} has ${steps.length} steps — enumerated the first ${MAX_STEPS_PER_JOB}`);
      }

      // Secret *names* referenced anywhere in the job.
      const secrets = new Set<string>();
      collectSecretReferences(job, secrets);
      for (const secret of [...secrets].sort()) {
        nodes.push({
          kind: 'property',
          name: secret.slice('secret:'.length),
          qualifiedName: secret,
          span: spanAt(doc, lines, ['jobs', jobId]),
          signature: 'gha.secret-ref',
          importance: 0.2,
        });
        edges.push({ kind: 'mounts', from: jobAddress, to: secret, confidence: 1 });
      }
    }

    return { nodes, edges, warnings };
  },
};

export const gitlabCiExtractor: ToolchainExtractor = {
  format: 'gitlab-ci',

  matches(rel) {
    return isGitLabCiPath(rel);
  },

  extract(rel, source): ToolchainExtraction {
    const { docs, warnings } = parseYamlStream(rel, source);
    const lines = new LineIndex(source);
    const nodes: ToolchainNodeDraft[] = [];
    const edges: ToolchainEdgeDraft[] = [];

    const doc = docs[0];
    if (!doc) return { nodes, edges, warnings };

    const pipelineAddress = `workflow:${toPosix(rel)}`;
    nodes.push({
      kind: 'job',
      name: 'GitLab CI',
      qualifiedName: pipelineAddress,
      span: spanAt(doc, lines, []),
      signature: 'gitlab.pipeline',
      importance: 0.6,
    });

    // Top-level keys that are neither reserved nor a `.hidden` template are jobs.
    const jobs = getRecordEntries(doc.value, []).filter(
      ([key, value]) =>
        !GITLAB_RESERVED.has(key) &&
        !key.startsWith('.') &&
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value),
    );
    const jobAddresses = new Set(jobs.map(([id]) => `job:${id}`));

    for (const [jobId, job] of jobs) {
      if (nodes.length >= TOOLCHAIN_NODES_PER_FILE_MAX) {
        warnings.push(`${rel}: stopped at ${TOOLCHAIN_NODES_PER_FILE_MAX} nodes`);
        break;
      }
      const jobAddress = `job:${jobId}`;
      const stage = getString(job, ['stage']);
      const image = getString(job, ['image']) ?? getString(job, ['image', 'name']);

      nodes.push({
        kind: 'job',
        name: jobId,
        qualifiedName: jobAddress,
        span: spanAt(doc, lines, [jobId]),
        signature: 'gitlab.job',
        doc: safeDoc([stage && `stage ${stage}`, image && `image ${image}`].filter(Boolean).join(', ')),
        importance: 0.5,
      });
      edges.push({ kind: 'contains', from: pipelineAddress, to: jobAddress, confidence: 1 });

      // GitLab uses both `needs:` (DAG) and `dependencies:` (artifacts).
      for (const key of ['needs', 'dependencies'] as const) {
        for (const need of asStringList(getPath(job, [key]))) {
          const to = `job:${need}`;
          if (jobAddresses.has(to)) {
            edges.push({ kind: 'depends_on', from: jobAddress, to, confidence: 1 });
          }
        }
      }
    }

    return { nodes, edges, warnings };
  },
};

/**
 * Turn what a `run:` script *does* into nodes and edges, so the cross-domain
 * linker can join on node identity instead of re-parsing shell.
 *
 * These are the anchor points the linker needs: an image this job builds, a
 * Terraform directory it applies, and whether it talks to a cluster at all.
 */
function emitScriptEffects(
  rel: string,
  script: string,
  workingDirectory: string | undefined,
  jobAddress: string,
  span: { start: number; end: number },
  nodes: ToolchainNodeDraft[],
  edges: ToolchainEdgeDraft[],
): void {
  for (const tag of imagesBuiltBy(script)) {
    const ref = parseImageRef(tag);
    if (!ref) continue;
    const address = `image:${ref.raw}`;
    nodes.push({
      kind: 'image',
      name: ref.repository.split('/').pop() ?? ref.repository,
      qualifiedName: address,
      span,
      signature: 'ci.builds-image',
      doc: safeDoc(ref.tag ? `${ref.repository} tag ${ref.tag}` : ref.repository),
      importance: 0.4,
    });
    // The job creates this artifact.
    edges.push({ kind: 'provisions', from: jobAddress, to: address, confidence: 1 });
  }

  for (const dir of terraformAppliedDirs(script, workingDirectory)) {
    // `-chdir=` and `working-directory:` are both relative to the *workspace
    // root* (the checkout), never to the workflow file that names them — a
    // workflow at `.github/workflows/cd.yml` applying `-chdir=infra` means
    // `infra/`, not `.github/workflows/cd.yml/infra`.
    const resolved = normaliseWorkspacePath(dir);
    const address = `tfdir:${resolved}`;
    nodes.push({
      kind: 'resource',
      name: resolved,
      qualifiedName: address,
      span,
      signature: 'ci.terraform-apply',
      doc: safeDoc(`terraform apply in ${resolved}`),
      importance: 0.4,
    });
    edges.push({ kind: 'deploys', from: jobAddress, to: address, confidence: 1 });
  }
}

/**
 * Normalise a workspace-root-relative path from a CI file: strip a leading
 * `./`, collapse `.` segments and resolve `..` without escaping the root.
 * Returns `'.'` for the root itself.
 */
function normaliseWorkspacePath(dir: string): string {
  const out: string[] = [];
  for (const part of toPosix(dir).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/') || '.';
}

/** `on:` in its three shapes → a sorted list of event names. */
function triggerEvents(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string').sort();
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>).sort();
  return [];
}

/**
 * A field that is either a string, a list of strings, or a list of objects
 * carrying a `job` key (GitLab's `needs: [{job: build}]`), normalised to names.
 */
function asStringList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else if (item && typeof item === 'object') {
      const job = (item as Record<string, unknown>).job;
      if (typeof job === 'string') out.push(job);
    }
  }
  return out.sort();
}
