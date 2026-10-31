import { describe, expect, it } from 'vitest';
import { ageText, countText, isFleetRuns, newest, relativeText, type FleetRuns } from './ops-runs-model.js';

export const fixture: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z',
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'degraded', codex: 'missing', merges: 'not-landed' },
  lastTick: '2026-10-31T11:59:00Z', paused: true, memFreePct: 30, diskFreeGb: 80,
  switches: ['HOLD', 'queue/DISABLE'], claudeLane: 'down: quota',
  lanes: [{ lane: 'codex', running: 1, target: 2, queued: 3, held: true, heldReason: 'Budget hold', tokensLastHour: 500, merged24h: 6, mergeRate24h: 75 }],
  workers: [{ job: 'worker-one', repo: 'phantom', lane: 'codex', tier: 'frontier', ageSeconds: 65 }],
  leaders: [{ label: 'leader', ageSeconds: 20 }], orchestratorAgents: 2,
  publishesLastHour: [{ job: 'publish-one', lane: 'codex', url: 'https://github.com/ashlrai/phantom/pull/12', at: '2026-10-31T12:00:00Z' }],
  mergesLastHour: { count: 1, items: [{ repo: 'phantom', number: 12, title: 'Fleet view' }] },
  events: [{ at: '2026-10-31T11:00:00Z', kind: 'tick', text: 'Old event' }, { at: '2026-10-31T12:00:00Z', kind: 'merge', text: 'New event' }],
  codexPersonal: { usedPct: 42, resetsAt: '2026-10-31T13:00:00Z', asOf: '2026-10-31T12:00:00Z' },
  inbox: [{ at: '2026-10-31T12:00:00Z', source: 'Mason', text: 'Inbox message' }],
  drop: { pending: [{ lane: 'codex', file: 'request.md' }], done: 1 },
};
describe('live runs model', () => {
  it('validates every branch of the wire shape', () => {
    expect(isFleetRuns(fixture)).toBe(true);
    expect(isFleetRuns({ ...fixture, publishesLastHour: [{ ...fixture.publishesLastHour[0], lane: null, url: null }] })).toBe(true);
    for (const bad of [null, [], { ...fixture, v: 2 }, { ...fixture, sources: {} },
      { ...fixture, workers: [{ ...fixture.workers[0], ageSeconds: 'old' }] },
      { ...fixture, mergesLastHour: { count: 1, items: [null] } },
      { ...fixture, lanes: [{ ...fixture.lanes[0], held: 1 }] },
      { ...fixture, diskFreeGb: Infinity }, { ...fixture, drop: {} }]) expect(isFleetRuns(bad)).toBe(false);
  });
  it('keeps unknown distinct from zero and derives readable time', () => {
    expect(countText(null)).toBe('—'); expect(countText(0)).toBe('0');
    expect(ageText(65)).toBe('01:05'); expect(ageText(3660)).toBe('1:01'); expect(ageText(null)).toBe('—');
    expect(relativeText('2026-10-31T12:01:00Z', Date.parse(fixture.generatedAt))).toBe('in 1 minute');
    expect(newest(fixture.events, 1)[0].text).toBe('New event');
    expect(fixture.events[0].text).toBe('Old event');
  });
});
