// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import * as semver from 'semver';
import { XMLParser } from 'fast-xml-parser';
import { findFiles, findSolutionFiles, pathExists, readTextFile, FileCache } from '../utils/fs.js';
import { withTimeout } from '../utils/timeout.js';
import { NuGetCache } from './nuget-cache.js';
import { latestStable, runtimeEolStatus, extractCycle, eolDate } from '../runtimes/catalog.js';
import { BUNDLED_RUNTIME_CATALOG } from '../runtimes/snapshot.js';
import type { RuntimeCatalog } from '../runtimes/types.js';
import type { ProjectScan, DependencyRow, DetectedFramework, ProjectReference } from '../types.js';
import { compareCodeUnits } from '../utils/code-unit.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

/** Known .NET framework packages to track */
const KNOWN_DOTNET_FRAMEWORKS: Record<string, string> = {
  // ── ASP.NET Core & Web ──
  'Microsoft.AspNetCore.App': 'ASP.NET Core',
  'Microsoft.AspNetCore.Mvc': 'ASP.NET Core MVC',
  'Microsoft.AspNetCore.Components': 'Blazor',
  'Microsoft.AspNetCore.Components.WebAssembly': 'Blazor WASM',
  'Microsoft.AspNetCore.SignalR': 'SignalR',
  'Microsoft.AspNetCore.OData': 'OData',
  'Microsoft.AspNetCore.Identity': 'ASP.NET Identity',
  'Microsoft.AspNetCore.Authentication.JwtBearer': 'JWT Bearer Auth',
  'Microsoft.AspNetCore.Diagnostics.HealthChecks': 'Health Checks',
  'Swashbuckle.AspNetCore': 'Swashbuckle',
  'NSwag.AspNetCore': 'NSwag',

  // ── Entity Framework & Data Access ──
  'Microsoft.EntityFrameworkCore': 'EF Core',
  'Microsoft.EntityFrameworkCore.SqlServer': 'EF Core SQL Server',
  'Microsoft.EntityFrameworkCore.Sqlite': 'EF Core SQLite',
  'Microsoft.EntityFrameworkCore.Design': 'EF Core Design',
  'Microsoft.EntityFrameworkCore.Tools': 'EF Core Tools',
  'Npgsql.EntityFrameworkCore.PostgreSQL': 'EF Core PostgreSQL',
  'Pomelo.EntityFrameworkCore.MySql': 'EF Core MySQL (Pomelo)',
  'MongoDB.EntityFrameworkCore': 'EF Core MongoDB',
  'Dapper': 'Dapper',
  'Dapper.Contrib': 'Dapper Contrib',
  'NHibernate': 'NHibernate',
  'Npgsql': 'Npgsql',
  'MySqlConnector': 'MySqlConnector',
  'MongoDB.Driver': 'MongoDB Driver',
  'StackExchange.Redis': 'StackExchange.Redis',
  'Microsoft.Data.SqlClient': 'SqlClient',
  'Oracle.ManagedDataAccess.Core': 'Oracle (Managed)',
  'Cassandra': 'Cassandra Driver',
  'Neo4j.Driver': 'Neo4j Driver',
  'Marten': 'Marten',
  'LiteDB': 'LiteDB',
  'RavenDB.Client': 'RavenDB',

  // ── Hosting & Configuration ──
  // All Microsoft.Extensions.* and System.* packages that ship as part of the
  // .NET SDK release train are prefixed with '.NET ' so that the dashboard can
  // group them under a single '.NET X.Y.Z → A.B.C' header when they all move
  // together (e.g. .NET 8 → 10 upgrade).
  'Microsoft.Extensions.Hosting': '.NET Hosting',
  'Microsoft.Extensions.Hosting.Abstractions': '.NET Hosting Abstractions',
  'Microsoft.Extensions.DependencyInjection': '.NET DI',
  'Microsoft.Extensions.DependencyInjection.Abstractions': '.NET DI Abstractions',
  'Microsoft.Extensions.Configuration': '.NET Configuration',
  'Microsoft.Extensions.Configuration.Abstractions': '.NET Configuration Abstractions',
  'Microsoft.Extensions.Configuration.Binder': '.NET Configuration Binder',
  'Microsoft.Extensions.Configuration.EnvironmentVariables': '.NET Configuration EnvVars',
  'Microsoft.Extensions.Configuration.Json': '.NET Configuration JSON',
  'Microsoft.Extensions.Configuration.UserSecrets': '.NET Configuration UserSecrets',
  'Microsoft.Extensions.Logging': '.NET Logging',
  'Microsoft.Extensions.Logging.Abstractions': '.NET Logging Abstractions',
  'Microsoft.Extensions.Logging.Console': '.NET Logging Console',
  'Microsoft.Extensions.Logging.Debug': '.NET Logging Debug',
  'Microsoft.Extensions.Logging.EventSource': '.NET Logging EventSource',
  'Microsoft.Extensions.Options': '.NET Options',
  'Microsoft.Extensions.Options.ConfigurationExtensions': '.NET Options Configuration',
  'Microsoft.Extensions.Options.DataAnnotations': '.NET Options DataAnnotations',
  'Microsoft.Extensions.Caching.Memory': '.NET Memory Cache',
  'Microsoft.Extensions.Caching.Abstractions': '.NET Caching Abstractions',
  'Microsoft.Extensions.Caching.StackExchangeRedis': '.NET Redis Cache',
  'Microsoft.Extensions.Http': '.NET HttpClientFactory',
  'Microsoft.Extensions.Http.Resilience': '.NET HttpClient Resilience',
  'Microsoft.Extensions.Resilience': '.NET Resilience',
  'Microsoft.Extensions.Diagnostics': '.NET Diagnostics',
  'Microsoft.Extensions.Diagnostics.HealthChecks': '.NET Health Checks (Extensions)',
  'Microsoft.Extensions.Diagnostics.HealthChecks.Abstractions': '.NET Health Checks Abstractions',
  'Microsoft.Extensions.FileProviders.Abstractions': '.NET File Providers',
  'Microsoft.Extensions.FileProviders.Physical': '.NET File Providers Physical',
  'Microsoft.Extensions.Localization': '.NET Localization',
  'Microsoft.Extensions.Localization.Abstractions': '.NET Localization Abstractions',
  'Microsoft.Extensions.Primitives': '.NET Primitives',
  // System.* packages that ship with the .NET SDK
  'System.Text.Json': '.NET System.Text.Json',
  'System.Text.Encodings.Web': '.NET System.Text.Encodings.Web',
  'System.Net.Http.Json': '.NET System.Net.Http.Json',
  'System.ComponentModel.Annotations': '.NET ComponentModel Annotations',

  // ── CQRS & Mediator ──
  'MediatR': 'MediatR',
  'Wolverine': 'Wolverine',
  'Brighter': 'Brighter',

  // ── Mapping ──
  'AutoMapper': 'AutoMapper',
  'Mapster': 'Mapster',
  'Riok.Mapperly': 'Mapperly',

  // ── Validation ──
  'FluentValidation': 'FluentValidation',
  'FluentValidation.AspNetCore': 'FluentValidation ASP.NET',

  // ── Serialization ──
  'Newtonsoft.Json': 'Newtonsoft.Json',
  // Note: System.Text.Json is defined above under '── Hosting & Configuration ──'
  // as a .NET platform package so it groups with other .NET SDK packages.
  'MessagePack': 'MessagePack',
  'protobuf-net': 'protobuf-net',
  'CsvHelper': 'CsvHelper',

  // ── Logging & Observability ──
  'Serilog': 'Serilog',
  'Serilog.AspNetCore': 'Serilog ASP.NET',
  'Serilog.Sinks.Console': 'Serilog Console',
  'Serilog.Sinks.Seq': 'Serilog Seq',
  'Serilog.Sinks.File': 'Serilog File',
  'Serilog.Sinks.Elasticsearch': 'Serilog Elasticsearch',
  'NLog': 'NLog',
  'NLog.Web.AspNetCore': 'NLog ASP.NET',
  'log4net': 'log4net',
  'OpenTelemetry': 'OpenTelemetry',
  'OpenTelemetry.Extensions.Hosting': 'OpenTelemetry Hosting',
  'OpenTelemetry.Instrumentation.AspNetCore': 'OpenTelemetry ASP.NET',
  'OpenTelemetry.Exporter.Prometheus': 'OpenTelemetry Prometheus',
  'OpenTelemetry.Exporter.Jaeger': 'OpenTelemetry Jaeger',
  'OpenTelemetry.Exporter.OpenTelemetryProtocol': 'OpenTelemetry OTLP',
  'App.Metrics': 'App.Metrics',
  'prometheus-net': 'Prometheus.NET',
  'Elastic.Apm': 'Elastic APM',

  // ── Testing ──
  'xunit': 'xUnit',
  'xunit.runner.visualstudio': 'xUnit Runner',
  'NUnit': 'NUnit',
  'NUnit3TestAdapter': 'NUnit Adapter',
  'MSTest.TestFramework': 'MSTest',
  'MSTest.TestAdapter': 'MSTest Adapter',
  'Moq': 'Moq',
  'NSubstitute': 'NSubstitute',
  'FakeItEasy': 'FakeItEasy',
  'FluentAssertions': 'FluentAssertions',
  'Shouldly': 'Shouldly',
  'Bogus': 'Bogus',
  'AutoFixture': 'AutoFixture',
  'WireMock.Net': 'WireMock.Net',
  'Testcontainers': 'Testcontainers',
  'Respawn': 'Respawn',
  'BenchmarkDotNet': 'BenchmarkDotNet',
  'coverlet.collector': 'Coverlet',
  'SpecFlow': 'SpecFlow',
  'TUnit': 'TUnit',
  'Verify.Xunit': 'Verify',
  'Snapshooter': 'Snapshooter',

  // ── Messaging & Event Bus ──
  'MassTransit': 'MassTransit',
  'MassTransit.RabbitMQ': 'MassTransit RabbitMQ',
  'MassTransit.Azure.ServiceBus.Core': 'MassTransit Azure SB',
  'NServiceBus': 'NServiceBus',
  'RabbitMQ.Client': 'RabbitMQ Client',
  'Confluent.Kafka': 'Confluent Kafka',
  'Azure.Messaging.ServiceBus': 'Azure Service Bus',
  'Azure.Messaging.EventHubs': 'Azure Event Hubs',
  'Amazon.SQS': 'AWS SQS',
  'Amazon.SNS': 'AWS SNS',
  'Rebus': 'Rebus',
  'EasyNetQ': 'EasyNetQ',
  'SlimMessageBus': 'SlimMessageBus',
  'CAP': 'DotNetCore.CAP',

  // ── Cloud SDKs ──
  'AWSSDK.Core': 'AWS SDK Core',
  'AWSSDK.S3': 'AWS SDK S3',
  'AWSSDK.SQS': 'AWS SDK SQS',
  'AWSSDK.DynamoDBv2': 'AWS SDK DynamoDB',
  'AWSSDK.Lambda': 'AWS SDK Lambda',
  'AWSSDK.SecretsManager': 'AWS SDK Secrets Manager',
  'AWSSDK.CloudWatch': 'AWS SDK CloudWatch',
  'Azure.Storage.Blobs': 'Azure Blob Storage',
  'Azure.Identity': 'Azure Identity',
  'Azure.Security.KeyVault.Secrets': 'Azure Key Vault',
  'Azure.Cosmos': 'Azure Cosmos DB',
  'Microsoft.Azure.Functions.Worker': 'Azure Functions',
  'Google.Cloud.Storage.V1': 'GCP Storage',
  'Google.Cloud.PubSub.V1': 'GCP Pub/Sub',
  'Google.Cloud.Firestore': 'GCP Firestore',

  // ── Auth & Identity ──
  'Microsoft.Identity.Web': 'Microsoft Identity Web',
  'Microsoft.Identity.Client': 'MSAL',
  'IdentityServer4': 'IdentityServer4',
  'Duende.IdentityServer': 'Duende IdentityServer',
  'Microsoft.AspNetCore.Authentication.OpenIdConnect': 'OpenID Connect',
  'IdentityModel': 'IdentityModel',

  // ── HTTP & API ──
  'Refit': 'Refit',
  'RestSharp': 'RestSharp',
  'Flurl.Http': 'Flurl',
  'Polly': 'Polly',
  'Polly.Extensions.Http': 'Polly HTTP',
  'Microsoft.Extensions.Http.Polly': 'HttpClient Polly',
  'Grpc.AspNetCore': 'gRPC ASP.NET',
  'Grpc.Net.Client': 'gRPC Client',
  'GraphQL.Server.All': 'GraphQL Server',
  'HotChocolate.AspNetCore': 'Hot Chocolate (GraphQL)',

  // ── Background Processing ──
  'Hangfire': 'Hangfire',
  'Hangfire.Core': 'Hangfire Core',
  'Hangfire.AspNetCore': 'Hangfire ASP.NET',
  'Quartz': 'Quartz.NET',
  'Quartz.Extensions.Hosting': 'Quartz.NET Hosting',
  'Coravel': 'Coravel',

  // ── File & Document ──
  'EPPlus': 'EPPlus',
  'ClosedXML': 'ClosedXML',
  'iTextSharp': 'iTextSharp',
  'QuestPDF': 'QuestPDF',
  'ImageSharp': 'ImageSharp',
  'SixLabors.ImageSharp': 'ImageSharp',

  // ── Feature Flags & Config ──
  'LaunchDarkly.ServerSdk': 'LaunchDarkly',
  'Microsoft.FeatureManagement': 'Feature Management',
  'Microsoft.FeatureManagement.AspNetCore': 'Feature Management ASP.NET',

  // ── Microservices & Distributed ──
  'Dapr.Client': 'Dapr',
  'Steeltoe.Discovery.ClientCore': 'Steeltoe',
  'Ocelot': 'Ocelot (API Gateway)',
  'Yarp.ReverseProxy': 'YARP',

  // ── Real-time ──
  'Microsoft.AspNetCore.SignalR.Client': 'SignalR Client',
};

