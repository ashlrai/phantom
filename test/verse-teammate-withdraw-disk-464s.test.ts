/**
 * RQ-PHX-WITHDRAWAPIDISK464S: disk-backed qualification of desktop teammate-task
 * withdrawal. The verse withdraw edge runs the REAL enqueueTeammateTask /
 * cancelTeammateTask pair against a temporary runsDir — only native transport
 * and config I/O (send/reconcile/approved) is stubbed, and send is asserted
 * never called. No iMessage send, token lookup, external API or live HOME.
 * Complements fleet-teammate-task-withdraw-api-457c.test.ts, which injects
 * vi.fn cancellation results; this suite proves the receipt corresponds to a
 * withdrawn local reservation on disk.
 */
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import { defaultConfig } from '../src/core/config.js';
import { cancelTeammateTask, enqueueTeammateTask, listTeammateTasks, runTeammateTasks } from '../src/core/comms/imessage-teammate-tasks.js';
import { createFleetTeammateTaskWithdrawApi, VERSE_FLEET_TEAMMATE_TASK_WITHDRAW_PATH as PATH } from '../src/core/verse/fleet-teammate-task-withdraw-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import { QueueStore } from '../src/core/queue/store.js';

const CLOCK = Date.parse('2026-11-16T12:00:00Z');
const now = () => CLOCK;
const TOKEN = 'fixture-token-464s';
const input = {
  jobId: 'RQ-WITHDRAW-DISK-464S', peer: 'dot', kind: 'research',
  scope: 'Fixture scope for disk-backed withdrawal 464s', repo: 'fixture/example',
  format: 'Fixture format 464s', deadline: '2099-01-01T00:00:00Z',
} as const;

let runsDir: string;
let cfg: AshlrConfig;

const ledger = () => join(runsDir, 'imessage', 'teammate-tasks.json');
const queue = () => new QueueStore(join(runsDir, 'queue'));
const bytes = () => [readFileSync(ledger(), 'utf8'), readFileSync(queue().path, 'utf8')];
const tasks = () => listTeammateTasks({ runsDir, now }).tasks;
const queueJob = async (jobId = input.jobId) => (await queue().read()).jobs.find(job => job.id === jobId);

/** The only injection: bind the real cancelTeammateTask to this temporary root. */
const withdrawApi = (): ApiModule => createFleetTeammateTaskWithdrawApi(
  (jobId, opts) => cancelTeammateTask(jobId, { ...opts, runsDir, now }));

async function call(api: ApiModule, method: string, body?: unknown, opts: { token?: string; allowDispatch?: boolean } = {}) {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method, url: PATH, headers: { 'content-type': 'application/json', 'x-ashlr-token': opts.token ?? TOKEN } });
  req.end(body === undefined ? undefined : JSON.stringify(body));
  let status = 0, payload = '';
  const res = {
    setHeader() {},
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const ctx = { token: TOKEN, allowDispatch: opts.allowDispatch ?? true } as VerseApiContext;
  const handled = await api(ctx, req, res, PATH, method);
  return { handled, status, body: payload ? JSON.parse(payload) as Record<string, unknown> : null };
}

beforeEach(async () => {
  runsDir = mkdtempSync(join(tmpdir(), 'teammate-withdraw-disk-464s-'));
  vi.stubEnv('HOME', runsDir);
  vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
  vi.stubEnv('PHANTOM_STACKSYNC', 'off');
  cfg = defaultConfig();
  const result = await enqueueTeammateTask(input, cfg, { runsDir, apply: true, now, approved: () => 'fixture-peer-464s' });
  expect(result.state).toBe('queued');
  expect((await queue().read()).jobs).toHaveLength(1);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(runsDir, { recursive: true, force: true }); });

