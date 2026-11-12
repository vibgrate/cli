// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Maven `${...}` interpolation for coordinates declared in a POM.
 *
 * Explicit `<properties>` are loaded by the caller first. `seedMavenProjectProperties`
 * then fills the built-in project coordinates without replacing a key that
 * `<properties>` already set. `project.version` and `project.groupId` fall
 * back to the parent only when this POM does not declare the element.
 * `project.parent.version` stays the parent's version, which can differ.
 * `${pom.*}` is an alias for the same value.
 */

const MAX_MAVEN_PROPERTY_PASSES = 8;

/**
 * Replace `${key}` from `properties`. A replacement may itself contain
 * `${...}`, so this repeats until the text settles. An unknown key is left
 * as `${key}`. A cycle stops at the pass limit.
 */
export function resolveMavenProperty(value: string, properties: Record<string, string>): string {
  let current = value;
  for (let pass = 0; pass < MAX_MAVEN_PROPERTY_PASSES; pass++) {
    if (!current.includes('${')) return current;
    let changed = false;
    const next = current.replace(/\$\{([^}]+)\}/g, (match, key: string) => {
      const replacement = properties[key];
      if (replacement === undefined || replacement === match) return match;
      changed = true;
      return replacement;
    });
    if (!changed || next === current) return next;
    current = next;
  }
  return current;
}

function resolveConcrete(value: string | undefined, properties: Record<string, string>): string | undefined {
  if (value == null) return undefined;
  const text = resolveMavenProperty(value, properties).trim();
  if (!text || text.includes('${')) return undefined;
  return text;
}

export interface MavenProjectCoordinates {
  /** Present only when the POM declares `<groupId>`. */
  groupId?: string;
  /** Parent groupId, used when `groupId` is omitted. */
  inheritedGroupId?: string;
  /** Present only when the POM declares `<artifactId>`. */
  artifactId?: string;
  /** Directory name (or other caller fallback) when `<artifactId>` is omitted. */
  inheritedArtifactId?: string;
  /** Present only when the POM declares `<version>`. */
  version?: string;
  /** Parent version, used when `version` is omitted. */
  inheritedVersion?: string;
  parentGroupId?: string;
  parentVersion?: string;
}

export function seedMavenProjectProperties(
  properties: Record<string, string>,
  coords: MavenProjectCoordinates,
): void {
  const pick = (declared: string | undefined, inherited: string | undefined): string | undefined =>
    declared !== undefined ? resolveConcrete(declared, properties) : resolveConcrete(inherited, properties);

  setAlias(properties, 'project.groupId', 'pom.groupId', pick(coords.groupId, coords.inheritedGroupId));
  setAlias(properties, 'project.artifactId', 'pom.artifactId', pick(coords.artifactId, coords.inheritedArtifactId));
  setAlias(properties, 'project.version', 'pom.version', pick(coords.version, coords.inheritedVersion));
  setAlias(properties, 'project.parent.groupId', 'pom.parent.groupId', resolveConcrete(coords.parentGroupId, properties));
  setAlias(properties, 'project.parent.version', 'pom.parent.version', resolveConcrete(coords.parentVersion, properties));
}

function setAlias(
  properties: Record<string, string>,
  projectKey: string,
  pomKey: string,
  value: string | undefined,
): void {
  if (properties[projectKey] === undefined && properties[pomKey] !== undefined) {
    properties[projectKey] = properties[pomKey];
  } else if (properties[pomKey] === undefined && properties[projectKey] !== undefined) {
    properties[pomKey] = properties[projectKey];
  }
  if (value === undefined) return;
  if (properties[projectKey] === undefined) properties[projectKey] = value;
  if (properties[pomKey] === undefined) properties[pomKey] = value;
}
