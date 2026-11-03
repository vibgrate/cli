/**
 * Cargo.toml dependency headers, including target tables and crate sub-tables.
 * A target spec may be a single-quoted cfg, a double-quoted cfg with an
 * escaped quote, or a bare triple. Other headers are not dependency tables.
 */
import { describe, expect, it } from 'vitest';
import { cargoDependencyHeader } from '../src/core-open/scanners/rust-scanner.js';

describe('cargoDependencyHeader', () => {
  it('maps plain and target dependency tables', () => {
    expect(cargoDependencyHeader('[dependencies]')).toEqual({ table: 'dependencies', target: false });
    expect(cargoDependencyHeader('[dev-dependencies]')).toEqual({ table: 'dev-dependencies', target: false });
    expect(cargoDependencyHeader('[build-dependencies]')).toEqual({ table: 'build-dependencies', target: false });
    expect(cargoDependencyHeader("[target.'cfg(windows)'.dependencies]")).toEqual({ table: 'dependencies', target: true });
    expect(cargoDependencyHeader("[target.'cfg(windows)'.dev-dependencies]")).toEqual({ table: 'dev-dependencies', target: true });
    expect(cargoDependencyHeader("[target.'cfg(windows)'.build-dependencies]")).toEqual({ table: 'build-dependencies', target: true });
    expect(cargoDependencyHeader('[target."cfg(target_os = \\"macos\\")".dependencies]')).toEqual({
      table: 'dependencies',
      target: true,
    });
    expect(cargoDependencyHeader('[target."cfg(windows)".dev-dependencies]')).toEqual({
      table: 'dev-dependencies',
      target: true,
    });
    expect(cargoDependencyHeader('[target.x86_64-pc-windows-msvc.dependencies]')).toEqual({
      table: 'dependencies',
      target: true,
    });
    expect(cargoDependencyHeader("[target.'x86_64-apple-darwin'.build-dependencies]")).toEqual({
      table: 'build-dependencies',
      target: true,
    });
    expect(cargoDependencyHeader("[ target . 'cfg(unix)' . dependencies ]")).toEqual({
      table: 'dependencies',
      target: true,
    });
  });

  it('maps crate sub-tables, including target variants', () => {
    expect(cargoDependencyHeader('[dependencies.serde]')).toEqual({
      table: 'dependencies',
      target: false,
      crate: 'serde',
    });
    expect(cargoDependencyHeader('[dev-dependencies.criterion]')).toEqual({
      table: 'dev-dependencies',
      target: false,
      crate: 'criterion',
    });
    expect(cargoDependencyHeader('[build-dependencies.cc]')).toEqual({
      table: 'build-dependencies',
      target: false,
      crate: 'cc',
    });
    expect(cargoDependencyHeader("[ dependencies . serde ]")).toEqual({
      table: 'dependencies',
      target: false,
      crate: 'serde',
    });
    expect(cargoDependencyHeader("[target.'cfg(windows)'.dependencies.winapi]")).toEqual({
      table: 'dependencies',
      target: true,
      crate: 'winapi',
    });
    expect(cargoDependencyHeader('[target."cfg(windows)".dev-dependencies.libc]')).toEqual({
      table: 'dev-dependencies',
      target: true,
      crate: 'libc',
    });
    expect(cargoDependencyHeader("[target.'x86_64-apple-darwin'.build-dependencies.cc]")).toEqual({
      table: 'build-dependencies',
      target: true,
      crate: 'cc',
    });
    expect(cargoDependencyHeader('[target.x86_64-pc-windows-msvc.dependencies.windows-sys]')).toEqual({
      table: 'dependencies',
      target: true,
      crate: 'windows-sys',
    });
  });

  it('rejects headers that are not a dependency table', () => {
    expect(cargoDependencyHeader('[package]')).toBeNull();
    expect(cargoDependencyHeader('[features]')).toBeNull();
    expect(cargoDependencyHeader('[workspace.dependencies]')).toBeNull();
    expect(cargoDependencyHeader('[workspace.dependencies.serde]')).toBeNull();
    expect(cargoDependencyHeader('[dependencies.serde.features]')).toBeNull();
    expect(cargoDependencyHeader('[[bin]]')).toBeNull();
    expect(cargoDependencyHeader('serde = "1.0"')).toBeNull();
    expect(cargoDependencyHeader('[target."unterminated.dependencies]')).toBeNull();
  });
});
