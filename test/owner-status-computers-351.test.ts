import { describe, expect, it } from 'vitest';
import { formatRuntimeLine, RUNTIME_LINE_MAX_CHARS } from '../src/core/agents/owner-status-runtime-line.js';
import type { RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';
import type { TailnetPeer, TailnetPeers } from '../src/core/fleet/tailnet-peers.js';

const NOW = new Date('2026-11-13T20:27:00.000Z');

const identity = (over: Partial<RuntimeIdentity> = {}): RuntimeIdentity => ({
  host: 'mac-a', platform: 'darwin', asOf: NOW.toISOString(),
  installedVersion: '3.31.2', sourceVersion: '3.31.2', versionDrift: false,
  fleetState: { path: '~/.ashlr-runs/guardian/state.json', mtime: new Date(NOW.getTime() - 120_000).toISOString(), ageSeconds: 120, stale: false },
  tailnetName: 'mac-a', reasons: [], ...over,
});

const peer = (name: string, online: boolean | 'unknown'): TailnetPeer =>
  ({ name, os: 'macOS', online, lastSeen: 'unknown', ageSeconds: 'unknown' });
const peers = (list: TailnetPeer[], reasons: string[] = []): TailnetPeers =>
  ({ asOf: NOW.toISOString(), self: 'mac-a', peers: list, reasons });

describe('formatRuntimeLine computers segment', () => {
  it('counts online peers', () => {
    const line = formatRuntimeLine(identity(), null, NOW, peers([peer('mac-b', true), peer('mac-c', true), peer('mac-d', false)]));
    expect(line).toContain(' · computers 2/3 online ·');
    expect(line).not.toContain('unknown)');
  });

  it('reports unknown peers', () => {
    const line = formatRuntimeLine(identity(), null, NOW, peers([peer('mac-b', true), peer('mac-c', 'unknown')]));
    expect(line).toContain(' · computers 1/2 online (1 unknown)');
  });

  it('prints computers unknown for an empty failed read', () => {
    const line = formatRuntimeLine(identity(), null, NOW, peers([], ['tailscale unavailable or status unreadable']));
    expect(line).toContain(' · computers unknown');
  });

  it('is byte-identical to the 3-argument call when peers is null', () => {
    expect(formatRuntimeLine(identity(), null, NOW, null)).toBe(formatRuntimeLine(identity(), null, NOW));
    expect(formatRuntimeLine(identity(), null, NOW)).not.toContain('computers');
  });

  it('still caps at 240 chars with a long host', () => {
    const line = formatRuntimeLine(identity({ host: 'h'.repeat(400) }), null, NOW, peers([peer('mac-b', true)]));
    expect(line).toHaveLength(RUNTIME_LINE_MAX_CHARS);
  });

  it('never prints peer names, paths or IPs', () => {
    const line = formatRuntimeLine(identity(), null, NOW, peers([peer('/Users/syntheticowner/box', true), peer('10.1.2.3', false)]));
    expect(line).toContain('computers 1/2 online');
    expect(line).not.toContain('syntheticowner');
    expect(line).not.toContain('10.1.2.3');
    expect(line).not.toContain('/Users/');
  });
});
