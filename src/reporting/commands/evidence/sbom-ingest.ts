// Read CycloneDX and SPDX documents into frozen release components.
//
// A schema-valid component often has neither a Package URL nor a CPE: vendored
// files, firmware, and machine-learning models. Those rows are kept. The
// identity is the name, the version (empty when the document omitted it), and
// the type (CycloneDX `type`, SPDX `primaryPackagePurpose`). A purl, when
// present, is the identity. A CPE is the identity only when there is no purl.
//
// Nested CycloneDX `components` arrays are walked iteratively. Each component
// object is visited once, so a cycle cannot loop. A component with no name and
// no purl and no CPE is skipped. The caller gets one warning for the file.

import type { FrozenComponent } from './types.js';
import { warningPathLabel } from '../../../core-open/warnings.js';

/** Safety bound for one document. The walk is still O(n) in the document. */
export const SBOM_COMPONENT_WALK_LIMIT = 100_000;

export interface SbomIngest {
  components: FrozenComponent[];
  /** One warning for this input. Absent when every component was kept or deliberately omitted. */
  warning?: string;
}

const CPE_REF_TYPES = new Set(['cpe22type', 'cpe23type', 'cpe22', 'cpe23', 'cpe']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Trimmed non-empty string, or undefined. Non-strings are absent, never thrown on. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function ecosystemForPurl(purl: string): string | undefined {
  const match = /^pkg:([^/]+)\//.exec(purl);
  if (!match) return undefined;
  const map: Record<string, string> = {
    npm: 'npm',
    pypi: 'PyPI',
    maven: 'Maven',
    nuget: 'NuGet',
    golang: 'Go',
    cargo: 'crates.io',
    gem: 'RubyGems',
    composer: 'Packagist',
    pub: 'Pub',
    hex: 'Hex',
    deb: 'Debian',
    apk: 'Alpine',
    rpm: 'RPM',
  };
  return map[match[1].toLowerCase()];
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, 'en');
}

function compareComponents(a: FrozenComponent, b: FrozenComponent): number {
  return (
    compareText(a.name, b.name) ||
    compareText(a.version, b.version) ||
    compareText(a.type ?? '', b.type ?? '') ||
    compareText(a.purl ?? '', b.purl ?? '') ||
    compareText(a.cpe ?? '', b.cpe ?? '')
  );
}

interface IdentityInput {
  name?: string;
  version: string;
  purl?: string;
  cpe?: string;
  type?: string;
}

type Classified = { kind: 'keep'; component: FrozenComponent } | { kind: 'image' } | { kind: 'unidentified' };

/**
 * Purl wins over CPE. With neither, the row is name + version + type.
 * A missing name falls back to the purl or the CPE. With none of those, the
 * row has no identity.
 */
function classifyIdentity(input: IdentityInput): Classified {
  const purl = input.purl;
  const cpe = input.cpe;
  const name = input.name ?? purl ?? cpe;
  if (!name) return { kind: 'unidentified' };
  const component: FrozenComponent = { name, version: input.version };
  if (purl) {
    component.purl = purl;
    const ecosystem = ecosystemForPurl(purl);
    if (ecosystem) component.ecosystem = ecosystem;
    return { kind: 'keep', component };
  }
  if (cpe) {
    component.cpe = cpe;
    return { kind: 'keep', component };
  }
  if (input.type) component.type = input.type;
  return { kind: 'keep', component };
}

function identityKey(component: FrozenComponent): string {
  if (component.purl) return `p\u0000${component.purl}`;
  if (component.cpe) return `c\u0000${component.cpe}`;
  return `n\u0000${component.type ?? ''}\u0000${component.name}\u0000${component.version}`;
}

function spdxRefs(pkg: Record<string, unknown>): { purl?: string; cpe?: string } {
  const refs = pkg.externalRefs;
  if (!Array.isArray(refs)) return {};
  let purl: string | undefined;
  let cpe: string | undefined;
  for (const ref of refs) {
    if (!isRecord(ref)) continue;
    const type = text(ref.referenceType)?.toLowerCase();
    const locator = text(ref.referenceLocator);
    if (!type || !locator) continue;
    if (!purl && type === 'purl') purl = locator;
    else if (!cpe && CPE_REF_TYPES.has(type)) cpe = locator;
    if (purl && cpe) break;
  }
  return { purl, cpe };
}

function classifySpdx(pkg: Record<string, unknown>): Classified {
  const refs = spdxRefs(pkg);
  const purpose = text(pkg.primaryPackagePurpose);
  // The package that describes the image itself is not a release component.
  if (purpose === 'CONTAINER' || refs.purl?.startsWith('pkg:oci/')) return { kind: 'image' };
  return classifyIdentity({
    name: text(pkg.name),
    version: text(pkg.versionInfo) ?? '',
    purl: refs.purl,
    cpe: refs.cpe,
    type: purpose,
  });
}

