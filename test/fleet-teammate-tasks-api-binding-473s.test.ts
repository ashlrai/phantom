import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const sendJson = vi.hoisted(() => vi.fn());
vi.mock('../src/core/web/api.js', () => ({ sendJson }));
import { defaultConfig } from '../src/core/config.js';
import { enqueueTeammateTask } from '../src/core/comms/imessage-teammate-tasks.js';
import { imessageStateDir } from '../src/core/integrations/imessage.js';
import { createFleetTeammateTasksApi, projectTeammateTasks, type TeammateBindings } from '../src/core/verse/fleet-teammate-tasks-api.js';

const PATH = '/api/verse/fleet/control/teammate-tasks';
const PRIVATE = { scope: 'FAKE_PRIVATE_SCOPE_473', summary: 'FAKE_PRIVATE_SUMMARY_473' };
const call = async (api: ReturnType<typeof createFleetTeammateTasksApi>, query = '') => {
  sendJson.mockClear();
  expect(await api({} as VerseApiContext, { url: PATH + query } as IncomingMessage, {} as ServerResponse, PATH, 'GET')).toBe(true);
  return { status: sendJson.mock.lastCall?.[1] as number, body: sendJson.mock.lastCall?.[2] };
};
type Row = { jobId: string; workState: string; queueBinding: string; queueClaim: string | null; executionVerified: boolean };
const rowsOf = (body: { rows: Row[] }) => Object.fromEntries(body.rows.map(r => [r.jobId, r]));

