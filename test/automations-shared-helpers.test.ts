/**
 * Regression coverage for shared automations helpers consolidated across
 * types, rrule, validate, lanes, store, engine, needs-you, import, and CLI.
 */
import { describe, expect, it } from 'vitest';

import {
  approvedReviewLane,
  AUTOMATION_BRANCH_PATTERN,
  automationToInput,
  isAutomationRecord,
  roundAutomationUsd,
  truncateAutomationText,
  type AutomationFiringV1,
  type AutomationV1,
} from '../src/core/automations/types.js';
import { formatLocalTimestamp, pad2, parseIsoDate, RRULE_DAY_CODES } from '../src/core/automations/rrule.js';
import { dispatchToLane, resolveLaneDeps, safeReadKillActive, safeReadPolicy } from '../src/core/automations/lanes.js';
import { AutomationInputError, failAutomationInput } from '../src/core/automations/validate.js';
import { policyFor } from './helpers/automations-fakes.js';

const sampleAutomation: AutomationV1 = {
  v: 1,
  id: 'au_sample',
  name: 'Sample',
  enabled: true,
  trigger: { kind: 'webhook' },
  lane: 'cloud',
  playbookId: null,
  repos: ['acme/app'],
  instructions: 'Fix it.',
  maxConcurrent: 2,
  maxPerDay: 5,
  queueDepth: 10,
  spendCapUsd: 25,
  dedupeKey: null,
  triage: null,
  createdAt: '2026-09-27T12:00:00.000Z',
  updatedAt: '2026-09-27T12:00:00.000Z',
};

const sampleFiring: AutomationFiringV1 = {
  v: 1,
  id: 'af_20260927T120000_abc123',
  automationId: 'au_sample',
  dedupeKey: 'k1',
  source: { kind: 'webhook', url: null, ref: 'k1' },
  repo: 'acme/app',
  title: 'Task',
  text: 'Details',
  lane: 'cloud',
  playbookId: null,
  state: 'dispatching',
  reason: null,
  laneRef: null,
  spendUsd: 0,
  attempts: 1,
  createdAt: '2026-09-27T12:00:00.000Z',
  dispatchedAt: null,
  settledAt: null,
  updatedAt: '2026-09-27T12:00:00.000Z',
};

describe('automations shared helpers', () => {
  it('guards plain records and validates branch patterns', () => {
    expect(isAutomationRecord({ a: 1 })).toBe(true);
    expect(isAutomationRecord(null)).toBe(false);
    expect(isAutomationRecord([])).toBe(false);
    expect(isAutomationRecord('text')).toBe(false);
    expect(AUTOMATION_BRANCH_PATTERN.test('main')).toBe(true);
    expect(AUTOMATION_BRANCH_PATTERN.test('release/v1.2_rc-1')).toBe(true);
    expect(AUTOMATION_BRANCH_PATTERN.test('bad branch')).toBe(false);
  });

  it('rounds USD, truncates text, picks approved review lane, and strips stored metadata', () => {
    expect(roundAutomationUsd(12.345)).toBe(12.35);
    expect(roundAutomationUsd(0)).toBe(0);
    expect(truncateAutomationText('short', 10)).toBe('short');
    expect(truncateAutomationText('abcdefghij', 5)).toBe('abcd…');
    expect(approvedReviewLane(null)).toBe('fleet');
    expect(approvedReviewLane({ lane: 'leader-review' })).toBe('fleet');
    expect(approvedReviewLane({ lane: 'devin' })).toBe('devin');
    const input = automationToInput(sampleAutomation);
    expect(input).not.toHaveProperty('v');
    expect(input).not.toHaveProperty('id');
    expect(input).not.toHaveProperty('createdAt');
    expect(input).not.toHaveProperty('updatedAt');
    expect(input.name).toBe('Sample');
  });

  it('parses ISO dates, zero-pads digits, exposes RFC 5545 weekday codes, and formats local timestamps', () => {
    expect(RRULE_DAY_CODES).toEqual(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']);
    expect(pad2(4)).toBe('04');
    expect(pad2(12)).toBe('12');
    expect(parseIsoDate('2026-09-27T12:00:00Z')?.toISOString()).toBe('2026-09-27T12:00:00.000Z');
    expect(parseIsoDate('')).toBeNull();
    expect(parseIsoDate('not-a-date')).toBeNull();
    expect(parseIsoDate(123)).toBeNull();
    const local = new Date(2026, 8, 27, 9, 5);
    expect(formatLocalTimestamp(local.toISOString())).toBe('2026-09-27 09:05');
    expect(formatLocalTimestamp(null)).toBeNull();
    expect(formatLocalTimestamp('invalid')).toBeNull();
  });

  it('fails closed on kill/policy reads and throws AutomationInputError on invalid input', async () => {
    expect(await safeReadKillActive({ killActive: () => { throw new Error('boom'); } })).toBe(true);
    expect(await safeReadKillActive({ killActive: async () => false })).toBe(false);
    expect(await safeReadPolicy({ policy: () => { throw new Error('boom'); } })).toBeNull();
    const policy = policyFor(['acme/app']);
    expect(await safeReadPolicy({ policy: async () => policy })).toBe(policy);
    expect(() => failAutomationInput('bad input')).toThrow(AutomationInputError);
  });

  it('maps cloud launch failures cleanly: null failure refuses, coded failure defers', async () => {
    const refused = await dispatchToLane(
      sampleAutomation,
      sampleFiring,
      resolveLaneDeps({ launchCloud: async () => ({ ok: false, task: null, error: 'Bad request.', failure: null }) }),
    );
    expect(refused).toEqual({ kind: 'refused', reason: 'Bad request.' });

    for (const failure of ['budget', 'auth', 'unknown'] as const) {
      const deferred = await dispatchToLane(
        sampleAutomation,
        sampleFiring,
        resolveLaneDeps({ launchCloud: async () => ({ ok: false, task: null, error: `Cloud ${failure}`, failure }) }),
      );
      expect(deferred).toEqual({ kind: 'deferred', reason: `Cloud ${failure}` });
    }
  });
});
