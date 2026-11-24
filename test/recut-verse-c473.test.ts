import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/core/web/api.js', () => ({ sendJson: send }));
import { createFleetTeammateTasksApi } from '../src/core/verse/fleet-teammate-tasks-api.js';

type Report = Awaited<ReturnType<NonNullable<Parameters<typeof createFleetTeammateTasksApi>[0]>>>;
const path = '/api/verse/fleet/control/teammate-tasks';
const call = (api: ReturnType<typeof createFleetTeammateTasksApi>, query = '') =>
  api({} as VerseApiContext, { url: path + query } as IncomingMessage, {} as ServerResponse, path, 'GET');
const empty = { schema: 'imessage.teammate-tasks.v1', state: 'healthy', tasks: [] } as const;

afterEach(() => { vi.useRealTimers(); send.mockClear(); });

it('awaits async readers while retaining the job selector and clearing the timeout', async () => {
  vi.useFakeTimers();
  const api = createFleetTeammateTasksApi(async () => ({ ...empty, tasks: [] }), () => new Date('2026-11-16T00:00:00Z'));
  expect(await call(api, '?job=RQ-FAKE-MISSING')).toBe(true);
  expect(send.mock.lastCall?.slice(1)).toEqual([200, {
    schema: empty.schema, asOf: '2026-11-16T00:00:00.000Z',
    counts: { queued: 0, sending: 0, pending: 0, replied: 0, expired: 0, cancelled: 0 },
    rows: [], truncated: false, selection: { jobId: 'RQ-FAKE-MISSING' }, matched: false,
  }]);
  expect(vi.getTimerCount()).toBe(0);
});

it('fails closed on async unavailable reports and rejections without leaking diagnostics', async () => {
  vi.useFakeTimers();
  for (const read of [
    async () => ({ ...empty, state: 'unavailable' as const, tasks: [] }),
    async () => { throw new Error('FAKE_PRIVATE_DIAGNOSTIC'); },
  ]) {
    await call(createFleetTeammateTasksApi(read));
    expect(send.mock.lastCall?.slice(1)).toEqual([503, { error: 'teammate tasks unavailable' }]);
    expect(vi.getTimerCount()).toBe(0);
  }
});

it('sends exactly one generic response when a timed-out reader later rejects', async () => {
  vi.useFakeTimers();
  let rejectRead!: (reason: Error) => void;
  const read = new Promise<Report>((_resolve, reject) => { rejectRead = reject; });
  const pending = call(createFleetTeammateTasksApi(() => read));
  await vi.advanceTimersByTimeAsync(5_000);
  await pending;
  expect(send.mock.calls.map(call => call.slice(1))).toEqual([[503, { error: 'teammate tasks unavailable' }]]);
  rejectRead(new Error('FAKE_LATE_FAILURE'));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(send).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
