/**
 * improve/area-outcomes.ts — per-backlog-area merge/revert outcomes.
 * Hermetic: tasks, items and both evidence reads are injected; no HOME,
 * ledger or fleet state is touched.
 */
import { describe, expect, it } from 'vitest';

import { backlogAreaOutcomes, type AreaOutcomeTask } from '../src/core/improve/area-outcomes.js';
import { prKey } from '../src/core/improve/lesson-trial.js';
import type { RevertLedgerRead } from '../src/core/improve/revert-ledger.js';
import type { RevertOutcomeRecord } from '../src/core/improve/reverted.js';
import type { CloudTaskV1 } from '../src/core/cloud/types.js';
import type { DevinTaskV1 } from '../src/core/devin/types.js';

const M1 = 'a'.repeat(40), R1 = 'd'.repeat(40), L1 = 'f'.repeat(40);
const REPO = 'ashlrai/phantom';

const item = (id: string, area: string) => ({ id, area });

const cloudTask = (over: Record<string, unknown> = {}): CloudTaskV1 => ({
  id: 'ct_1', repo: REPO, state: 'merged', createdAt: '2026-11-20T00:00:00Z',
  pr: { number: 5, url: `https://github.com/${REPO}/pull/5`, state: 'merged', draft: false, title: 't' },
  outcome: { observedAt: '2026-11-21T00:00:00Z', headSha: null, mergeSha: M1, ci: 'success', failedChecks: [], reviewDecision: null, changesRequested: 0 },
  backlogItemId: 'b1',
  ...over,
} as unknown as CloudTaskV1);

const devinTask = (over: Record<string, unknown> = {}): DevinTaskV1 => ({
  id: 'dv_1', repo: REPO, state: 'merged', createdAt: '2026-11-20T00:00:00Z',
  pr: { number: 7, url: `https://github.com/${REPO}/pull/7`, state: 'merged', draft: false, title: 't' },
  backlogItemId: 'b2',
  ...over,
} as unknown as DevinTaskV1);

const revertRecord = (over: Partial<RevertOutcomeRecord> = {}): RevertOutcomeRecord => ({
  repository: REPO, number: 5, pr: prKey(REPO, 5), mergeSha: M1,
  mergedAt: '2026-11-20T00:00:00Z', revertedBy: R1, revertedAt: '2026-11-21T00:00:00Z',
  revertLatencyMs: 86_400_000, relandedBy: null, ...over,
});

const revertRead = (records: RevertOutcomeRecord[], state: RevertLedgerRead['state'] = 'read'): RevertLedgerRead =>
  ({ records, intact: state !== 'unreadable', reasons: state === 'unreadable' ? ['unreadable-line-2'] : [], state });

const noReverts = () => revertRead([]);
const missingFleet = () => ({ state: 'missing' as const });

