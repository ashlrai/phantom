/**
 * Tests for src/core/fleet/merge-backlog-read.ts — the read-only open-PR
 * merge backlog the verse route serves to the desktop console.
 *
 * FULLY HERMETIC: `gh` is injected everywhere (no subprocess), and the
 * merge-state join is exercised both through an injected `states` map and
 * through the real record store — which lands under the isolated HOME the
 * test setup installs, so a "temp merge-state dir" is just the suite's home.
 */
import { describe, expect, it } from 'vitest';

import type { CloudGh } from '../src/core/cloud/pr-actions.js';
import {
  newFleetMergeState,
  writeFleetMergeState,
  type FleetMergeStateRead,
  type FleetMergeStateV1,
} from '../src/core/fleet/fleet-merge-state.js';
import {
  readMergeBacklog,
  readMergeBacklogStates,
  type MergeBacklogReadInput,
} from '../src/core/fleet/merge-backlog-read.js';

const SHA = 'a'.repeat(40);
const REPO = 'acme/app';
const NOW = '2026-11-01T20:00:00.000Z';

/** One `gh pr list --json` row; overrides shape each classification lane. */
function ghRow(number: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number, state: 'OPEN', isDraft: false,
    headRefOid: SHA, headRefName: `fleet/rq-phx-job${number}`, baseRefName: 'main',
    isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    title: `PR ${number}`, updatedAt: '2026-11-01T19:00:00.000Z',
    ...over,
  };
}

const ghOk = (rows: unknown[]): CloudGh => async () => ({ ok: true, stdout: JSON.stringify(rows), stderr: '' });
const noStates: NonNullable<MergeBacklogReadInput['states']> = () => new Map<number, FleetMergeStateRead>();
const clock = () => new Date(NOW);

function input(over: MergeBacklogReadInput = {}): MergeBacklogReadInput {
  return { repo: REPO, gh: ghOk([]), states: noStates, now: clock, ...over };
}

/** A merge-state record whose stored PR head no longer matches the gh head. */
function trackedRecord(number: number, headSha: string, repo = REPO): FleetMergeStateV1 {
  const record = newFleetMergeState({
    key: `prop-${number}`, kind: 'change', proposalId: `prop-${number}`, revertsLandingId: null,
    repo, repoPath: '/tmp/fake', enforcement: null, nowIso: NOW,
  });
  record.pr = {
    number, nodeId: 'N', repositoryId: 'R', branch: `fleet/rq-phx-job${number}`, baseBranch: 'main',
    baseSha: 'c'.repeat(40), headSha, treeSha: 'd'.repeat(40), ownerLane: false, ownerLaneReason: null,
    openedAt: NOW, ledgered: true, state: 'open', closedBy: null,
    nextCheckAt: null, checkBackoffMs: 0, checks: null, wouldMergeHeadSha: null,
  };
  return record;
}

