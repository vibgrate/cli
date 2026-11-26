/**
 * The Java runtime comes from `<properties>` first. When those keys are absent,
 * `maven-compiler-plugin` `<configuration>` supplies `<release>`, then
 * `<source>`, then `<target>`, under `build.plugins` or `build.pluginManagement`.
 * A single plugin is an object; several plugins are an array. `${...}` in the
 * plugin value is resolved against POM properties.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MavenCache } from '../src/core-open/scanners/maven-cache.js';
import { scanJavaProjects } from '../src/core-open/scanners/java-scanner.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function pom(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>compiler-app</artifactId>
  <version>1.0.0</version>
${body}
</project>
`;
}

async function runtimeOf(body: string): Promise<{ runtime?: string; targetFramework?: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-maven-compiler-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'pom.xml'), pom(body));
  const projects = await scanJavaProjects(root, new MavenCache(new Semaphore(1), undefined, true));
  expect(projects).toHaveLength(1);
  return { runtime: projects[0]?.runtime, targetFramework: projects[0]?.targetFramework };
}

describe('Java version from maven-compiler-plugin', () => {
  it('reads <release> from a single plugin under build.plugins', async () => {
    const facts = await runtimeOf(`  <build>
    <plugins>
      <plugin>
        <artifactId>maven-compiler-plugin</artifactId>
        <configuration>
          <release>17</release>
          <source>11</source>
        </configuration>
      </plugin>
    </plugins>
  </build>`);
    expect(facts).toEqual({ runtime: 'Java 17', targetFramework: 'Java 17' });
  });

  it('reads <source> from a plugin array when <release> is absent', async () => {
    const facts = await runtimeOf(`  <build>
    <plugins>
      <plugin>
        <artifactId>maven-surefire-plugin</artifactId>
        <configuration>
          <release>99</release>
        </configuration>
      </plugin>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <configuration>
          <source>11</source>
          <target>8</target>
        </configuration>
      </plugin>
    </plugins>
  </build>`);
    expect(facts).toEqual({ runtime: 'Java 11', targetFramework: 'Java 11' });
  });

  it('reads <target> when <release> and <source> are absent', async () => {
    const facts = await runtimeOf(`  <build>
    <plugins>
      <plugin>
        <artifactId>maven-compiler-plugin</artifactId>
        <configuration>
          <target>8</target>
        </configuration>
      </plugin>
    </plugins>
  </build>`);
    expect(facts).toEqual({ runtime: 'Java 8', targetFramework: 'Java 8' });
  });

  it('reads <release> from a single plugin under pluginManagement', async () => {
    const facts = await runtimeOf(`  <build>
    <pluginManagement>
      <plugins>
        <plugin>
          <artifactId>maven-compiler-plugin</artifactId>
          <configuration>
            <release>17</release>
          </configuration>
        </plugin>
      </plugins>
    </pluginManagement>
  </build>`);
    expect(facts).toEqual({ runtime: 'Java 17', targetFramework: 'Java 17' });
  });

  it('reads <release> from a pluginManagement plugin array', async () => {
    const facts = await runtimeOf(`  <build>
    <pluginManagement>
      <plugins>
        <plugin>
          <artifactId>maven-surefire-plugin</artifactId>
        </plugin>
        <plugin>
          <artifactId>maven-compiler-plugin</artifactId>
          <configuration>
            <release>21</release>
          </configuration>
        </plugin>
      </plugins>
    </pluginManagement>
  </build>`);
    expect(facts).toEqual({ runtime: 'Java 21', targetFramework: 'Java 21' });
  });

  it('uses a pluginManagement <release> ahead of <source> on the plugin', async () => {
    const facts = await runtimeOf(`  <build>
    <plugins>
      <plugin>
        <artifactId>maven-compiler-plugin</artifactId>
        <configuration>
          <source>11</source>
        </configuration>
      </plugin>
    </plugins>
    <pluginManagement>
      <plugins>
        <plugin>
          <artifactId>maven-compiler-plugin</artifactId>
          <configuration>
            <release>17</release>
          </configuration>
        </plugin>
      </plugins>
    </pluginManagement>
  </build>`);
    expect(facts).toEqual({ runtime: 'Java 17', targetFramework: 'Java 17' });
  });

  it('prefers <release> on build.plugins over pluginManagement', async () => {
    const facts = await runtimeOf(`  <build>
    <plugins>
      <plugin>
        <artifactId>maven-compiler-plugin</artifactId>
        <configuration>
          <release>11</release>
        </configuration>
      </plugin>
    </plugins>
    <pluginManagement>
      <plugins>
        <plugin>
          <artifactId>maven-compiler-plugin</artifactId>
          <configuration>
            <release>17</release>
          </configuration>
        </plugin>
      </plugins>
    </pluginManagement>
  </build>`);
    expect(facts).toEqual({ runtime: 'Java 11', targetFramework: 'Java 11' });
  });

  it('keeps maven.compiler.release ahead of plugin configuration', async () => {
    const facts = await runtimeOf(`  <properties>
    <maven.compiler.release>17</maven.compiler.release>
  </properties>
  <build>
    <plugins>
      <plugin>
        <artifactId>maven-compiler-plugin</artifactId>
        <configuration>
          <release>11</release>
        </configuration>
      </plugin>
    </plugins>
  </build>`);
    expect(facts).toEqual({ runtime: 'Java 17', targetFramework: 'Java 17' });
  });

  it('resolves a property reference in plugin configuration', async () => {
    const facts = await runtimeOf(`  <properties>
    <jdk.version>21</jdk.version>
  </properties>
  <build>
    <plugins>
      <plugin>
        <artifactId>maven-compiler-plugin</artifactId>
        <configuration>
          <release>\${jdk.version}</release>
        </configuration>
      </plugin>
    </plugins>
  </build>`);
    expect(facts).toEqual({ runtime: 'Java 21', targetFramework: 'Java 21' });
  });

  it('skips an unresolved property and uses the next configuration key', async () => {
    const facts = await runtimeOf(`  <build>
    <plugins>
      <plugin>
        <artifactId>maven-compiler-plugin</artifactId>
        <configuration>
          <release>\${missing.version}</release>
          <source>11</source>
        </configuration>
      </plugin>
    </plugins>
  </build>`);
    expect(facts).toEqual({ runtime: 'Java 11', targetFramework: 'Java 11' });
  });

  it('reports no Java runtime when the only plugin value stays unresolved', async () => {
    const facts = await runtimeOf(`  <build>
    <pluginManagement>
      <plugins>
        <plugin>
          <artifactId>maven-compiler-plugin</artifactId>
          <configuration>
            <release>\${missing.version}</release>
          </configuration>
        </plugin>
      </plugins>
    </pluginManagement>
  </build>`);
    expect(facts).toEqual({ runtime: undefined, targetFramework: undefined });
  });
});
