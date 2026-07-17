/**
 * Maps a dependency name to the line it is declared on, inside a manifest.
 *
 * This is the one thing the scan engine cannot tell us: it reports *what* is
 * drifted, not *where the text is*. The editor needs a line to hang a
 * decoration, a hover, or a diagnostic on.
 *
 * Deliberately lexical, not a full parse. We are matching a declaration line in
 * a file the user is looking at; a tolerant regex over the exact text in the
 * editor buffer beats a parser that fails on a half-typed edit. If we can't
 * find a line, we return nothing and the surface silently doesn't render —
 * which is the correct failure mode for an ambient feature.
 */

export type ManifestKind =
  | 'package.json'
  | 'go.mod'
  | 'requirements.txt'
  | 'pyproject.toml'
  | 'Cargo.toml'
  | 'pom.xml'
  | 'build.gradle'
  | 'Gemfile'
  | 'composer.json'
  | 'pubspec.yaml'
  | 'mix.exs'
  | 'csproj'
  | 'Dockerfile'
  | 'unknown';

/** Classify a path so we know which matcher to use. Case-insensitive on the basename. */
export function manifestKind(filePath: string): ManifestKind {
  const base = (filePath.split(/[\\/]/).pop() ?? '').toLowerCase();
  if (base === 'package.json') return 'package.json';
  if (base === 'go.mod') return 'go.mod';
  if (base === 'requirements.txt' || /^requirements.*\.txt$/.test(base)) return 'requirements.txt';
  if (base === 'pyproject.toml') return 'pyproject.toml';
  if (base === 'cargo.toml') return 'Cargo.toml';
  if (base === 'pom.xml') return 'pom.xml';
  if (base === 'build.gradle' || base === 'build.gradle.kts') return 'build.gradle';
  if (base === 'gemfile') return 'Gemfile';
  if (base === 'composer.json') return 'composer.json';
  if (base === 'pubspec.yaml') return 'pubspec.yaml';
  if (base === 'mix.exs') return 'mix.exs';
  if (base.endsWith('.csproj') || base.endsWith('.fsproj') || base.endsWith('.vbproj')) return 'csproj';
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'Dockerfile';
  return 'unknown';
}

/** True when this file is one the LSP should attach surfaces to. */
export function isManifest(filePath: string): boolean {
  return manifestKind(filePath) !== 'unknown';
}

/** Escape a package name for safe embedding in a RegExp. */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the 0-based line index on which `pkg` is declared in `text`.
 * Returns -1 when not found.
 */
export function findPackageLine(text: string, pkg: string, kind: ManifestKind): number {
  const lines = text.split(/\r?\n/);
  const p = esc(pkg);

  // Ordered candidate matchers. The first that hits wins.
  const patterns: RegExp[] = (() => {
    switch (kind) {
      case 'package.json':
      case 'composer.json':
        // "react": "^17.0.2"   — the key, quoted, followed by a colon
        return [new RegExp(`^\\s*"${p}"\\s*:`)];

      case 'go.mod':
        // 	github.com/foo/bar v1.2.3      (inside a require block, or `require x v1`)
        return [new RegExp(`^\\s*(?:require\\s+)?${p}\\s+v?\\d`)];

      case 'requirements.txt':
        // requests==2.31.0 · requests>=2 · requests[security]==2 · requests
        return [new RegExp(`^\\s*${p}\\s*(?:\\[[^\\]]*\\])?\\s*(?:[=<>!~]|$)`, 'i')];

      case 'pyproject.toml':
      case 'Cargo.toml':
        // foo = "1.2" · foo = { version = "1.2" } · "foo>=1.2" (poetry/pep621 arrays)
        return [
          new RegExp(`^\\s*${p}\\s*=`),
          new RegExp(`^\\s*"${p}\\s*(?:[=<>!~\\[]|")`),
        ];

      case 'pom.xml':
        // <artifactId>spring-boot</artifactId>
        return [new RegExp(`<artifactId>\\s*${p}\\s*</artifactId>`)];

      case 'build.gradle':
        // implementation 'com.foo:bar:1.2'  ·  implementation("com.foo:bar:1.2")
        return [new RegExp(`["']${p}(?:["':])`)];

      case 'Gemfile':
        // gem 'rails', '~> 7.0'
        return [new RegExp(`^\\s*gem\\s+["']${p}["']`)];

      case 'pubspec.yaml':
        return [new RegExp(`^\\s*${p}\\s*:`)];

      case 'mix.exs':
        // {:phoenix, "~> 1.7"}
        return [new RegExp(`\\{\\s*:${p}\\s*,`)];

      case 'csproj':
        // <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />
        return [new RegExp(`Include\\s*=\\s*"${p}"`, 'i')];

      case 'Dockerfile':
        // FROM node:18-alpine   — the "package" here is the base image
        return [new RegExp(`^\\s*FROM\\s+.*${p}`, 'i')];

      default:
        return [];
    }
  })();

  for (const re of patterns) {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) return i;
    }
  }

  return -1;
}

/**
 * The line a *runtime* constraint sits on — `engines.node`, `go 1.21`,
 * `<java.version>`, `FROM node:18`. Used to place the EOL-runtime diagnostic on
 * the actual offending line instead of dumping it at the top of the file.
 * Returns -1 when we can't place it (caller falls back to line 0).
 */
export function findRuntimeLine(text: string, kind: ManifestKind): number {
  const lines = text.split(/\r?\n/);
  const patterns: RegExp[] = (() => {
    switch (kind) {
      case 'package.json':
        return [/^\s*"node"\s*:/, /^\s*"engines"\s*:/];
      case 'go.mod':
        return [/^\s*go\s+\d/];
      case 'pyproject.toml':
        return [/^\s*(?:requires-python|python)\s*=/];
      case 'pom.xml':
        return [/<(?:java\.version|maven\.compiler\.(?:source|target|release))>/];
      case 'build.gradle':
        return [/(?:sourceCompatibility|targetCompatibility|JavaVersion)/];
      case 'csproj':
        return [/<TargetFrameworks?>/i];
      case 'Dockerfile':
        return [/^\s*FROM\s+/i];
      default:
        return [];
    }
  })();

  for (const re of patterns) {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) return i;
    }
  }

  return -1;
}

/** The end-of-line column for a given line — where an `after` decoration lands. */
export function endOfLine(text: string, line: number): number {
  const lines = text.split(/\r?\n/);
  return (lines[line] ?? '').length;
}