describe('backlogAreaOutcomes', () => {
  it('counts a merged-and-standing carrier PR as held for the item area kind', () => {
    const cells = backlogAreaOutcomes(
      [cloudTask()],
      [item('b1', 'Fleet Fixes')],
      { reverts: noReverts, fleetState: missingFleet },
    );
    expect(cells.get('fleet-fixes')).toEqual({ held: 1, reverted: 0 });
  });

  it('counts a standing revert from the journal as reverted, overriding the task merge field', () => {
    const cells = backlogAreaOutcomes(
      [cloudTask()],
      [item('b1', 'fleet-fixes')],
      { reverts: () => revertRead([revertRecord()]), fleetState: missingFleet },
    );
    expect(cells.get('fleet-fixes')).toEqual({ held: 0, reverted: 1 });
  });

  it('counts a re-landed merge as held', () => {
    const cells = backlogAreaOutcomes(
      [cloudTask()],
      [item('b1', 'fleet-fixes')],
      { reverts: () => revertRead([revertRecord({ relandedBy: L1 })]), fleetState: missingFleet },
    );
    expect(cells.get('fleet-fixes')).toEqual({ held: 1, reverted: 0 });
  });

  it('lets the newest task with resolved evidence decide an item', () => {
    const items = [item('b1', 'fleet-fixes')];
    const deps = { reverts: () => revertRead([revertRecord()]), fleetState: missingFleet };
    // Older attempt merged then reverted; newer attempt merged and stands.
    const older = cloudTask({ id: 'ct_old', createdAt: '2026-11-18T00:00:00Z' });
    const newer = cloudTask({ id: 'ct_new', createdAt: '2026-11-22T00:00:00Z', pr: { number: 6, url: 'u', state: 'merged', draft: false, title: 't' }, outcome: { mergeSha: M1 } });
    const cells = backlogAreaOutcomes([older, newer], items, deps);
    expect(cells.get('fleet-fixes')).toEqual({ held: 1, reverted: 0 });
    // Reverse order of resolution: the standing revert is the verdict.
    const relanded = cloudTask({ id: 'ct_new2', createdAt: '2026-11-23T00:00:00Z', pr: { number: 8, url: 'u', state: 'merged', draft: false, title: 't' }, outcome: { mergeSha: M1 } });
    const revertedAgain = backlogAreaOutcomes(
      [cloudTask({ id: 'ct_old2', createdAt: '2026-11-18T00:00:00Z' }), relanded],
      items,
      { reverts: () => revertRead([revertRecord(), revertRecord({ number: 8, pr: prKey(REPO, 8) })]), fleetState: missingFleet },
    );
    expect(revertedAgain.get('fleet-fixes')).toEqual({ held: 0, reverted: 1 });
  });

  it('an in-flight retry does not erase the resolved verdict before it', () => {
    const cells = backlogAreaOutcomes(
      [
        cloudTask({ id: 'ct_old', createdAt: '2026-11-18T00:00:00Z' }),
        cloudTask({ id: 'ct_run', createdAt: '2026-11-23T00:00:00Z', state: 'running', pr: null, outcome: null }),
      ],
      [item('b1', 'fleet-fixes')],
      { reverts: () => revertRead([revertRecord()]), fleetState: missingFleet },
    );
    expect(cells.get('fleet-fixes')).toEqual({ held: 0, reverted: 1 });
  });

  it('observes a Devin-lane merge through the revert journal when the task has no outcome block', () => {
    const cells = backlogAreaOutcomes(
      [devinTask()],
      [item('b2', 'ui-polish')],
      {
        // A re-land record supplies the merge SHA and clears the revert — held.
        reverts: () => revertRead([revertRecord({ number: 7, pr: prKey(REPO, 7), relandedBy: L1 })]),
        fleetState: missingFleet,
      },
    );
    expect(cells.get('ui-polish')).toEqual({ held: 1, reverted: 0 });
  });

  it('keys a superseded task under its fleet carrier PR', () => {
    const cells = backlogAreaOutcomes(
      [devinTask({
        pr: { number: 3, url: 'u', state: 'closed', draft: false, title: 't' },
        supersededBy: { repo: REPO, number: 9 },
      })],
      [item('b2', 'ui-polish')],
      { reverts: () => revertRead([revertRecord({ number: 9, pr: prKey(REPO, 9), relandedBy: L1 })]), fleetState: missingFleet },
    );
    expect(cells.get('ui-polish')).toEqual({ held: 1, reverted: 0 });
  });

  it('skips tasks and PRs with no resolved evidence instead of counting them', () => {
    const cells = backlogAreaOutcomes(
      [
        cloudTask({ id: 't_open', state: 'pr-open', pr: { number: 11, url: 'u', state: 'open', draft: false, title: 't' }, outcome: null }),
        cloudTask({ id: 't_nopr', state: 'merged', pr: null, outcome: null }),
        cloudTask({ id: 't_other', backlogItemId: 'not-in-items' }),
        cloudTask({ id: 't_none', backlogItemId: null }),
      ],
      [item('b1', 'fleet-fixes')],
      { reverts: noReverts, fleetState: missingFleet },
    );
    expect(cells.size).toBe(0);
  });

  it('an unreadable revert journal contributes no journal verdict but task fields still apply', () => {
    const cells = backlogAreaOutcomes(
      [cloudTask()],
      [item('b1', 'fleet-fixes')],
      { reverts: () => revertRead([revertRecord()], 'unreadable'), fleetState: missingFleet },
    );
    // Task outcome.mergeSha still supplies the merge; the journal's standing
    // revert is withheld, so the item reads held — never a guessed verdict.
    expect(cells.get('fleet-fixes')).toEqual({ held: 1, reverted: 0 });
  });

  it('a throwing evidence read yields an empty map, never a stall', () => {
    const cells = backlogAreaOutcomes(
      [cloudTask()],
      [item('b1', 'fleet-fixes')],
      {
        reverts: () => { throw new Error('journal exploded'); },
        fleetState: missingFleet,
      },
    );
    expect(cells.size).toBe(0);
  });

  it('aggregates items per normalized area kind', () => {
    const cells = backlogAreaOutcomes(
      [
        cloudTask({ id: 't1', pr: { number: 5, url: 'u', state: 'merged', draft: false, title: 't' } }),
        cloudTask({ id: 't2', backlogItemId: 'b2', pr: { number: 6, url: 'u', state: 'merged', draft: false, title: 't' } }),
      ],
      [item('b1', 'Fleet Fixes'), item('b2', 'fleet  fixes')],
      {
        reverts: () => revertRead([revertRecord({ number: 6, pr: prKey(REPO, 6) })]),
        fleetState: missingFleet,
      },
    );
    expect(cells.get('fleet-fixes')).toEqual({ held: 1, reverted: 1 });
  });

  it('accepts a narrowed claim-task shape (optional evidence fields)', () => {
    const narrow: AreaOutcomeTask = {
      backlogItemId: 'b1', createdAt: '2026-11-20T00:00:00Z',
      repo: REPO, state: 'merged',
      pr: { number: 5, url: 'u', state: 'merged', draft: false, title: 't' },
      outcome: { mergeSha: M1 },
    };
    const cells = backlogAreaOutcomes([narrow], [item('b1', 'fleet-fixes')], { reverts: noReverts, fleetState: missingFleet });
    expect(cells.get('fleet-fixes')).toEqual({ held: 1, reverted: 0 });
  });
});
