import { describe, expect, it } from 'vitest';
import { parseGradleBuild } from '../src/core-open/scanners/java-scanner.js';

describe('parseGradleBuild Java version', () => {
  it("reads sourceCompatibility = '1.8' as 1.8, not 1", () => {
    const parsed = parseGradleBuild("sourceCompatibility = '1.8'\n", 'proj/build.gradle');
    expect(parsed.javaVersion).toBe('1.8');
  });

  it('reads JavaVersion.VERSION_1_8 as 1.8 in Groovy and Kotlin DSL', () => {
    const groovy = parseGradleBuild('sourceCompatibility = JavaVersion.VERSION_1_8\n', 'proj/build.gradle');
    const kotlin = parseGradleBuild('java.sourceCompatibility = JavaVersion.VERSION_1_8\n', 'proj/build.gradle.kts');
    expect(groovy.javaVersion).toBe('1.8');
    expect(kotlin.javaVersion).toBe('1.8');
  });

  it('leaves VERSION_11, VERSION_17 and a quoted 17 unchanged', () => {
    expect(parseGradleBuild('sourceCompatibility = JavaVersion.VERSION_11\n', 'proj/build.gradle').javaVersion).toBe('11');
    expect(parseGradleBuild('java.sourceCompatibility = JavaVersion.VERSION_17\n', 'proj/build.gradle.kts').javaVersion).toBe('17');
    expect(parseGradleBuild("sourceCompatibility = '17'\n", 'proj/build.gradle').javaVersion).toBe('17');
  });

  it('lets JavaLanguageVersion.of win over sourceCompatibility', () => {
    const parsed = parseGradleBuild(
      "sourceCompatibility = '1.8'\njava { toolchain { languageVersion = JavaLanguageVersion.of(17) } }\n",
      'proj/build.gradle',
    );
    expect(parsed.javaVersion).toBe('17');
  });
});
