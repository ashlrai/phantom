import { describe, expect, it } from 'vitest';
import { nodeReachView, sanitizeNodeLabel } from '../src/core/fleet/node-reach-view.js';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');

describe('nodeReachView', () => {
  it('a fresh lease is reachable', () => {
    const [row] = nodeReachView({ lease: { node: 'fake-node-a', at: NOW - 30_000 } }, NOW);
    expect(row).toMatchObject({ label: 'fake-node-a', role: 'leader', state: 'reachable', source: 'lease' });
    expect(row?.lastSeenIso).toBe(new Date(NOW - 30_000).toISOString());
  });
  it('a 3-minute-old heartbeat is stale', () => {
    const [row] = nodeReachView({ joined: [{ node: 'fake-node-b', at: NOW - 180_000 }] }, NOW);
    expect(row).toMatchObject({ role: 'worker', state: 'stale' });
  });
  it('a missing timestamp is unknown, never offline', () => {
    const [row] = nodeReachView({ standby: { node: 'fake-node-b', at: null } }, NOW);
    expect(row).toMatchObject({ role: 'standby', state: 'unknown', lastSeenIso: null });
  });
  it('merges a duplicate node keeping the newest time and strongest role', () => {
    const rows = nodeReachView({
      lease: { node: 'fake-node-a', at: NOW - 170_000 },
      joined: [{ node: 'fake-node-a.tail0000.ts.net', at: NOW - 10_000 }, { node: 'fake-node-b', at: NOW - 5_000 }],
    }, NOW);
    expect(rows.map((r) => r.label)).toEqual(['fake-node-a', 'fake-node-b']);
    expect(rows[0]).toMatchObject({ role: 'leader', state: 'reachable', source: 'joined', lastSeenIso: new Date(NOW - 10_000).toISOString() });
  });
  it('treats a future time as unknown', () => {
    expect(nodeReachView({ joined: [{ node: 'fake-node-a', at: NOW + 60_000 }] }, NOW)[0]?.state).toBe('unknown');
  });
});

describe('sanitizeNodeLabel', () => {
  it('strips the tailnet suffix, user and IPs', () => {
    expect(sanitizeNodeLabel('fake-node-a.tail0000.ts.net')).toBe('fake-node-a');
    expect(sanitizeNodeLabel('someone@fake-node-b')).toBe('fake-node-b');
    expect(sanitizeNodeLabel('100.64.0.1')).toBe('unknown-node');
  });
});