// Latest .NET major version is resolved at scan time — see runtime-baselines.ts

/** Normalize a file system path to always use forward slashes */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Parse target framework moniker to a major version number */
function parseTfmMajor(tfm: string): number | null {
  // net9.0, net8.0, net7.0, net6.0
  const match = tfm.match(/^net(\d+)\.\d+$/);
  if (match?.[1]) return parseInt(match[1], 10);

  // netcoreapp3.1, etc
  const coreMatch = tfm.match(/^netcoreapp(\d+)\.\d+$/);
  if (coreMatch?.[1]) return parseInt(coreMatch[1], 10);

  // netstandard2.0 → treat as legacy
  if (tfm.startsWith('netstandard')) return null;

  // net48, net472 → .NET Framework (legacy)
  const fxMatch = tfm.match(/^net(\d)(\d+)?$/);
  if (fxMatch) return null; // Legacy .NET Framework, can't compare to modern

  return null;
}


/**
 * `.sqlproj` (SQL Server Database Projects — SSDT) are recognized alongside
 * `.csproj`/`.vbproj` so they are discovered and classified as a project
 * (name, path) like any other .NET-tooling project, giving them at least
 * baseline visibility even though they rarely declare NuGet
 * `<PackageReference>`s the way app projects do (dependency drift naturally
 * reads as zero/unknown for them, which the scanner already handles for any
 * project with no package references). The database-schema scanner
 * separately globs `.sql` table-definition scripts under a `.sqlproj`'s
 * directory tree and parses them structurally.
 */
