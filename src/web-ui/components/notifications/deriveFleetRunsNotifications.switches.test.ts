import { describe, expect, it } from 'vitest';
import { parseDeepLink } from '../../routes/verse/shell/deep-link.js';
import { deriveFleetRunsNotifications as derive } from './deriveFleetRunsNotifications.js';

const now = Date.parse('2026-10-31T11:45:00Z');
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  generatedAt: new Date(now).toISOString(), paused: false, claudeLane: 'healthy',
  memFreePct: null, diskFreeGb: null, lanes: [], workers: [{ ageSeconds: 60 }],
  mergesLastHour: { count: 0 }, drop: null, events: [], ...overrides,
});

describe('fleet switch and runs-dir notifications', () => {
  it('emits one fleet-switches-on when HOLD switch files stop dispatch', () => {
    const out = derive(snapshot({ switches: ['HOLD-ALL'] }), now);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'fleet-switches-on', severity: 'high', title: 'Dispatch paused by HOLD-ALL',
      detail: 'A HOLD switch file is stopping dispatch; clear it from Fleet controls.',
      actionLabel: 'Open lanes',
    });
    const url = new URL(out[0]!.actionHref!);
    expect(url.pathname).toBe('/verse/');
    expect(parseDeepLink(url.search)).toEqual({ paneId: 'fleet-lanes', sessionId: null });
  });

  it('scrubs switch names and caps the title at three names plus a count', () => {
    const out = derive(snapshot({ switches: ['HOLD-ALL', 'HOLD-B', 'x'.repeat(40), 'HOLD-C', 'HOLD-D'] }), now);
    expect(out[0]?.title).toBe('Dispatch paused by HOLD-ALL, HOLD-B, … +2 more');
  });

  it('emits fleet-runs-dir-missing when sources.runsDir reports missing', () => {
    const out = derive(snapshot({ sources: { runsDir: 'missing' } }), now);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'fleet-runs-dir-missing', severity: 'critical', title: 'Fleet runs directory is missing',
      detail: 'The fleet cannot read runs, lanes or switches until it exists. Check the runs path on the Host pane.',
      actionLabel: 'Open host',
    });
    const url = new URL(out[0]!.actionHref!);
    expect(url.pathname).toBe('/verse/');
    expect(parseDeepLink(url.search)).toEqual({ paneId: 'fleet-host', sessionId: null });
  });

  it.each(['healthy', 'degraded', 'not-landed'])('emits neither when runsDir is %s and no switches are on', (runsDir) => {
    expect(derive(snapshot({ switches: [], sources: { runsDir } }), now)).toEqual([]);
  });

  it('sorts switch and runs-dir alerts ahead of the fleet-stall alert', () => {
    const stalled = { workers: [{ ageSeconds: 2040 }], mergesLastHour: { count: 0 } };
    expect(derive(snapshot({ ...stalled, switches: ['HOLD-ALL'], sources: { runsDir: 'missing' } }), now)
      .map((n) => n.id)).toEqual(['fleet-switches-on', 'fleet-runs-dir-missing', 'fleet-stall']);
  });

  it('still accepts snapshots without switches or sources keys', () => {
    expect(derive(snapshot(), now)).toEqual([]);
    expect(derive(snapshot({ claudeLane: 'down' }), now).map((n) => n.id)).toEqual(['fleet-claude-lane-down']);
  });

  it.each([
    ['a non-string switch entry', { switches: ['HOLD-ALL', 7] }],
    ['a non-array switches value', { switches: 'HOLD-ALL' }],
    ['a non-record sources value', { sources: 'missing' }],
    ['a non-string runsDir', { sources: { runsDir: 7 } }],
  ])('rejects %s', (_label, overrides) => {
    expect(derive(snapshot(overrides), now)).toEqual([]);
  });
});
