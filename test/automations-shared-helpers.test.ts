import { describe, expect, it } from 'vitest';
import {
  approvalTargetLane,
  estimateLaneUsdSafe,
  readKillActiveSafe,
  readPolicySafe,
} from '../src/core/automations/lanes.js';
import { pad2, RRULE_DAY_CODES } from '../src/core/automations/rrule.js';
import { AUTOMATION_SCHEMA_VERSION, type AutomationV1 } from '../src/core/automations/types.js';
import {
  AUTOMATION_INPUT_KEYS,
  AutomationInputError,
  failAutomationInput,
  formatLocalMinute,
  isRecord,
  isValidBranchName,
  normaliseAutomation,
  parseIsoDate,
  roundUsd,
  truncateWithEllipsis,
} from '../src/core/automations/validate.js';
import { policyFor } from './helpers/automations-fakes.js';

function makeAutomation(lane: AutomationV1['lane']): AutomationV1 {
  return normaliseAutomation({
    name: 'Shared helper test',
    enabled: false,
    trigger: { kind: 'webhook' },
    lane,
    playbookId: null,
    repos: ['acme/app'],
    instructions: 'Check the task.',
  }, { now: new Date('2026-11-27T12:00:00.000Z') });
}

describe('automations shared helpers', () => {
  it('guards plain records and validates branch names consistently', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect([null, undefined, [], 'text', 42].every((v) => !isRecord(v))).toBe(true);

    expect(isValidBranchName('main')).toBe(true);
    expect(isValidBranchName('release/v3.15_rc-1')).toBe(true);
    expect(['feature..bad', '-dash', 'has space', '', 'a'.repeat(201), 123].every((v) => !isValidBranchName(v))).toBe(true);
  });

  it('formats zero-padded numbers, ellipsis caps, USD amounts, and local minute stamps', () => {
    expect([pad2(0), pad2(7), pad2(23)]).toEqual(['00', '07', '23']);
    expect(RRULE_DAY_CODES).toEqual(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']);
    expect([truncateWithEllipsis('short', 10), truncateWithEllipsis('exact', 5), truncateWithEllipsis('toolong', 5)]).toEqual(['short', 'exact', 'tool…']);
    expect([roundUsd(0.1 + 0.2), roundUsd(12.346), roundUsd(12.344), roundUsd(0)]).toEqual([0.3, 12.35, 12.34, 0]);

    expect(parseIsoDate('2026-11-27T15:05:00.000Z')?.toISOString()).toBe('2026-11-27T15:05:00.000Z');
    expect([parseIsoDate('not-a-date'), parseIsoDate(null), parseIsoDate(12345)]).toEqual([null, null, null]);
    const local = new Date(2026, 10, 27, 9, 5, 0, 0);
    expect([formatLocalMinute(local.toISOString()), formatLocalMinute(null), formatLocalMinute('invalid')]).toEqual(['2026-11-27 09:05', null, null]);
  });

  it('keeps AUTOMATION_INPUT_KEYS aligned with normalised definitions and fails closed on gate errors', async () => {
    const normalised = makeAutomation('fleet');
    expect(normalised.v).toBe(AUTOMATION_SCHEMA_VERSION);
    for (const key of AUTOMATION_INPUT_KEYS) expect(key in normalised).toBe(true);
    expect(() => failAutomationInput('bad input')).toThrow(AutomationInputError);

    expect(await readKillActiveSafe({ killActive: () => false })).toBe(false);
    expect(await readKillActiveSafe({ killActive: () => { throw new Error('boom'); } })).toBe(true);
    const policy = policyFor(['acme/app']);
    expect(await readPolicySafe({ policy: () => policy })).toBe(policy);
    expect(await readPolicySafe({ policy: () => { throw new Error('boom'); } })).toBeNull();
    expect(await estimateLaneUsdSafe('cloud', { estimateUsd: () => 4.25 })).toBe(4.25);
    expect(await estimateLaneUsdSafe('cloud', { estimateUsd: () => { throw new Error('boom'); } })).toBe(Number.POSITIVE_INFINITY);

    expect([
      approvalTargetLane(null),
      approvalTargetLane(makeAutomation('leader-review')),
      approvalTargetLane(makeAutomation('fleet')),
      approvalTargetLane(makeAutomation('cloud')),
      approvalTargetLane(makeAutomation('devin')),
    ]).toEqual(['fleet', 'fleet', 'fleet', 'cloud', 'devin']);
  });
});