function classifyCyclone(component: Record<string, unknown>): Classified {
  return classifyIdentity({
    name: text(component.name),
    version: text(component.version) ?? '',
    purl: text(component.purl),
    cpe: text(component.cpe),
    type: text(component.type),
  });
}

function childComponents(node: Record<string, unknown>): unknown[] {
  return Array.isArray(node.components) ? node.components : [];
}

interface WalkResult {
  components: FrozenComponent[];
  unidentified: number;
  capped: number;
}

/**
 * Depth-first, array order, each object once. Children of a component are
 * visited even when the parent itself is skipped, so a nameless wrapper does
 * not hide the tree under it.
 */
function walk(
  roots: unknown[],
  classify: (node: Record<string, unknown>) => Classified,
  childrenOf: (node: Record<string, unknown>) => unknown[],
  limit: number,
): WalkResult {
  const stack: unknown[] = [];
  for (let i = roots.length - 1; i >= 0; i--) stack.push(roots[i]);
  const seen = new WeakSet<object>();
  const byKey = new Map<string, FrozenComponent>();
  let unidentified = 0;
  let capped = 0;
  let visited = 0;

  while (stack.length > 0) {
    const node = stack.pop();
    if (!isRecord(node)) {
      if (visited >= limit) capped++;
      else {
        visited++;
        unidentified++;
      }
      continue;
    }
    if (seen.has(node)) continue;
    seen.add(node);
    const children = childrenOf(node);
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (isRecord(child) && seen.has(child)) continue;
      stack.push(child);
    }
    if (visited >= limit) {
      capped++;
      continue;
    }
    visited++;
    const classified = classify(node);
    if (classified.kind === 'image') continue;
    if (classified.kind === 'unidentified') {
      unidentified++;
      continue;
    }
    const key = identityKey(classified.component);
    if (!byKey.has(key)) byKey.set(key, classified.component);
  }

  const components = [...byKey.values()].sort(compareComponents);
  return { components, unidentified, capped };
}

function skippedWarning(sourceLabel: string, unidentified: number, capped: number, limit: number): string | undefined {
  const file = warningPathLabel(sourceLabel);
  const parts: string[] = [];
  if (unidentified > 0) {
    const noun = unidentified === 1 ? 'component' : 'components';
    const verb = unidentified === 1 ? 'it has' : 'they have';
    const pronoun = unidentified === 1 ? 'it' : 'them';
    parts.push(
      `Skipped ${unidentified} ${noun} in ${file} because ${verb} no name, no purl, and no CPE. Add a name, and a version and a type when the component has them, or add a purl or a CPE to include ${pronoun}.`,
    );
  }
  if (capped > 0) {
    const noun = capped === 1 ? 'component' : 'components';
    parts.push(
      `Skipped ${capped} ${noun} in ${file} because the walk stopped at ${limit} components. Split the document so each file stays within ${limit} components.`,
    );
  }
  if (parts.length === 0) return undefined;
  return parts.join(' ');
}

function finish(walked: WalkResult, sourceLabel: string, limit: number): SbomIngest {
  const warning = skippedWarning(sourceLabel, walked.unidentified, walked.capped, limit);
  return warning ? { components: walked.components, warning } : { components: walked.components };
}

function bound(limit: number): number {
  return limit > 0 ? limit : SBOM_COMPONENT_WALK_LIMIT;
}

function cycloneRoots(doc: unknown): unknown[] {
  if (!isRecord(doc)) return [];
  const roots: unknown[] = [];
  if (isRecord(doc.metadata) && isRecord(doc.metadata.component)) roots.push(doc.metadata.component);
  if (Array.isArray(doc.components)) roots.push(...doc.components);
  return roots;
}

/** CycloneDX `components`, including `metadata.component` and nested `components`. */
export function ingestCycloneDx(doc: unknown, sourceLabel: string, limit = SBOM_COMPONENT_WALK_LIMIT): SbomIngest {
  const cap = bound(limit);
  return finish(walk(cycloneRoots(doc), classifyCyclone, childComponents, cap), sourceLabel, cap);
}

/** SPDX 2.x `packages`. The image package (`CONTAINER` or `pkg:oci/`) is not a release component. */
export function ingestSpdx(doc: unknown, sourceLabel: string, limit = SBOM_COMPONENT_WALK_LIMIT): SbomIngest {
  const cap = bound(limit);
  const packages = isRecord(doc) && Array.isArray(doc.packages) ? doc.packages : [];
  return finish(walk(packages, classifySpdx, () => [], cap), sourceLabel, cap);
}
