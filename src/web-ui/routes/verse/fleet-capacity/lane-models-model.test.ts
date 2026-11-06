import { expect, it } from 'vitest';
import type { FleetLaneModelsV1 } from '../../../../core/verse/fleet-lane-models-contract.js';
import { laneModelLine, laneModelsHeadline, mismatchText } from './lane-models-model.js';
import { narrow } from './lane-models-query.js';
const now = Date.parse('2026-11-01T00:04:00Z');
const data: FleetLaneModelsV1 = {
  v: 1, generatedAt: new Date(now).toISOString(), source: 'ok', reason: null, launches: 1,
  lanes: [{ lane: 'codex-personal', family: 'codex', mismatch: false,
    tiers: [{ tier: 'work', model: 'gpt-6.1-sol', via: null }, { tier: 'mid', model: 'gpt-6.1-terra', via: null }, { tier: 'fast', model: 'gpt-6.1-terra', via: null }, { tier: 'low', model: null, via: null }],
    lastLaunch: { lane: 'codex-personal', tier: 'mid', model: 'gpt-6.1-terra', at: '2026-11-01T00:00:00Z' } }],
};
it('groups tiers and reports last launch age', () => {
  expect(laneModelLine('codex-personal', data, now)).toBe('work gpt-6.1-sol · mid, fast gpt-6.1-terra · last launch mid → gpt-6.1-terra 4 min ago');
  expect(mismatchText('codex-personal', data)).toBeNull();
  expect(laneModelsHeadline(data)).toBe('Models: 1 lanes, 0 mismatches');
});
it('reports mismatch against the launched tier', () => {
  const changed = structuredClone(data); changed.lanes[0].mismatch = true; changed.lanes[0].lastLaunch!.model = 'fake-old-model';
  expect(mismatchText('codex-personal', changed)).toBe('last launch used fake-old-model, table says gpt-6.1-terra');
  expect(laneModelsHeadline(changed)).toBe('Models: 1 lanes, 1 mismatches');
});
it('omits absent and unavailable data and unknown launch ages', () => {
  expect(laneModelLine('missing', data, now)).toBeNull();
  expect(laneModelLine('codex-personal', null, now)).toBeNull();
  expect(laneModelsHeadline({ ...data, source: 'unavailable' })).toBeNull();
  const changed = structuredClone(data); changed.lanes[0].lastLaunch!.at = null;
  expect(laneModelLine('codex-personal', changed, now)).not.toContain('ago');
  changed.lanes[0].lastLaunch = null;
  expect(laneModelLine('codex-personal', changed, now)).not.toContain('last launch');
});
it('narrows nested fields before rendering', () => {
  expect(narrow(data)).toEqual(data);
  expect(narrow({ ...data, source: ['ok'] })).toBeNull();
  expect(narrow({ ...data, lanes: [{ ...data.lanes[0], tiers: [{}] }] })).toBeNull();
  expect(narrow({ ...data, lanes: [{ ...data.lanes[0], lastLaunch: {} }] })).toBeNull();
  expect(narrow({ ...data, launches: -1 })).toBeNull();
});
