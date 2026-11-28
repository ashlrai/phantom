import { describe, expect, it } from 'vitest';

import { pollRedBranch } from '../src/core/automations/github.js';
import {
  dispatchToLane,
  globalGateRefusal,
  KILL_REASON,
  laneGateRefusal,
  NO_GRANT_REASON,
  readEstimateUsd,
  readKillActive,
  readStandingPolicy,
  resolveLaneDeps,
} from '../src/core/automations/lanes.js';
import { pad2, RRULE_DAY_CODES } from '../src/core/automations/rrule.js';
import type { AutomationFiringV1, AutomationV1 } from '../src/core/automations/types.js';
import {
  AUTOMATION_INPUT_KEYS,
  AutomationInputError,
  failInput,
  formatLocalStamp,
  isRecord,
  isValidBranchName,
  parseIsoDate,
  truncateText,
} from '../src/core/automations/validate.js';
import { fakeGh, fakeLanes, policyFor } from './helpers/automations-fakes.js';

const sampleAutomation = (lane: AutomationV1['lane']): AutomationV1 => ({
  v: 1, id: 'au_sample', name: 'Sample', enabled: true, trigger: { kind: 'webhook' },
  lane, playbookId: null, repos: ['acme/app'], instructions: 'Do the thing.',
  maxConcurrent: 2, maxPerDay: 5, queueDepth: 10, spendCapUsd: 50, dedupeKey: null, triage: null,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
});

const sampleFiring = (lane: AutomationV1['lane']): AutomationFiringV1 => ({
  v: 1, id: 'af_20261001T000000_abc123', automationId: 'au_sample', dedupeKey: 'k1',
  source: { kind: 'webhook', url: null, ref: 'k1' }, repo: 'acme/app',
  title: 'Fix flaky build', text: 'Details here', lane, playbookId: null,
  state: 'dispatching', reason: null, laneRef: null, spendUsd: 0, attempts: 1,
  createdAt: '2026-10-01T00:00:00.000Z', dispatchedAt: null, settledAt: null, updatedAt: '2026-10-01T00:00:00.000Z',
});

