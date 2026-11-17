// Recovered from #6194; expectations retain master's newer privacy and state contract.
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
  token: 'FAKE_TASK_TOKEN', scope: 'FAKE_PRIVATE_SCOPE',
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

it('projects durable work states, counts all tasks, and caps unsorted rows at the newest 50', async () => {
  const tasks = Array.from({ length: 55 }, (_, i) => task(i, 'queued'));
  tasks.push(task(55, 'sending'), task(56, 'pending'), task(57, 'replied'),
    task(58, 'replied', 'BLOCKED'), task(59, 'replied', 'FAILED'), task(60, 'expired'), task(61, 'cancelled'));
  // Master's binding seam: an empty evidence map degrades every row to an unavailable, unconfirmed state.
  const api = createFleetTeammateTasksApi(() => report([...tasks.slice(15), ...tasks.slice(0, 15)]), undefined, () => new Map());
  expect(await call(api, '/unrelated')).toBe(false);
  expect(send).not.toHaveBeenCalled();
  expect(await call(api)).toBe(true);
  const [, status, body] = send.mock.lastCall!;
  expect(status).toBe(200);
  expect(body.schema).toBe('imessage.teammate-tasks.v1');
  expect(new Date(body.asOf).toISOString()).toBe(body.asOf);
  expect(body.counts).toEqual({ queued: 55, sending: 1, pending: 1, replied: 3, expired: 1, cancelled: 1 });
  expect(body.truncated).toBe(true);
  expect(body.rows.map((row: { jobId: string }) => row.jobId)).toEqual(Array.from({ length: 50 }, (_, i) => `RQ-FAKE-${61 - i}`));
  const byId = (i: number) => body.rows.find((row: { jobId: string }) => row.jobId === `RQ-FAKE-${i}`);
  expect([61, 60, 59, 58, 57, 56, 55, 54].map(i => byId(i).workState))
    .toEqual(['CANCELLED', 'UNKNOWN', 'BLOCKED', 'BLOCKED', 'REPORTED_DONE', 'UNCONFIRMED', 'UNCONFIRMED', 'UNCONFIRMED']);
  expect(byId(57)).toEqual({
    jobId: 'RQ-FAKE-57', peer: 'dot', kind: 'report', repo: 'ashlrai/phantom', prRefs: [1],
    workState: 'REPORTED_DONE', deadline: '2026-11-16T00:00:00.000Z',
    createdAt: new Date(epoch + 57).toISOString(),
    queueBinding: 'unavailable', queueClaim: null, executionVerified: false,
  });
  expect(byId(56).workState).toBe('UNCONFIRMED');
  expect(byId(54).workState).toBe('UNCONFIRMED');
  const json = JSON.stringify(body);
  for (const value of Object.values(privateFields)) expect(json).not.toContain(value);
  for (const row of body.rows) expect(Object.keys(row).sort()).toEqual([
    'jobId', 'peer', 'kind', 'repo', 'prRefs', 'workState', 'deadline', 'createdAt',
    'queueBinding', 'queueClaim', 'executionVerified',
  ].sort());
});

it('rejects POST and unsupported query keys without reading', async () => {
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
