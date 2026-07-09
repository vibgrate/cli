import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { findFiles, findPackageJsonFiles, readJsonFile, readTextFile, pathExists, FileCache } from '../../core-open/index.js';
import type { PackageJson, PlatformMatrixResult } from '../../core-open/index.js';

/** Packages known to require native compilation or be platform-specific */
const NATIVE_MODULE_PACKAGES = new Set([
  // Image / media processing
  'sharp',                   // libvips native bindings
  'canvas',                  // node-canvas (Cairo native)
  'jimp',                    // pure JS but optionally uses native
  '@napi-rs/image',          // NAPI-RS image processing
  'imagemagick',             // ImageMagick bindings
  'gm',                      // GraphicsMagick
  'fluent-ffmpeg',           // FFmpeg bindings
  'ffmpeg-static',           // bundled FFmpeg binary
  'puppeteer',               // ships Chromium binary
  'playwright',              // ships browser binaries
  'playwright-core',         // browser binaries
  // Cryptography / security
  'bcrypt',                  // native bcrypt
  'argon2',                  // native argon2 hashing
  'sodium-native',           // libsodium bindings
  'libsodium-wrappers',      // libsodium WASM/native
  'node-forge',              // mostly JS but linked to native in some envs
  'ssh2',                    // native SSH bindings (optional)
  'keytar',                  // OS keychain native bindings
  // Database drivers
  'better-sqlite3',          // native SQLite
  'sqlite3',                 // native SQLite
  'pg-native',               // PostgreSQL native bindings
  'oracledb',                // Oracle native client
  'odbc',                    // native ODBC
  'ibm_db',                  // IBM DB2 native
  'couchbase',               // native Couchbase SDK
  'rocksdb',                 // native RocksDB store
  'leveldown',               // native LevelDB
  'lmdb',                    // native LMDB bindings
  // Compilation & build tools
  'node-gyp',                // native build tool itself
  'node-pre-gyp',            // native binary distribution
  '@mapbox/node-pre-gyp',    // native binary distribution
  'prebuild',                // prebuilt native bindings
  'prebuild-install',        // prebuilt native installer
  'esbuild',                 // platform-specific Go binary
  '@swc/core',               // platform-specific Rust binary
  '@rspack/core',            // platform-specific Rust binary
  '@biomejs/biome',          // platform-specific Rust binary
  'node-sass',               // deprecated, native libsass
  'sass-embedded',           // Dart Sass embedded binary
  'turbo',                   // Turborepo Go/Rust binary
  '@vercel/nft',             // native file tracing (optional)
  // System / hardware access
  'fsevents',                // macOS-only file watching
  'cpu-features',            // CPU instruction detection
  'deasync',                 // native event loop control
  'usb',                     // USB device access
  'serialport',              // serial port access
  'node-hid',                // HID device access
  'i2c-bus',                 // I2C bus access
  'spi-device',              // SPI bus access
  'node-bluetooth',          // Bluetooth
  'mdns',                    // mDNS/Bonjour
  // Compression
  'snappy',                  // native Snappy compression
  'zstd-napi',               // native Zstandard
  'lz4',                     // native LZ4
  'brotli',                  // native Brotli (older, node has built-in)
  // Regex / text
  're2',                     // native RE2 regex engine
  'oniguruma',               // native Oniguruma regex
  'vscode-oniguruma',        // native Oniguruma (VS Code)
  'tree-sitter',             // native parser generator
  'node-tree-sitter',        // native Tree-sitter
  // XML / HTML
  'libxmljs',                // native libxml2
  'libxmljs2',               // native libxml2
  'node-expat',              // native Expat XML parser
  'htmlparser2',             // mostly JS, optional native
  // Networking / IPC
  '@grpc/grpc-js',           // gRPC (JS but has native dep for HTTP/2)
  'grpc',                    // deprecated native gRPC
  'zeromq',                  // native ZeroMQ
  'nanomsg',                 // native nanomsg
  'unix-dgram',              // native Unix sockets
  // Observability
  'dtrace-provider',         // native DTrace
  'v8-profiler-next',        // native V8 profiler
  'heapdump',                // native V8 heap dump
  // Misc
  'farmhash',                // native FarmHash
  'xxhash',                  // native xxHash
  'xxhash-addon',            // native xxHash
  'iconv',                   // native iconv
  'ref-napi',                // native FFI
  'ffi-napi',                // native FFI
  'node-pty',                // native pseudo-terminal
  'robotjs',                 // native desktop automation
  'electron',                // ships Chromium + Node binary
  'xdg-open',                // OS-specific
  'windows-process-tree',    // Windows-only
]);

/** Patterns in package.json scripts keys that suggest OS assumptions */
const OS_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bcmd\.exe\b|\.bat\b|\.cmd\b/i, label: 'windows-scripts' },
  { pattern: /\bpowershell\b|\bpwsh\b/i, label: 'powershell' },
  { pattern: /\bbash\b|#!\/bin\/bash/i, label: 'bash-scripts' },
  { pattern: /\\\\/g, label: 'backslash-paths' },
];

