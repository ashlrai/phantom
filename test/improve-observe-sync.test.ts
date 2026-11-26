import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendLedger, readLedger, scoreOutcomes, type LedgerEvent, type LedgerRecord, type MetricSpec } from '../src/core/improve/outcomes.js';
import { prKey } from '../src/core/improve/lesson-trial.js';
import type { RevertLedgerRead } from '../src/core/improve/revert-ledger.js';
import type { RevertOutcomeRecord } from '../src/core/improve/reverted.js';
import {
  observationEvents,
  outcomeObservationEvidence,
  syncCloudOutcomeObservations,
} from '../src/core/improve/observe-sync.js';
import type { CloudTaskOutcome, CloudTaskV1 } from '../src/core/cloud/types.js';
import type { FleetMergeStateRead, FleetMergeStateV1 } from '../src/core/fleet/fleet-merge-state.js';

const M1 = 'a'.repeat(40), M2 = 'b'.repeat(40), M3 = 'c'.repeat(40);
const R1 = 'd'.repeat(40), R2 = 'e'.repeat(40), L1 = 'f'.repeat(40);
const LAND = '1'.repeat(40);
const metric: MetricSpec = { name: 'gate-ms', direction: 'decrease', runner: { kind: 'npm', script: 'bench:gate' } };
const REPO = 'ashlrai/phantom';

