// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import * as semver from 'semver';
import { XMLParser } from 'fast-xml-parser';
import { readTextFile, FileCache } from '../utils/fs.js';
import { withTimeout } from '../utils/timeout.js';
import { MavenCache } from './maven-cache.js';
import { latestLts, runtimeEolStatus, extractCycle, eolDate } from '../runtimes/catalog.js';
import { BUNDLED_RUNTIME_CATALOG } from '../runtimes/snapshot.js';
import type { RuntimeCatalog } from '../runtimes/types.js';
import type { ProjectScan, DependencyRow, DetectedFramework, ProjectReference } from '../types.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

/** Well-known Java frameworks and libraries to track */
const KNOWN_JAVA_FRAMEWORKS: Record<string, string> = {
  // ── Spring ──
  'org.springframework.boot:spring-boot-starter-web': 'Spring Boot Web',
  'org.springframework.boot:spring-boot-starter': 'Spring Boot',
  'org.springframework.boot:spring-boot-starter-data-jpa': 'Spring Data JPA',
  'org.springframework.boot:spring-boot-starter-security': 'Spring Security',
  'org.springframework.boot:spring-boot-starter-webflux': 'Spring WebFlux',
  'org.springframework.boot:spring-boot-starter-actuator': 'Spring Actuator',
  'org.springframework.boot:spring-boot-starter-test': 'Spring Boot Test',
  'org.springframework:spring-core': 'Spring Framework',
  'org.springframework:spring-web': 'Spring Web',
  'org.springframework:spring-webmvc': 'Spring MVC',
  'org.springframework.cloud:spring-cloud-starter-netflix-eureka-client': 'Spring Cloud Eureka',
  'org.springframework.cloud:spring-cloud-starter-gateway': 'Spring Cloud Gateway',
  'org.springframework.kafka:spring-kafka': 'Spring Kafka',

  // ── Jakarta / Java EE ──
  'jakarta.platform:jakarta.jakartaee-api': 'Jakarta EE',
  'jakarta.servlet:jakarta.servlet-api': 'Jakarta Servlet',
  'javax.servlet:javax.servlet-api': 'Java Servlet (Legacy)',

  // ── Micronaut ──
  'io.micronaut:micronaut-core': 'Micronaut',
  'io.micronaut:micronaut-http-server-netty': 'Micronaut HTTP',

  // ── Quarkus ──
  'io.quarkus:quarkus-core': 'Quarkus',
  'io.quarkus:quarkus-resteasy': 'Quarkus RESTEasy',
  'io.quarkus:quarkus-resteasy-reactive': 'Quarkus RESTEasy Reactive',

  // ── Vert.x ──
  'io.vertx:vertx-core': 'Vert.x',
  'io.vertx:vertx-web': 'Vert.x Web',

  // ── ORM & Database ──
  'org.hibernate.orm:hibernate-core': 'Hibernate',
  'org.hibernate:hibernate-core': 'Hibernate',
  'org.mybatis:mybatis': 'MyBatis',
  'org.mybatis.spring.boot:mybatis-spring-boot-starter': 'MyBatis Spring Boot',
  'org.jooq:jooq': 'jOOQ',
  'org.flywaydb:flyway-core': 'Flyway',
  'org.liquibase:liquibase-core': 'Liquibase',
  'com.zaxxer:HikariCP': 'HikariCP',
  'org.postgresql:postgresql': 'PostgreSQL JDBC',
  'com.mysql:mysql-connector-j': 'MySQL Connector',
  'mysql:mysql-connector-java': 'MySQL Connector (Legacy)',
  'com.oracle.database.jdbc:ojdbc11': 'Oracle JDBC',
  'org.mongodb:mongodb-driver-sync': 'MongoDB Driver',
  'io.lettuce:lettuce-core': 'Lettuce (Redis)',
  'redis.clients:jedis': 'Jedis (Redis)',

  // ── Messaging ──
  'org.apache.kafka:kafka-clients': 'Apache Kafka',
  'com.rabbitmq:amqp-client': 'RabbitMQ Client',
  'software.amazon.awssdk:sqs': 'AWS SQS',
  'software.amazon.awssdk:sns': 'AWS SNS',

  // ── HTTP & API ──
  'com.squareup.okhttp3:okhttp': 'OkHttp',
  'com.squareup.retrofit2:retrofit': 'Retrofit',
  'org.apache.httpcomponents.client5:httpclient5': 'Apache HttpClient 5',
  'io.grpc:grpc-netty': 'gRPC',
  'com.graphql-java:graphql-java': 'GraphQL Java',
  'com.netflix.graphql.dgs:graphql-dgs-spring-boot-starter': 'Netflix DGS',

  // ── JSON ──
  'com.fasterxml.jackson.core:jackson-databind': 'Jackson',
  'com.google.code.gson:gson': 'Gson',

  // ── Testing ──
  'junit:junit': 'JUnit 4',
  'org.junit.jupiter:junit-jupiter': 'JUnit 5',
  'org.junit.jupiter:junit-jupiter-api': 'JUnit 5',
  'org.mockito:mockito-core': 'Mockito',
  'org.assertj:assertj-core': 'AssertJ',
  'org.testcontainers:testcontainers': 'Testcontainers',
  'io.rest-assured:rest-assured': 'REST Assured',
  'org.awaitility:awaitility': 'Awaitility',
  'com.tngtech.archunit:archunit-junit5': 'ArchUnit',
  'org.hamcrest:hamcrest': 'Hamcrest',

  // ── Logging ──
  'org.slf4j:slf4j-api': 'SLF4J',
  'ch.qos.logback:logback-classic': 'Logback',
  'org.apache.logging.log4j:log4j-core': 'Log4j2',

  // ── Build Plugins (tracked as frameworks) ──
  'org.projectlombok:lombok': 'Lombok',
  'org.mapstruct:mapstruct': 'MapStruct',

  // ── Cloud SDKs ──
  'software.amazon.awssdk:bom': 'AWS SDK v2',
  'com.google.cloud:google-cloud-bom': 'Google Cloud SDK',
  'com.azure:azure-sdk-bom': 'Azure SDK',

  // ── Security ──
  'io.jsonwebtoken:jjwt-api': 'JJWT',
  'com.nimbusds:nimbus-jose-jwt': 'Nimbus JOSE+JWT',

  // ── Observability ──
  'io.micrometer:micrometer-core': 'Micrometer',
  'io.opentelemetry:opentelemetry-api': 'OpenTelemetry',
  'io.prometheus:simpleclient': 'Prometheus Client',

  // ── Reactive ──
  'io.projectreactor:reactor-core': 'Project Reactor',
  'io.reactivex.rxjava3:rxjava': 'RxJava 3',
};

