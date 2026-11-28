/**
 * Regression tests for shared helpers consolidated across src/core/automations,
 * src/core/verse/automations-api.ts, and src/cli/automations.ts, and for dead-code
 * cleanups in lane dispatch and state parsing.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AUTOMATION_BRANCH_PATTERN,
  AUTOMATION_INPUT_KEYS,
  formatLocalTimestamp,
  isPlainObject,
  readAutomationState,
  type AutomationFiringV1,
  type AutomationV1,
} from '../src/core/automations/index.js';
import { pollRedBranch } from '../src/core/automations/github.js';
import {
  dispatchToLane,
  estimateLaneUsdSafely,
  isKillActiveSafely,
  readPolicySafely,
  resolveLaneDeps,
  reviewTargetLane,
} from '../src/core/automations/lanes.js';
import { RRULE_DAY_CODES } from '../src/core/automations/rrule.js';
import { automationsDir } from '../src/core/automations/store.js';
import {
  automationToInput,
  capText,
  normaliseAutomation,
  pad2,
  parseIsoDate,
  roundUsd,
} from '../src/core/automations/validate.js';
import { fakeGh, fakeLanes, isolateAshlrHome, policyFor } from './helpers/automations-fakes.js';

describe('automations shared validation and formatting helpers', () => {
  it('identifies plain JSON objects and rejects arrays, null and primitives', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    for (const bad of [null, undefined, [], 'text', 42]) expect(isPlainObject(bad)).toBe(false);
  });

  it('caps text, rounds USD values to cents, and zero-pads two-digit numbers', () => {
    expect(capText('short', 5)).toBe('short');
    expect(capText('toolong', 5)).toBe('tool…');
    expect(roundUsd(1.234)).toBe(1.23);
    expect(roundUsd(1.236)).toBe(1.24);
    expect([pad2(0), pad2(7), pad2(12)]).toEqual(['00', '07', '12']);
  });

  it('parses ISO dates and formats local timestamps safely', () => {
    const sample = new Date(2026, 8, 5, 7, 9, 0, 0);
    const iso = sample.toISOString();
    expect(parseIsoDate(iso)?.getTime()).toBe(sample.getTime());
    for (const bad of ['not-a-date', 123, null]) expect(parseIsoDate(bad)).toBeNull();
    expect(formatLocalTimestamp(iso)).toBe('2026-09-05 07:09');
    expect(formatLocalTimestamp(null)).toBeNull();
    expect(formatLocalTimestamp('invalid')).toBeNull();
  });

  it('strips stored-only metadata fields with automationToInput', () => {
    const stored: AutomationV1 = normaliseAutomation(
      { name: 'Nightly hunt', lane: 'cloud', trigger: { kind: 'schedule', rrule: 'FREQ=DAILY;BYHOUR=2' }, repos: ['acme/app'], instructions: 'Check flaky tests.' },
      { now: new Date('2026-09-27T12:00:00Z') },
    );
    const input = automationToInput(stored);
    for (const key of ['v', 'id', 'createdAt', 'updatedAt']) expect(input).not.toHaveProperty(key);
    expect(input).toMatchObject({ name: 'Nightly hunt', lane: 'cloud', repos: ['acme/app'], instructions: 'Check flaky tests.' });
    expect(Object.keys(input).every((k) => (AUTOMATION_INPUT_KEYS as readonly string[]).includes(k))).toBe(true);
  });

  it('shares canonical branch regex and RRULE day codes', () => {
    expect(AUTOMATION_BRANCH_PATTERN.test('main')).toBe(true);
    expect(AUTOMATION_BRANCH_PATTERN.test('release/1.2-rc_1')).toBe(true);
    expect(AUTOMATION_BRANCH_PATTERN.test('-leading-dash')).toBe(false);
    expect(AUTOMATION_BRANCH_PATTERN.test('has space')).toBe(false);
    expect(RRULE_DAY_CODES).toEqual(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']);
  });
});

describe('automations fail-closed lane helpers and cloud dispatch classification', () => {
  it('fails closed when killActive, policy, or estimateUsd throws', async () => {
    expect(await isKillActiveSafely({ killActive: () => false })).toBe(false);
    expect(await isKillActiveSafely({ killActive: () => { throw new Error('boom'); } })).toBe(true);
    const policy = policyFor(['acme/app']);
    expect(await readPolicySafely({ policy: () => policy })).toBe(policy);
    expect(await readPolicySafely({ policy: () => { throw new Error('boom'); } })).toBeNull();
    expect(await estimateLaneUsdSafely('cloud', { estimateUsd: () => 3 })).toBe(3);
    expect(await estimateLaneUsdSafely('cloud', { estimateUsd: () => { throw new Error('boom'); } })).toBe(Number.POSITIVE_INFINITY);
  });

  it('resolves reviewTargetLane for leader-review, null, and working lanes', () => {
    expect(reviewTargetLane(null)).toBe('fleet');
    expect(reviewTargetLane({ lane: 'leader-review' })).toBe('fleet');
    expect(reviewTargetLane({ lane: 'cloud' })).toBe('cloud');
    expect(reviewTargetLane({ lane: 'devin' })).toBe('devin');
    expect(reviewTargetLane({ lane: 'fleet' })).toBe('fleet');
  });

  it('classifies cloud launch outcomes consistently for null vs coded failures', async () => {
    const automation = normaliseAutomation(
      { name: 'Cloud work', lane: 'cloud', trigger: { kind: 'webhook' }, repos: ['acme/app'] },
      { now: new Date('2026-09-27T12:00:00Z') },
    );
    const firing: AutomationFiringV1 = {
      v: 1, id: 'af_20260927T120000_abc123', automationId: automation.id, dedupeKey: 'k1',
      source: { kind: 'webhook', url: null, ref: 'k1' }, repo: 'acme/app', title: 'Fix bug', text: 'Details',
      lane: 'cloud', playbookId: null, state: 'dispatching', reason: 'Handing to the lane.', laneRef: null,
      spendUsd: 0, attempts: 1, createdAt: '2026-09-27T12:00:00.000Z', dispatchedAt: null, settledAt: null, updatedAt: '2026-09-27T12:00:00.000Z',
    };
    const lanes = fakeLanes();
    lanes.set.cloud(() => ({ ok: false, task: null, error: 'permanently refused', failure: null }));
    expect(await dispatchToLane(automation, firing, resolveLaneDeps(lanes.deps))).toEqual({ kind: 'refused', reason: 'permanently refused' });
    for (const failure of ['budget', 'rate-limited', 'unknown'] as const) {
      lanes.set.cloud(() => ({ ok: false, task: null, error: `temp ${failure}`, failure }));
      expect(await dispatchToLane(automation, firing, resolveLaneDeps(lanes.deps))).toEqual({ kind: 'deferred', reason: `temp ${failure}` });
    }
  });
});

describe('automations state and GitHub poll hygiene', () => {
  let restore: () => void;
  beforeEach(() => { restore = isolateAshlrHome(); });
  afterEach(() => restore());

  it('ignores malformed array structures in state.json without throwing', async () => {
    mkdirSync(automationsDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(automationsDir(), 'state.json'), JSON.stringify({
      v: 1, cursors: ['not-a-map'], firings: [['not-a-firing']], seen: ['not-a-map'],
    }));
    expect(await readAutomationState()).toEqual({ v: 1, cursors: {}, firings: [], seen: {} });
  });

  it('scopes failing check summaries and URLs to the first failing SHA', async () => {
    const shaA = 'a'.repeat(40);
    const shaB = 'b'.repeat(40);
    const { gh } = fakeGh(() => ({
      status: 200,
      body: {
        check_runs: [
          { name: 'unit', status: 'completed', conclusion: 'failure', head_sha: shaA, html_url: 'https://github.com/acme/app/runs/10' },
          { name: 'other-sha', status: 'completed', conclusion: 'failure', head_sha: shaB, html_url: 'https://github.com/acme/app/runs/99' },
        ],
      },
    }));
    const res = await pollRedBranch(gh, { kind: 'ci-red', branch: 'main', pollMinutes: 10 }, 'acme/app', { branch: 'main', etag: null });
    expect(res.events).toHaveLength(1);
    expect(res.events[0]!.vars.sha).toBe(shaA);
    expect(res.events[0]!.text).toContain('unit');
    expect(res.events[0]!.text).not.toContain('other-sha');
    expect(res.events[0]!.url).toBe('https://github.com/acme/app/runs/10');
  });
});