describe('automations shared validation and formatting helpers', () => {
  it('exposes canonical RRULE day codes, input keys, and zero-padded numbers', () => {
    expect(RRULE_DAY_CODES).toEqual(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']);
    expect([pad2(0), pad2(7), pad2(12), pad2(123)]).toEqual(['00', '07', '12', '123']);
    expect(AUTOMATION_INPUT_KEYS).toContain('trigger');
    expect(AUTOMATION_INPUT_KEYS).toContain('triage');
    expect(new Set(AUTOMATION_INPUT_KEYS).size).toBe(AUTOMATION_INPUT_KEYS.length);
    expect(() => failInput('bad input')).toThrowError(AutomationInputError);
    expect(() => failInput('bad input')).toThrow('bad input');
  });

  it('guards plain records, git branch names, and ellipsis truncation', () => {
    expect([isRecord({}), isRecord({ id: 'au_a' })]).toEqual([true, true]);
    expect([isRecord(null), isRecord(undefined), isRecord([]), isRecord('x'), isRecord(42)]).toEqual([false, false, false, false, false]);

    expect([isValidBranchName('main'), isValidBranchName('release/v3.15_rc-1')]).toEqual([true, true]);
    expect([isValidBranchName(''), isValidBranchName('.hidden'), isValidBranchName('main..other'), isValidBranchName('bad branch'), isValidBranchName(null)]).toEqual([false, false, false, false, false]);

    expect(truncateText('short', 10)).toBe('short');
    expect(truncateText('exact', 5)).toBe('exact');
    expect(truncateText('abcdef', 5)).toBe('abcd…');
  });

  it('parses valid ISO timestamps and formats local YYYY-MM-DD HH:MM stamps', () => {
    const d = new Date(2026, 8, 5, 7, 9, 0, 0);
    expect(parseIsoDate(d.toISOString())?.getTime()).toBe(d.getTime());
    expect([parseIsoDate(''), parseIsoDate('not-a-date'), parseIsoDate(null), parseIsoDate(123)]).toEqual([null, null, null, null]);
    expect(formatLocalStamp(d.toISOString())).toBe('2026-09-05 07:09');
    expect([formatLocalStamp(null), formatLocalStamp('not-a-date')]).toEqual([null, null]);
  });
});

describe('automations shared lane gate, estimate, and remote-failure helpers', () => {
  it('fails closed when killActive, policy, or estimateUsd throw', async () => {
    const throwingDeps = resolveLaneDeps({
      killActive: () => { throw new Error('disk unreadable'); },
      policy: () => { throw new Error('grant unreadable'); },
      estimateUsd: () => { throw new Error('budget unreadable'); },
    });
    expect(await readKillActive(throwingDeps)).toBe(true);
    expect(await readStandingPolicy(throwingDeps)).toBeNull();
    expect(await readEstimateUsd('cloud', throwingDeps)).toBe(Number.POSITIVE_INFINITY);
    expect(await globalGateRefusal(throwingDeps)).toBe(KILL_REASON);

    const noGrantDeps = resolveLaneDeps({ killActive: () => false, policy: () => null });
    expect(await globalGateRefusal(noGrantDeps)).toBe(NO_GRANT_REASON);
    expect(await laneGateRefusal('leader-review', 'acme/app', noGrantDeps)).toBeNull();
    expect(await laneGateRefusal('fleet', 'acme/app', noGrantDeps)).toBe(NO_GRANT_REASON);

    const clearDeps = resolveLaneDeps({ killActive: () => false, policy: () => policyFor(['acme/app']) });
    expect(await globalGateRefusal(clearDeps)).toBeNull();
    expect(await laneGateRefusal('fleet', 'acme/app', clearDeps)).toBeNull();
    expect(await laneGateRefusal('fleet', 'acme/other', clearDeps)).toMatch(/not in the standing grant/);
  });

  it('classifies cloud and devin launch failures and preserves started devin sessions if estimateUsd throws', async () => {
    const lanes = fakeLanes();

    lanes.set.cloud(() => ({ ok: false, task: null, error: 'Self-improvement off.', failure: null }));
    expect(await dispatchToLane(sampleAutomation('cloud'), sampleFiring('cloud'), resolveLaneDeps(lanes.deps)))
      .toEqual({ kind: 'refused', reason: 'Self-improvement off.' });

    lanes.set.cloud(() => ({ ok: false, task: null, error: 'Rate limited.', failure: 'rate-limited' }));
    expect(await dispatchToLane(sampleAutomation('cloud'), sampleFiring('cloud'), resolveLaneDeps(lanes.deps)))
      .toEqual({ kind: 'deferred', reason: 'Rate limited.' });

    lanes.set.devin(() => ({ ok: false, task: null, error: 'Auth failed.', failure: 'auth' }));
    expect(await dispatchToLane(sampleAutomation('devin'), sampleFiring('devin'), resolveLaneDeps(lanes.deps)))
      .toEqual({ kind: 'refused', reason: 'Auth failed.' });

    lanes.set.devin(() => ({ ok: false, task: null, error: 'Rate limited.', failure: 'rate-limited' }));
    expect(await dispatchToLane(sampleAutomation('devin'), sampleFiring('devin'), resolveLaneDeps(lanes.deps)))
      .toEqual({ kind: 'deferred', reason: 'Rate limited.' });

    lanes.set.devin(() => ({
      ok: true,
      task: { id: 'dv_1', repo: 'acme/app', sessionUrl: 'https://app.devin.ai/sessions/1' } as never,
      error: null,
      failure: null,
    }));
    const deps = resolveLaneDeps({ ...lanes.deps, estimateUsd: () => { throw new Error('budget file corrupt'); } });
    expect(await dispatchToLane(sampleAutomation('devin'), sampleFiring('devin'), deps)).toEqual({
      kind: 'dispatched',
      ref: { lane: 'devin', id: 'dv_1', url: 'https://app.devin.ai/sessions/1' },
      spendUsd: 0,
      reason: 'Devin session started.',
    });
  });

  it('rejects default branches containing traversal sequences and groups failing checks by head sha', async () => {
    const badBranchGh = fakeGh(() => ({ status: 200, body: { default_branch: 'main..evil' } }));
    const badRes = await pollRedBranch(badBranchGh.gh, { kind: 'ci-red', branch: null, pollMinutes: 10 }, 'acme/app', { branch: null, etag: null });
    expect(badRes.events).toEqual([]);
    expect(badRes.error).toMatch(/default branch/);

    const shaA = 'a'.repeat(40);
    const shaB = 'b'.repeat(40);
    const multiShaGh = fakeGh(() => ({
      status: 200,
      body: {
        check_runs: [
          { name: 'test', status: 'completed', conclusion: 'failure', head_sha: shaA, html_url: null },
          { name: 'lint', status: 'completed', conclusion: 'failure', head_sha: shaA, html_url: 'https://github.com/acme/app/runs/2' },
          { name: 'stale', status: 'completed', conclusion: 'failure', head_sha: shaB, html_url: 'https://github.com/acme/app/runs/3' },
        ],
      },
    }));
    const res = await pollRedBranch(multiShaGh.gh, { kind: 'ci-red', branch: 'main', pollMinutes: 10 }, 'acme/app', { branch: 'main', etag: null });
    expect(res.error).toBeNull();
    expect(res.events).toHaveLength(1);
    expect(res.events[0]!.vars.sha).toBe(shaA);
    expect(res.events[0]!.title).toContain('test, lint');
    expect(res.events[0]!.title).not.toContain('stale');
    expect(res.events[0]!.url).toBe('https://github.com/acme/app/runs/2');
  });
});
