import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
const send = vi.hoisted(() => vi.fn());
vi.mock('../src/core/web/api.js', () => ({ sendJson: send }));
import { createFleetTeammateTasksApi } from '../src/core/verse/fleet-teammate-tasks-api.js';
import { listTeammateTasks } from '../src/core/comms/imessage-teammate-tasks.js';

type Report = ReturnType<typeof listTeammateTasks>;
type Task = Report['tasks'][number];
const path = '/api/verse/fleet/control/teammate-tasks';
const epoch = Date.UTC(2026, 10, 15);
const privateFields = {
  token: '0123456789abcdef0123456789abcdef', scope: 'FAKE_PRIVATE_SCOPE',
  format: 'FAKE_PRIVATE_FORMAT', summary: 'FAKE_PRIVATE_SUMMARY',
  handles: 'FAKE_PRIVATE_HANDLE', senderIds: 'FAKE_PRIVATE_SENDER',
};
function task(i: number, state: Task['state'], status: 'DONE' | 'BLOCKED' | 'FAILED' = 'DONE'): Task {
  const result = state === 'replied' ? { rowid: 2, status, at: epoch + i + 2, evidence: 'peer-reported', summary: privateFields.summary } : null;
  return {
    ...privateFields, jobId: `RQ-FAKE-${i}`, peer: i % 2 ? 'dot' : 'instinct', kind: 'report',
    repo: 'ashlrai/phantom', prRefs: [1], deadline: '2026-11-16T00:00:00.000Z',
    createdAt: epoch + i, state, metrics: [], settled: false,
    resource: 'imsg:dot', claimKey: `queue:imsg.dot.RQ-FAKE-${i}`,
    ...(state === 'sending' || state === 'pending' || state === 'replied' ? { attemptedAt: epoch + i + 1 } : {}),
    ...(state === 'pending' || state === 'replied' ? { receipt: { rowid: 1, sent: true, delivered: false, error: 0 } } : {}),
    result,
  };
}
const report = (tasks: Task[]): Report => ({ schema: 'imessage.teammate-tasks.v1', state: 'healthy', tasks });
const call = (api: ReturnType<typeof createFleetTeammateTasksApi>, url = path, method = 'GET') =>
  api({} as VerseApiContext, { url } as IncomingMessage, {} as ServerResponse, url.split('?')[0]!, method);

beforeEach(() => send.mockClear());
afterEach(() => vi.useRealTimers());

it('projects durable work states, counts all tasks, and caps unsorted rows at the newest 30', async () => {
  const tasks = Array.from({ length: 25 }, (_, i) => task(i, 'queued'));
  tasks.push(task(25, 'sending'), task(26, 'pending'), task(27, 'replied'),
    task(28, 'replied', 'BLOCKED'), task(29, 'replied', 'FAILED'), task(30, 'expired'), task(31, 'cancelled'));
  const api = createFleetTeammateTasksApi(() => report([...tasks.slice(15), ...tasks.slice(0, 15)]));
  expect(await call(api, '/unrelated')).toBe(false);
  expect(send).not.toHaveBeenCalled();
  expect(await call(api)).toBe(true);
  const [, status, body] = send.mock.lastCall!;
  expect(status).toBe(200);
  expect(body.schema).toBe('imessage.teammate-tasks.v1');
  expect(new Date(body.asOf).toISOString()).toBe(body.asOf);
  expect(body.counts).toEqual({ queued: 25, sending: 1, pending: 1, replied: 3, expired: 1, cancelled: 1 });
  expect(body.truncated).toBe(true);
  expect(body.rows.map((row: { jobId: string }) => row.jobId)).toEqual(Array.from({ length: 30 }, (_, i) => `RQ-FAKE-${31 - i}`));
  const byId = (i: number) => body.rows.find((row: { jobId: string }) => row.jobId === `RQ-FAKE-${i}`);
  expect([31, 30, 29, 28, 27, 26, 25, 24].map(i => byId(i).workState))
    .toEqual(['CANCELLED', 'BLOCKED', 'BLOCKED', 'BLOCKED', 'REPORTED_DONE', 'RUNNING', 'ASSIGNED', 'RECEIVED']);
  expect(byId(27)).toEqual({
    jobId: 'RQ-FAKE-27', peer: 'dot', kind: 'report', repo: 'ashlrai/phantom', prRefs: [1],
    state: 'replied', workState: 'REPORTED_DONE', deadline: '2026-11-16T00:00:00.000Z',
    createdAt: new Date(epoch + 27).toISOString(), attemptedAt: new Date(epoch + 28).toISOString(),
    receiptSent: true, resultStatus: 'DONE', resultAt: new Date(epoch + 29).toISOString(), evidence: 'peer-reported',
  });
  expect(byId(26).evidence).toBe('transport-receipt');
  expect(byId(24)).toMatchObject({ attemptedAt: null, receiptSent: null, resultStatus: null, resultAt: null, evidence: 'none' });
  const json = JSON.stringify(body);
  for (const value of Object.values(privateFields)) expect(json).not.toContain(value);
  for (const row of body.rows) expect(Object.keys(row).sort()).toEqual([
    'jobId', 'peer', 'kind', 'repo', 'prRefs', 'state', 'workState', 'deadline', 'createdAt',
    'attemptedAt', 'receiptSent', 'resultStatus', 'resultAt', 'evidence',
  ].sort());
});

it('rejects POST and every query key without reading', async () => {
  const read = vi.fn(() => report([])), api = createFleetTeammateTasksApi(read);
  await call(api, path, 'POST');
  expect(send.mock.lastCall![1]).toBe(405);
  await call(api, `${path}?x=1`);
  expect(send.mock.lastCall![1]).toBe(400);
  expect(read).not.toHaveBeenCalled();
});

it('returns only the generic 503 error when the reader throws', async () => {
  await call(createFleetTeammateTasksApi(() => { throw new Error('FAKE_PRIVATE_FAILURE'); }));
  expect(send.mock.lastCall!.slice(1)).toEqual([503, { error: 'teammate tasks unavailable' }]);
});

it('returns 503 after a five second read timeout', async () => {
  vi.useFakeTimers();
  const pending = call(createFleetTeammateTasksApi(() => new Promise<Report>(() => {})));
  await vi.advanceTimersByTimeAsync(5_001);
  await pending;
  expect(send.mock.lastCall!.slice(1)).toEqual([503, { error: 'teammate tasks unavailable' }]);
  expect(vi.getTimerCount()).toBe(0);
});

it('serves a missing real store as empty without creating files', async () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'teammate-tasks-api-'));
  try {
    await call(createFleetTeammateTasksApi(() => listTeammateTasks({ runsDir })));
    expect(send.mock.lastCall![1]).toBe(200);
    expect(send.mock.lastCall![2]).toMatchObject({
      counts: { queued: 0, sending: 0, pending: 0, replied: 0, expired: 0, cancelled: 0 }, rows: [], truncated: false,
    });
    expect(readdirSync(runsDir)).toEqual([]);
  } finally { rmSync(runsDir, { recursive: true, force: true }); }
});
