import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { ApiError } from '../../../data/client.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import {
  JOB_STOP_PATH, jobStopBody, jobStopEligible, postJobStop,
  STOP_CONFIRM_MS, stopConfirmLabel, stopFailureText, stopOutcomeText,
  type JobStopResult,
} from './job-stop-action.js';

beforeEach(() => { clearMutationToken(); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

const stopped: JobStopResult = { id: 'RQ-PHX-TEST1', pids: [111, 222], outcome: 'stopped', at: '2026-11-01T00:08:00.000Z' };

it('builds the request shape and the five-second confirm window', () => {
  expect(JOB_STOP_PATH).toBe('/api/verse/fleet/runs/stop');
  expect(jobStopBody('RQ-PHX-TEST1')).toEqual({ id: 'RQ-PHX-TEST1' });
  expect(STOP_CONFIRM_MS).toBe(5_000);
  expect(stopConfirmLabel('RQ-PHX-TEST1', false)).toBe('Stop');
  expect(stopConfirmLabel('RQ-PHX-TEST1', true)).toBe('Stop RQ-PHX-TEST1? click again');
});

it('shows Stop while the job is not finished', () => {
  expect(jobStopEligible('running')).toBe(true);
  expect(jobStopEligible('unknown')).toBe(true);
  for (const state of ['published', 'archived', null, undefined] as const) expect(jobStopEligible(state)).toBe(false);
});

it('maps outcomes to inline text', () => {
  expect(stopOutcomeText({ ...stopped, pids: [111, 222] })).toBe('stopped 2 processes');
  expect(stopOutcomeText({ ...stopped, pids: [7] })).toBe('stopped 1 process');
  expect(stopOutcomeText({ ...stopped, outcome: 'not-running', pids: [] })).toBe('not running');
  expect(stopOutcomeText({ ...stopped, outcome: 'refused', pids: [] })).toBe('refused');
});

it('requires the control token before any request', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(postJobStop('RQ-PHX-TEST1')).rejects.toThrow(VerseControlLockedError);
  expect(fetcher).not.toHaveBeenCalled();
});

it('posts through the mutation client and returns the stop outcome', async () => {
  setMutationToken('a'.repeat(64));
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ id: 'RQ-PHX-TEST1' });
    return Response.json(stopped);
  });
  vi.stubGlobal('fetch', fetcher);
  const result = await postJobStop('RQ-PHX-TEST1');
  expect(result).toEqual(stopped);
  expect(fetcher.mock.calls[0]?.[0]).toBe(JOB_STOP_PATH);
});

it('surfaces the client rejection sentence on a rejected token', async () => {
  setMutationToken('a'.repeat(64));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'unauthorized' }, { status: 401 })));
  const error = await postJobStop('RQ-PHX-TEST1').catch((e: unknown) => e);
  expect(error).toMatchObject({ status: 401 });
  expect(stopFailureText(error)).toBe('Mutation token was rejected.');
});

it('maps a 409 to not running, a 404 to the update message, and a bad body to a 502', async () => {
  setMutationToken('a'.repeat(64));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...stopped, outcome: 'not-running', pids: [] }, { status: 409 })));
  await expect(postJobStop('RQ-PHX-TEST1')).resolves.toMatchObject({ outcome: 'not-running', pids: [] });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'not found' }, { status: 404 })));
  await expect(postJobStop('RQ-PHX-TEST1')).rejects.toThrow('This Phantom server cannot stop jobs yet; update the app.');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ nope: true }, { status: 202 })));
  await expect(postJobStop('RQ-PHX-TEST1')).rejects.toThrow('Invalid stop response.');
});

it('keeps the operator-written sentence as failure text', () => {
  expect(stopFailureText(new VerseControlLockedError())).toBe('Unlock actions with the mutation token before changing the loop.');
  expect(stopFailureText(new ApiError('POST x failed (HTTP 500).', 500, JOB_STOP_PATH, 'stop failed'))).toBe('stop failed');
  expect(stopFailureText('nope')).toBe('The request failed.');
});
