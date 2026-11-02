import { expect, it, vi } from 'vitest';
import { runSelfTickNow, SELF_TICK_RUN_PATH } from './self-tick-run-now.js';

const RAN_OK = {
  v: 1, exitCode: 0,
  report: {
    v: 1, at: '2026-11-01T12:00:00Z', mode: 'apply', state: 'ran',
    steps: [
      { step: 'reset-release', state: 'ok', exitCode: 0, report: null },
      { step: 'lane-autohold', state: 'ok', exitCode: 0, report: null },
      { step: 'planner-tick', state: 'ok', exitCode: 0, report: null },
    ],
  },
};
const RAN_FAILED = {
  v: 1, exitCode: 1,
  report: {
    v: 1, at: '2026-11-01T12:00:00Z', mode: 'apply', state: 'ran',
    steps: [{ step: 'planner-tick', state: 'failed', exitCode: 1, report: null }],
  },
};
const BUSY = {
  v: 1, exitCode: 0,
  report: { v: 1, at: '2026-11-01T12:00:00Z', mode: 'apply', state: 'busy', steps: [] },
};

const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));

it('posts {apply:true} with the mutation-token header to the self-tick path', async () => {
  const fetcher = vi.fn(() => json(RAN_OK));
  await runSelfTickNow(fetcher as unknown as typeof fetch, 'fixture-token');
  const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(SELF_TICK_RUN_PATH);
  expect(init.method).toBe('POST');
  expect(JSON.parse(init.body as string)).toEqual({ apply: true });
  expect((init.headers as Record<string, string>)['x-ashlr-token']).toBe('fixture-token');
  expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
});

it('maps a clean ran report to ran-ok', async () => {
  const view = await runSelfTickNow(vi.fn(() => json(RAN_OK)) as unknown as typeof fetch, 't');
  expect(view).toEqual({ outcome: 'ran-ok', failedSteps: [] });
});

it('maps a ran report with failed steps to ran-failed with their names', async () => {
  const view = await runSelfTickNow(vi.fn(() => json(RAN_FAILED)) as unknown as typeof fetch, 't');
  expect(view).toEqual({ outcome: 'ran-failed', failedSteps: ['planner-tick'] });
});

it('maps a busy report and a 409 in-flight answer to busy', async () => {
  expect(await runSelfTickNow(vi.fn(() => json(BUSY)) as unknown as typeof fetch, 't'))
    .toEqual({ outcome: 'busy', failedSteps: [] });
  const conflict = vi.fn(() => json({ code: 'busy', error: 'a self-tick run is already in flight' }, 409));
  expect(await runSelfTickNow(conflict as unknown as typeof fetch, 't'))
    .toEqual({ outcome: 'busy', failedSteps: [] });
});

it('maps HTTP errors, network failures and malformed answers to error', async () => {
  for (const impl of [
    vi.fn(() => json({ error: 'not found' }, 404)),
    vi.fn(() => json({ v: 1, error: 'fleet self-tick unavailable' }, 503)),
    vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    vi.fn(() => json({ unexpected: true })),
    vi.fn(() => Promise.resolve(new Response('not json', { status: 200 }))),
  ]) {
    expect(await runSelfTickNow(impl as unknown as typeof fetch, 't'))
      .toEqual({ outcome: 'error', failedSteps: [] });
  }
});
