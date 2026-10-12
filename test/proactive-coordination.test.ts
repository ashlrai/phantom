/** Isolated local lifecycle tests: no provider, home-state or network calls. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { createCompanionCoordinator } from '../src/core/proactive/coordination.js';
import { companionTaskId, companionTextDigest, type CompanionCommand, type CompanionCoordinator,
  type CompanionHostObservation, type CompanionTask, type CompanionWrite } from '../src/core/proactive/coordination-types.js';

let root: string, directory: string, coordinator: CompanionCoordinator, now: Date;
let observation: CompanionHostObservation | null;
const identity = { provider: 'openai-dot', accountId: 'client', agentId: 'ashlr.2.0' };
const peer = { provider: 'openai-dot', accountId: 'company', agentId: 'Ashlr' };
const input = { tenantId: 'client', projectBindingId: 'project-approved', taskKey: 'review-pr-1', goal: 'Review this exact PR.',
  acceptance: ['Return source-backed findings.'], packetDigest: 'a'.repeat(64), capabilityIds: ['review'], maxAttempts: 3 };
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'phantom-companion-ledger-'));
  directory = join(root, 'coordination'); now = new Date('2026-10-12T12:00:00.000Z'); observation = null;
  coordinator = createCompanionCoordinator({ directory, now: () => now, host: { observe: () => observation } });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function good(write: CompanionWrite): Extract<CompanionWrite, { ok: true }> {
  expect(write).toMatchObject({ ok: true, dispatchAuthorized: false });
  if (!write.ok) throw new Error(write.reason); return write;
}
function execute(command: Omit<CompanionCommand, 'expectedRevision'>): CompanionWrite {
  return coordinator.execute({ ...command, expectedRevision: coordinator.list().revision } as CompanionCommand);
}
function create(): CompanionTask { return good(execute({ kind: 'create', commandId: 'create', task: input } as Omit<CompanionCommand, 'expectedRevision'>)).task; }
function assign(taskId: string, commandId = 'assign', assignee = identity): CompanionTask {
  return good(execute({ kind: 'assign', commandId, taskId, assignee, ownerId: 'local-operator', leaseMs: 60_000 } as Omit<CompanionCommand, 'expectedRevision'>)).task;
}
function handoff(task: CompanionTask): CompanionTask {
  const attempt = task.attempts.at(-1)!;
  return good(execute({ kind: 'handoff', commandId: `handoff-${attempt.epoch}`, taskId: task.id,
    attemptId: attempt.id, epoch: attempt.epoch, ownerId: attempt.ownerId } as Omit<CompanionCommand, 'expectedRevision'>)).task;
}
function report(task: CompanionTask, commandId = 'report', packetDigest = input.packetDigest): CompanionTask {
  const attempt = task.attempts.at(-1)!;
  return good(execute({ kind: 'report', commandId, taskId: task.id, attemptId: attempt.id, epoch: attempt.epoch,
    packetDigest, result: 'A source-backed result.', report: 'I checked the requested evidence.', sourceReference: 'operator-pasted-report' } as Omit<CompanionCommand, 'expectedRevision'>)).task;
}
function observe(task: CompanionTask, state: CompanionHostObservation['state'], commandId: string): CompanionTask {
  const attempt = task.attempts.at(-1)!;
  observation = { taskId: task.id, attemptId: attempt.id, epoch: attempt.epoch, assignee: attempt.assignee,
    packetDigest: attempt.packetDigest, state, providerRunId: state === 'accepted' ? 'provider-run' : null, evidenceReference: 'fixture-host-receipt' };
  return good(coordinator.reconcile(commandId, coordinator.list().revision, task.id, attempt.id)).task;
}
// Durable directory-entry fsync and immutable history validation are real local I/O.
describe('companion coordination durable manual ledger', { timeout: 15_000 }, () => {
  it('retains corrected source references while deduplicating the exact corrected report', () => {
    const initial = report(assign(create().id));
    const attempt = initial.attempts[0]!;
    const write = (commandId: string) => good(execute({ kind: 'report', commandId, taskId: initial.id,
      attemptId: attempt.id, epoch: attempt.epoch, packetDigest: input.packetDigest,
      result: initial.reports[0]!.result, report: initial.reports[0]!.report,
      sourceReference: 'manual:corrected-citation' } as Omit<CompanionCommand, 'expectedRevision'>)).task;
    const corrected = write('correct-reference');
    expect(corrected.reports).toHaveLength(2);
    expect(corrected.reports[0]?.stale).toBe(true);
    expect(corrected.reports[1]?.sourceReference).toBe('manual:corrected-citation');
    const duplicate = write('repeat-correct-reference');
    expect(duplicate.reports).toHaveLength(2);
    expect(duplicate.notification).toEqual(corrected.notification);
  });
  it('creates no state on reads; bounds immutable task intent and round trips through a fresh coordinator', () => {
    expect(coordinator.list()).toEqual({ sourceState: 'missing', revision: 0, tasks: [] });
    const task = create(); expect(task.id).toBe(companionTaskId(input));
    expect(task).toMatchObject({ state: 'draft', deadline: null, maxCostUsd: null, notification: null, attempts: [] });
    expect(createCompanionCoordinator({ directory }).read(task.id).task).toEqual(task);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    const files = readdirSync(join(directory, 'ledger', 'records'));
    expect(statSync(join(directory, 'ledger', 'records', files[0]!)).mode & 0o777).toBe(0o600);
  });
  it('replays exact command at its original revision, rejects changed payload, and deduplicates semantic tasks', () => {
    const command: CompanionCommand = { kind: 'create', commandId: 'same-command', expectedRevision: 0, task: input };
    const first = good(coordinator.execute(command)); assign(first.taskId);
    expect(coordinator.replay({ ...command, commandId: 'new-receipt' })).toBeNull();
    expect(good(coordinator.replay(command)!)).toMatchObject({ disposition: 'replayed', revision: 1, dispatchAuthorized: false });
    expect(coordinator.replay({ ...command, task: { ...input, goal: 'Changed body' } })).toMatchObject({ ok: false, reason: 'conflict' });
    expect(good(coordinator.execute(command))).toMatchObject({ disposition: 'replayed', revision: 1, task: { state: 'draft' } });
    expect(coordinator.execute({ ...command, task: { ...input, goal: 'Different meaning.' } })).toMatchObject({ ok: false, reason: 'conflict' });
    good(execute({ ...command, commandId: 'new-create' })); expect(coordinator.list().tasks).toHaveLength(1);
    expect(execute({ ...command, commandId: 'changed-scope', task: { ...input, packetDigest: 'b'.repeat(64) } } as Omit<CompanionCommand, 'expectedRevision'>))
      .toMatchObject({ ok: false, reason: 'conflict' });
  });
  it('isolates stable tenant and project bindings independently of assistant display names', () => {
    create(); good(execute({ kind: 'create', commandId: 'company-create', task: { ...input, tenantId: 'company' } } as Omit<CompanionCommand, 'expectedRevision'>));
    good(execute({ kind: 'create', commandId: 'project-create', task: { ...input, projectBindingId: 'other-project' } } as Omit<CompanionCommand, 'expectedRevision'>));
    expect(coordinator.list({ tenantId: 'client', projectBindingId: 'project-approved' }).tasks).toHaveLength(1);
    expect(coordinator.list({ tenantId: 'company' }).tasks).toHaveLength(1);
    expect(new Set(coordinator.list().tasks.map(task => task.id)).size).toBe(3);
  });
  it('concurrent claims have one CAS winner; a foreign live store lock cannot be bypassed', async () => {
    const task = create(); const second = createCompanionCoordinator({ directory });
    const command: CompanionCommand = { kind: 'assign', commandId: 'winner-a', expectedRevision: 1, taskId: task.id, assignee: identity, ownerId: 'one', leaseMs: 60_000 };
    const results = await Promise.all([Promise.resolve().then(() => coordinator.execute(command)),
      Promise.resolve().then(() => second.execute({ ...command, commandId: 'winner-b', ownerId: 'two' }))]);
    expect(results.filter(value => value.ok)).toHaveLength(1); expect(second.read(task.id).task?.attempts).toHaveLength(1);
    const lock = acquireLocalStoreLockWithOutcome(join(directory, '.coordination.lock'), 0, { anchorPath: directory, exactPrivateStorage: true });
    expect(lock.state).toBe('acquired');
    if (lock.state !== 'acquired') throw new Error('fixture lock');
    try { expect(execute({ kind: 'notification-ack', commandId: 'locked', taskId: task.id, eventId: 'a'.repeat(64) } as Omit<CompanionCommand, 'expectedRevision'>))
      .toMatchObject({ ok: false, reason: 'conflict' }); } finally { releaseLocalStoreLock(lock.lock); }
  });
  it('records handoff intent before contact without granting dispatch or accepting JSON provider states', () => {
    const task = assign(create().id); const handed = handoff(task);
    expect(handed.attempts[0]).toMatchObject({ contact: 'intent', providerRunId: null });
    const command: CompanionCommand = { kind: 'handoff', commandId: 'handoff-1', expectedRevision: 2,
      taskId: task.id, attemptId: task.attempts[0]!.id, epoch: 1, ownerId: 'local-operator' };
    expect(good(coordinator.execute(command))).toMatchObject({ disposition: 'replayed', dispatchAuthorized: false });
    expect(coordinator.execute({ ...command, commandId: 'forged', state: 'accepted' } as CompanionCommand)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(coordinator.execute({ kind: 'reconcile', commandId: 'raw-observation', expectedRevision: 3, taskId: task.id } as unknown as CompanionCommand))
      .toMatchObject({ ok: false, reason: 'invalid' });
    expect(execute({ ...command, commandId: 'wrong-owner', ownerId: 'other' })).toMatchObject({ ok: false, reason: 'held' });
  });
  it('lease expiry cannot implicitly reassign or launch another attempt', () => {
    const task = assign(create().id); now = new Date('2026-10-12T12:01:00.000Z');
    expect(execute({ kind: 'handoff', commandId: 'expired', taskId: task.id, attemptId: task.attempts[0]!.id,
      epoch: 1, ownerId: 'local-operator' } as Omit<CompanionCommand, 'expectedRevision'>)).toMatchObject({ ok: false, reason: 'held' });
    expect(execute({ kind: 'assign', commandId: 'expired-reassign', taskId: task.id, assignee: peer, ownerId: 'next', leaseMs: 60_000 } as Omit<CompanionCommand, 'expectedRevision'>))
      .toMatchObject({ ok: false, reason: 'held' });
    expect(coordinator.read(task.id).task?.attempts).toHaveLength(1);
  });
  it('only injected exact-account host evidence can reconcile accepted or unknown work', () => {
    const task = handoff(assign(create().id));
    expect(createCompanionCoordinator({ directory }).reconcile('no-port', 3, task.id, task.attempts[0]!.id)).toMatchObject({ ok: false, reason: 'held' });
    const accepted = observe(task, 'accepted', 'accepted'); expect(accepted.attempts[0]?.providerRunId).toBe('provider-run');
    observation = { ...observation!, assignee: peer };
    expect(coordinator.reconcile('foreign-account', 4, task.id, task.attempts[0]!.id)).toMatchObject({ ok: false, reason: 'held' });
    const unknown = observe(accepted, 'unknown', 'unknown'); expect(unknown.attempts[0]?.providerRunId).toBe('provider-run');
    expect(execute({ kind: 'assign', commandId: 'unknown-reassign', taskId: task.id, assignee: peer, ownerId: 'next', leaseMs: 60_000 } as Omit<CompanionCommand, 'expectedRevision'>))
      .toMatchObject({ ok: false, reason: 'held' });
  });
  it('cancel is requested separately from confirmed; only proved-safe prior attempts can be reassigned', () => {
    let task = observe(handoff(assign(create().id)), 'accepted', 'accepted');
    task = good(execute({ kind: 'cancel', commandId: 'cancel', taskId: task.id, attemptId: task.attempts[0]!.id } as Omit<CompanionCommand, 'expectedRevision'>)).task;
    expect(task).toMatchObject({ state: 'cancel-requested', attempts: [expect.objectContaining({ contact: 'accepted' })] });
    expect(execute({ kind: 'assign', commandId: 'not-yet', taskId: task.id, assignee: peer, ownerId: 'next', leaseMs: 60_000 } as Omit<CompanionCommand, 'expectedRevision'>))
      .toMatchObject({ ok: false, reason: 'held' });
    task = observe(task, 'cancel-confirmed', 'confirmed'); task = assign(task.id, 'new-assignment', peer);
    expect(task.attempts.map(attempt => attempt.epoch)).toEqual([1, 2]); expect(task.attempts[0]?.assignee).toEqual(identity);
  });
  it('manual report is unverified, digest is computed, and producer cannot verify its own result', () => {
    const task = report(handoff(assign(create().id))); const result = task.reports[0]!;
    expect(result).toMatchObject({ resultDigest: companionTextDigest(result.result), source: 'manual-unverified', stale: false });
    expect(task.state).toBe('reported');
    const review: CompanionCommand = { kind: 'operator-review', commandId: 'review', expectedRevision: 4, taskId: task.id,
      reportId: result.id, checkedResultDigest: result.resultDigest, reviewer: { kind: 'peer', identity }, acceptanceMet: true };
    expect(coordinator.execute(review)).toMatchObject({ ok: false, reason: 'held' });
    expect(coordinator.execute({ ...review, checkedResultDigest: 'f'.repeat(64), reviewer: { kind: 'peer', identity: peer } }))
      .toMatchObject({ ok: false, reason: 'held' });
    const verified = good(coordinator.execute({ ...review, reviewer: { kind: 'peer', identity: peer } })).task;
    expect(verified).toMatchObject({ state: 'verified', verifications: [expect.objectContaining({ applied: true, source: 'manual-operator-review' })] });
  });
  it('retains stale packet/ownership result but cannot apply it; operator review is explicitly labeled', () => {
    let task = handoff(assign(create().id)); const oldAttempt = task.attempts[0]!;
    task = observe(task, 'proved-unstarted', 'unstarted'); task = handoff(assign(task.id, 'second', peer));
    task = good(execute({ kind: 'report', commandId: 'late-old', taskId: task.id, attemptId: oldAttempt.id, epoch: 1,
      packetDigest: input.packetDigest, result: 'Late old reply', report: 'Old report', sourceReference: 'manual-import' } as Omit<CompanionCommand, 'expectedRevision'>)).task;
    const oldReport = task.reports[0]!; expect(oldReport.stale).toBe(true);
    task = good(execute({ kind: 'operator-review', commandId: 'review-old', taskId: task.id, reportId: oldReport.id,
      checkedResultDigest: oldReport.resultDigest, reviewer: { kind: 'operator', operatorId: 'Mason' }, acceptanceMet: true } as Omit<CompanionCommand, 'expectedRevision'>)).task;
    expect(task.verifications[0]).toMatchObject({ applied: false, reviewer: { kind: 'operator', operatorId: 'Mason' } });
    expect(task.state).not.toBe('verified');
    const stalePacket = report(task, 'wrong-packet', 'b'.repeat(64)); expect(stalePacket.reports.at(-1)?.stale).toBe(true);
  });
  it('tracks one notification state and acknowledges only its current event', () => {
    const task = report(handoff(assign(create().id))); const notice = task.notification!;
    expect(notice).toMatchObject({ state: 'pending', reason: 'needs-review' });
    expect(execute({ kind: 'notification-ack', commandId: 'foreign-notice', taskId: task.id, eventId: 'f'.repeat(64) } as Omit<CompanionCommand, 'expectedRevision'>))
      .toMatchObject({ ok: false, reason: 'held' });
    const ack = good(execute({ kind: 'notification-ack', commandId: 'ack', taskId: task.id, eventId: notice.eventId } as Omit<CompanionCommand, 'expectedRevision'>)).task;
    expect(ack.notification).toMatchObject({ eventId: notice.eventId, state: 'acknowledged' });
    expect(ack.events.map(event => event.seq)).toEqual([1, 2, 3, 4, 5]);
    const repeated = report(ack, 'same-result-new-command');
    expect(repeated.reports).toHaveLength(1); expect(repeated.notification).toEqual(ack.notification);
    expect(repeated.events).toEqual(ack.events);
  });
  it('preserves cancel intent when a late current report arrives and cannot verify canceled work', () => {
    let task = handoff(assign(create().id)); const attempt = task.attempts[0]!;
    task = good(execute({ kind: 'cancel', commandId: 'cancel-before-report', taskId: task.id, attemptId: attempt.id } as Omit<CompanionCommand, 'expectedRevision'>)).task;
    const notice = task.notification; task = report(task, 'late-current');
    expect(task.state).toBe('cancel-requested'); expect(task.notification).toEqual(notice);
    task = good(execute({ kind: 'operator-review', commandId: 'late-review', taskId: task.id, reportId: task.reports[0]!.id,
      checkedResultDigest: task.reports[0]!.resultDigest, reviewer: { kind: 'operator', operatorId: 'Mason' }, acceptanceMet: true } as Omit<CompanionCommand, 'expectedRevision'>)).task;
    expect(task.state).toBe('cancel-requested'); expect(task.verifications[0]?.applied).toBe(false); expect(task.notification).toEqual(notice);
  });
  it('a newer current result supersedes its older draft, retaining its review without applying it', () => {
    let task = report(handoff(assign(create().id))); const old = task.reports[0]!; const attempt = task.attempts[0]!;
    task = good(execute({ kind: 'report', commandId: 'new-current-result', taskId: task.id, attemptId: attempt.id, epoch: 1,
      packetDigest: input.packetDigest, result: 'A corrected newer result.', report: 'Corrected report.', sourceReference: 'manual-new-result' } as Omit<CompanionCommand, 'expectedRevision'>)).task;
    expect(task.reports[0]?.stale).toBe(true); expect(task.reports[1]?.stale).toBe(false);
    task = good(execute({ kind: 'operator-review', commandId: 'old-draft-review', taskId: task.id, reportId: old.id,
      checkedResultDigest: old.resultDigest, reviewer: { kind: 'operator', operatorId: 'Mason' }, acceptanceMet: true } as Omit<CompanionCommand, 'expectedRevision'>)).task;
    expect(task.state).toBe('reported'); expect(task.verifications.at(-1)?.applied).toBe(false);
  });
  it('keeps verified completion and notification immutable under subsequent historical reports and negative review', () => {
    let task = report(handoff(assign(create().id))); const result = task.reports[0]!;
    task = good(execute({ kind: 'operator-review', commandId: 'verify', taskId: task.id, reportId: result.id,
      checkedResultDigest: result.resultDigest, reviewer: { kind: 'operator', operatorId: 'Mason' }, acceptanceMet: true } as Omit<CompanionCommand, 'expectedRevision'>)).task;
    const notice = task.notification;
    task = good(execute({ kind: 'operator-review', commandId: 'later-negative', taskId: task.id, reportId: result.id,
      checkedResultDigest: result.resultDigest, reviewer: { kind: 'peer', identity: peer }, acceptanceMet: false } as Omit<CompanionCommand, 'expectedRevision'>)).task;
    expect(task.state).toBe('verified'); expect(task.notification).toEqual(notice);
    const attempt = task.attempts[0]!;
    task = good(execute({ kind: 'report', commandId: 'later-report', taskId: task.id, attemptId: attempt.id, epoch: 1,
      packetDigest: input.packetDigest, result: 'Later historical note', report: 'Additional report', sourceReference: 'manual-history' } as Omit<CompanionCommand, 'expectedRevision'>)).task;
    expect(task.state).toBe('verified'); expect(task.reports.at(-1)?.stale).toBe(true); expect(task.notification).toEqual(notice);
  });
  it('accepts bounded real provider identity references but rejects credential-shaped metadata and reports', () => {
    const task = create(); const realIdentity = { provider: 'custom-provider', accountId: 'mason@example.test', agentId: 'workspaces/company/agents/Ashlr' };
    expect(assign(task.id, 'email-account', realIdentity).attempts[0]?.assignee).toEqual(realIdentity);
    const attempt = coordinator.read(task.id).task!.attempts[0]!;
    const base: CompanionCommand = { kind: 'report', commandId: 'unsafe', expectedRevision: 2, taskId: task.id,
      attemptId: attempt.id, epoch: 1, packetDigest: input.packetDigest, result: 'Clean result', report: 'Clean report', sourceReference: 'manual-reference' };
    const synthetic = `sk-${'Ab1Cd2Ef3Gh4'.repeat(4)}`;
    for (const field of ['result', 'report', 'sourceReference']) {
      expect(coordinator.execute({ ...base, [field]: synthetic })).toMatchObject({ ok: false, reason: 'invalid' });
    }
    expect(coordinator.execute({ kind: 'assign', commandId: synthetic, expectedRevision: 2, taskId: task.id,
      assignee: peer, ownerId: 'operator', leaseMs: 60_000 })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(coordinator.execute({ kind: 'assign', commandId: 'secret-owner', expectedRevision: 2, taskId: task.id,
      assignee: peer, ownerId: synthetic, leaseMs: 60_000 })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(coordinator.read(task.id).task?.reports).toEqual([]);
  });
  it('refuses oversize or unexpected input and never overwrites corrupt/symlink/public storage', () => {
    expect(coordinator.execute({ kind: 'create', commandId: 'huge', expectedRevision: 0, task: { ...input, goal: 'x'.repeat(9000) } }))
      .toMatchObject({ ok: false, reason: 'invalid' });
    const task = create(); const records = join(directory, 'ledger', 'records'); const file = join(records, readdirSync(records)[0]!);
    const original = readFileSync(file, 'utf8'); writeFileSync(file, original.replace('Review this exact PR.', 'Tampered task.'), { mode: 0o600 });
    expect(coordinator.list().sourceState).toBe('degraded'); expect(assignFailure(task.id)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(readFileSync(file, 'utf8')).toContain('Tampered task.');
    writeFileSync(file, original); rmSync(file); symlinkSync(join(root, 'outside-file'), file);
    expect(coordinator.list().sourceState).toBe('degraded'); rmSync(file); writeFileSync(file, original, { mode: 0o600 });
    chmodSync(directory, 0o755); expect(coordinator.list().sourceState).toBe('degraded');
  });
  it('rejects symlink ancestors without creating or mutating their target', () => {
    const link = join(root, 'link'); symlinkSync(directory, link);
    const linked = createCompanionCoordinator({ directory: link });
    expect(linked.execute({ kind: 'create', commandId: 'link-create', expectedRevision: 0, task: input })).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(coordinator.list().sourceState).toBe('missing');
  });
});
function assignFailure(taskId: string) {
  return coordinator.execute({ kind: 'assign', commandId: 'after-corrupt', expectedRevision: 1, taskId, assignee: peer, ownerId: 'operator', leaseMs: 10_000 });
}