// Latest Java LTS is resolved at scan time — see runtime-baselines.ts

// ── POM parsing ──

interface PomDependency {
  groupId: string;
  artifactId: string;
  version: string;
  scope?: string;
}

interface PomData {
  groupId?: string;
  artifactId: string;
  version?: string;
  packaging?: string;
  javaVersion?: string;
  dependencies: PomDependency[];
  modules: string[];
  parent?: { groupId: string; artifactId: string; version: string };
  properties: Record<string, string>;
}

function parsePom(xml: string, filePath: string): PomData {
  const parsed = parser.parse(xml);
  const project = parsed?.project;
  if (!project) {
    return {
      artifactId: path.basename(path.dirname(filePath)),
      dependencies: [],
      modules: [],
      properties: {},
    };
  }

  const properties: Record<string, string> = {};
  if (project.properties && typeof project.properties === 'object') {
    for (const [key, val] of Object.entries(project.properties)) {
      if (typeof val === 'string' || typeof val === 'number') {
        properties[key] = String(val);
      }
    }
  }

  // Extract Java version from properties
  let javaVersion: string | undefined;
  const javaProps = [
    'java.version', 'maven.compiler.source', 'maven.compiler.target',
    'maven.compiler.release', 'java.source.version',
  ];
  for (const prop of javaProps) {
    if (properties[prop]) {
      javaVersion = String(properties[prop]);
      break;
    }
  }

  // Extract dependencies
  const depContainer = project.dependencies;
  const rawDeps = depContainer?.dependency
    ? (Array.isArray(depContainer.dependency) ? depContainer.dependency : [depContainer.dependency])
    : [];

  const dependencies: PomDependency[] = rawDeps
    .filter((d: Record<string, unknown>) => d.groupId && d.artifactId)
    .map((d: Record<string, unknown>) => ({
      groupId: resolveProperty(String(d.groupId ?? ''), properties),
      artifactId: resolveProperty(String(d.artifactId ?? ''), properties),
      version: resolveProperty(String(d.version ?? ''), properties),
      scope: d.scope ? String(d.scope) : undefined,
    }));

  // Also get dependencyManagement dependencies
  const mgmt = project.dependencyManagement?.dependencies;
  const mgmtDeps = mgmt?.dependency
    ? (Array.isArray(mgmt.dependency) ? mgmt.dependency : [mgmt.dependency])
    : [];

  for (const d of mgmtDeps) {
    if (d.groupId && d.artifactId && d.version) {
      dependencies.push({
        groupId: resolveProperty(String(d.groupId), properties),
        artifactId: resolveProperty(String(d.artifactId), properties),
        version: resolveProperty(String(d.version), properties),
        scope: d.scope ? String(d.scope) : undefined,
      });
    }
  }

  // Modules
  const rawModules = project.modules?.module
    ? (Array.isArray(project.modules.module) ? project.modules.module : [project.modules.module])
    : [];
  const modules = rawModules.map(String);

  // Parent
  let parent: PomData['parent'];
  if (project.parent?.groupId && project.parent?.artifactId) {
    parent = {
      groupId: String(project.parent.groupId),
      artifactId: String(project.parent.artifactId),
      version: String(project.parent.version ?? ''),
    };
  }

  return {
    groupId: project.groupId ? String(project.groupId) : parent?.groupId,
    artifactId: String(project.artifactId ?? path.basename(path.dirname(filePath))),
    version: project.version ? String(project.version) : parent?.version,
    packaging: project.packaging ? String(project.packaging) : undefined,
    javaVersion,
    dependencies,
    modules,
    parent,
    properties,
  };
}