it('authorized POST returns the bounded cancelled receipt and a fresh persisted read proves the claim released', async () => {
  const api = withdrawApi();
  const r = await call(api, 'POST', { jobId: input.jobId });
  expect(r.handled).toBe(true);
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ v: 1, jobId: input.jobId, state: 'cancelled' });
  // Fresh persisted reads: the ledger tombstone and the released queue claim.
  expect(tasks()).toEqual([expect.objectContaining({ jobId: input.jobId, state: 'cancelled', result: null })]);
  expect(await queueJob()).toMatchObject({
    status: 'BLOCKED',
    blockedReason: 'Operator withdrew unsent teammate task',
    claims: [{ owner: 'imsg:dot', finishedAt: expect.any(String) }],
  });
  // A subsequent drain cannot send the cancelled job; native send is never reached.
  const send = vi.fn(async (): Promise<'accepted' | 'uncertain' | 'refused'> => 'accepted');
  const reconcile = vi.fn(async () => null);
  const report = await runTeammateTasks(cfg, { runsDir, apply: true, now, approved: () => 'fixture-peer-464s', send, reconcile });
  expect(send).not.toHaveBeenCalled();
  expect(reconcile).not.toHaveBeenCalled();
  expect(report.sent).toBe(0);
  expect(tasks()[0]!.state).toBe('cancelled');
  expect(await queueJob()).toMatchObject({ status: 'BLOCKED' });
});

it('a repeated request and a fresh API instance stay safe without further writes', async () => {
  const api = withdrawApi();
  expect((await call(api, 'POST', { jobId: input.jobId })).body).toEqual({ v: 1, jobId: input.jobId, state: 'cancelled' });
  const settled = bytes();
  const again = await call(api, 'POST', { jobId: input.jobId });
  expect(again.status).toBe(200);
  expect(again.body).toEqual({ v: 1, jobId: input.jobId, state: 'cancelled' });
  // Simulated restart: a new module instance has no in-memory in-flight state.
  const restarted = await call(withdrawApi(), 'POST', { jobId: input.jobId });
  expect(restarted.status).toBe(200);
  expect(restarted.body).toEqual({ v: 1, jobId: input.jobId, state: 'cancelled' });
  expect(bytes()).toEqual(settled);
  expect((await queue().read()).jobs).toHaveLength(1);
});

it('unauthorized and dispatch-disabled POSTs leave ledger and queue byte-for-byte unchanged', async () => {
  const api = withdrawApi();
  const before = bytes();
  const noToken = await call(api, 'POST', { jobId: input.jobId }, { token: '' });
  expect(noToken.status).toBe(401);
  const wrongToken = await call(api, 'POST', { jobId: input.jobId }, { token: 'other-token' });
  expect(wrongToken.status).toBe(401);
  const disabled = await call(api, 'POST', { jobId: input.jobId }, { allowDispatch: false });
  expect(disabled.status).toBe(404);
  expect(bytes()).toEqual(before);
  expect(tasks()[0]!.state).toBe('queued');
  const job = await queueJob();
  expect(job).toMatchObject({ status: 'CLAIMED', claims: [{ owner: 'imsg:dot' }] });
  expect(job!.claims[0]!.finishedAt).toBeUndefined();
});

it('a task with persisted sent evidence is refused and preserves claim and ledger', async () => {
  // Same hermetic ledger-seeding convention as fleet-teammate-withdraw-persisted-462s.
  const store = JSON.parse(readFileSync(ledger(), 'utf8')) as { tasks: Record<string, unknown>[] };
  Object.assign(store.tasks[0]!, { state: 'pending', attemptedAt: CLOCK - 1000,
    receipt: { rowid: 7, sent: true, delivered: true, error: 0 } });
  writeFileSync(ledger(), JSON.stringify(store));
  const before = bytes();
  const r = await call(withdrawApi(), 'POST', { jobId: input.jobId });
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ v: 1, jobId: input.jobId, state: 'refused',
    reason: 'Cancellation cannot prove a remote stop' });
  expect(bytes()).toEqual(before);
  // The claim stays active; no remote stop is implied by the refusal.
  const job = await queueJob();
  expect(job).toMatchObject({ status: 'CLAIMED', claims: [{ owner: 'imsg:dot' }] });
  expect(job!.claims[0]!.finishedAt).toBeUndefined();
  expect(tasks()[0]).toMatchObject({ state: 'pending', attemptedAt: CLOCK - 1000 });
});
