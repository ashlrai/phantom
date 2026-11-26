import { describe, expect, it } from 'vitest';
import * as automationsCli from '../src/cli/automations.js';
import * as engine from '../src/core/automations/engine.js';
import * as github from '../src/core/automations/github.js';
import * as index from '../src/core/automations/index.js';
import * as lanes from '../src/core/automations/lanes.js';
import * as needsYou from '../src/core/automations/needs-you.js';
import * as routines from '../src/core/automations/routines.js';
import * as rrule from '../src/core/automations/rrule.js';
import * as scheduler from '../src/core/automations/scheduler.js';
import * as store from '../src/core/automations/store.js';
import * as types from '../src/core/automations/types.js';
import * as validate from '../src/core/automations/validate.js';

describe('automations shared pure helpers', () => {
  it('validates records, branches, ISO timestamps, padding, local minutes, and USD rounding', () => {
    expect(types.isAutomationRecord({ ok: true })).toBe(true);
    expect(types.isAutomationRecord(null)).toBe(false);
    expect(types.isAutomationRecord([])).toBe(false);
    expect(types.isAutomationRecord('text')).toBe(false);

    expect(types.AUTOMATION_BRANCH_PATTERN.test('main')).toBe(true);
    expect(types.AUTOMATION_BRANCH_PATTERN.test('release/v1.2_rc-1')).toBe(true);
    expect(types.AUTOMATION_BRANCH_PATTERN.test('-leading-dash')).toBe(false);
    expect(types.AUTOMATION_BRANCH_PATTERN.test('bad branch')).toBe(false);

    expect(types.parseIsoDate('2026-11-10T12:34:00.000Z')?.toISOString()).toBe('2026-11-10T12:34:00.000Z');
    expect(types.parseIsoDate('not-a-date')).toBeNull();
    expect(types.parseIsoDate(null)).toBeNull();
    expect(types.parseIsoDate(12345)).toBeNull();

    expect(types.padTwo(3)).toBe('03');
    expect(types.padTwo(12)).toBe('12');

    const localSample = new Date(2026, 10, 5, 8, 7, 0, 0).toISOString();
    expect(types.formatLocalMinute(localSample)).toBe('2026-11-05 08:07');
    expect(types.formatLocalMinute(null)).toBeNull();
    expect(types.formatLocalMinute('invalid')).toBeNull();

    expect(types.roundUsd(1.236)).toBe(1.24);
    expect(types.roundUsd(1.234)).toBe(1.23);
    expect(types.roundUsd(0.1 + 0.2)).toBe(0.3);

    expect(index.formatLocalMinute).toBe(types.formatLocalMinute);
    expect(index.isAutomationRecord).toBe(types.isAutomationRecord);
    expect(rrule.RRULE_DAY_CODES).toEqual(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']);
  });
});

describe('automations fail-closed lane guards', () => {
  it('returns dep results when healthy and fails closed when deps throw', async () => {
    const healthyDeps = lanes.resolveLaneDeps({
      killActive: () => false,
      policy: () => null,
      estimateUsd: () => 2.5,
    });
    expect(await lanes.readKillActive(healthyDeps)).toBe(false);
    expect(await lanes.readStandingPolicy(healthyDeps)).toBeNull();
    expect(await lanes.readLaneEstimateUsd('cloud', healthyDeps)).toBe(2.5);

    const throwingDeps = lanes.resolveLaneDeps({
      killActive: () => { throw new Error('boom'); },
      policy: () => { throw new Error('boom'); },
      estimateUsd: () => { throw new Error('boom'); },
    });
    expect(await lanes.readKillActive(throwingDeps)).toBe(true);
    expect(await lanes.readStandingPolicy(throwingDeps)).toBeNull();
    expect(await lanes.readLaneEstimateUsd('cloud', throwingDeps)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('automations stats, trigger summary, and github polling helpers', () => {
  it('computes stats consistently from shared limit counts and uses VERSE_AUTOMATIONS_PATH for webhooks', () => {
    const now = new Date('2026-11-10T15:00:00.000Z');
    const automation = validate.normaliseAutomation({
      id: 'au_shared-check',
      name: 'Shared check',
      enabled: true,
      lane: 'cloud',
      repos: ['example/repo'],
      trigger: { kind: 'webhook' },
      instructions: 'Verify shared stats.',
    }, { now });

    expect(engine.triggerSummary(automation)).toBe(
      `Local webhook (POST ${types.VERSE_AUTOMATIONS_PATH}/au_shared-check/webhook) for example/repo`,
    );

    const state = store.emptyState();
    const baseFiring: Omit<types.AutomationFiringV1, 'id' | 'state' | 'spendUsd' | 'dispatchedAt' | 'settledAt'> = {
      v: 1,
      automationId: automation.id,
      dedupeKey: 'k1',
      source: { kind: 'webhook', url: null, ref: 'k1' },
      repo: 'example/repo',
      title: 'Synthetic task',
      text: 'body',
      lane: 'cloud',
      playbookId: null,
      reason: null,
      laneRef: null,
      attempts: 1,
      createdAt: '2026-11-10T12:00:00.000Z',
      updatedAt: '2026-11-10T12:00:00.000Z',
    };
    state.firings.push(
      { ...baseFiring, id: 'af_20261110T120000_aaaaaa', state: 'queued', spendUsd: 0, dispatchedAt: null, settledAt: null },
      { ...baseFiring, id: 'af_20261110T120100_bbbbbb', state: 'dispatched', spendUsd: 0.1, dispatchedAt: '2026-11-10T12:01:00.000Z', settledAt: null },
      { ...baseFiring, id: 'af_20261110T120200_cccccc', state: 'succeeded', spendUsd: 0.2, dispatchedAt: '2026-11-10T12:02:00.000Z', settledAt: '2026-11-10T12:10:00.000Z' },
      { ...baseFiring, id: 'af_20261110T120300_dddddd', state: 'failed', spendUsd: 0, dispatchedAt: '2026-11-10T12:03:00.000Z', settledAt: '2026-11-10T12:20:00.000Z' },
    );

    const stats = engine.automationStats(automation, state, now);
    expect(stats).toMatchObject({
      queued: 1,
      active: 1,
      firedToday: 3,
      spentThisMonthUsd: 0.3,
      succeeded: 1,
      failed: 1,
      successRate: 0.5,
      nextRunAt: null,
    });
  });

  it('extracts stderr HTTP status codes once in ghGet and groups head-SHA check runs once in pollRedBranch', async () => {
    const rateLimited = await github.ghGet(
      async () => ({ ok: false, stdout: '', stderr: 'gh: API rate limit exceeded (HTTP 429)' }),
      'repos/example/repo/issues',
      {},
      null,
    );
    expect(rateLimited).toEqual({ error: 'GitHub rate-limited or refused the poll; it will retry on the next interval.' });

    const missing = await github.ghGet(
      async () => ({ ok: false, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }),
      'repos/example/repo/issues',
      {},
      null,
    );
    expect(missing).toEqual({ error: 'GitHub answered 404 for repos/example/repo (repo missing or not visible to gh).' });

    const shaA = 'a'.repeat(40);
    const shaB = 'b'.repeat(40);
    const poll = await github.pollRedBranch(
      async () => ({
        ok: true,
        stdout: [
          'HTTP/2.0 200 OK',
          'etag: "e1"',
          '',
          JSON.stringify({
            check_runs: [
              { name: 'lint', status: 'completed', conclusion: 'failure', head_sha: shaA, html_url: null },
              { name: 'unit', status: 'completed', conclusion: 'timed_out', head_sha: shaA, html_url: 'https://github.com/example/repo/runs/2' },
              { name: 'older', status: 'completed', conclusion: 'failure', head_sha: shaB, html_url: 'https://github.com/example/repo/runs/3' },
            ],
          }),
        ].join('\n'),
        stderr: '',
      }),
      { kind: 'ci-red', branch: 'main', pollMinutes: 10 },
      'example/repo',
      { branch: null, etag: null },
    );
    expect(poll.error).toBeNull();
    expect(poll.events).toHaveLength(1);
    expect(poll.events[0]).toMatchObject({
      vars: { sha: shaA },
      url: 'https://github.com/example/repo/runs/2',
    });
    expect(poll.events[0]!.text).toContain('- lint');
    expect(poll.events[0]!.text).toContain('- unit');
    expect(poll.events[0]!.text).not.toContain('older');
  });
});

describe('automations pruned internal-only exports', () => {
  it('keeps unreferenced internal helpers private across the automations module family', () => {
    for (const key of ['defaultDedupeTemplate', 'renderDedupeKey', 'textKey', 'automationView', 'limitCounts', 'limitRefusal']) {
      expect(key in engine, `engine.${key}`).toBe(false);
    }
    expect('safeGithubUrl' in github).toBe(false);
    expect('fleetDedupeKey' in lanes).toBe(false);
    expect('reviewNeedsYouItem' in needsYou).toBe(false);
    expect('parseRoutines' in routines).toBe(false);
    expect('parseRoutineProbe' in routines).toBe(false);
    for (const key of ['AUTOMATIONS_TICK_EVERY_MS', 'AUTOMATIONS_FIRST_TICK_MS', 'automationsSchedulerRefusal']) {
      expect(key in scheduler, `scheduler.${key}`).toBe(false);
    }
    for (const key of ['AUTOMATIONS_FILE', 'AUTOMATIONS_STATE_FILE', 'automationStatePath', 'automationJournalPath', 'ensureAutomationsDir', 'isAutomationFiring', 'writeAutomationState']) {
      expect(key in store, `store.${key}`).toBe(false);
    }
    expect('slugifyAutomationId' in validate).toBe(false);
    expect('AUTOMATIONS_USAGE' in automationsCli).toBe(false);
  });
});