function resolveProperty(value: string, properties: Record<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, key: string) => properties[key] ?? `\${${key}}`);
}

// ── Gradle parsing ──

interface GradleDependency {
  groupId: string;
  artifactId: string;
  version: string;
  configuration: string;
}

interface GradleData {
  javaVersion?: string;
  dependencies: GradleDependency[];
  projectName: string;
}

function parseGradleBuild(content: string, filePath: string): GradleData {
  const deps: GradleDependency[] = [];
  const projectName = path.basename(path.dirname(filePath));

  // Detect Java/JVM version
  let javaVersion: string | undefined;

  // sourceCompatibility/targetCompatibility = '17'
  const compatMatch = content.match(/(?:sourceCompatibility|targetCompatibility|javaVersion)\s*[=:]\s*['"]?(?:JavaVersion\.VERSION_)?(\d+)['"]?/);
  if (compatMatch) javaVersion = compatMatch[1];

  // java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }
  const toolchainMatch = content.match(/JavaLanguageVersion\.of\((\d+)\)/);
  if (toolchainMatch) javaVersion = toolchainMatch[1];

  // Parse dependencies: implementation 'group:artifact:version'
  const depRegex = /(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|annotationProcessor|kapt)\s*(?:\(?\s*)?['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = depRegex.exec(content)) !== null) {
    const parts = match[1]!.split(':');
    if (parts.length >= 2) {
      deps.push({
        groupId: parts[0]!,
        artifactId: parts[1]!,
        version: parts[2] ?? '',
        configuration: match[0]!.split(/\s/)[0]!,
      });
    }
  }

  // Parse Kotlin DSL: implementation("group:artifact:version")
  const kotlinDepRegex = /(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|annotationProcessor|kapt)\s*\(\s*"([^"]+)"\s*\)/g;
  while ((match = kotlinDepRegex.exec(content)) !== null) {
    const parts = match[1]!.split(':');
    if (parts.length >= 2) {
      // Only add if not already captured
      const key = `${parts[0]}:${parts[1]}`;
      if (!deps.some((d) => `${d.groupId}:${d.artifactId}` === key)) {
        deps.push({
          groupId: parts[0]!,
          artifactId: parts[1]!,
          version: parts[2] ?? '',
          configuration: match[0]!.split(/\s/)[0]!,
        });
      }
    }
  }

  // Parse platform/BOM dependencies
  const platformRegex = /(?:implementation|api)\s*(?:\(?\s*)?platform\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = platformRegex.exec(content)) !== null) {
    const parts = match[1]!.split(':');
    if (parts.length >= 2) {
      deps.push({
        groupId: parts[0]!,
        artifactId: parts[1]!,
        version: parts[2] ?? '',
        configuration: 'platform',
      });
    }
  }

  return { javaVersion, dependencies: deps, projectName };
}

/**
 * Convert a Maven version string to semver where possible.
 */
function mavenToSemver(ver: string): string | null {
  let v = ver.trim();
  if (!v || v.includes('$')) return null;
  if (/(?:-SNAPSHOT|-alpha|-beta|-rc|-M\d|-CR\d)/i.test(v)) return null;
  v = v.replace(/\.(?:RELEASE|Final|GA)$/i, '');
  const parts = v.split('.');
  while (parts.length < 3) parts.push('0');
  v = parts.slice(0, 3).join('.');
  return semver.valid(v);
}

// ── Main scanner ──

const JAVA_MANIFEST_FILES = new Set(['pom.xml', 'build.gradle', 'build.gradle.kts']);

export async function scanJavaProjects(
  rootDir: string,
  mavenCache: MavenCache,
  cache?: FileCache,
  projectScanTimeout?: number,
  catalog: RuntimeCatalog = BUNDLED_RUNTIME_CATALOG,
): Promise<ProjectScan[]> {
  const manifestFiles = cache
    ? await cache.findFiles(rootDir, (name) => JAVA_MANIFEST_FILES.has(name))
    : await findJavaManifests(rootDir);

  // Group by directory
  const projectDirs = new Map<string, string[]>();
  for (const f of manifestFiles) {
    const dir = path.dirname(f);
    if (!projectDirs.has(dir)) projectDirs.set(dir, []);
    projectDirs.get(dir)!.push(f);
  }

  const results: ProjectScan[] = [];
  const STUCK_TIMEOUT_MS = projectScanTimeout ?? cache?.projectScanTimeout ?? 180_000;

  for (const [dir, files] of projectDirs) {
    try {
      const scanPromise = scanOneJavaProject(dir, files, rootDir, mavenCache, cache, catalog);
      const result = await withTimeout(scanPromise, STUCK_TIMEOUT_MS);
      if (result.ok) {
        results.push(result.value);
      } else {
        const relPath = path.relative(rootDir, dir);
        if (cache) cache.addStuckPath(relPath || '.');
        console.error(`Timeout scanning Java project ${dir} (>${STUCK_TIMEOUT_MS / 1000}s) — skipped`);
        if (cache?.shouldShowTimeoutHint()) {
          console.error(`  Tip: increase projectScanTimeout in vibgrate.config.ts (or --project-scan-timeout <seconds>) for large projects`);
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error scanning Java project ${dir}: ${msg}`);
    }
  }

  // Resolve module references between projects
  const projectPathMap = new Map<string, string>();
  for (const p of results) {
    projectPathMap.set(p.name, p.path);
  }

  return results;
}

async function findJavaManifests(rootDir: string): Promise<string[]> {
  const { findFiles } = await import('../utils/fs.js');
  return findFiles(rootDir, (name) => JAVA_MANIFEST_FILES.has(name));
}

async function scanOneJavaProject(
  dir: string,
  manifestFiles: string[],
  rootDir: string,
  mavenCache: MavenCache,
  cache: FileCache | undefined,
  catalog: RuntimeCatalog,
): Promise<ProjectScan> {
  const relDir = path.relative(rootDir, dir) || '.';
  let projectName = path.basename(dir === rootDir ? rootDir : dir);
  let javaVersion: string | undefined;
  const allDeps = new Map<string, { groupId: string; artifactId: string; version: string }>();
  const projectReferences: ProjectReference[] = [];

  // Parse manifests — prefer pom.xml over Gradle
  for (const f of manifestFiles) {
    const fileName = path.basename(f);
    const content = cache ? await cache.readTextFile(f) : await readTextFile(f);

    if (fileName === 'pom.xml') {
      const pom = parsePom(content, f);
      if (pom.artifactId) projectName = pom.artifactId;
      if (pom.javaVersion) javaVersion = pom.javaVersion;

      for (const dep of pom.dependencies) {
        const key = `${dep.groupId}:${dep.artifactId}`;
        if (!allDeps.has(key) && dep.version && !dep.version.includes('${')) {
          allDeps.set(key, dep);
        }
      }

      // Module references
      for (const mod of pom.modules) {
        projectReferences.push({
          path: path.join(relDir, mod),
          name: mod,
          refType: 'project',
        });
      }
    } else if (fileName === 'build.gradle' || fileName === 'build.gradle.kts') {
      const gradle = parseGradleBuild(content, f);
      if (gradle.projectName) projectName = gradle.projectName;
      if (gradle.javaVersion) javaVersion = gradle.javaVersion;

      for (const dep of gradle.dependencies) {
        const key = `${dep.groupId}:${dep.artifactId}`;
        if (!allDeps.has(key) && dep.version) {
          allDeps.set(key, dep);
        }
      }
    }
  }

  // Determine Java runtime lag
  let runtimeMajorsBehind: number | undefined;
  let runtimeEol: boolean | null | undefined;
  let runtimeEolDate: string | undefined;
  const javaLts = latestLts(catalog, 'java')?.major;
  const runtimeLatest = javaLts !== undefined ? String(javaLts) : undefined;

  if (javaVersion) {
    const jvMatch = javaVersion.match(/^(1\.)?(\d+)/);
    if (jvMatch) {
      // Handle "1.8" → 8, "11" → 11, "17" → 17
      const major = jvMatch[1] ? parseInt(jvMatch[2]!, 10) : parseInt(jvMatch[2]!, 10);
      if (javaLts !== undefined) runtimeMajorsBehind = Math.max(0, javaLts - major);
    }
    runtimeEol = runtimeEolStatus(catalog, 'java', javaVersion);
    const cycle = extractCycle('java', javaVersion);
    if (cycle) runtimeEolDate = eolDate(catalog, 'java', cycle);
  }

  // Resolve dependencies against Maven Central
  const dependencies: DependencyRow[] = [];
  const frameworks: DetectedFramework[] = [];
  const buckets = { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 };

  const depEntries = [...allDeps.entries()];
  const metaPromises = depEntries.map(async ([key, dep]) => {
    const meta = await mavenCache.get(dep.groupId, dep.artifactId);
    return { key, dep, meta };
  });

  const resolved = await Promise.all(metaPromises);

  for (const { key, dep, meta } of resolved) {
    const resolvedVersion = mavenToSemver(dep.version);
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

      if (majorsBehind <= 0) buckets.current++;
      else if (majorsBehind === 1) buckets.oneBehind++;
      else buckets.twoPlusBehind++;
    } else {
      buckets.unknown++;
    }

    dependencies.push({
      package: key,
      section: 'dependencies',
      currentSpec: dep.version,
      resolvedVersion,
      latestStable,
      majorsBehind,
      drift,
    });

    // Detect known frameworks
    if (key in KNOWN_JAVA_FRAMEWORKS) {
      frameworks.push({
        name: KNOWN_JAVA_FRAMEWORKS[key]!,
        currentVersion: resolvedVersion,
        latestVersion: latestStable,
        majorsBehind,
      });
    }
  }

  // Sort: worst drift first
  dependencies.sort((a, b) => {
    const order = { 'major-behind': 0, 'minor-behind': 1, 'current': 2, 'unknown': 3 };
    const diff = (order[a.drift] ?? 9) - (order[b.drift] ?? 9);
    if (diff !== 0) return diff;
    return a.package.localeCompare(b.package);
  });

  // Count files (use cached walk to avoid redundant I/O)
  let fileCount: number | undefined;
  try {
    fileCount = cache
      ? await cache.countFilesUnder(rootDir, dir)
      : undefined;
  } catch { /* ignore */ }

  return {
    type: 'java',
    path: relDir,
    name: projectName,
    runtime: javaVersion ? `Java ${javaVersion}` : undefined,
    runtimeLatest,
    runtimeMajorsBehind,
    runtimeEol,
    runtimeEolDate,
    targetFramework: javaVersion ? `Java ${javaVersion}` : undefined,
    frameworks,
    dependencies,
    dependencyAgeBuckets: buckets,
    projectReferences: projectReferences.length > 0 ? projectReferences : undefined,
    fileCount,
  };
}
