import { describe, expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { workerRows } from './fleet-lanes-model.js';
import { boardHeadline, fleetStrip, laneCard, laneFacts, PIP_LIMIT, pulseLine } from './lanes-board-model.js';

const lane = { lane: 'codex', running: 2, target: 4, queued: 3, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null };
const runs: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: '2026-10-31T11:59:20Z', paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [lane], workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 2, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};

describe('fleet lanes model', () => {
  it('clamps lane fills, handles zero targets and mutes held lanes', () => {
    const cards = [lane, { ...lane, lane: 'held', running: 8, held: true, heldReason: 'Budget' }, { ...lane, lane: 'zero', target: 0 }, { ...lane, lane: 'negative', running: -1 }]
      .map((row) => laneCard(row, false));
    expect(cards.map(({ fillPct, state }) => [fillPct, state])).toEqual([[50, 'open'], [100, 'held'], [null, 'over'], [0, 'open']]);
    expect(cards[1]).toMatchObject({ held: true, heldReason: 'Budget', queued: 3 });
  });
  it('names each lane state in words, leaving Down and Held to their badges', () => {
    const text = (row: Partial<typeof lane>, claudeDown = false) => { const card = laneCard({ ...lane, ...row }, claudeDown); return [card.state, card.stateText]; };
    expect(text({})).toEqual(['open', '2 open']);
    expect(text({ running: 4 })).toEqual(['full', 'Full']);
    expect(text({ running: 6 })).toEqual(['over', '2 over target']);
    expect(text({ running: 0, target: 0 })).toEqual(['off', 'Target 0']);
    expect(text({ held: true })).toEqual(['held', null]);
    expect(text({ lane: 'claude' }, true)).toEqual(['down', null]);
    // Only the claude lane follows the claude lane's health, and only while it is asked to run something.
    expect(text({}, true)[0]).toBe('open');
    expect(text({ lane: 'claude', running: 0, target: 0 }, true)[0]).toBe('off');
  });
  it('draws one mark per slot, running first, and falls back to a bar for a large lane', () => {
    expect(laneCard(lane, false).pips).toEqual(['running', 'running', 'open', 'open']);
    expect(laneCard({ ...lane, running: 3, target: 2 }, false).pips).toEqual(['running', 'running', 'over']);
    expect(laneCard({ ...lane, running: 0, target: 0 }, false).pips).toBeNull();
    expect(laneCard({ ...lane, target: PIP_LIMIT }, false).pips).toHaveLength(PIP_LIMIT);
    expect(laneCard({ ...lane, target: PIP_LIMIT + 1 }, false)).toMatchObject({ pips: null, fillPct: 2 / (PIP_LIMIT + 1) * 100 });
  });
  it('sorts known worker ages oldest first and formats ages, leaving unknown last', () => {
    const worker = { job: 'a', repo: 'example/repo', lane: 'codex', tier: 'frontier', ageSeconds: 10 };
    const rows = workerRows({ ...runs, workers: [worker, { ...worker, job: 'unknown', ageSeconds: null }, { ...worker, job: 'old', ageSeconds: 120 }] });
    expect(rows.map(({ job, age }) => [job, age])).toEqual([['old', '02:00'], ['a', '00:10'], ['unknown', '—']]);
  });
  it('summarizes totals and preserves unknown readings', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    expect(boardHeadline(runs)).toBe('2 of 4 slots running.');
    expect(boardHeadline({ ...runs, lanes: [{ ...lane, target: 1, running: 1 }, { ...lane, lane: 'devin', running: 0, target: 0, held: true }] })).toBe('1 of 1 slot running, 1 lane held.');
    expect(boardHeadline({ ...runs, lanes: [] })).toBe('No lanes reported.');
    expect(pulseLine(runs, now)).toBe('2 merged last hour · last tick 40 s ago');
    expect(pulseLine({ ...runs, lastTick: null, mergesLastHour: { count: null, items: [] } }, now)).toBe('Merges last hour unknown · last tick unknown');
    expect(pulseLine({ ...runs, lastTick: 'not a date' }, now)).toContain('last tick unknown');
    expect(pulseLine({ ...runs, lastTick: '2026-10-31T11:58:00Z' }, now)).toContain('last tick 2 minutes ago');
  });
  it('lays every lane with slots on one strip and skips a lane with none', () => {
    const cards = [lane, { ...lane, lane: 'devin', running: 3, target: 2, held: true }, { ...lane, lane: 'local', running: 0, target: 0 }].map((row) => laneCard(row, false));
    expect(fleetStrip(cards)).toEqual({
      segments: [{ lane: 'codex', weight: 4, fillPct: 50, state: 'open' }, { lane: 'devin', weight: 3, fillPct: 100, state: 'held' }],
      label: 'Fleet slots: codex 2 of 4, devin 3 of 2',
    });
    expect(fleetStrip([laneCard({ ...lane, running: 0, target: 0 }, false)])).toBeNull();
    expect(fleetStrip([])).toBeNull();
  });
  it('labels each reading and leaves a missing one unknown rather than zero', () => {
    expect(laneFacts(lane)).toEqual([{ label: 'Tokens last hour', value: null }, { label: 'Merged in 24 h', value: null }, { label: 'Merge rate', value: null }]);
    expect(laneFacts({ ...lane, tokensLastHour: 1_300_000, merged24h: 0, mergeRate24h: 0.375 }).map((fact) => fact.value)).toEqual(['1.3M', '0', '0.4/h']);
    expect(laneFacts({ ...lane, tokensLastHour: -1, merged24h: NaN, mergeRate24h: Infinity }).map((fact) => fact.value)).toEqual([null, null, null]);
  });
});