let dir: string;
let ledgerPath: string;
beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'phm-observe-sync-')); ledgerPath = join(dir, 'outcomes.jsonl'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const records = (): LedgerRecord[] => readLedger(ledgerPath).records;
const reg = (id: string, pr = 5): LedgerEvent[] => [
  { type: 'registered', proposalId: id, title: `Proposal ${id}`, proposalKind: 'perf', source: { kind: 'deterministic', rule: 'test' }, metric, predictedDelta: null },
  { type: 'pr', proposalId: id, repository: REPO, number: pr },
];
const write = (...events: LedgerEvent[]) => { for (const e of events) appendLedger(e, { path: ledgerPath }); };

const task = (over: { outcome?: Partial<CloudTaskOutcome> } & Record<string, unknown> = {}): CloudTaskV1 => {
  const { outcome, ...rest } = over;
  return {
    id: 'task-1', repo: REPO, state: 'merged',
    pr: { number: 5, url: 'https://github.com/ashlrai/phantom/pull/5', state: 'merged', draft: false, title: 't' },
    outcome: { observedAt: '2026-11-25T00:00:00Z', headSha: null, mergeSha: M1, ci: 'success', failedChecks: [], reviewDecision: 'APPROVED', changesRequested: 0, ...outcome },
    ...rest,
  } as CloudTaskV1;
};

/** A task whose cloud PR #5 was superseded by fleet PR #77 (the carrier that lands). */
const superseded = (over: { outcome?: Partial<CloudTaskOutcome> } & Record<string, unknown> = {}): CloudTaskV1 => task({
  pr: { number: 5, url: 'https://github.com/ashlrai/phantom/pull/5', state: 'closed', draft: false, title: 't' },
  supersededBy: { repo: REPO, number: 77 },
  ...over,
});

/** The fleet merge-state record cloud intake's proposal produced (only the fields the fold reads). */
const fleetRecord = (over: Record<string, unknown> = {}): FleetMergeStateV1 => ({
  v: 1, key: 'prop-1', kind: 'change', proposalId: 'prop-1', revertsLandingId: null,
  repo: REPO, repoPath: '/m', enforcement: null, createdAt: '2026-11-25T00:00:00Z', updatedAt: '2026-11-25T00:00:00Z',
  gates: {}, judgeWaitSince: null, baseBranch: 'master', baseSha: null, treeSha: null, diffHash: null, verifyDigest: null,
  risk: null, files: null, linesAdded: null, linesDeleted: null, producer: null, judgeId: null, openGatesDigest: null,
  pr: { number: 77, state: 'merged' }, merge: null,
  landing: { kind: 'merge', mergeSha: LAND },
  landingLedgered: true, outcome: 'merged', outcomeReason: null,
  ...over,
}) as unknown as FleetMergeStateV1;
const fleetOk = (record: FleetMergeStateV1): FleetMergeStateRead => ({ state: 'ok', record });

const revertRecord = (over: Partial<RevertOutcomeRecord> = {}): RevertOutcomeRecord => ({
  repository: REPO, number: 5, pr: prKey(REPO, 5), mergeSha: M1,
  mergedAt: '2026-11-20T00:00:00Z', revertedBy: R1, revertedAt: '2026-11-21T00:00:00Z',
  revertLatencyMs: 86_400_000, relandedBy: null, ...over,
});

const revertRead = (records: RevertOutcomeRecord[], state: RevertLedgerRead['state'] = 'read'): RevertLedgerRead =>
  ({ records, intact: state !== 'unreadable', reasons: state === 'unreadable' ? ['unreadable-line-2'] : [], state });

const sync = (deps: Parameters<typeof syncCloudOutcomeObservations>[0] = {}) =>
  syncCloudOutcomeObservations({
    ledger: () => readLedger(ledgerPath),
    append: (e) => appendLedger(e, { path: ledgerPath }),
    tasks: () => [],
    reverts: () => revertRead([]),
    ...deps,
  });

describe('syncCloudOutcomeObservations', () => {
  it('records a merged task outcome as an observed merge, once', () => {
    write(...reg('1111111111'));
    const first = sync({ tasks: () => [task()] });
    expect(first).toMatchObject({ intact: true, proposals: 1, matched: 1, appended: 1, merged: 1, reverted: 0 });
    expect(records().at(-1)).toMatchObject({ type: 'observed', proposalId: '1111111111', observation: 'merged', sha: M1 });
    expect(sync({ tasks: () => [task()] }).appended).toBe(0);
  });

  it('records merge then standing revert from task outcome fields', () => {
    write(...reg('1111111111'));
    const t = task({ outcome: { mergeSha: M1, revertedBy: R1 } });
    const res = sync({ tasks: () => [t] });
    expect(res).toMatchObject({ appended: 2, merged: 1, reverted: 1 });
    const obs = records().filter((r): r is LedgerRecord & { type: 'observed' } => r.type === 'observed');
    expect(obs.map((o) => [o.observation, o.sha])).toEqual([['merged', M1], ['reverted', R1]]);
    // A measured improvement the revert undid scores as a regression.
    write({ type: 'measured', proposalId: '1111111111', phase: 'base', sha: M2, value: 100, reason: null },
      { type: 'measured', proposalId: '1111111111', phase: 'head', sha: M3, value: 80, reason: null });
    expect(scoreOutcomes(records()).find((o) => o.proposalId === '1111111111')).toMatchObject({ status: 'regressed', reasons: ['reverted-after-merge'] });
  });

  it('uses the revert journal as the authoritative verdict, including re-lands', () => {
    write(...reg('1111111111'));
    // Journal record proves merge+revert with no task at all.
    const first = sync({ reverts: () => revertRead([revertRecord()]) });
    expect(first).toMatchObject({ matched: 1, appended: 2, merged: 1, reverted: 1 });
    // A later scan finds the revert itself was reverted: reland evidence clears it.
    const second = sync({ reverts: () => revertRead([revertRecord(), revertRecord({ relandedBy: L1 })]) });
    expect(second).toMatchObject({ appended: 1, merged: 1, reverted: 0 });
    expect(records().at(-1)).toMatchObject({ observation: 'merged', sha: L1 });
    expect(scoreOutcomes(records()).find((o) => o.proposalId === '1111111111')?.reverted).toBeNull();
  });

  it('lets the journal verdict override a stale task revertedBy', () => {
    write(...reg('1111111111'));
    const t = task({ outcome: { mergeSha: M1, revertedBy: R2 } });
    const res = sync({
      tasks: () => [t],
      reverts: () => revertRead([revertRecord({ revertedBy: R1, relandedBy: L1 })]),
    });
    // The journal says the change stands via re-land L1; the task's stale
    // revertedBy must not resurrect a revert the scan already cleared.
    expect(res).toMatchObject({ appended: 1, merged: 1, reverted: 0 });
    expect(records().at(-1)).toMatchObject({ observation: 'merged', sha: L1 });
  });

  it('never clears a standing revert on merge evidence alone', () => {
    write(...reg('1111111111'),
      { type: 'observed', proposalId: '1111111111', observation: 'merged', sha: M1 },
      { type: 'observed', proposalId: '1111111111', observation: 'reverted', sha: R1 });
    // Task still reports the merge but no revert or re-land evidence exists.
    const res = sync({ tasks: () => [task()] });
    expect(res.appended).toBe(0);
    expect(records().at(-1)).toMatchObject({ observation: 'reverted', sha: R1 });
  });

  it('skips an unreadable revert journal but still applies task outcome fields', () => {
    write(...reg('1111111111'));
    const res = sync({
      tasks: () => [task()],
      reverts: () => revertRead([revertRecord()], 'unreadable'),
    });
    expect(res).toMatchObject({ revertLedger: 'unreadable', appended: 1, merged: 1 });
    expect(records().at(-1)).toMatchObject({ observation: 'merged', sha: M1 });
  });

  it('reports a non-intact outcome ledger and appends nothing', () => {
    write(...reg('1111111111'));
    fs.appendFileSync(ledgerPath, '{"v":1,"at":"2026-11-25T00:00:00Z","prev":"bad","digest":"bad","type":"observed","proposalId":"1111111111","observation":"merged","sha":"' + M2 + '"}\n');
    const res = sync({ tasks: () => [task()] });
    expect(res).toMatchObject({ intact: false });
    expect(res.reasons.length).toBeGreaterThan(0);
    expect(res.appended).toBe(0);
  });

  it('degrades to source-unavailable and append-failed without throwing', () => {
    write(...reg('1111111111'));
    expect(sync({ tasks: () => { throw new Error('store down'); } })).toMatchObject({ reason: 'source-unavailable', appended: 0 });
    const failing = syncCloudOutcomeObservations({
      ledger: () => readLedger(ledgerPath),
      tasks: () => [task()],
      reverts: () => revertRead([]),
      append: () => { throw new Error('disk full'); },
    });
    expect(failing).toMatchObject({ reason: 'append-failed', appended: 0 });
  });

  it('examines only registered proposals with a PR event', () => {
    write(
      { type: 'registered', proposalId: '2222222222', title: 'no pr', proposalKind: 'perf', source: { kind: 'deterministic', rule: 'test' }, metric, predictedDelta: null },
      { type: 'pr', proposalId: '3333333333', repository: REPO, number: 9 },
      ...reg('1111111111', 8),
    );
    const res = sync({ tasks: () => [task()] });
    // Only 1111111111 pairs registered+pr, but its PR #8 has no evidence.
    expect(res).toMatchObject({ proposals: 1, matched: 0, appended: 0 });
  });

  it('re-keys a proposal to the fleet PR that superseded it, then observes the carrier merge', () => {
    write(...reg('1111111111')); // pr #5: the cloud PR, closed by the intake
    const t = superseded(); // outcome.mergeSha M1 describes fleet PR #77
    const first = sync({ tasks: () => [t] });
    expect(first).toMatchObject({ proposals: 1, matched: 1, appended: 2, merged: 1, reverted: 0, rekeyed: 1 });
    const tail = records().slice(-2);
    expect(tail[0]).toMatchObject({ type: 'pr', proposalId: '1111111111', repository: REPO, number: 77 });
    expect(tail[1]).toMatchObject({ type: 'observed', proposalId: '1111111111', observation: 'merged', sha: M1 });
    // The re-keyed ledger now names the fleet PR: the next pass needs no carrier map.
    expect(sync({ tasks: () => [t] })).toMatchObject({ appended: 0, rekeyed: 0 });
  });

  it('re-keys even while the fleet PR has no merge evidence yet', () => {
    write(...reg('1111111111'));
    const t = superseded({ state: 'pr-open', outcome: { mergeSha: null } });
    const res = sync({ tasks: () => [t] });
    expect(res).toMatchObject({ matched: 0, appended: 1, rekeyed: 1 });
    expect(records().at(-1)).toMatchObject({ type: 'pr', number: 77 });
  });

  it('takes the merge SHA from the fleet landing record when the task outcome lacks one', () => {
    write(...reg('1111111111'));
    const t = superseded({
      outcome: { mergeSha: null },
      intake: { headSha: 'a'.repeat(40), proposalId: 'prop-1', diffHash: null, refused: null, at: '2026-11-25T00:00:00Z' },
    });
    const fleetState = (key: string): FleetMergeStateRead => (key === 'prop-1' ? fleetOk(fleetRecord()) : { state: 'missing' });
    const res = sync({ tasks: () => [t], fleetState });
    expect(res).toMatchObject({ matched: 1, appended: 2, merged: 1, rekeyed: 1 });
    expect(records().at(-1)).toMatchObject({ observation: 'merged', sha: LAND });
  });

  it('ignores a fleet record that names a different PR, repo or outcome', () => {
    write(...reg('1111111111'));
    const t = superseded({
      outcome: { mergeSha: null },
      intake: { headSha: 'a'.repeat(40), proposalId: 'prop-1', diffHash: null, refused: null, at: '2026-11-25T00:00:00Z' },
    });
    for (const record of [
      fleetRecord({ pr: { number: 78, state: 'merged' } }),
      fleetRecord({ repo: 'ashlrai/locus' }),
      fleetRecord({ outcome: 'closed' }),
      fleetRecord({ outcome: null, landing: null, merge: null }),
    ]) {
      const res = sync({ tasks: () => [t], fleetState: () => fleetOk(record) });
      expect(res).toMatchObject({ matched: 0, merged: 0 });
    }
    // Only the carrier re-key was appended across all four passes.
    expect(records().filter((r) => r.type === 'pr' && r.proposalId === '1111111111').map((r) => (r as { number: number }).number)).toEqual([5, 77]);
  });
});

describe('observationEvents', () => {
  const ev = (mergeSha: string | null, revertSha: string | null, relandSha: string | null) =>
    ({ mergeSha, revertSha, relandSha, taskRevertSha: null, ledgerVerdict: false });

  it('orders merged before reverted for a fresh proposal', () => {
    expect(observationEvents('1111111111', [], ev(M1, R1, null))).toEqual([
      { type: 'observed', proposalId: '1111111111', observation: 'merged', sha: M1 },
      { type: 'observed', proposalId: '1111111111', observation: 'reverted', sha: R1 },
    ]);
  });

  it('emits nothing without evidence or when already observed', () => {
    expect(observationEvents('1111111111', [], ev(null, null, null))).toEqual([]);
    const seen = [{ type: 'observed', proposalId: '1111111111', observation: 'merged', sha: M1 }] as unknown as LedgerRecord[];
    expect(observationEvents('1111111111', seen, ev(M1, null, null))).toEqual([]);
  });
});

describe('outcomeObservationEvidence', () => {
  it('prefers task mergeSha and falls back to the journal merge commit', () => {
    const byPr = outcomeObservationEvidence([task()], [revertRecord({ mergeSha: M2 })]);
    const e = byPr.get(prKey(REPO, 5))!;
    expect(e.mergeSha).toBe(M1);
    expect(e.revertSha).toBe(R1);
    const journalOnly = outcomeObservationEvidence([], [revertRecord({ mergeSha: M2 })]).get(prKey(REPO, 5))!;
    expect(journalOnly.mergeSha).toBe(M2);
  });

  it('keys a superseded task under its fleet carrier and fills mergeSha from the landing record', () => {
    const t = superseded({
      outcome: { mergeSha: null },
      intake: { headSha: 'a'.repeat(40), proposalId: 'prop-1', diffHash: null, refused: null, at: '2026-11-25T00:00:00Z' },
    });
    const byPr = outcomeObservationEvidence([t], [], () => fleetOk(fleetRecord()));
    expect(byPr.get(prKey(REPO, 77))?.mergeSha).toBe(LAND);
    expect(byPr.get(prKey(REPO, 5))).toBeUndefined();
    // Task outcome still wins when both sources have a SHA.
    const both = outcomeObservationEvidence([superseded()], [], () => fleetOk(fleetRecord()));
    expect(both.get(prKey(REPO, 77))?.mergeSha).toBe(M1);
  });
});
