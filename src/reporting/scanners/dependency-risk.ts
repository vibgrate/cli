import type { ProjectScan, DependencyRiskResult } from '../../core-open/index.js';

/** Packages widely known to be deprecated */
const DEPRECATED_PACKAGES = new Set([
  'request', 'node-sass', 'tslint', 'istanbul', 'popper.js',
  'Left-pad', 'left-pad', 'bower', 'grunt', 'gulp',
  'coffee-script', 'coffeescript', 'merge', 'nomnom', 'optimist',
  'natives', 'querystring', 'domain-browser', 'sys', 'punycode',
]);

/** Packages that use node-gyp / native compilation */
const NATIVE_MODULE_PACKAGES = new Set([
  'sharp', 'canvas', 'bcrypt', 'node-gyp', 'fsevents',
  'better-sqlite3', 'sqlite3', 'leveldown', 'sodium-native',
  'node-sass', 'argon2', 'usb', 'serialport', 're2',
  'libxmljs', 'libxmljs2', 'cpu-features', 'deasync', 'farmhash',
  'grpc', '@grpc/grpc-js',
]);

export function scanDependencyRisk(projects: ProjectScan[]): DependencyRiskResult {
  const deprecated = new Set<string>();
  const nativeModules = new Set<string>();
  let totalDeps = 0;

  for (const project of projects) {
    for (const dep of project.dependencies) {
      totalDeps++;
      if (DEPRECATED_PACKAGES.has(dep.package)) {
        deprecated.add(dep.package);
      }
      if (NATIVE_MODULE_PACKAGES.has(dep.package)) {
        nativeModules.add(dep.package);
      }
    }
  }

  return {
    deprecatedPackages: [...deprecated].sort(),
    nativeModulePackages: [...nativeModules].sort(),
    totalDependencies: totalDeps,
  };
}
