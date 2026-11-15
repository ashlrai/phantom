/** RQ-PHX-RECHECKPOOLLINE355 — the pure "Pool:" reply line. Fake names only. */
import { describe, expect, it } from 'vitest';
import { formatPoolLine } from '../src/core/fleet/recheck-pool-line.js';
import type { PoolReach, PoolReachHost } from '../src/core/fleet/pool-reach.js';
import { sanitizeIdentityText } from '../src/core/fleet/runtime-identity.js';

const ISO = '2026-11-13T18:05:00.000Z';
const scrub = (s: string): string =>
  sanitizeIdentityText(s.replace(/\/(?:Users|home)\/[^/\s;,)]+/g, '~'), '');

function host(slot: 'primary' | 'backup', alias: string, over: Partial<PoolReachHost> = {}): PoolReachHost {
  return { slot, alias, matched: alias, online: true, lastSeen: ISO, ageSeconds: 5, isSelf: false, ...over };
}
function pool(hosts: PoolReachHost[], reasons: string[] = []): PoolReach {
  return { asOf: ISO, self: 'mac-a', role: 'primary', hosts, reasons };
}

describe('formatPoolLine', () => {
  it('both online', () => {
    expect(formatPoolLine(pool([host('primary', 'mac-a'), host('backup', 'mac-b')]), scrub)).toBe(
      `Pool: primary mac-a online · backup mac-b online · as of ${ISO} (tailnet evidence, not a claim)`);
  });
  it('backup offline shows last seen', () => {
    const line = formatPoolLine(pool([
      host('primary', 'mac-a'),
      host('backup', 'mac-b', { online: false, lastSeen: '2026-11-13T18:00:00Z' }),
    ]), scrub);
    expect(line).toContain('backup mac-b offline (last seen 2026-11-13T18:00:00Z)');
  });
  it('unknown state prints unknown', () => {
    const line = formatPoolLine(pool([host('primary', 'mac-a', { online: 'unknown' })]), scrub);
    expect(line).toContain('primary mac-a unknown');
  });
  it('isSelf appends this computer', () => {
    expect(formatPoolLine(pool([host('primary', 'mac-a', { isSelf: true })]), scrub))
      .toContain('primary mac-a online (this computer)');
  });
  it('not configured', () => {
    expect(formatPoolLine(pool([], ['tailscale unavailable', 'node pool not configured']), scrub))
      .toBe('Pool: not configured');
  });
  it('no hosts uses the first reason', () => {
    expect(formatPoolLine(pool([], ['pool: reader failed']), scrub))
      .toBe(`Pool: unknown · pool: reader failed · as of ${ISO} (tailnet evidence, not a claim)`);
  });
  it('null and undefined', () => {
    expect(formatPoolLine(null, scrub)).toBe('Pool: unknown (no pool evidence)');
    expect(formatPoolLine(undefined, scrub)).toBe('Pool: unknown (no pool evidence)');
  });
  it('redacts IPs and home paths', () => {
    const line = formatPoolLine(pool([
      host('primary', 'mac-a 100.64.1.2'),
      host('backup', 'mac-b', { online: false, lastSeen: '/home/fakeuser/x 100.100.9.9' }),
    ]), scrub);
    expect(line).not.toMatch(/100\.\d+\.\d+\.\d+|\/home\/fakeuser/);
    const none = formatPoolLine(pool([], ['see /Users/fakeuser/cfg 100.64.3.4']), scrub);
    expect(none).not.toMatch(/100\.\d+\.\d+\.\d+|\/Users\/fakeuser/);
  });
  it('bounds length by truncating reasons, never host states', () => {
    const long = formatPoolLine(pool([], ['r'.repeat(2000)]), scrub);
    expect(long.length).toBeLessThanOrEqual(240);
    expect(long.endsWith('(tailnet evidence, not a claim)')).toBe(true);
    const hosts = formatPoolLine(pool([
      host('primary', 'a'.repeat(500), { online: false }),
      host('backup', 'b'.repeat(500), { online: 'unknown' }),
    ]), scrub);
    expect(hosts.length).toBeLessThanOrEqual(240);
    expect(hosts).toContain(' offline');
    expect(hosts).toContain(' unknown');
  });
});
