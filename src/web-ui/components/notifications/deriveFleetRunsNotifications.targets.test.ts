import { describe, expect, it, vi } from 'vitest';
import * as paneLink from '../../routes/verse/dock/pane-link.js';
import { parseDeepLink } from '../../routes/verse/shell/deep-link.js';
import { deriveFleetRunsNotifications as derive } from './deriveFleetRunsNotifications.js';

const now = Date.parse('2026-10-31T11:45:00Z');
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  generatedAt: new Date(now).toISOString(), paused: false, claudeLane: 'healthy',
  memFreePct: null, diskFreeGb: null, lanes: [], workers: [{ ageSeconds: 60 }],
  mergesLastHour: { count: 0 }, drop: null, events: [], ...overrides,
});
const lane = (held: boolean) => ({ lane: 'codex', held, running: 0, target: 1, queued: 2 });
const entry = (at: string) => ({ at, source: 'desktop', text: 'Check the fleet' });

describe('fleet notification targets', () => {
  it.each([
    ['fleet-stall', { workers: [{ ageSeconds: 1800 }] }, 'Open lanes', 'fleet-lanes'],
    ['fleet-claude-lane-down', { claudeLane: 'down' }, 'Open host', 'fleet-host'],
    ['fleet-lane-held-codex', { lanes: [lane(true)] }, 'Open lanes', 'fleet-lanes'],
    ['fleet-lane-idle-codex', { lanes: [lane(false)] }, 'Open lanes', 'fleet-lanes'],
    ['fleet-drop-pending', { drop: { pending: [{ lane: 'codex', file: 'job' }], done: 0 } }, 'Open leader journal', 'leader-journal'],
    ['fleet-inbox-read:', { inbox: [entry('2026-10-31 07:31')], leaders: [{ ageSeconds: 300 }] }, 'Open inbox', 'fleet-inbox'],
    ['fleet-inbox-overdue:', { inbox: [entry('2026-10-31 07:15')], leaders: [] }, 'Open inbox', 'fleet-inbox'],
    ['fleet-host-pressure', { diskFreeGb: 8 }, 'Open host', 'fleet-host'],
  ])('opens the correct pane for %s', (id, overrides, label, pane) => {
    const notification = derive(snapshot(overrides), now).find((item) => item.id.startsWith(id));
    expect(notification?.actionLabel).toBe(label);
    expect(notification?.actionHref).toContain(pane);
    const url = new URL(notification!.actionHref!);
    expect(url.pathname).toBe('/verse/');
    expect(parseDeepLink(url.search)).toEqual({ paneId: pane, sessionId: null });
  });

  it('omits both action fields when a pane link cannot be resolved', () => {
    const link = vi.spyOn(paneLink, 'paneLinkUrl').mockReturnValue(null);
    try {
      const [notification] = derive(snapshot({ diskFreeGb: 8 }), now);
      expect(notification).not.toHaveProperty('actionHref');
      expect(notification).not.toHaveProperty('actionLabel');
    } finally {
      link.mockRestore();
    }
  });
});

describe('host pressure notifications', () => {
  it.each([[9.9, 'critical'], [10, 'high'], [24.9, 'high'], [25, null]])(
    'disk %s GB produces %s', (diskFreeGb, severity) => {
      const notification = derive(snapshot({ diskFreeGb }), now).find((item) => item.id === 'fleet-host-pressure');
      expect(notification?.severity ?? null).toBe(severity);
    },
  );
  it.each([[4, 'critical'], [5, 'high'], [9, 'high'], [10, null]])(
    'memory %s%% produces %s', (memFreePct, severity) => {
      const notification = derive(snapshot({ memFreePct }), now).find((item) => item.id === 'fleet-host-pressure');
      expect(notification?.severity ?? null).toBe(severity);
    },
  );
  it('reports available measurements and uses the most severe threshold', () => {
    expect(derive(snapshot({ diskFreeGb: 8.2, memFreePct: 4 }), now)).toEqual([expect.objectContaining({
      id: 'fleet-host-pressure', severity: 'critical', title: 'Host under pressure',
      detail: 'Disk 8.2 GB free · memory 4% free',
    })]);
    expect(derive(snapshot({ diskFreeGb: 20, memFreePct: 4 }), now)[0]?.severity).toBe('critical');
    expect(derive(snapshot({ diskFreeGb: null, memFreePct: 9 }), now)[0]?.detail).toBe('memory 9% free');
    expect(derive(snapshot({ diskFreeGb: 8, memFreePct: null }), now)[0]?.detail).toBe('Disk 8 GB free');
    expect(derive(snapshot(), now)).toEqual([]);
  });
});
