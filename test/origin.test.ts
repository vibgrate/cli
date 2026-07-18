import { describe, it, expect } from 'vitest';
import { originAllowed } from '../src/util/origin.js';

describe('originAllowed (DNS-rebinding protection for vg serve --http)', () => {
  it('passes requests with no Origin header (CLI/native clients)', () => {
    expect(originAllowed(undefined)).toBe(true);
    expect(originAllowed('')).toBe(true);
  });

  it('allows loopback origins on any port and scheme', () => {
    expect(originAllowed('http://localhost:3000')).toBe(true);
    expect(originAllowed('http://localhost')).toBe(true);
    expect(originAllowed('https://localhost:8443')).toBe(true);
    expect(originAllowed('http://127.0.0.1:7437')).toBe(true);
    expect(originAllowed('http://127.1.2.3')).toBe(true);
    expect(originAllowed('http://[::1]:7437')).toBe(true);
  });

  it('rejects non-loopback origins — the rebinding case', () => {
    expect(originAllowed('http://evil.example')).toBe(false);
    expect(originAllowed('https://attacker.test:7437')).toBe(false);
    // A rebound hostname resolving to 127.0.0.1 still carries its own Origin.
    expect(originAllowed('http://localtest.me')).toBe(false);
    // localhost as a suffix/prefix must not fool the check.
    expect(originAllowed('http://localhost.evil.example')).toBe(false);
    expect(originAllowed('http://notlocalhost')).toBe(false);
  });

  it('rejects opaque and non-http origins', () => {
    expect(originAllowed('null')).toBe(false);
    expect(originAllowed('file://x')).toBe(false);
    expect(originAllowed('chrome-extension://abc')).toBe(false);
  });

  it('honours the explicit allowlist, including the * escape hatch', () => {
    expect(originAllowed('https://tool.example', 'https://tool.example')).toBe(true);
    expect(originAllowed('https://tool.example', 'https://other.example, https://tool.example')).toBe(true);
    expect(originAllowed('https://tool.example', 'https://other.example')).toBe(false);
    expect(originAllowed('https://anything.example', '*')).toBe(true);
  });
});
