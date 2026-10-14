/** Local synthetic fixture integration; no listener/provider/native session or actual user state. */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProactiveCoordinationApi, PROACTIVE_COORDINATION_PATH } from '../src/core/verse/proactive-coordination-api.js';
import { createProactiveProfilesStore, type ProactiveProfilesStore } from '../src/core/proactive/profiles.js';
import { createCompanionCoordinator } from '../src/core/proactive/coordination.js';
import type { CompanionCoordinator, CompanionTask } from '../src/core/proactive/coordination-types.js';
import { decodeCompanionWire, projectCompanionWire } from '../src/core/proactive/coordination-wire.js';
import type { GrokHandoffPreviewRequest, GrokHandoffPreviewResponse } from '../src/core/proactive/handoff-preview-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

let root: string, profiles: ProactiveProfilesStore, coordinator: CompanionCoordinator;
const NOW = new Date('2026-10-15T00:00:00.000Z');
const PATH = `${PROACTIVE_COORDINATION_PATH}/handoff-preview`;
beforeEach(async () => {
  root = await mkdtemp(join(realpathSync(tmpdir()), 'grok-handoff-test-'));
  profiles = createProactiveProfilesStore({ directory: () => join(root, 'profiles'), now: () => NOW });
  coordinator = createCompanionCoordinator({ directory: join(root, 'coordination'), now: () => NOW });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function request(body: unknown, options: { path?: string; method?: string; token?: string; allowDispatch?: boolean; raw?: string;
  host?: CompanionCoordinator; store?: ProactiveProfilesStore; now?: Date } = {}) {
  const path = options.path ?? PATH;
  const req = Readable.from([options.raw ?? JSON.stringify(projectCompanionWire(body))]) as unknown as IncomingMessage;
  req.url = path; req.headers = { 'content-type': 'application/json', 'x-ashlr-token': options.token ?? 'fixture-token' };
  let status = 0, wire: unknown;
  const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; },
    end(text: string) { wire = JSON.parse(text); } } as unknown as ServerResponse;
  const api = createProactiveCoordinationApi({ coordinator: () => options.host ?? coordinator, profiles: () => options.store ?? profiles,
    packetRoot: () => root, now: () => options.now ?? NOW });
  const handled = await api({ token: 'fixture-token', allowDispatch: options.allowDispatch ?? true } as VerseApiContext,
    req, res, path.split('?')[0]!, options.method ?? 'POST');
  return { handled, status, wire, body: decodeCompanionWire(wire) as GrokHandoffPreviewResponse };
}
async function prepare(handoff = true, goal = 'Review the public specification.') {
  const profile = await profiles.create({ identity: { provider: 'grok-bot', accountId: 'fixture-account', agentId: 'fixture-bot' },
    displayName: 'Fixture Bot', capabilityIds: ['review'], preferences: { projectBindingIds: ['fixture-project'] } });
  const task = { tenantId: 'fixture-tenant', projectBindingId: 'fixture-project', taskKey: 'review', goal,
    acceptance: ['Return cited findings.'], capabilityIds: ['review'], deadline: '2026-10-15T01:00:00.000Z', maxCostUsd: 0, maxAttempts: 1 };
  const packet = await request({ ...task, profileId: profile.id }, { path: `${PROACTIVE_COORDINATION_PATH}/packet` });
  expect(packet.status).toBe(200);
  const created = coordinator.execute({ kind: 'create', commandId: 'create', expectedRevision: 0, task: { ...task, packetDigest: packet.body.packetDigest } });
  expect(created.ok).toBe(true); if (!created.ok) throw Error('Fixture creation failed');
  const assigned = coordinator.execute({ kind: 'assign', commandId: 'assign', expectedRevision: created.revision,
    taskId: created.taskId, assignee: profile.identity, ownerId: 'fixture-owner', leaseMs: 60_000 });
  expect(assigned.ok).toBe(true); if (!assigned.ok) throw Error('Fixture assignment failed');
  const attempt = assigned.task.attempts.at(-1)!;
  if (handoff) expect(coordinator.execute({ kind: 'handoff', commandId: 'intent', expectedRevision: assigned.revision,
    taskId: assigned.taskId, attemptId: attempt.id, epoch: attempt.epoch, ownerId: attempt.ownerId }).ok).toBe(true);
  const read = coordinator.read(assigned.taskId);
  const input: GrokHandoffPreviewRequest = { taskId: assigned.taskId, attemptId: attempt.id, epoch: attempt.epoch,
    expectedRevision: read.revision, profileId: profile.id, expectedProfileVersion: profile.version };
  return { profile, input, task: read.task as CompanionTask };
}
function files(directory = root): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const next = join(path, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) result[next.slice(root.length)] = createHash('sha256').update(readFileSync(next)).digest('hex');
    }
  }
  walk(directory); return result;
}
describe('read-only Grok Bot handoff preview API', () => {
  it('checks method/token/dispatch and exact body before reading source stores', async () => {
    const read = vi.spyOn(coordinator, 'read'), list = vi.spyOn(profiles, 'list'), execute = vi.spyOn(coordinator, 'execute');
    expect((await request({}, { token: 'wrong' })).status).toBe(401);
    expect((await request({}, { allowDispatch: false })).status).toBe(404);
    expect((await request({}, { method: 'GET' })).status).toBe(404);
    expect((await request({}, { method: 'DELETE' })).status).toBe(404);
    expect((await request({}, { path: PATH + '?scope=all' })).status).toBe(400);
    expect((await request({}, { raw: '{invalid' })).status).toBe(400);
    expect((await request({})).status).toBe(400);
    expect(read).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect(files()).toEqual({});
  });
  it('round-trips sanitized exact brief bytes and rechecks copying without mutating records or invoking execute', async () => {
    const { input } = await prepare(); const before = files(), ledger = coordinator.list();
    const execute = vi.spyOn(coordinator, 'execute'), replay = vi.spyOn(coordinator, 'replay'), reconcile = vi.spyOn(coordinator, 'reconcile');
    const result = await request(input);
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ taskId: input.taskId, attemptId: input.attemptId, epoch: input.epoch,
      revision: input.expectedRevision, profileId: input.profileId, profileVersion: input.expectedProfileVersion,
      dispatchAuthorized: false, contextShared: false, transport: 'manual-copy' });
    expect(result.body.previewDigest).toBe(createHash('sha256').update(result.body.briefText).digest('hex'));
    expect((result.wire as Record<string, unknown>).previewDigest).toMatch(/^sha256:/);
    expect(result.body.briefText).not.toContain('[REDACTED]'); expect(JSON.parse(result.body.briefText).goal).toBe('Review the public specification.');
    const copied = await request({ ...input, expectedPreviewDigest: result.body.previewDigest });
    expect(copied.status).toBe(200); expect(copied.body).toEqual(result.body);
    expect((await request({ ...input, expectedPreviewDigest: 'a'.repeat(64) })).status).toBe(409);
    expect(execute).not.toHaveBeenCalled(); expect(replay).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled();
    expect(coordinator.list()).toEqual(ledger); expect(files()).toEqual(before);
  });
  it('requires the durable handoff fence and holds stale bindings, expired lease and cancellation', async () => {
    const { input } = await prepare(false);
    expect((await request(input)).status).toBe(409);
    const attempt = coordinator.read(input.taskId).task!.attempts.at(-1)!;
    const intent = coordinator.execute({ kind: 'handoff', commandId: 'intent', expectedRevision: input.expectedRevision,
      taskId: input.taskId, attemptId: input.attemptId, epoch: input.epoch, ownerId: attempt.ownerId });
    expect(intent.ok).toBe(true); if (!intent.ok) throw Error('Fixture intent failed'); input.expectedRevision = intent.revision;
    for (const patch of [{ expectedRevision: 1 }, { epoch: 2 }, { attemptId: 'f'.repeat(64) }, { expectedProfileVersion: 2 }]) {
      expect((await request({ ...input, ...patch })).status).toBe(409);
    }
    expect((await request(input, { now: new Date(NOW.getTime() + 60_000) })).status).toBe(409);
    const canceled = coordinator.execute({ kind: 'cancel', commandId: 'cancel', expectedRevision: intent.revision,
      taskId: input.taskId, attemptId: input.attemptId });
    expect(canceled.ok).toBe(true); if (!canceled.ok) throw Error('Fixture cancel failed');
    expect((await request({ ...input, expectedRevision: canceled.revision })).status).toBe(409);
  });
  it('refuses a changed separate profile store during awaits and a changed ledger before response', async () => {
    const { input, profile } = await prepare(); const before = files(); let calls = 0;
    const changing = { ...profiles, list: vi.fn(async () => ({ schemaVersion: 1 as const,
      profiles: [{ ...profile, version: ++calls === 1 ? profile.version : profile.version + 1 }] })) };
    expect((await request(input, { store: changing })).status).toBe(409);
    const base = coordinator.read(input.taskId); let reads = 0;
    const host = { ...coordinator, read: vi.fn(() => ({ ...base, revision: ++reads === 1 ? base.revision : base.revision + 1 })) };
    expect((await request(input, { host })).status).toBe(409);
    expect(files()).toEqual(before);
  });
  it('does not turn missing/degraded source into empty success or include raw failure diagnostics', async () => {
    const { input } = await prepare();
    const unavailable = { ...coordinator, read: vi.fn(() => ({ sourceState: 'degraded' as const, revision: input.expectedRevision, task: null })) };
    expect((await request(input, { host: unavailable })).status).toBe(503);
    const throws = { ...profiles, list: vi.fn(async () => { throw Error('/Users/private/credential secret=not-for-output'); }) };
    const response = await request(input, { store: throws }); expect(response.status).toBe(503);
    expect(JSON.stringify(response.wire)).not.toContain('/Users/private'); expect(JSON.stringify(response.wire)).not.toContain('not-for-output');
  });
  it('refuses output transformed by the unchanged public sanitizer rather than returning an incorrect digest', async () => {
    const { input } = await prepare(true, 'Review fixture path ' + root + '/example.');
    vi.stubEnv('HOME', root);
    expect((await request(input)).status).toBe(409);
  });
});