describe('readMergeBacklog', () => {
  it('returns the v1 envelope and one bounded item per open PR', async () => {
    const out = await readMergeBacklog(input({
      gh: ghOk([
        ghRow(1, { title: 'bridge: RQ-PHX-ABC31', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
        ghRow(2, { mergeStateStatus: 'BLOCKED', statusCheckRollup: [] }),
        ghRow(3),
      ]),
    }));
    expect(out.v).toBe(1);
    expect(out.repo).toBe(REPO);
    expect(out.generatedAt).toBe(NOW);
    expect(out.source).toBe('ok');
    expect(out.items).toHaveLength(3);
    expect(out.items[0]).toMatchObject({
      number: 1,
      title: 'bridge: RQ-PHX-ABC31',
      headRef: 'fleet/rq-phx-job1',
      updatedAt: '2026-11-01T19:00:00.000Z',
      mergeStateStatus: 'DIRTY',
      isDraft: false,
      job: 'RQ-PHX-ABC31',
      classification: { class: 'conflicted', work: 'refix', reason: 'merge-conflict' },
      suggestedAction: 'recut',
    });
    expect(out.items[1]).toMatchObject({
      number: 2,
      mergeStateStatus: 'BLOCKED',
      classification: { class: 'pending' },
      suggestedAction: 'wait',
    });
    expect(out.items[2]).toMatchObject({
      number: 3,
      mergeStateStatus: 'CLEAN',
      classification: { class: 'green-ready' },
      suggestedAction: 'merge',
    });
    expect(out.counts.mergeState).toEqual({ DIRTY: 1, BLOCKED: 1, CLEAN: 1 });
    expect(out.counts.actions).toEqual({ merge: 1, recut: 1, refresh: 0, wait: 1, none: 0 });
  });

  it('parses the fleet job id from the headRef when the title lacks one', async () => {
    const out = await readMergeBacklog(input({
      gh: ghOk([
        ghRow(7, { title: 'plain title', headRefName: 'fleet/RQ-PHX-HEAD99-work' }),
        ghRow(8, { title: 'nothing anywhere', headRefName: 'feature/other' }),
      ]),
    }));
    expect(out.items[0]!.job).toBe('RQ-PHX-HEAD99');
    expect(out.items[1]!.job).toBeNull();
  });

  it('prefers the job id in the title over the one in the headRef', async () => {
    const out = await readMergeBacklog(input({
      gh: ghOk([ghRow(9, { title: 'bridge: RQ-PHX-TITLE1', headRefName: 'fleet/RQ-PHX-REF22' })]),
    }));
    expect(out.items[0]!.job).toBe('RQ-PHX-TITLE1');
  });

  it('joins the merge-state record store and classifies a moved head as pending', async () => {
    // The real store, in the suite's isolated HOME — a temp merge-state dir.
    expect(writeFleetMergeState(trackedRecord(4, 'b'.repeat(40)))).toBe(true);
    expect(writeFleetMergeState(trackedRecord(5, SHA, 'other/repo'))).toBe(true);

    const out = await readMergeBacklog({
      repo: REPO,
      gh: ghOk([ghRow(4), ghRow(5)]),
      now: clock,
      // No injected states: readMergeBacklogStates reads the store above.
    });
    // The stored head ('bbb…') differs from gh's ('aaa…') → head-moved, not green.
    expect(out.items[0]).toMatchObject({
      number: 4,
      classification: { class: 'pending', reason: 'head-moved' },
      suggestedAction: 'wait',
    });
    // The other repo's record must not join: #5 classifies on the gh view alone.
    expect(out.items[1]).toMatchObject({ number: 5, classification: { class: 'green-ready' } });
  });

  it('readMergeBacklogStates keys records by PR number for the named repo only', () => {
    expect(writeFleetMergeState(trackedRecord(11, SHA))).toBe(true);
    const states = readMergeBacklogStates(REPO);
    expect(states.get(11)?.state).toBe('ok');
    expect(states.size).toBeGreaterThanOrEqual(1);
    expect(readMergeBacklogStates('nobody/else').has(11)).toBe(false);
  });

  it('bounds title and headRef to 200 characters and validates updatedAt', async () => {
    const longTitle = 't'.repeat(500);
    const longRef = `fleet/${'r'.repeat(500)}`;
    const out = await readMergeBacklog(input({
      gh: ghOk([
        ghRow(12, { title: longTitle, headRefName: longRef }),
        ghRow(13, { updatedAt: 'not a date' }),
      ]),
    }));
    expect(out.items[0]!.title).toHaveLength(200);
    expect(out.items[0]!.headRef).toHaveLength(200);
    expect(out.items[0]!.updatedAt).toBe('2026-11-01T19:00:00.000Z');
    expect(out.items[1]!.updatedAt).toBeNull();
  });

  it('keeps a row gh cannot fully describe, classified unknown, suggestedAction none', async () => {
    const out = await readMergeBacklog(input({
      gh: ghOk([
        { number: 14, title: 'half a row', mergeStateStatus: 'weird' },
        ghRow(15),
      ]),
    }));
    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toMatchObject({
      number: 14,
      mergeStateStatus: 'WEIRD',
      classification: { class: 'unknown' },
      suggestedAction: 'none',
    });
    expect(out.counts.mergeState).toEqual({ WEIRD: 1, CLEAN: 1 });
  });

  it('reports gh failure as gh-failed with empty items, never a throw', async () => {
    const fail: CloudGh = async () => ({ ok: false, stdout: '', stderr: 'boom' });
    const out = await readMergeBacklog(input({ gh: fail }));
    expect(out.source).toBe('gh-failed');
    expect(out.reason).toBe('gh-pr-list-failed');
    expect(out.items).toEqual([]);
    expect(out.counts.mergeState).toEqual({});
    expect(out.counts.actions).toEqual({ merge: 0, recut: 0, refresh: 0, wait: 0, none: 0 });
  });

  it('reports non-JSON gh output as gh-failed', async () => {
    const bad: CloudGh = async () => ({ ok: true, stdout: 'not json', stderr: '' });
    const out = await readMergeBacklog(input({ gh: bad }));
    expect(out.source).toBe('gh-failed');
    expect(out.reason).toBe('gh-pr-list-not-json');
  });

  it('passes the repo and a bounded limit to the gh read', async () => {
    const calls: string[][] = [];
    const gh: CloudGh = async (args) => { calls.push([...args]); return { ok: true, stdout: '[]', stderr: '' }; };
    await readMergeBacklog(input({ gh, limit: 25 }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual(['pr', 'list']);
    expect(calls[0]).toContain(REPO);
    expect(calls[0]).toContain('25');
  });
});
