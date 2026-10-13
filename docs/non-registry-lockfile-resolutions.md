# CDN and non-registry lockfile resolutions

Some lockfiles record a download URL that is a CDN, a tarball host, or a git remote. `vg scan` and `vg build` keep the package's ecosystem. They do not read that URL as a registry, and they do not parse a version out of it.

Identity is the ecosystem, the package name, and the version. The [package URL](https://github.com/package-url/purl-spec) (purl) is that triple. Match advisories on the same triple. The host in a `resolved` URL is a separate fact, and these commands do not store it.

The runs below used local files only: `vg scan --offline`, `vg sbom export`, and `vg build --offline`. No registry was contacted. The examples use `vg`.

```bash
vg scan --offline --vulns --package-manifest ./package-versions.json --format json --out scan.json
vg sbom export --in scan.json --format cyclonedx --out sbom.cdx.json
vg build --offline --graph graph.json
```

Join `scan.json` to the SBOM on the purl rules in [Component identity](../DOCS.md#component-identity).

## Fields to trust

| Question | Field |
| --- | --- |
| Installed name and version on a scan row | `projects[].dependencies[].package` and `resolvedVersion`. `projects[].type` is the project kind (`node`, `python`, `java`). |
| Advisory match | `extended.vulnerabilities.packages[].ecosystem`, `.package`, and `.version`. For an npm project, `ecosystem` is `npm`. |
| SBOM identity | CycloneDX `components[].purl` (and `bom-ref` when the purl was written). SPDX `packages[].externalRefs[]` with `referenceType` `purl`. |
| Code map (`vg build`, and the map `vg scan` writes) | An `external` node. `name` and `qualifiedName` are the dependency name from the manifest. `lang` is `external`. `file` is empty. |

`resolvedVersion` is the lockfile **version** string (npm `version`, Yarn `version`, pnpm package key, Cargo `version`, NuGet `resolved`). It is a version. On an npm lockfile the key named `resolved` is a URL, and that URL has no field in the scan row.

A purl for `left-pad` at `1.3.0` in a Node project is `pkg:npm/left-pad@1.3.0` when the lockfile records that name and version, including when `resolved` is `https://cdn.example/left-pad/-/left-pad-1.3.0.tgz`. The advisory ecosystem stays `npm`. The CDN host does not select another ecosystem's range.

SPDX writes `downloadLocation` `NOASSERTION` on every package. CycloneDX does not write the tarball URL. A digest is copied only when the lockfile already recorded one; see [Package digests](../DOCS.md#package-digests). The digest is the lockfile's integrity string. It is not a fetch of the URL, and it does not name the host.

## What a CDN URL becomes

This `package.json` declares a registry range. The lockfile points the same package at a CDN tarball and records `version` `1.3.0`:

```json
{
  "name": "cdn-fixture",
  "version": "1.0.0",
  "dependencies": {
    "left-pad": "^1.3.0"
  }
}
```

```json
{
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "cdn-fixture", "dependencies": { "left-pad": "^1.3.0" } },
    "node_modules/left-pad": {
      "version": "1.3.0",
      "resolved": "https://cdn.example/left-pad/-/left-pad-1.3.0.tgz",
      "integrity": "sha512-…"
    }
  }
}
```

`vg scan --offline --format json` writes this dependency. There is no `resolved` key and no URL:

```json
{
  "package": "left-pad",
  "section": "dependencies",
  "currentSpec": "^1.3.0",
  "resolvedVersion": "1.3.0"
}
```

`vg scan --vulns --offline --package-manifest` matches that row as:

```json
{
  "ecosystem": "npm",
  "package": "left-pad",
  "version": "1.3.0"
}
```

`vg sbom export` writes `purl` `pkg:npm/left-pad@1.3.0`. A recognized `integrity` value is copied to CycloneDX `hashes`. The CDN URL is omitted from both the CycloneDX and the SPDX document.

`vg build` writes an `external` node for the manifest name. The lockfile is not a node (lockfiles are skipped while the map is built). The node has no version and no URL:

```json
{
  "kind": "external",
  "name": "left-pad",
  "qualifiedName": "left-pad",
  "file": "",
  "lang": "external"
}
```

A second package that exists only under `node_modules/` in the lockfile, with `resolved` set to a CDN URL such as `https://cdn.jsdelivr.net/npm/nested-dep@9.9.9/nested-dep-9.9.9.tgz` and `version` `9.9.9`, is the same kind of record: purl `pkg:npm/nested-dep@9.9.9`. When a direct dependency's lockfile edge reaches it, `--vulns` reports it as transitive, `ecosystem` `npm`, `via` the direct package. The URL is not part of the match.

## Manifest specs that are not registry ranges

`vg scan` scores a Node dependency when the `package.json` spec is a semver range (including `*` and `latest`). These specs are handled on their own. The lockfile URL does not fill in a range for them.

| Spec in `package.json` | Scan row | Advisory target | Code-map `external` node |
| --- | --- | --- | --- |
| Semver range (`^1.3.0`) | `currentSpec` is the range. `resolvedVersion` is the lockfile version when that version is valid semver and still satisfies the range. | `npm` + name + `resolvedVersion`. | The name. |
| `workspace:*` | Row kept. `resolvedVersion` is `null`. `drift` is `unknown`. | Omitted. A null version is not a target. | The name, when the spec is under `dependencies`, `peerDependencies`, or `optionalDependencies`. |
| `file:`, `link:`, `git+`, `github:`, or any spec that contains `://` | No row. | Not a direct target. | The name, from those same three sections. The spec string is not stored on the node. |

`devDependencies` are scan rows (the `workspace:*` row above can come from that section). They are not code-map edges. `vg build` reads `dependencies`, `peerDependencies`, and `optionalDependencies`.

A `workspace:*` row exports as a purl with no version. `@my/lib` at `workspace:*` is `pkg:npm/%40my/lib`, CycloneDX `version` `unknown`, `vibgrate:currentSpec` `workspace:*`, `vibgrate:scope` `direct`. That purl names the package. It does not name an installed registry version. Leave it unmatched against an npm version range.

A URL spec such as `https://cdn.example/cdn-only-2.0.0.tgz` produces no scan row, so it is not a direct advisory target even when the manifest's advisory file has a vuln for that name. The lockfile can still list `node_modules/cdn-only` with `version` `2.0.0`. `vg sbom export` then includes `pkg:npm/cdn-only@2.0.0` as `transitive`. The component's version is the lockfile `version`. The URL spec is not copied onto the component.

## Lockfile entries the advisory graph drops

`vg scan --vulns` walks the npm-family lockfile for packages reachable from a direct dependency. That walk uses name and version. It skips entries that are not registry installs:

| Lockfile entry | Advisory graph | SBOM component list |
| --- | --- | --- |
| `package-lock.json` entry with `link: true` (a `file:` install) | Omitted. | Kept when the path is under `node_modules/` and `version` is a string. `file:../local-pkg` at version `0.1.0` is `pkg:npm/local-pkg@0.1.0`. The `resolved` value `file:../local-pkg` is omitted. |
| Path that is not under `node_modules/` (a workspace member such as `packages/web`, often `link: true`) | Omitted. | Omitted. The path does not match a `node_modules/<name>` install. |
| `resolved` URL and no `version` | Omitted. The version is not read from the URL or the filename. | Omitted. Same reason. |
| `yarn.lock` block whose header contains `@workspace:`, `@link:`, `@portal:`, or `@file:` | Omitted. | Kept when the block has a `version` line. `@my/lib@workspace:*` with version `0.0.0-use.local` is `pkg:npm/@my/lib@0.0.0-use.local`. The block's `resolved` URL is omitted. |
| `pnpm-lock.yaml` package key whose version is `link:`, `file:`, or `workspace:` | Omitted. | Omitted. |
| `pnpm-lock.yaml` `resolution.tarball` | Not read. The package key supplies the name and version. | Not read. `resolution.integrity` is the digest, when it is a recognized algorithm. |
| `git+` URL in `resolved`, with a numeric `version` | Kept. A direct dependency that edges to it is reported as transitive `npm` + that name + that version. | Kept. `pkg:npm/<name>@<version>`. The git URL is omitted. |

A `git+https://example.com/git-pkg.git` entry at version `3.1.4` was matched, in an offline scan, as `ecosystem` `npm`, `package` `git-pkg`, `version` `3.1.4`, `transitive` true. The same scan left the `link: true` package out of `extended.vulnerabilities.packages`. The advisory range is the npm range for that name and version. It is the range for the recorded coordinates. It does not assert that the bytes came from the npm registry. The CLI does not download the URL.

`extended.dependencyGraph` is a separate count. It lists lockfile entries that have a `version`, including `link: true`. The name is the install path with a leading `node_modules/` removed, so `packages/web` stays `packages/web` and is not replaced by the entry's `name` field. `totalUnique` counts those names. It is not a purl list. An entry that has a `resolved` URL and no `version` is absent from the count.

## Other ecosystems

The same rule applies where the lockfile carries a source URL. The URL is a known field, so it does not raise an unknown-field warning, and it is not copied into the component.

| Lockfile | URL-like field | What is kept |
| --- | --- | --- |
| `Cargo.lock` | `source` (a registry index URL, a `git+` URL, or absent for a path crate) | `name` and `version`. Ecosystem `rust`. Purl `pkg:cargo/<name>@<version>`. A git `source` and a path crate use that same purl type. `checksum` is the digest when it is 64 hex characters. |
| `poetry.lock`, `uv.lock` | `source` | `name` and `version`. Ecosystem `pypi`. |
| `Package.resolved` | `location` | `state.version`, keyed by `identity`. A pin with no `state.version` is skipped. `location` is not the version. |
| `packages.lock.json` (NuGet) | — | The field named `resolved` is the version string, not a URL. That string is the installed version. |

## Credentials stay out of identity

A userinfo segment on a lockfile `resolved` URL (`https://user:…@cdn.example/…`) was absent from the scan dependency rows, from `extended.vulnerabilities.packages`, from the CycloneDX and SPDX documents, and from the code map. The lockfile is not opened as a source document, so that URL is not in `graph.json`.

Two places do copy a URL that you wrote in `package.json`:

- The code map stores the manifest text on the `package.json` document node, in `doc`. A URL in the manifest is in that text because the file is source.
- When the dependency name is missing from the lockfile, and the spec is not `workspace:`, `extended.dependencyGraph.phantomDependencyDetails[].spec` is the manifest spec. A URL spec is copied in full, including userinfo. There is no warning code that redacts it.

Keep registry tokens out of manifests and lockfiles. An offline scan reads `--package-manifest` from disk and does not fetch the lockfile URL.

## When resolution metadata is incomplete

| Situation | Result | What to do |
| --- | --- | --- |
| Lockfile truncated or not valid syntax | The command fails. The error names the file and does not print the file. | Regenerate it with the package manager. See [Unknown lockfile fields](../DOCS.md#unknown-lockfile-fields). |
| `resolved` URL present, `version` absent | The package is absent from the scan row list, the advisory graph, the SBOM, and `extended.dependencyGraph`. No version is inferred from the URL. There is no separate warning code for that omission. | Regenerate the lockfile so the entry has a `version`. |
| `workspace:*` | `resolvedVersion` is `null`, `drift` is `unknown`, and the purl has no `@version`. | Treat it as a workspace member. It is not an npm version range. |
| URL, `file:`, `git+`, `link:`, or `github:` spec, and the name is absent from the lockfile | No dependency row. The name is a phantom dependency, and `spec` is the manifest string. | Install so the lockfile records a version, or drop the spec. Remove userinfo before committing the manifest. |
| Extra lockfile field this version does not know | One warning per field name. Names, versions, and known edges are kept. `resolved` is a known field, so a CDN URL does not warn. | See [Unknown lockfile fields](../DOCS.md#unknown-lockfile-fields). |