let root: string; let previous: string | undefined;
const ledgerFile = () => join(imessageStateDir(root), 'teammate-tasks.json');
const queueFile = () => join(root, 'queue', 'queue.v1.json');
const editJson = (file: string, edit: (doc: any) => void) => { const doc = JSON.parse(readFileSync(file, 'utf8')); edit(doc); writeFileSync(file, JSON.stringify(doc)); };

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'teamtasks-binding-473-'));
  previous = process.env['ASHLR_RUNS_DIR']; process.env['ASHLR_RUNS_DIR'] = root;
  const send = vi.fn(() => { throw new Error('no real dispatch'); });
  for (const jobId of ['FAKE-473-BOUND', 'FAKE-473-CONFLICT', 'FAKE-473-MISSING', 'FAKE-473-PENDING', 'FAKE-473-FINISHED']) {
    await enqueueTeammateTask({ jobId, peer: 'dot', kind: 'research', scope: PRIVATE.scope, repo: 'fixture/example',
      format: 'Fake refs', deadline: '2099-01-01T00:00:00Z' }, defaultConfig(), { runsDir: root, apply: true, approved: () => 'fake@example.test', send });
  }
  expect(send).not.toHaveBeenCalled();
  editJson(queueFile(), doc => {
    doc.jobs.find((j: any) => j.id === 'FAKE-473-CONFLICT').scope = 'different scope';
    doc.jobs = doc.jobs.filter((j: any) => j.id !== 'FAKE-473-MISSING');
    const done = doc.jobs.find((j: any) => j.id === 'FAKE-473-FINISHED');
    done.status = 'DONE'; done.claims.at(-1).finishedAt = new Date().toISOString();
  });
  editJson(ledgerFile(), doc => {
    for (const t of doc.tasks) {
      if (t.jobId === 'FAKE-473-PENDING') { t.state = 'pending'; t.attemptedAt = 1; t.receipt = { rowid: 1, sent: true, delivered: false, error: 0 }; }
      if (t.jobId === 'FAKE-473-FINISHED') { t.state = 'replied'; t.attemptedAt = 1; t.receipt = { rowid: 1, sent: true, delivered: true, error: 0 }; t.result = { rowid: 2, status: 'DONE', summary: PRIVATE.summary, at: 2 }; }
    }
  });
});
afterEach(() => {
  if (previous === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = previous;
  rmSync(root, { recursive: true, force: true });
});

it('projects persisted queue binding evidence through the GET handler', async () => {
  const ledger = readFileSync(ledgerFile(), 'utf8'); const queue = readFileSync(queueFile(), 'utf8');
  const { status, body } = await call(createFleetTeammateTasksApi());
  expect(status).toBe(200);
  const rows = rowsOf(body);
  expect(rows['FAKE-473-BOUND']).toMatchObject({ workState: 'ASSIGNED', queueBinding: 'bound', queueClaim: 'active', executionVerified: false });
  expect(rows['FAKE-473-CONFLICT']).toMatchObject({ workState: 'UNCONFIRMED', queueBinding: 'conflicting', queueClaim: null });
  expect(rows['FAKE-473-MISSING']).toMatchObject({ workState: 'UNCONFIRMED', queueBinding: 'missing', queueClaim: null });
  // A send receipt is transport evidence only: never RUNNING.
  expect(rows['FAKE-473-PENDING']).toMatchObject({ workState: 'TRANSPORT_CONFIRMED', queueBinding: 'bound', queueClaim: 'active', executionVerified: false });
  expect(rows['FAKE-473-FINISHED']).toMatchObject({ workState: 'REPORTED_DONE', queueBinding: 'bound', queueClaim: 'finished' });
  expect(body.rows).toHaveLength(5);
  expect(body.counts).toMatchObject({ queued: 3, pending: 1, replied: 1 });
  const out = JSON.stringify(body);
  for (const v of [PRIVATE.scope, PRIVATE.summary, root, 'token', 'claimKey', 'imsg:', 'queue:imsg', 'receipt', 'VERIFIED', 'RUNNING',
    ...JSON.parse(ledger).tasks.map((t: { token: string }) => t.token)]) expect(out).not.toContain(v);
  expect(readFileSync(ledgerFile(), 'utf8')).toBe(ledger); expect(readFileSync(queueFile(), 'utf8')).toBe(queue);
});

it('keeps exact selection and sibling isolation', async () => {
  const bound = await call(createFleetTeammateTasksApi(), '?job=FAKE-473-BOUND');
  expect(bound.body.rows.map((r: Row) => [r.jobId, r.workState])).toEqual([['FAKE-473-BOUND', 'ASSIGNED']]);
  expect(bound.body).toMatchObject({ selection: { jobId: 'FAKE-473-BOUND' }, matched: true });
  const conflict = await call(createFleetTeammateTasksApi(), '?job=FAKE-473-CONFLICT');
  expect(conflict.body.rows.map((r: Row) => [r.jobId, r.queueBinding])).toEqual([['FAKE-473-CONFLICT', 'conflicting']]);
  const none = await call(createFleetTeammateTasksApi(), '?job=FAKE-473');
  expect(none.body).toMatchObject({ matched: false, rows: [] });
});

it('reports unavailable binding for every row, never dropping tasks, when the queue is unreadable', async () => {
  writeFileSync(queueFile(), '{invalid');
  const { status, body } = await call(createFleetTeammateTasksApi());
  expect(status).toBe(200);
  expect(body.rows).toHaveLength(5);
  for (const r of body.rows as Row[]) if (['FAKE-473-BOUND', 'FAKE-473-PENDING'].includes(r.jobId)) expect(r).toMatchObject({ workState: 'UNCONFIRMED', queueBinding: 'unavailable', queueClaim: null });
});

it('degrades to unavailable when an injected binding reader throws or omits a job', async () => {
  for (const bind of [() => { throw new Error('private diagnostic'); }, async () => new Map() as TeammateBindings]) {
    const { status, body } = await call(createFleetTeammateTasksApi(undefined, undefined, bind));
    expect(status).toBe(200);
    expect(rowsOf(body)['FAKE-473-BOUND']).toMatchObject({ workState: 'UNCONFIRMED', queueBinding: 'unavailable' });
    expect(JSON.stringify(body)).not.toContain('private diagnostic');
  }
});

it('keeps the legacy label-only projection when no binding evidence is supplied', () => {
  const raw = { schema: 's', state: 'healthy', tasks: [{ jobId: 'J', peer: 'dot', kind: 'k', repo: 'r', prRefs: [], deadline: 'd', createdAt: 1, state: 'queued' }] };
  const row = projectTeammateTasks(raw as never, 'now').rows[0]!;
  expect(row.workState).toBe('ASSIGNED'); expect(row).not.toHaveProperty('queueBinding');
});
