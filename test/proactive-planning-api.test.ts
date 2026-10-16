/** Request/response checks without a server, account collector or provider. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { createProactivePlanningApi, PROACTIVE_PLANNING_PATH } from '../src/core/verse/proactive-planning-api.js';
import { createProactiveCoordinationApi, PROACTIVE_COORDINATION_PATH } from '../src/core/verse/proactive-coordination-api.js';
import { createProactiveProfilesStore } from '../src/core/proactive/profiles.js';
import { createCompanionCoordinator } from '../src/core/proactive/coordination.js';
import { projectCompanionWire, decodeCompanionWire } from '../src/core/proactive/coordination-wire.js';
import { projectProactiveResourceEvidence } from '../src/core/proactive/resource-evidence.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { RoutingLab } from '../src/core/proactive/routing-lab-types.js';
let root: string;
const NOW = new Date('2026-10-12T20:00:00Z');
beforeEach(async () => { root = await mkdtemp(join(realpathSync(tmpdir()), 'planning-api-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function setup(extra: Parameters<typeof createProactivePlanningApi>[0] = {}) {
  const profiles = createProactiveProfilesStore({ directory: () => join(root, 'profiles') });
  const coordinator = createCompanionCoordinator({ directory: join(root, 'coordination'), now: () => NOW });
  const common = { profiles: () => profiles, coordinator: () => coordinator, packetRoot: () => root, now: () => NOW };
  return { profiles, coordinator, api: createProactivePlanningApi({ ...common, labRoot: () => join(root, 'lab'), ...extra }),
    coordinationApi: createProactiveCoordinationApi(common) };
}
async function request(api: ApiModule, body?: unknown, options: { path?: string; method?: string; token?: string; allowDispatch?: boolean; raw?: string; aborted?: boolean } = {}) {
  const path = options.path ?? PROACTIVE_PLANNING_PATH;
  const req = Readable.from([options.raw ?? JSON.stringify(projectCompanionWire(body ?? {}))]) as unknown as IncomingMessage;
  req.url = path; req.headers = { 'content-type': 'application/json', 'x-ashlr-token': options.token ?? 'operator-test' };
  Object.defineProperty(req, 'aborted', { value: options.aborted ?? false });
  let status = 0; let wire: any;
  const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false,
    writeHead(code: number) { status = code; this.headersSent = true; }, end(text: string) { wire = JSON.parse(text); } }) as unknown as ServerResponse;
  const ctx = { token: 'operator-test', allowDispatch: options.allowDispatch ?? true } as VerseApiContext;
  const handled = await api(ctx, req, res, path.split('?')[0]!, options.method ?? 'POST');
  return { status, handled, wire, body: decodeCompanionWire(wire) as any };
}
describe('local planning API', () => {
  it('lists receipts without collecting resources and shows missing release target honestly', async () => {
    const resources = vi.fn(() => { throw new Error('must not collect'); });
    const { api } = setup({ resources });
    expect((await request(api, undefined, { method: 'GET' })).body).toMatchObject({ revision: 0, evaluations: [], executionAuthorized: false });
    expect((await request(api, undefined, { method: 'GET', path: `${PROACTIVE_PLANNING_PATH}/release` })).body)
      .toMatchObject({ sourceState: 'missing', readiness: null, releaseAuthorized: false });
    expect(resources).not.toHaveBeenCalled();
  });
  it('projects saved provider-neutral declarations without implying verified access or money', async () => {
    const { api, profiles } = setup();
    await profiles.create({ identity: { provider: 'independent-engine', accountId: 'a', agentId: 'agent' }, displayName: 'Research', capabilityIds: ['research'] });
    const result = await request(api, undefined, { method: 'GET', path: `${PROACTIVE_PLANNING_PATH}/resources` });
    expect(result.status).toBe(200);
    expect(result.body.resources[0]).toMatchObject({ identityState: 'declared', entitlementState: 'unknown', cost: { state: 'unknown' }, executionAuthorized: false });
  });
  it('guards local writes and refuses caller-provided release evidence or task scope', async () => {
    const { api } = setup();
    expect((await request(api, {}, { token: 'wrong' })).status).toBe(401);
    expect((await request(api, {}, { allowDispatch: false })).status).toBe(404);
    expect((await request(api, {}, { raw: '{invalid' })).status).toBe(400);
    expect((await request(api, {}, { path: `${PROACTIVE_PLANNING_PATH}?refresh=1` })).status).toBe(400);
    expect((await request(api, {}, { path: `${PROACTIVE_PLANNING_PATH}/release` })).status).toBe(404);
    expect((await request(api, { kind: 'preview', requestId: 'forged', expectedRevision: 0, taskId: 'missing', task: { tenantId: 'other' } })).status).toBe(400);
    expect((await request(api, { kind: 'preview', requestId: 'missing', expectedRevision: 0, taskId: 'missing' })).status).toBe(409);
  });
  it('records one offline benchmark and returns exact retries before reading resource evidence', async () => {
    const resources = vi.fn(() => { throw new Error('must not collect'); });
    const { api } = setup({ resources });
    const command = { kind: 'benchmark', requestId: 'benchmark-once', expectedRevision: 0 };
    const first = await request(api, command); expect(first.status).toBe(200);
    expect(first.body.evaluation).toMatchObject({ mode: 'fixture', executionAuthorized: false, providerLatencyMs: null });
    expect(first.wire.evaluation.snapshotDigest).toMatch(/^sha256:/);
    const again = await request(api, command); expect(again.status).toBe(200); expect(again.body.disposition).toBe('replayed');
    const listing = await request(api, undefined, { method: 'GET' }); expect(listing.body.evaluations).toHaveLength(1);
    expect(resources).not.toHaveBeenCalled();
  });
  it('derives a shadow task from the exact local brief and keeps held results replayable after cache failure', async () => {
    const resources = vi.fn(() => projectProactiveResourceEvidence({}, { nowMs: NOW.getTime() }));
    const { api, coordinationApi, profiles } = setup({ resources });
    const profile = await profiles.create({ identity: { provider: 'custom', accountId: 'a', agentId: 'agent' }, displayName: 'Agent', capabilityIds: ['research'] });
    const task = { tenantId: 'tenant', projectBindingId: 'project', taskKey: 'research', goal: 'Review a brief.', acceptance: ['Cite evidence.'], capabilityIds: ['research'] };
    const packet = await request(coordinationApi, { ...task, profileId: profile.id }, { path: `${PROACTIVE_COORDINATION_PATH}/packet` });
    expect(packet.status).toBe(200);
    const created = await request(coordinationApi, { kind: 'create', commandId: 'create', expectedRevision: 0, task: { ...task, packetDigest: packet.body.packetDigest } }, { path: PROACTIVE_COORDINATION_PATH });
    expect(created.status).toBe(200);
    const command = { kind: 'preview', requestId: 'shadow-once', expectedRevision: 0, taskId: created.body.task.id };
    const first = await request(api, command); expect(first.status).toBe(200);
    expect(first.body.evaluation).toMatchObject({ mode: 'shadow-readonly', executionAuthorized: false, adapterMode: 'deterministic-only' });
    await rm(join(root, 'companion-packets'), { recursive: true, force: true });
    resources.mockImplementation(() => { throw new Error('cache unavailable'); });
    const again = await request(api, command); expect(again.status).toBe(200); expect(again.body.disposition).toBe('replayed');
    expect(resources).toHaveBeenCalledTimes(1);
  });
  it('passes disconnection through an AbortSignal without authorizing any effect', async () => {
    let observed: AbortSignal | undefined;
    const lab: RoutingLab = { list: vi.fn(), replay: () => null, execute: async (_command, options) => {
      observed = options?.signal;
      return { ok: false, reason: 'held', executionAuthorized: false };
    } };
    const { api } = setup({ lab: () => lab });
    const result = await request(api, { kind: 'benchmark', requestId: 'abortable', expectedRevision: 0 }, { aborted: true });
    expect(observed).toBeInstanceOf(AbortSignal); expect(observed?.aborted).toBe(true);
    expect(result.body.executionAuthorized).toBe(false);
  });
});