export async function scanPlatformMatrix(rootDir: string, cache?: FileCache): Promise<PlatformMatrixResult> {
  const result: PlatformMatrixResult = {
    dotnetTargetFrameworks: [],
    nativeModules: [],
    osAssumptions: [],
    dockerBaseImages: [],
    nodeVersionFiles: [],
  };

  // Collect from all package.json files
  const pkgFiles = cache
    ? await cache.findPackageJsonFiles(rootDir)
    : await findPackageJsonFiles(rootDir);
  const allDeps = new Set<string>();
  const osAssumptions = new Set<string>();

  for (const pjPath of pkgFiles) {
    try {
      const pj = cache
        ? await cache.readJsonFile<PackageJson>(pjPath)
        : await readJsonFile<PackageJson>(pjPath);

      // engines
      if (pj.engines?.node && !result.nodeEngines) result.nodeEngines = pj.engines.node;
      if (pj.engines?.npm && !result.npmEngines) result.npmEngines = pj.engines.npm;
      if ((pj.engines as Record<string, string>)?.pnpm && !result.pnpmEngines) {
        result.pnpmEngines = (pj.engines as Record<string, string>).pnpm;
      }

      // Gather all dep names
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
        const deps = pj[section];
        if (deps) {
          for (const name of Object.keys(deps)) {
            allDeps.add(name);
          }
        }
      }

      // OS assumptions from scripts (command names only, never values)
      const scripts = (pj as Record<string, unknown>).scripts;
      if (scripts && typeof scripts === 'object') {
        for (const val of Object.values(scripts as Record<string, string>)) {
          if (typeof val !== 'string') continue;
          // Only check command names (first token) to avoid leaking script content
          const firstToken = val.split(/\s/)[0] ?? '';
          for (const { pattern, label } of OS_PATTERNS) {
            if (pattern.test(firstToken)) {
              osAssumptions.add(label);
            }
          }
        }
      }
    } catch { /* skip unreadable package.json */ }
  }

  // Native modules
  for (const dep of allDeps) {
    if (NATIVE_MODULE_PACKAGES.has(dep)) {
      result.nativeModules.push(dep);
    }
  }
  result.nativeModules.sort();

  // OS assumptions
  result.osAssumptions = [...osAssumptions].sort();

  // .NET target frameworks from .csproj/.vbproj files
  const csprojFiles = cache
    ? await cache.findFiles(rootDir, (name) => name.endsWith('.csproj') || name.endsWith('.vbproj'))
    : await findFiles(rootDir, (name) => name.endsWith('.csproj') || name.endsWith('.vbproj'));
  const tfms = new Set<string>();
  for (const csprojPath of csprojFiles) {
    try {
      const xml = cache
        ? await cache.readTextFile(csprojPath)
        : await readTextFile(csprojPath);
      const tfMatch = xml.match(/<TargetFramework>(.*?)<\/TargetFramework>/);
      if (tfMatch?.[1]) tfms.add(tfMatch[1]);
      const tfsMatch = xml.match(/<TargetFrameworks>(.*?)<\/TargetFrameworks>/);
      if (tfsMatch?.[1]) {
        for (const tfm of tfsMatch[1].split(';')) {
          if (tfm.trim()) tfms.add(tfm.trim());
        }
      }
    } catch { /* skip */ }
  }
  result.dotnetTargetFrameworks = [...tfms].sort();

  // Docker base images (FROM lines only)
  const dockerfiles = cache
    ? await cache.findFiles(rootDir, (name) =>
        name === 'Dockerfile' || name.startsWith('Dockerfile.'),
      )
    : await findFiles(rootDir, (name) =>
        name === 'Dockerfile' || name.startsWith('Dockerfile.'),
      );
  const baseImages = new Set<string>();
  for (const df of dockerfiles) {
    try {
      const content = cache
        ? await cache.readTextFile(df)
        : await readTextFile(df);
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (/^FROM\s+/i.test(trimmed)) {
          const parts = trimmed.split(/\s+/);
          if (parts[1] && !parts[1].startsWith('--')) {
            baseImages.add(parts[1]);
          } else if (parts[1]?.startsWith('--')) {
            // FROM --platform=linux/amd64 node:20  OR  FROM --platform linux/amd64 node:20
            const imageIdx = parts[1].includes('=') ? 2 : 3;
            if (parts[imageIdx]) baseImages.add(parts[imageIdx]);
          }
        }
      }
    } catch { /* skip */ }
  }
  result.dockerBaseImages = [...baseImages].sort();

  // Node version files
  for (const file of ['.nvmrc', '.node-version', '.tool-versions']) {
    const exists = cache
      ? await cache.pathExists(path.join(rootDir, file))
      : await pathExists(path.join(rootDir, file));
    if (exists) {
      result.nodeVersionFiles.push(file);
    }
  }

  return result;
}
