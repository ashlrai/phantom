import { describe, expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { deriveFleetNeedsYou } from './fleet-needs-you.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const snapshot = (over: Partial<FleetRuns> = {}): FleetRuns => ({
  v: 1, generatedAt: '2026-10-31T12:00:00Z',
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: false, memFreePct: 50, diskFreeGb: 80, switches: [], claudeLane: null,
  lanes: [], workers: [{ job: 'job', repo: 'phantom', lane: 'codex', tier: 'frontier', ageSeconds: 60 }],
  leaders: [{ label: 'leader', ageSeconds: 31 * 60 }], orchestratorAgents: 1, publishesLastHour: [],
  mergesLastHour: { count: 1, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null, ...over,
});
const item = (over: Partial<FleetRuns> = {}, now = NOW) =>
  deriveFleetNeedsYou(snapshot(over), now).items.find(i => i.id === 'leader-overdue');
const entry = (at: string) => ({ at, source: 'desktop', text: 'hello' });

describe('leader overdue', () => {
  it('reports an absent leader and counts the inbox', () => {
    expect(item({ leaders: [], inbox: [entry('2026-10-31 07:50')] })).toEqual({
      id: 'leader-overdue', severity: 'urgent', title: 'No leader process is running',
      detail: '1 inbox entries are waiting on a leader',
      nextStep: 'Check the leaders in Ops and restart the leader loop if it stopped', target: 'ops',
    });
  });
  it('reports the newest pass after 30 minutes and uses snapshot time', () => {
    expect(item({ leaders: [{ label: 'old', ageSeconds: 3600 }, { label: 'new', ageSeconds: 1860 }] }))
      .toMatchObject({ title: 'No leader pass for 31 minutes', detail: 'Nothing is waiting in the inbox yet', target: 'ops' });
    expect(item({ generatedAt: '2026-10-31T11:59:00Z', leaders: [{ label: 'new', ageSeconds: 1800 }] })?.title)
      .toBe('No leader pass for 31 minutes');
  });
  it('stays silent before or exactly at the threshold, and for unknown ages', () => {
    for (const ageSeconds of [14 * 60, 30 * 60, null]) {
      expect(item({ leaders: [{ label: 'leader', ageSeconds }] })).toBeUndefined();
    }
    expect(item({ generatedAt: 'invalid' })).toBeUndefined();
  });
  it('requires a reporting runs directory and no pause or switch', () => {
    expect(item({ switches: ['HOLD'] })).toBeUndefined();
    expect(item({ paused: true })).toBeUndefined();
    for (const runsDir of ['missing', 'not-landed'] as const) {
      expect(item({ sources: { ...snapshot().sources, runsDir } })).toBeUndefined();
    }
    expect(item({ sources: { ...snapshot().sources, runsDir: 'degraded' } })).toBeDefined();
  });
  it('counts only parseable entries strictly newer than the newest pass', () => {
    const inbox = ['07:28', '07:29', '07:30', '07:45', '07:59'].map(time => entry(`2026-10-31 ${time}`));
    inbox.push(entry('bad timestamp'));
    expect(item({ inbox })?.detail).toBe('3 inbox entries are waiting on a leader');
  });
  it('suppresses the card when the shared pulse is an incident', () => {
    const result = deriveFleetNeedsYou(snapshot({ leaders: [], workers: [], mergesLastHour: { count: 0, items: [] } }), NOW);
    expect(result.items.map(i => i.id)).toEqual(['stall-incident']);
  });
});
