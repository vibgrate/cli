import { describe, expect, it } from 'vitest';
import { isOneShotBuild, resolveBuildAttach } from './build-attach.js';

describe('isOneShotBuild', () => {
  it('requires the three flags together', () => {
    expect(isOneShotBuild({ fast: true, warm: false, index: false })).toBe(true);
    expect(isOneShotBuild({ fast: true, warm: false })).toBe(false);
    expect(isOneShotBuild({ fast: true, index: false })).toBe(false);
    expect(isOneShotBuild({ warm: false, index: false })).toBe(false);
    expect(isOneShotBuild({})).toBe(false);
  });
});

describe('resolveBuildAttach', () => {
  it('keeps auto-attach + publish and does not spawn vg embed --bg', () => {
    expect(resolveBuildAttach({})).toEqual({
      disabled: false,
      autoStart: true,
      publish: true,
      diskEmbedFallback: false,
    });
  });

  it('honours --no-daemon and allows the disk-embed fallback', () => {
    const plan = resolveBuildAttach({ daemon: false });
    expect(plan.disabled).toBe(true);
    expect(plan.autoStart).toBe(false);
    expect(plan.publish).toBe(false);
    expect(plan.diskEmbedFallback).toBe(true);
    expect(plan.reason).toMatch(/--no-daemon/);
  });

  it('--no-daemon --no-warm does not spawn an embedder', () => {
    expect(resolveBuildAttach({ daemon: false, warm: false }).diskEmbedFallback).toBe(false);
  });

  it('--no-publish does not start, publish, or embed', () => {
    const plan = resolveBuildAttach({ publish: false });
    expect(plan.disabled).toBe(false);
    expect(plan.autoStart).toBe(false);
    expect(plan.publish).toBe(false);
    expect(plan.diskEmbedFallback).toBe(false);
  });

  it('treats --fast --no-warm --no-index as one-shot', () => {
    const plan = resolveBuildAttach({ fast: true, warm: false, index: false });
    expect(plan.autoStart).toBe(false);
    expect(plan.publish).toBe(false);
    expect(plan.diskEmbedFallback).toBe(false);
    expect(plan.reason).toMatch(/one-shot/);
  });

  it('--fast alone still auto-attaches and still does not spawn vg embed --bg', () => {
    const plan = resolveBuildAttach({ fast: true });
    expect(plan.autoStart).toBe(true);
    expect(plan.publish).toBe(true);
    expect(plan.diskEmbedFallback).toBe(false);
  });

  it('--no-daemon wins over --no-publish', () => {
    const plan = resolveBuildAttach({ daemon: false, publish: false });
    expect(plan.disabled).toBe(true);
    expect(plan.reason).toMatch(/--no-daemon/);
  });
});
