import { describe, expect, it } from 'vitest';
import { dotEvidenceView, missingReason, NO_OWNER_TEXT } from './dot-evidence-model.js';

const unavailable = { state: 'unavailable' };
const packet = (over: Record<string, unknown> = {}) => ({
  v: 1, authority: 'none', generatedAt: '2026-11-14T18:00:00.000Z',
  packet: {
    runtime: { host: 'fake-host-a', installedVersion: '1.0.0', sourceVersion: '1.1.0', versionDrift: true, fleetState: { ageSeconds: 30, stale: false } },
    tailnet: { self: 'fake-node', peers: [{ name: 'p1', os: 'x', online: true, ageSeconds: 1 }, { name: 'p2', os: 'x', online: 'unknown', ageSeconds: 'unknown' }] },
    claims: { claims: [{ id: 'c1', state: 'ASSIGNED' }, { id: 'c2', state: 'RUNNING' }] },
    slack: { counts: { total: 3, answered: 2, uncertain: 0, busFailed: 0, unanswered: 1 }, sources: { journal: 'ok', sends: 'ok' } },
    bridge: { owner: 'agent-fake-1' }, missing: [],
    ...over,
  },
});
const row = (v: ReturnType<typeof dotEvidenceView>, label: string) => v!.rows.find(r => r.label === label)!;

describe('dotEvidenceView', () => {
  it('maps a full packet to rows', () => {
    const v = dotEvidenceView(packet());
    expect(row(v, 'Runtime host').text).toContain('fake-host-a');
    expect(row(v, 'Runtime host').text).toContain('version drift');
    expect(row(v, 'Tailnet').text).toBe('fake-node · 1 of 2 peers online (1 unknown)');
    expect(row(v, 'Live claims').text).toBe('2 live · ASSIGNED, RUNNING');
    expect(row(v, 'Slack traces').text).toContain('3 total');
    expect(row(v, 'Bridge owner').text).toBe('agent-fake-1');
  });
  it('keeps unavailable sections as unknown, never 0 or offline', () => {
    const v = dotEvidenceView(packet({ runtime: unavailable, tailnet: unavailable, claims: unavailable, slack: unavailable }));
    for (const label of ['Runtime host', 'Fleet state', 'Tailnet', 'Live claims', 'Slack traces']) {
      expect(row(v, label)).toMatchObject({ text: 'unknown', tone: 'unknown' });
    }
  });
  it('shows unknown fleet-state age as unknown', () => {
    const v = dotEvidenceView(packet({ runtime: { host: 'h', installedVersion: '1', sourceVersion: '1', versionDrift: false, fleetState: { ageSeconds: 'unknown', stale: 'unknown' } } }));
    expect(row(v, 'Fleet state').text).toContain('unknown');
  });
  it('renders owner unknown as the no-owner sentence', () => {
    const v = dotEvidenceView(packet({ bridge: { owner: 'unknown' } }));
    expect(row(v, 'Bridge owner').text).toBe('no named owner (no live claim names dot-handoff)');
    expect(NO_OWNER_TEXT).toBe(row(v, 'Bridge owner').text);
  });
  it('maps missing codes to plain language', () => {
    const v = dotEvidenceView(packet({ missing: ['claims-store-unreadable', 'bridge-owner-unknown', 'weird-code'] }));
    expect(v!.missing).toEqual([
      'The claims store could not be read.', 'No live claim names the Dot bridge owner.', missingReason('weird-code'),
    ]);
    expect(v!.missing[2]).not.toContain('weird-code');
  });
  it('returns null for a non-packet response', () => {
    expect(dotEvidenceView(null)).toBeNull();
    expect(dotEvidenceView({ v: 2 })).toBeNull();
  });
});
