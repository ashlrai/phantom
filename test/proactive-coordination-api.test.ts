/** Local request/response vertical slice. No server, provider, credentials or paid calls. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { createProactiveCoordinationApi, PROACTIVE_COORDINATION_PATH } from '../src/core/verse/proactive-coordination-api.js';
import { createProactiveProfilesStore, type ProactiveProfilesStore } from '../src/core/proactive/profiles.js';
import { createCompanionCoordinator } from '../src/core/proactive/coordination.js';
import type { CompanionCoordinator, CompanionTask } from '../src/core/proactive/coordination-types.js';
import { decodeCompanionWire, projectCompanionWire } from '../src/core/proactive/coordination-wire.js';
import { rankCompanionCandidates } from '../src/core/proactive/planning.js';

let root: string, profiles: ProactiveProfilesStore, coordinator: CompanionCoordinator;
const NOW = new Date('2026-10-12T20:00:00.000Z');
beforeEach(async () => {
  root = await mkdtemp(join(realpathSync(tmpdir()), 'companion-api-test-'));
  profiles = createProactiveProfilesStore({ directory: () => join(root, 'profiles') });
  coordinator = createCompanionCoordinator({ directory: join(root, 'coordination'), now: () => NOW });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function request(body?: unknown, options: { path?: string; method?: string; token?: string; allowDispatch?: boolean; raw?: string } = {}) {
  const path = options.path ?? PROACTIVE_COORDINATION_PATH, method = options.method ?? 'POST';
  const req = Readable.from([options.raw ?? JSON.stringify(projectCompanionWire(body ?? {}))]) as unknown as IncomingMessage;
  req.url = path; req.headers = { 'content-type': 'application/json', 'x-ashlr-token': options.token ?? 'operator-test' };
  let status = 0, wire: any;
  const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; },
    end(text: string) { wire = JSON.parse(text); } } as unknown as ServerResponse;
  const ctx = { cfg: {} as AshlrConfig, token: 'operator-test', allowDispatch: options.allowDispatch ?? true } as VerseApiContext;
  const handled = await createProactiveCoordinationApi({ coordinator: () => coordinator, profiles: () => profiles,
    packetRoot: () => root, now: () => NOW })(ctx, req, res, path.split('?')[0]!, method);
  return { handled, status, wire, body: decodeCompanionWire(wire) as any };
}
async function prepare() {
  const a = await profiles.create({ identity: { provider: 'custom-assistant', accountId: 'client@example.test', agentId: 'research-agent' },
    displayName: 'Client research', capabilityIds: ['research'], preferences: { maxConcurrent: 1 } });
  const b = await profiles.create({ identity: { provider: 'custom-assistant', accountId: 'company@example.test', agentId: 'research-agent' },
    displayName: 'Company research', capabilityIds: ['research'] });
  const task = { tenantId: 'client', projectBindingId: 'client-project', taskKey: 'review-spec', goal: 'Review the specification.',
    acceptance: ['Return cited findings.'], capabilityIds: ['research'], deadline: null, maxCostUsd: null, maxAttempts: 1 };
  const packet = await request({ ...task, profileId: a.id }, { path: `${PROACTIVE_COORDINATION_PATH}/packet` });
  expect(packet.status).toBe(200); expect(packet.body.contextShared).toBe(false);
  expect(packet.wire.packetDigest).toMatch(/^sha256:/); expect(packet.body.packet.coverage.complete).toBe(false);
  const create = await request({ kind: 'create', commandId: 'create-task', expectedRevision: 0,
    task: { ...task, packetDigest: packet.body.packetDigest } });
  expect(create.status).toBe(200);
  return { a, b, task: create.body.task as CompanionTask, revision: create.body.revision as number };
}
describe('provider-neutral local coordination API', () => {
  it('guards local writes and refuses forged transport operations without touching state', async () => {
    expect((await request({}, { token: 'wrong' })).status).toBe(401);
    expect((await request({}, { allowDispatch: false })).status).toBe(404);
    expect((await request(undefined, { raw: '{malformed' })).status).toBe(400);
    expect((await request({}, { path: `${PROACTIVE_COORDINATION_PATH}?account=all` })).status).toBe(400);
    expect((await request({ kind: 'accepted', commandId: 'forge', expectedRevision: 0 })).status).toBe(400);
    expect(coordinator.list()).toMatchObject({ revision: 0, tasks: [] });
  });
  it('prepares only a local brief and rejects input/source scope substitution', async () => {
    const profile = await profiles.create({ identity: { provider: 'arbitrary', accountId: 'a', agentId: 'one' }, displayName: 'One' });
    const input = { tenantId: 'tenant', projectBindingId: 'project', taskKey: 'task', goal: 'A goal', acceptance: ['A check'], capabilityIds: [], profileId: profile.id };
    expect((await request({ ...input, evidence: [{ excerpt: 'Imported client context' }] }, { path: `${PROACTIVE_COORDINATION_PATH}/packet` })).status).toBe(400);
    expect((await request({ ...input, goal: 'token=sk-abcdefghijklmnopqrstuv1234567890' }, { path: `${PROACTIVE_COORDINATION_PATH}/packet` })).status).toBe(400);
    expect((await request({ ...input, deadline: '2020-01-01T00:00:00Z' }, { path: `${PROACTIVE_COORDINATION_PATH}/packet` })).status).toBe(400);
    expect((await request({ kind: 'create', commandId: 'substitute', expectedRevision: 0,
      task: { tenantId: input.tenantId, projectBindingId: input.projectBindingId, taskKey: input.taskKey,
        goal: input.goal, acceptance: input.acceptance, capabilityIds: [], packetDigest: 'a'.repeat(64) } })).status).toBe(409);
    expect(coordinator.list().tasks).toHaveLength(0);
  });
  it('round-trips ownership, cancellation, failure and verification with replay-safe notification IDs', async () => {
    const { a, b, task, revision } = await prepare();
    const assign = { kind: 'assign', commandId: 'assign-task', expectedRevision: revision, taskId: task.id,
      assignee: a.identity, ownerId: 'operator-a', leaseMs: 60_000 };
    const assigned = await request(assign); expect(assigned.status).toBe(200);
    const attempt = assigned.body.task.attempts[0];
    expect(assigned.wire.task.attempts[0].id).toMatch(/^sha256:/);
    const replay = await request(assign); expect(replay.status).toBe(200); expect(replay.body.disposition).toBe('replayed');
    expect(replay.body.dispatchAuthorized).toBe(false);
    expect((await request({ ...assign, commandId: 'wrong-destination', expectedRevision: assigned.body.revision, assignee: b.identity })).status).toBe(409);
    const handoff = await request({ kind: 'handoff', commandId: 'handoff-task', expectedRevision: assigned.body.revision,
      taskId: task.id, attemptId: attempt.id, epoch: attempt.epoch, ownerId: attempt.ownerId });
    expect(handoff.status).toBe(200); expect(handoff.body.task.attempts[0].contact).toBe('intent');
    const reportCommand = { kind: 'report', commandId: 'report-task', expectedRevision: handoff.body.revision,
      taskId: task.id, attemptId: attempt.id, epoch: attempt.epoch, packetDigest: task.packetDigest,
      result: 'Cited finding in the specification.', report: 'One finding returned.', sourceReference: 'manual:review-note' };
    const reported = await request(reportCommand); expect(reported.status).toBe(200);
    const report = reported.body.task.reports[0];
    expect(reported.wire.task.reports[0].id).toMatch(/^sha256:/);
    const review = { kind: 'operator-review', commandId: 'reject-report', expectedRevision: reported.body.revision,
      taskId: task.id, reportId: report.id, checkedResultDigest: report.resultDigest,
      reviewer: { kind: 'operator', operatorId: 'operator-reviewer' }, acceptanceMet: false };
    const failedReview = await request(review); expect(failedReview.status).toBe(200);
    expect(failedReview.body.task.state).toBe('needs-attention');
    const verified = await request({ ...review, commandId: 'verify-report', expectedRevision: failedReview.body.revision, acceptanceMet: true });
    expect(verified.status).toBe(200); expect(verified.body.task.state).toBe('verified');
    const notification = verified.body.task.notification;
    expect(verified.wire.task.notification.eventId).toMatch(/^sha256:/);
    const ack = { kind: 'notification-ack', commandId: 'ack-report', expectedRevision: verified.body.revision,
      taskId: task.id, eventId: notification.eventId };
    const acknowledged = await request(ack); expect(acknowledged.status).toBe(200);
    expect(acknowledged.body.task.notification.state).toBe('acknowledged');
    expect((await request(ack)).body.disposition).toBe('replayed');
    const listing = await request(undefined, { method: 'GET' });
    expect(listing.body).toMatchObject({ planningOnly: true, transport: 'unavailable' });
    expect(listing.body.packetDestinations[0].identity).toEqual(a.identity);
    expect(listing.body.routing[0].candidates.every((candidate: any) => candidate.executionEligible === false)).toBe(true);
  }, 30_000);
  it('returns old exact receipt even after planning preferences change', async () => {
    const { a, task, revision } = await prepare();
    const command = { kind: 'assign', commandId: 'assign-once', expectedRevision: revision, taskId: task.id,
      assignee: a.identity, ownerId: 'owner', leaseMs: 1000 };
    const first = await request(command); expect(first.status).toBe(200);
    await profiles.update(a.id, { expectedVersion: a.version, enabled: false });
    const replay = await request(command); expect(replay.status).toBe(200); expect(replay.body.disposition).toBe('replayed');
    expect((await request({ ...command, assignee: { ...a.identity, agentId: 'different' } })).status).toBe(409);
    expect(coordinator.read(task.id).task?.attempts).toHaveLength(1);
  }, 20_000);
  it('rechecks narrowed project preferences before a new handoff and preserves cancel intent after a report', async () => {
    const { a, task, revision } = await prepare();
    const assigned = await request({ kind: 'assign', commandId: 'claim-for-cancel', expectedRevision: revision,
      taskId: task.id, assignee: a.identity, ownerId: 'owner', leaseMs: 60_000 });
    expect(assigned.status).toBe(200);
    const attempt = assigned.body.task.attempts[0];
    await profiles.update(a.id, { expectedVersion: a.version, preferences: { projectBindingIds: ['another-project'] } });
    expect((await request({ kind: 'handoff', commandId: 'scope-changed', expectedRevision: assigned.body.revision,
      taskId: task.id, attemptId: attempt.id, epoch: attempt.epoch, ownerId: 'owner' })).status).toBe(409);
    const canceled = await request({ kind: 'cancel', commandId: 'cancel-intent', expectedRevision: assigned.body.revision,
      taskId: task.id, attemptId: attempt.id });
    expect(canceled.status).toBe(200); expect(canceled.body.task.state).toBe('cancel-requested');
    expect(canceled.body.task.attempts[0].contact).toBe('not-contacted');
    const late = await request({ kind: 'report', commandId: 'late-report', expectedRevision: canceled.body.revision,
      taskId: task.id, attemptId: attempt.id, epoch: attempt.epoch, packetDigest: task.packetDigest,
      result: 'A late manually observed result.', report: 'Late evidence.', sourceReference: 'manual:late' });
    expect(late.status).toBe(200); expect(late.body.task.state).toBe('cancel-requested');
    expect(late.body.task.attempts[0].cancelRequestedAt).not.toBeNull();
  }, 20_000);
  it('rejects results which would be hidden by response redaction', async () => {
    const { a, task, revision } = await prepare();
    const assigned = await request({ kind: 'assign', commandId: 'claim-report', expectedRevision: revision,
      taskId: task.id, assignee: a.identity, ownerId: 'owner', leaseMs: 1000 });
    const attempt = assigned.body.task.attempts[0];
    const report = { kind: 'report', commandId: 'hidden-result', expectedRevision: assigned.body.revision,
      taskId: task.id, attemptId: attempt.id, epoch: attempt.epoch, packetDigest: task.packetDigest,
      result: `xai-${'a1b2c3d4'.repeat(5)}`, report: 'A report.', sourceReference: 'manual:report' };
    expect((await request(report)).status).toBe(400);
    expect(coordinator.read(task.id).task?.reports).toHaveLength(0);
  }, 20_000);
});
describe('local deterministic capability advice', () => {
  it('filters declared fit and never turns preferences into execution eligibility', async () => {
    const { a, b, task } = await prepare();
    await profiles.update(b.id, { expectedVersion: b.version, capabilityIds: [], preferences: { priority: 100 } });
    const rows = rankCompanionCandidates(task, (await profiles.list()).profiles, []);
    expect(rows[0]).toMatchObject({ profileId: a.id, localAssignmentEligible: true, executionEligible: false });
    expect(rows[1]).toMatchObject({ profileId: b.id, localAssignmentEligible: false, executionEligible: false, missingCapabilityIds: ['research'] });
  }, 20_000);
});
