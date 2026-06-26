import { describe, it, expect } from 'vitest';
import {
  availableRegionIds,
  dashHostForIngestHost,
  ingestHostForRegionId,
  resolveIngestHost,
} from './regions.js';

describe('cli regions', () => {
  it('lists only available regions', () => {
    expect(availableRegionIds()).toEqual(['us', 'eu']);
  });

  it('resolves available region hosts (case-insensitive)', () => {
    expect(resolveIngestHost('us')).toBe('us.ingest.vibgrate.com');
    expect(resolveIngestHost('EU')).toBe('eu.ingest.vibgrate.com');
    expect(resolveIngestHost()).toBe('us.ingest.vibgrate.com');
  });

  it('rejects unknown regions', () => {
    expect(() => resolveIngestHost('ap')).toThrow('Unknown region');
  });

  it('rejects known-but-unavailable regions with a clear message', () => {
    expect(() => resolveIngestHost('apac')).toThrow('not yet available');
  });

  it('honors an explicit ingest URL override', () => {
    expect(resolveIngestHost('eu', 'https://custom.example.com')).toBe('custom.example.com');
  });

  it('maps ingest host to the matching dashboard host', () => {
    expect(dashHostForIngestHost('eu.ingest.vibgrate.com')).toBe('dash.vibgrate.eu');
    expect(dashHostForIngestHost('us.ingest.vibgrate.com')).toBe('dash.vibgrate.com');
    expect(dashHostForIngestHost('unknown.example.com')).toBe('dash.vibgrate.com');
  });

  it('resolves an ingest host for a known region id without throwing', () => {
    expect(ingestHostForRegionId('eu')).toBe('eu.ingest.vibgrate.com');
    expect(ingestHostForRegionId('US')).toBe('us.ingest.vibgrate.com');
    // Honours a residency redirect even for a region not yet user-selectable.
    expect(ingestHostForRegionId('apac')).toBe('apac.ingest.vibgrate.com');
    expect(ingestHostForRegionId('mars')).toBeUndefined();
  });
});
