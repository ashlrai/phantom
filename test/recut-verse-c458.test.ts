// Recut #6289 on current master: exercise the real route handler without sockets.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
const send = vi.hoisted(() => vi.fn());
vi.mock('../src/core/web/api.js', () => ({ sendJson: send }));
import { createFleetTeammateTasksApi } from '../src/core/verse/fleet-teammate-tasks-api.js';

type Report = Awaited<ReturnType<NonNullable<Parameters<typeof createFleetTeammateTasksApi>[0]>>>;
const path = '/api/verse/fleet/control/teammate-tasks';
afterEach(() => send.mockClear());
async function call(api: ReturnType<typeof createFleetTeammateTasksApi>, query = '') {
  expect(await api({} as VerseApiContext, { url: path + query } as IncomingMessage,
    {} as ServerResponse, path, 'GET')).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  const [, status, body] = send.mock.lastCall!;
  return { status, body };
}

it('awaits an asynchronous report while preserving active binding and privacy', async () => {
  const report: Report = {
    schema: 'imessage.teammate-tasks.v1', state: 'healthy', tasks: [{
      jobId: 'RQ-FAKE-C458', peer: 'dot', kind: 'report', repo: 'ashlrai/phantom', prRefs: [1],
      deadline: '2026-11-17T00:00:00.000Z', createdAt: Date.UTC(2026, 10, 16), state: 'pending',
      token: 'FAKE_TASK_TOKEN', scope: 'FAKE_PRIVATE_SCOPE', format: 'FAKE_PRIVATE_FORMAT',
      resource: 'imsg:dot', claimKey: 'queue:imsg.dot.RQ-FAKE-C458', metrics: [], settled: false,
      attemptedAt: Date.UTC(2026, 10, 16), result: null,
      receipt: { rowid: 1, sent: true, delivered: false, error: 0 },
    }],
  };
  const api = createFleetTeammateTasksApi(async () => report, undefined, (raw, filter) => {
    expect(raw).toBe(report);
    expect(filter).toEqual({ jobId: 'RQ-FAKE-C458' });
    return new Map([['RQ-FAKE-C458', { queueBinding: 'bound', queueClaim: 'active' }]]);
  });
  const response = await call(api, '?job=RQ-FAKE-C458');
  expect(response.status).toBe(200);
  const body = response.body;
  expect(body).toMatchObject({ matched: true, counts: { pending: 1 }, rows: [{
    jobId: 'RQ-FAKE-C458', workState: 'TRANSPORT_CONFIRMED', queueBinding: 'bound',
    queueClaim: 'active', executionVerified: false,
  }] });
  expect(body.rows).toHaveLength(1);
  for (const field of ['token', 'scope', 'format', 'receipt', 'claimKey', 'result', 'metrics', 'resource']) {
    expect(body.rows[0]).not.toHaveProperty(field);
  }
});

it('returns a generic 503 for an asynchronously rejected reader without binding', async () => {
  let bindingCalls = 0;
  const api = createFleetTeammateTasksApi(async () => {
    throw new Error('FAKE_PRIVATE_DIAGNOSTIC');
  }, undefined, () => { bindingCalls++; return new Map(); });
  const response = await call(api);
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ error: 'teammate tasks unavailable' });
  expect(bindingCalls).toBe(0);
});