function isDotnetProjectFile(name: string): boolean {
  return name.endsWith('.csproj') || name.endsWith('.vbproj') || name.endsWith('.sqlproj');
}

function stripDotnetProjectExtension(filePath: string): string {
  return path.basename(filePath).replace(/\.(cs|vb|sql)proj$/i, '');
}

/**
 * NuGet Central Package Management file. The nearest one between a project
 * and the scan root supplies `PackageVersion` pins.
 */
const CENTRAL_PACKAGE_PROPS = 'Directory.Packages.props';

/**
 * MSBuild `Directory.Build.props`. The nearest one between a project and the
 * scan root (both included) supplies `TargetFramework` / `TargetFrameworks`
 * when the project file sets neither. A value in the project file wins. The
 * nearest props file wins; imports inside it are not followed. A value that
 * contains `$(` is an unresolved property reference and is not a framework.
 */
const DIRECTORY_BUILD_PROPS = 'Directory.Build.props';

/**
 * A `PackageReference` whose version is not on the element, not in
 * `VersionOverride`, and not in `Directory.Packages.props`. Scan and SBOM
 * keep the row and say the version is unknown.
 */
const UNKNOWN_PACKAGE_VERSION = 'unknown';

interface PackageReferenceRow {
  name: string;
  /** Inline `Version`, or the resolved version after central lookup. */
  version: string;
  /** `VersionOverride` on the reference. Empty when the reference has none. */
  versionOverride: string;
  /**
   * True only when every `PrivateAssets` value on this reference is `all`
   * (trimmed, any letter case). A missing value, or any other value, is a
   * production reference.
   */
  devOnly: boolean;
}

