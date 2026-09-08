import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveSettings } from '../compress/config.js';
import { configSummary, isLoopbackBind, normalizeApiUrl, resolveProxyConfig } from './config.js';
import { RuntimeEnv } from './runtime-env.js';
import { tempEnv } from './test-util.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('resolveProxyConfig precedence', () => {
  it('layers flag > env > settings.json > profile > default', () => {
    const t = tempEnv();
    cleanups.push(t.cleanup);
    // Profile default: aggressive → token mode, min tokens 300.
    saveSettings({ VG_COMPRESS_PROFILE: 'aggressive', VG_PROXY_RPM: 7, VG_PROXY_HOST: '127.0.0.9' }, t.env);
    const fromSettings = resolveProxyConfig({}, t.env);
    expect(fromSettings.profile).toBe('aggressive');
    expect(fromSettings.mode).toBe('token');
    expect(fromSettings.rpm).toBe(7);
    expect(fromSettings.host).toBe('127.0.0.9');
    expect(fromSettings.env.VG_COMPRESS_MIN_TOKENS).toBe('300');
    // Env beats settings.
    const fromEnv = resolveProxyConfig({}, { ...t.env, VG_PROXY_RPM: '11', VG_COMPRESS_MODE: 'cache' });
    expect(fromEnv.rpm).toBe(11);
    expect(fromEnv.mode).toBe('cache');
    // Flag beats env.
    const fromFlag = resolveProxyConfig({ rpm: 13, mode: 'token', profile: 'general' }, { ...t.env, VG_PROXY_RPM: '11', VG_COMPRESS_MODE: 'cache' });
    expect(fromFlag.rpm).toBe(13);
    expect(fromFlag.mode).toBe('token');
    expect(fromFlag.profile).toBe('general');
    expect(fromFlag.env.VG_PROXY_RPM).toBe('13');
    expect(fromFlag.env.VG_COMPRESS_PROFILE).toBe('general');
  });

  it('applies knob defaults and normalizes upstream URLs', () => {
    const t = tempEnv();
    cleanups.push(t.cleanup);
    const cfg = resolveProxyConfig({}, t.env);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(0);
    expect(cfg.mode).toBe('cache');
    expect(cfg.profile).toBe('coding');
    expect(cfg.optimize).toBe(true);
    expect(cfg.ccr).toBe(true);
    expect(cfg.budgetUsd).toBeUndefined();
    expect(cfg.anthropicUrl).toBe('https://api.anthropic.com');
    const custom = resolveProxyConfig({ anthropicUrl: 'https://gw.example.com/v1/', upstreamUrl: 'http://localhost:11434/v1' }, { ...t.env, OPENAI_TARGET_API_URL: 'https://oai.example.com/v1' });
    expect(custom.anthropicUrl).toBe('https://gw.example.com');
    expect(custom.openaiUrl).toBe('https://oai.example.com');
    expect(custom.upstreamUrl).toBe('http://localhost:11434');
    expect(normalizeApiUrl('https://x.test/v1')).toBe('https://x.test');
    expect(isLoopbackBind('127.0.0.1')).toBe(true);
    expect(isLoopbackBind('::1')).toBe(true);
    expect(isLoopbackBind('0.0.0.0')).toBe(false);
    expect(configSummary(cfg).find((r) => r.key === 'token')?.value).toBe('<none>');
  });

  it('never leaks the token through the summary', () => {
    const t = tempEnv();
    cleanups.push(t.cleanup);
    const cfg = resolveProxyConfig({ token: 'hunter2' }, t.env);
    expect(JSON.stringify(configSummary(cfg))).not.toContain('hunter2');
  });
});

describe('RuntimeEnv hot reload', () => {
  it('re-reads hot knobs from settings.json and pins explicit env / flags', () => {
    const t = tempEnv();
    cleanups.push(t.cleanup);
    const base = { ...t.env, VG_PROXY_TPM: '5' };
    const cfg = resolveProxyConfig({ rpm: 3 }, base);
    const rt = new RuntimeEnv(cfg.env, base, ['VG_PROXY_RPM']);
    expect(rt.snapshot().rpm).toBe(3);
    expect(rt.snapshot().tpm).toBe(5);
    expect(rt.snapshot().outputShaper).toBe(false);
    const file = saveSettings({ VG_OUTPUT_SHAPER: true, VG_PROXY_RPM: 99, VG_PROXY_TPM: 99, VG_PROXY_HOST: '0.0.0.0' }, t.env);
    // Bump mtime so the change is visible even within the same millisecond.
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(file, later, later);
    const snap = rt.snapshot();
    expect(snap.outputShaper).toBe(true); // hot knob from settings
    expect(snap.rpm).toBe(3); // pinned by flag
    expect(snap.tpm).toBe(5); // pinned by explicit env
    expect(snap.env.VG_PROXY_HOST).toBe('127.0.0.1'); // not hot → unchanged
    expect(RuntimeEnv.hotKnobNames()).toContain('VG_OUTPUT_SHAPER');
    expect(RuntimeEnv.hotKnobNames()).not.toContain('VG_PROXY_HOST');
    expect(path.basename(file)).toBe('settings.json');
  });
});
