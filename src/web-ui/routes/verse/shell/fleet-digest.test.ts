import { describe, expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { fleetDigest } from './fleet-digest.js';

export const now = Date.parse('2026-10-31T12:00:00Z');
export const fixture: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: '2026-10-31T11:59:20Z', paused: true, memFreePct: null, diskFreeGb: null, switches: ['HOLD'], claudeLane: 'down token rejected',
  lanes: [{ lane: 'codex-personal', running: 8, target: 24, queued: 4, held: true, heldReason: 'reason', tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: [{ job: 'fake', repo: 'fake', lane: 'fake', tier: 'fake', ageSeconds: 2280 }], leaders: [], orchestratorAgents: null,
  publishesLastHour: [{ job: 'fake', lane: null, url: null, at: '2026-10-31T12:00:00Z' }], mergesLastHour: { count: 3, items: [] }, events: [],
  codexPersonal: { usedPct: 46, resetsAt: '2026-10-31T15:00:00Z', asOf: null },
  inbox: [{ at: '2026-10-31T11:48:00Z', source: 'Phantom desktop', text: 'hello' }], drop: null,
};
describe('fleetDigest', () => {
  it('renders every line', () => {
    const lines = fleetDigest(fixture, now).split('\n');
    expect(lines[0]).toContain('tick 40 s ago · HOLD on / paused');
    expect(lines.slice(1)).toEqual(['Lanes: codex-personal 8/24 (+4 q, held: reason)', 'Workers: 1 · oldest 38 min', 'Merged last hour: 3 · publishes: 1', 'Personal Codex: 46 % used, resets in 3 h', 'Claude lane: down token rejected', 'Inbox: last "hello" (Phantom desktop, 12 min ago)']);
  });
  it('omits unavailable fields', () => {
    const digest = fleetDigest({ ...fixture, lastTick: null, paused: null, switches: [], lanes: [], codexPersonal: null, claudeLane: null, inbox: [], mergesLastHour: { count: null, items: [] } }, now);
    expect(digest).not.toMatch(/tick|paused|Lanes:|Personal Codex:|Claude lane:|Inbox:|Merged last hour:/);
  });
  it('limits reasons and the whole digest', () => {
    const lane = { ...fixture.lanes[0], heldReason: 'x'.repeat(100) };
    expect(fleetDigest({ ...fixture, lanes: [lane] }, now)).toContain(`held: ${'x'.repeat(39)}…`);
    const digest = fleetDigest({ ...fixture, lanes: Array(100).fill(lane) }, now);
    expect(digest).toHaveLength(1200);
    expect(digest.endsWith('…')).toBe(true);
  });
});