interface CsprojData {
  targetFrameworks: string[];
  packageReferences: PackageReferenceRow[];
  projectReferences: string[];
  projectName: string;
}

function appendScalarText(raw: unknown, out: string[]): void {
  if (raw == null) return;
  if (Array.isArray(raw)) {
    for (const item of raw) appendScalarText(item, out);
    return;
  }
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    out.push(String(raw));
    return;
  }
  if (typeof raw === 'object' && '#text' in raw) {
    appendScalarText((raw as { '#text'?: unknown })['#text'], out);
  }
}

function asRecords(raw: unknown): Record<string, unknown>[] {
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
}

function childValue(node: Record<string, unknown>, name: string): unknown {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_')) continue;
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

/** First non-empty attribute, then the first non-empty child element. Names match without regard to case. */
function xmlScalar(node: Record<string, unknown>, name: string): string {
  const target = name.toLowerCase();
  const attributes: string[] = [];
  const elements: string[] = [];
  for (const [key, raw] of Object.entries(node)) {
    const isAttr = key.startsWith('@_');
    const bare = isAttr ? key.slice(2) : key;
    if (bare.toLowerCase() !== target) continue;
    appendScalarText(raw, isAttr ? attributes : elements);
  }
  for (const value of [...attributes, ...elements]) {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function isWithinRoot(dir: string, rootDir: string): boolean {
  const current = path.resolve(dir);
  const root = path.resolve(rootDir);
  if (current === root) return true;
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return current.startsWith(prefix);
}

/**
 * `PackageVersion` items from a `Directory.Packages.props`. The map key is
 * the package id in lower case; the first item for that id wins. Element
 * and attribute names match without regard to case. A bad file yields an
 * empty map so the project is still scanned.
 */
function parseDirectoryPackagesProps(xml: string): Map<string, string> {
  const versions = new Map<string, string>();
  if (!xml.trim()) return versions;
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    return versions;
  }
  if (!parsed || typeof parsed !== 'object') return versions;
  const project = childValue(parsed as Record<string, unknown>, 'Project');
  for (const projectNode of asRecords(project)) {
    for (const group of asRecords(childValue(projectNode, 'ItemGroup'))) {
      for (const item of asRecords(childValue(group, 'PackageVersion'))) {
        const name = xmlScalar(item, 'Include');
        const version = xmlScalar(item, 'Version');
        if (!name || !version) continue;
        const key = name.toLowerCase();
        if (!versions.has(key)) versions.set(key, version);
      }
    }
  }
  return versions;
}

/**
 * `VersionOverride` wins, then an inline `Version`, then the central
 * `PackageVersion` for that id. Otherwise the row stays, with an unknown
 * version.
 */
function resolvePackageVersion(row: PackageReferenceRow, central: ReadonlyMap<string, string>): string {
  if (row.versionOverride) return row.versionOverride;
  if (row.version) return row.version;
  return central.get(row.name.toLowerCase()) ?? UNKNOWN_PACKAGE_VERSION;
}

async function nearestAncestorFile(
  startDir: string,
  rootDir: string,
  fileName: string,
  exists: (filePath: string) => Promise<boolean>,
): Promise<string | null> {
  let current = path.resolve(startDir);
  const root = path.resolve(rootDir);
  for (;;) {
    if (!isWithinRoot(current, root)) return null;
    const candidate = path.join(current, fileName);
    if (await exists(candidate)) return candidate;
    if (current === root) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function nearestDirectoryPackagesProps(
  projectDir: string,
  rootDir: string,
  exists: (filePath: string) => Promise<boolean>,
): Promise<string | null> {
  return nearestAncestorFile(projectDir, rootDir, CENTRAL_PACKAGE_PROPS, exists);
}

/**
 * Monikers from one property value. Semicolon-separated lists are split.
 * A token that contains `$(` is an MSBuild property reference (`$(DefaultTfm)`)
 * and is dropped rather than reported as a framework.
 */
function concreteTargetFrameworks(raw: string): string[] {
  if (!raw) return [];
  const frameworks: string[] = [];
  for (const part of raw.split(';')) {
    const tfm = part.trim();
    if (!tfm || tfm.includes('$(')) continue;
    frameworks.push(tfm);
  }
  return frameworks;
}

/**
 * `TargetFramework`, then `TargetFrameworks`, from each `PropertyGroup`.
 * Element names match without regard to case. The first concrete moniker
 * for a repeated value wins.
 */
function targetFrameworksInProject(project: unknown): string[] {
  const targetFrameworks: string[] = [];
  for (const projectNode of asRecords(project)) {
    for (const group of asRecords(childValue(projectNode, 'PropertyGroup'))) {
      targetFrameworks.push(...concreteTargetFrameworks(xmlScalar(group, 'TargetFramework')));
      targetFrameworks.push(...concreteTargetFrameworks(xmlScalar(group, 'TargetFrameworks')));
    }
  }
  return [...new Set(targetFrameworks)];
}

/**
 * Target frameworks from a `Directory.Build.props`. A missing, empty, or
 * malformed file yields an empty list so the project is still scanned.
 */
function parseDirectoryBuildProps(xml: string): string[] {
  if (!xml.trim()) return [];
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  return targetFrameworksInProject(childValue(parsed as Record<string, unknown>, 'Project'));
}

async function directoryBuildTargetFrameworks(
  projectDir: string,
  rootDir: string,
  cache: FileCache | undefined,
  parsed: Map<string, string[]>,
): Promise<string[]> {
  const exists = (filePath: string) => (cache ? cache.pathExists(filePath) : pathExists(filePath));
  const readText = (filePath: string) => (cache ? cache.readTextFile(filePath) : readTextFile(filePath));
  const propsPath = await nearestAncestorFile(projectDir, rootDir, DIRECTORY_BUILD_PROPS, exists);
  if (!propsPath) return [];
  const cached = parsed.get(propsPath);
  if (cached) return cached.slice();
  let frameworks: string[] = [];
  try {
    frameworks = parseDirectoryBuildProps(await readText(propsPath));
  } catch {
    frameworks = [];
  }
  parsed.set(propsPath, frameworks);
  return frameworks.slice();
}

async function centralPackageVersions(
  projectDir: string,
  rootDir: string,
  cache: FileCache | undefined,
  parsed: Map<string, Map<string, string>>,
): Promise<Map<string, string>> {
  const exists = (filePath: string) => (cache ? cache.pathExists(filePath) : pathExists(filePath));
  const readText = (filePath: string) => (cache ? cache.readTextFile(filePath) : readTextFile(filePath));
  const propsPath = await nearestDirectoryPackagesProps(projectDir, rootDir, exists);
  if (!propsPath) return new Map();
  const cached = parsed.get(propsPath);
  if (cached) return cached;
  let versions = new Map<string, string>();
  try {
    versions = parseDirectoryPackagesProps(await readText(propsPath));
  } catch {
    versions = new Map();
  }
  parsed.set(propsPath, versions);
  return versions;
}

/**
 * `PrivateAssets="all"` and `<PrivateAssets>all</PrivateAssets>` are
 * build-time-only references (SourceLink, analyzers, MinVer,
 * coverlet.collector). The attribute or element name and the value are
 * compared without regard to case. Only a trimmed value of `all` counts.
 * `compile` and every other token stay production.
 */
function privateAssetsIsAll(ref: Record<string, unknown>): boolean {
  const values: string[] = [];
  for (const [key, raw] of Object.entries(ref)) {
    const bare = key.startsWith('@_') ? key.slice(2) : key;
    if (bare.toLowerCase() !== 'privateassets') continue;
    appendScalarText(raw, values);
  }
  return values.length > 0 && values.every((value) => value.trim().toLowerCase() === 'all');
}

/**
 * One row per package id (NuGet ids are case-insensitive). A reference that
 * is not `PrivateAssets=all` keeps the package in production, and that
 * production reference supplies the version. The first production row wins.
 * Two build-time-only rows keep the first version.
 */
function addPackageReference(rows: PackageReferenceRow[], next: PackageReferenceRow): void {
  const existing = rows.find((row) => row.name.toLowerCase() === next.name.toLowerCase());
  if (!existing) {
    rows.push(next);
    return;
  }
  if (existing.devOnly && !next.devOnly) {
    existing.version = next.version;
    existing.versionOverride = next.versionOverride;
    existing.devOnly = false;
  }
}

function dependencySection(ref: PackageReferenceRow): 'dependencies' | 'devDependencies' {
  return ref.devOnly ? 'devDependencies' : 'dependencies';
}

function parseDotnetProjectFile(xml: string, filePath: string): CsprojData {
  const parsed = parser.parse(xml);
  const project = parsed?.Project;
  if (!project) {
    return { targetFrameworks: [], packageReferences: [], projectReferences: [], projectName: stripDotnetProjectExtension(filePath) };
  }

  const targetFrameworks = targetFrameworksInProject(project);

  // Extract package references and project references
  const itemGroups = Array.isArray(project.ItemGroup)
    ? project.ItemGroup
    : project.ItemGroup ? [project.ItemGroup] : [];

  const packageReferences: PackageReferenceRow[] = [];
  const projectReferences: string[] = [];

  for (const ig of itemGroups) {
    // Package references
    const pkgRefs = Array.isArray(ig.PackageReference)
      ? ig.PackageReference
      : ig.PackageReference ? [ig.PackageReference] : [];

    for (const ref of pkgRefs) {
      if (!ref || typeof ref !== 'object') continue;
      const record = ref as Record<string, unknown>;
      const name = xmlScalar(record, 'Include');
      if (!name) continue;
      // A missing Version is kept. Central Package Management stores it in
      // Directory.Packages.props; VersionOverride is applied later.
      addPackageReference(packageReferences, {
        name,
        version: xmlScalar(record, 'Version'),
        versionOverride: xmlScalar(record, 'VersionOverride'),
        devOnly: privateAssetsIsAll(record),
      });
    }

    // Project references (internal dependencies)
    const projRefs = Array.isArray(ig.ProjectReference)
      ? ig.ProjectReference
      : ig.ProjectReference ? [ig.ProjectReference] : [];

    for (const ref of projRefs) {
      const include = ref['@_Include'] ?? ref['@_include'] ?? '';
      if (include) {
        // Convert Windows backslashes to forward slashes
        projectReferences.push(String(include).replace(/\\/g, '/'));
      }
    }
  }

  return {
    targetFrameworks: [...new Set(targetFrameworks)],
    packageReferences,
    projectReferences,
    projectName: stripDotnetProjectExtension(filePath),
  };
}

/**
 * Parse a legacy `packages.config` (pre-SDK NuGet format) into the same
 * `{ name, version, devOnly }` shape as SDK-style `<PackageReference>`s.
 * `packages.config` has no `PrivateAssets`, so every row is production.
 *
 * ```xml
 * <packages>
 *   <package id="EntityFramework" version="6.2.0" targetFramework="net48" />
 * </packages>
 * ```
 *
 * Non-SDK .csproj/.vbproj projects (WebForms, WCF, classic MVC5, EF6 estates)
 * declare their NuGet dependencies here instead of in the project file, so
 * without this they would surface zero dependencies and escape drift scoring.
 */
function parsePackagesConfig(xml: string): PackageReferenceRow[] {
  const parsed = parser.parse(xml);
  const root = parsed?.packages;
  if (!root) return [];

  const pkgs = Array.isArray(root.package) ? root.package : root.package ? [root.package] : [];
  const out: PackageReferenceRow[] = [];
  for (const pkg of pkgs) {
    const name = pkg['@_id'] ?? pkg['@_Id'] ?? '';
    const version = pkg['@_version'] ?? pkg['@_Version'] ?? '';
    if (name && version) {
      out.push({ name: String(name), version: String(version), versionOverride: '', devOnly: false });
    }
  }
  return out;
}

export async function scanDotnetProjects(rootDir: string, nugetCache?: NuGetCache, cache?: FileCache, projectScanTimeout?: number, catalog: RuntimeCatalog = BUNDLED_RUNTIME_CATALOG): Promise<ProjectScan[]> {
  const projectFiles = cache
    ? await cache.findFiles(rootDir, isDotnetProjectFile)
    : await findFiles(rootDir, isDotnetProjectFile);
  // Also check for .sln files to discover associated projects
  const slnFiles = cache
    ? await cache.findSolutionFiles(rootDir)
    : await findSolutionFiles(rootDir);

  // If we found .sln files, parse them to find associated .csproj/.vbproj files
  const slnProjectPaths = new Set<string>();
  for (const slnPath of slnFiles) {
    try {
      const slnContent = cache
        ? await cache.readTextFile(slnPath)
        : await readTextFile(slnPath);
      const slnDir = path.dirname(slnPath);
      // Parse .sln for project entries: Project("...") = "Name", "Path.csproj|vbproj|sqlproj", ...
      const projectRegex = /Project\("[^"]*"\)\s*=\s*"[^"]*",\s*"([^"]+\.(?:cs|vb|sql)proj)"/g;
      let match;
      while ((match = projectRegex.exec(slnContent)) !== null) {
        if (match[1]) {
          const csprojPath = path.resolve(slnDir, match[1].replace(/\\/g, '/'));
          slnProjectPaths.add(csprojPath);
        }
      }
    } catch {
      // ignore unreadable .sln
    }
  }

  // Merge discovered dotnet project files
  const allCsprojFiles = new Set([...projectFiles, ...slnProjectPaths]);
  const results: ProjectScan[] = [];
  const centralVersions = new Map<string, Map<string, string>>();
  const buildPropsFrameworks = new Map<string, string[]>();

  const STUCK_TIMEOUT_MS = projectScanTimeout ?? cache?.projectScanTimeout ?? 180_000;

  for (const csprojPath of allCsprojFiles) {
    try {
      const scanPromise = scanOneDotnetProjectFile(
        csprojPath,
        rootDir,
        nugetCache,
        cache,
        catalog,
        centralVersions,
        buildPropsFrameworks,
      );
      const result = await withTimeout(scanPromise, STUCK_TIMEOUT_MS);
      if (result.ok) {
        results.push(result.value);
      } else {
        // Timed out — record stuck path for auto-exclude
        const relPath = normalizePath(path.relative(rootDir, path.dirname(csprojPath)));
        if (cache) {
          cache.addStuckPath(relPath || '.');
        }
        console.error(`Timeout scanning ${csprojPath} (>${STUCK_TIMEOUT_MS / 1000}s) — skipped`);
        if (cache?.shouldShowTimeoutHint()) {
          console.error(`  Tip: increase projectScanTimeout in vibgrate.config.ts (or --project-scan-timeout <seconds>) for large projects`);
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error scanning ${csprojPath}: ${msg}`);
    }
  }

  return results;
}

async function scanOneDotnetProjectFile(
  csprojPath: string,
  rootDir: string,
  nugetCache: NuGetCache | undefined,
  cache: FileCache | undefined,
  catalog: RuntimeCatalog,
  centralVersions: Map<string, Map<string, string>>,
  buildPropsFrameworks: Map<string, string[]>,
): Promise<ProjectScan> {
  const xml = cache
    ? await cache.readTextFile(csprojPath)
    : await readTextFile(csprojPath);
  const data = parseDotnetProjectFile(xml, csprojPath);
  const csprojDir = path.dirname(csprojPath);
  // A concrete moniker in the project file wins. Otherwise take the nearest
  // Directory.Build.props, which is where many solutions set TargetFramework
  // once for every project.
  if (data.targetFrameworks.length === 0) {
    data.targetFrameworks = await directoryBuildTargetFrameworks(csprojDir, rootDir, cache, buildPropsFrameworks);
  }
  const central = await centralPackageVersions(csprojDir, rootDir, cache, centralVersions);
  for (const row of data.packageReferences) {
    row.version = resolvePackageVersion(row, central);
  }

  // Legacy NuGet: non-SDK projects keep their dependencies in a sibling
  // `packages.config` rather than in <PackageReference>. Merge those in so
  // .NET Framework estates are scored for dependency drift too. SDK-style
  // references take precedence on name collisions (rare — projects use one
  // format or the other): a resolved PackageReference version is kept.
  // packages.config fills a reference that stayed unknown, and it has no
  // PrivateAssets, so that name is not build-time-only.
  {
    const packagesConfigPath = path.join(csprojDir, 'packages.config');
    try {
      const cfgXml = cache
        ? await cache.readTextFile(packagesConfigPath)
        : await readTextFile(packagesConfigPath);
      const seen = new Map(data.packageReferences.map((r) => [r.name.toLowerCase(), r]));
      for (const ref of parsePackagesConfig(cfgXml)) {
        const existing = seen.get(ref.name.toLowerCase());
        if (!existing) {
          data.packageReferences.push(ref);
          seen.set(ref.name.toLowerCase(), ref);
        } else {
          // A versioned PackageReference still wins. packages.config only
          // fills a reference whose version stayed unknown, and it is not
          // build-time-only.
          if (existing.devOnly) existing.devOnly = false;
          if (existing.version === UNKNOWN_PACKAGE_VERSION && ref.version) {
            existing.version = ref.version;
          }
        }
      }
    } catch {
      // No packages.config (the common SDK-style case) — nothing to merge.
    }
  }

  // Determine target framework lag
  const primaryTfm = data.targetFrameworks[0];
  const dotnetLatest = latestStable(catalog, 'dotnet')?.major;
  let runtimeMajorsBehind: number | undefined;
  let runtimeEol: boolean | null | undefined;
  let runtimeEolDate: string | undefined;
  let targetFramework = primaryTfm;

  if (primaryTfm) {
    const major = parseTfmMajor(primaryTfm);
    if (major !== null && dotnetLatest !== undefined) {
      runtimeMajorsBehind = Math.max(0, dotnetLatest - major);
    }
    runtimeEol = runtimeEolStatus(catalog, 'dotnet', primaryTfm);
    const cycle = extractCycle('dotnet', primaryTfm);
    if (cycle) runtimeEolDate = eolDate(catalog, 'dotnet', cycle);
  }

  // Build dependency rows — query NuGet registry for latest versions when available
  const dependencies: DependencyRow[] = [];
  const bucketsMut = { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 };

  if (nugetCache) {
    // Fetch all NuGet metadata in parallel
    const metaPromises = data.packageReferences.map(async (ref) => {
      const meta = await nugetCache.get(ref.name);
      return { ref, meta };
    });
    const resolved = await Promise.all(metaPromises);

    for (const { ref, meta } of resolved) {
      const resolvedVersion = ref.version !== UNKNOWN_PACKAGE_VERSION && semver.valid(ref.version) ? ref.version : null;
      const latestStable = meta.latestStableOverall;

      let majorsBehind: number | null = null;
      let drift: DependencyRow['drift'] = 'unknown';

      if (resolvedVersion && latestStable) {
        const currentMajor = semver.major(resolvedVersion);
        const latestMajor = semver.major(latestStable);
        majorsBehind = latestMajor - currentMajor;

        if (majorsBehind === 0) {
          drift = semver.eq(resolvedVersion, latestStable) ? 'current' : 'minor-behind';
        } else if (majorsBehind > 0) {
          drift = 'major-behind';
        } else {
          drift = 'current';
        }

        if (majorsBehind <= 0) bucketsMut.current++;
        else if (majorsBehind === 1) bucketsMut.oneBehind++;
        else bucketsMut.twoPlusBehind++;
      } else {
        bucketsMut.unknown++;
      }

      dependencies.push({
        package: ref.name,
        section: dependencySection(ref),
        currentSpec: ref.version,
        resolvedVersion,
        latestStable,
        majorsBehind,
        drift,
      });
    }
  } else {
    // No NuGet cache — fallback to unknown drift (offline mode)
    for (const ref of data.packageReferences) {
      dependencies.push({
        package: ref.name,
        section: dependencySection(ref),
        currentSpec: ref.version,
        resolvedVersion: ref.version === UNKNOWN_PACKAGE_VERSION ? null : ref.version,
        latestStable: null,
        majorsBehind: null,
        drift: 'unknown',
      });
      bucketsMut.unknown++;
    }
  }

  // Detect known frameworks — use resolved dependency data for version info
  const frameworks: DetectedFramework[] = [];
  const depLookup = new Map(dependencies.map((d) => [d.package, d]));
  for (const ref of data.packageReferences) {
    if (ref.name in KNOWN_DOTNET_FRAMEWORKS) {
      const resolved = depLookup.get(ref.name);
      const declaredVersion = ref.version === UNKNOWN_PACKAGE_VERSION ? null : ref.version;
      frameworks.push({
        name: KNOWN_DOTNET_FRAMEWORKS[ref.name]!,
        currentVersion: resolved?.resolvedVersion ?? declaredVersion,
        latestVersion: resolved?.latestStable ?? null,
        majorsBehind: resolved?.majorsBehind ?? null,
      });
    }
  }

  // Resolve project references to relative paths from root
  const projectReferences: ProjectReference[] = data.projectReferences.map((refPath) => {
    // Resolve the reference path relative to the csproj file's directory
    const absRefPath = path.resolve(csprojDir, refPath);
    const relRefPath = normalizePath(path.relative(rootDir, path.dirname(absRefPath)));
    const refName = stripDotnetProjectExtension(absRefPath);
    return {
      path: relRefPath || '.',
      name: refName,
      refType: 'project' as const,
    };
  });

  // Count files in project directory (use cached walk to avoid redundant I/O)
  let fileCount: number | undefined;
  try {
    fileCount = cache
      ? await cache.countFilesUnder(rootDir, csprojDir)
      : undefined;
  } catch {
    // Ignore file count errors
  }

  // Sort: worst drift first
  dependencies.sort((a, b) => {
    const order = { 'major-behind': 0, 'minor-behind': 1, 'current': 2, 'unknown': 3 };
    const diff = (order[a.drift] ?? 9) - (order[b.drift] ?? 9);
    if (diff !== 0) return diff;
    return compareCodeUnits(a.package, b.package);
  });

  const buckets = bucketsMut;

  return {
    type: 'dotnet',
    path: normalizePath(path.relative(rootDir, csprojDir)) || '.',
    name: data.projectName,
    targetFramework,
    runtime: primaryTfm,
    runtimeLatest: dotnetLatest !== undefined ? `net${dotnetLatest}.0` : undefined,
    runtimeMajorsBehind,
    runtimeEol,
    runtimeEolDate,
    frameworks,
    dependencies,
    dependencyAgeBuckets: buckets,
    projectReferences: projectReferences.length > 0 ? projectReferences : undefined,
    fileCount,
  };
}
