import { describe, expect, it } from 'vitest';
import { corsOrigin, ipInCidr, isInternalAddress, isLoopbackAddress, isLoopbackHostHeader, isSafeUpstreamUrl, isSafeUpstreamUrlAsync, normalizeIp, parseCidr, readToken, requestIsSameOrigin, tokenMatches } from './guards.js';
import type { IncomingMessage } from 'node:http';

describe('loopback + CIDR', () => {
  it('detects loopback peers including IPv4-mapped IPv6', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.42.0.9')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(normalizeIp('[::1]')).toBe('::1');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
  });

  it('gates the Host header (DNS rebinding)', () => {
    expect(isLoopbackHostHeader('localhost:8787')).toBe(true);
    expect(isLoopbackHostHeader('127.0.0.1:8787')).toBe(true);
    expect(isLoopbackHostHeader('[::1]:8787')).toBe(true);
    expect(isLoopbackHostHeader('app.localhost')).toBe(true);
    expect(isLoopbackHostHeader('evil.example.com')).toBe(false);
    expect(isLoopbackHostHeader('127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackHostHeader(undefined)).toBe(false);
  });

  it('parses CIDRs and tests membership for v4 and v6', () => {
    const v4 = parseCidr('10.1.0.0/16')!;
    expect(ipInCidr('10.1.200.3', v4)).toBe(true);
    expect(ipInCidr('10.2.0.1', v4)).toBe(false);
    const host = parseCidr('192.168.1.5')!;
    expect(ipInCidr('192.168.1.5', host)).toBe(true);
    expect(ipInCidr('192.168.1.6', host)).toBe(false);
    const v6 = parseCidr('fd00::/8')!;
    expect(ipInCidr('fd12:3456::1', v6)).toBe(true);
    expect(ipInCidr('2001:db8::1', v6)).toBe(false);
    expect(parseCidr('bogus')).toBeNull();
    expect(parseCidr('10.0.0.0/33')).toBeNull();
  });

  it('classifies internal addresses (private, link-local, CGNAT, NAT64, multicast)', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.5', '192.168.0.1', '169.254.1.1', '100.64.1.1', '224.0.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', 'ff02::1', '64:ff9b::7f00:1']) expect(isInternalAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '64:ff9b::808:808']) expect(isInternalAddress(ip), ip).toBe(false);
  });
});

describe('SSRF upstream guard', () => {
  it('trusts built-in provider hosts and rejects internal literals', () => {
    expect(isSafeUpstreamUrl('https://api.anthropic.com/v1/messages')).toBe(true);
    expect(isSafeUpstreamUrl('https://api.openai.com')).toBe(true);
    expect(isSafeUpstreamUrl('http://127.0.0.1:11434')).toBe(false);
    expect(isSafeUpstreamUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isSafeUpstreamUrl('http://localhost:3000')).toBe(false);
    expect(isSafeUpstreamUrl('ftp://api.anthropic.com')).toBe(false);
    expect(isSafeUpstreamUrl('https://user:pw@api.anthropic.com')).toBe(false);
    expect(isSafeUpstreamUrl('http://intranet')).toBe(false);
    expect(isSafeUpstreamUrl('https://gateway.corp.example.com')).toBeNull(); // needs DNS
  });

  it('honours the strict allow-list and extra hosts', () => {
    expect(isSafeUpstreamUrl('https://api.anthropic.com', { allowedBaseUrls: ['https://gw.example.com'] })).toBe(false);
    expect(isSafeUpstreamUrl('https://gw.example.com/v1', { allowedBaseUrls: ['https://gw.example.com'] })).toBe(true);
    expect(isSafeUpstreamUrl('https://gw.example.com:8443', { allowedBaseUrls: ['https://gw.example.com'] })).toBe(false);
    expect(isSafeUpstreamUrl('https://gw.example.com', { allowedBaseUrls: ['gw.example.com'] })).toBe(true);
    expect(isSafeUpstreamUrl('https://llm.corp.example.com', { allowedHosts: ['llm.corp.example.com'] })).toBe(true);
    expect(isSafeUpstreamUrl('http://ollama.local', { configuredBases: ['http://ollama.local'] })).toBe(true);
  });

  it('resolves DNS with an injected resolver and rejects internal answers', async () => {
    expect(await isSafeUpstreamUrlAsync('https://gw.example.com', { resolve: async () => ['93.184.216.34'] })).toBe(true);
    expect(await isSafeUpstreamUrlAsync('https://gw.example.com', { resolve: async () => ['93.184.216.34', '10.0.0.5'] })).toBe(false);
    expect(await isSafeUpstreamUrlAsync('https://gw.example.com', { resolve: async () => [] })).toBe(false);
    expect(await isSafeUpstreamUrlAsync('https://gw.example.com', { resolve: () => new Promise(() => {}), timeoutMs: 20 })).toBe(false);
  });
});

describe('auth + CORS + same-origin', () => {
  const req = (headers: Record<string, string>): IncomingMessage => ({ headers } as unknown as IncomingMessage);

  it('reads x-vg-token first, then bearer, and compares in constant time', () => {
    expect(readToken(req({ 'x-vg-token': 'abc', authorization: 'Bearer zzz' }))).toBe('abc');
    expect(readToken(req({ authorization: 'bearer   zzz ' }))).toBe('zzz');
    expect(readToken(req({ authorization: 'Basic zzz' }))).toBeUndefined();
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abd', 'abc')).toBe(false);
    expect(tokenMatches(undefined, 'abc')).toBe(false);
  });

  it('allows loopback origins by default, configured origins otherwise, * as an escape hatch', () => {
    expect(corsOrigin('http://localhost:5173', [])).toBe('http://localhost:5173');
    expect(corsOrigin('http://127.0.0.1:3000', [])).toBe('http://127.0.0.1:3000');
    expect(corsOrigin('https://evil.example.com', [])).toBeUndefined();
    expect(corsOrigin('https://dash.example.com', ['https://dash.example.com'])).toBe('https://dash.example.com');
    expect(corsOrigin('http://localhost:5173', ['https://dash.example.com'])).toBeUndefined();
    expect(corsOrigin('https://anything.example.com', ['*'])).toBe('*');
    expect(corsOrigin(undefined, ['*'])).toBeUndefined();
  });

  it('accepts requests without browser provenance and same-origin ones only', () => {
    expect(requestIsSameOrigin(req({ host: '127.0.0.1:8787' }))).toBe(true);
    expect(requestIsSameOrigin(req({ host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787' }))).toBe(true);
    expect(requestIsSameOrigin(req({ host: '127.0.0.1:8787', origin: 'http://localhost:8787' }))).toBe(true);
    expect(requestIsSameOrigin(req({ host: '127.0.0.1:8787', origin: 'https://evil.example.com' }))).toBe(false);
    expect(requestIsSameOrigin(req({ host: '127.0.0.1:8787', referer: 'https://evil.example.com/page' }))).toBe(false);
  });
});
