import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { jobControlText, type JobControlReceiptV1 } from '../../../../core/fleet/job-control-types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { JOB_CONTROL_PATH, jobControlBody, postJobControl } from './job-control-action.js';
import { stopFailureText } from './job-stop-action.js';

beforeEach(() => { clearMutationToken(); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

const receipt: JobControlReceiptV1 = {
  schema: 'fleet.job.control.v1', action: 'pause', job: 'RQ-PHX-TEST1', lane: null, status: 'requested',
  reason: null, requestId: 'jc-0123456789ab', at: '2026-11-01T00:08:00.000Z', dryRun: false, duplicate: false,
};

it('builds the request shape', () => {
  expect(JOB_CONTROL_PATH).toBe('/api/verse/fleet/runs/control');
  expect(jobControlBody('RQ-PHX-TEST1', 'stop')).toEqual({ id: 'RQ-PHX-TEST1', action: 'stop' });
  expect(jobControlBody('RQ-PHX-TEST1', 'move', 'devin')).toEqual({ id: 'RQ-PHX-TEST1', action: 'move', lane: 'devin' });
});

it('maps every receipt status to one plain sentence', () => {
  expect(jobControlText(receipt)).toBe('Pause requested for RQ-PHX-TEST1.');
  expect(jobControlText({ ...receipt, action: 'stop', status: 'applied' })).toBe('Stopped RQ-PHX-TEST1.');
  expect(jobControlText({ ...receipt, action: 'move', lane: 'devin' })).toBe('Move to devin requested for RQ-PHX-TEST1.');
  expect(jobControlText({ ...receipt, action: 'move', lane: 'devin', status: 'applied' })).toBe('Moved RQ-PHX-TEST1 to devin.');
  expect(jobControlText({ ...receipt, status: 'refused', reason: 'Lane devin is held.' })).toBe('Lane devin is held.');
  expect(jobControlText({ ...receipt, status: 'unknown' })).toBe('No job RQ-PHX-TEST1 found.');
  expect(jobControlText({ ...receipt, dryRun: true })).toBe('Dry run, nothing changed. Pause requested for RQ-PHX-TEST1.');
});

it('requires the control token before any request', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(postJobControl('RQ-PHX-TEST1', 'pause')).rejects.toThrow(VerseControlLockedError);
  expect(fetcher).not.toHaveBeenCalled();
});

it('posts through the mutation client and returns the receipt', async () => {
  setMutationToken('a'.repeat(64));
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ id: 'RQ-PHX-TEST1', action: 'move', lane: 'devin' });
    return Response.json({ ...receipt, action: 'move', lane: 'devin' });
  });
  vi.stubGlobal('fetch', fetcher);
  await expect(postJobControl('RQ-PHX-TEST1', 'move', 'devin')).resolves.toEqual({ ...receipt, action: 'move', lane: 'devin' });
  expect(fetcher.mock.calls[0]?.[0]).toBe(JOB_CONTROL_PATH);
});

it('surfaces the client rejection sentence on a rejected token', async () => {
  setMutationToken('a'.repeat(64));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'unauthorized' }, { status: 401 })));
  const error = await postJobControl('RQ-PHX-TEST1', 'stop').catch((e: unknown) => e);
  expect(error).toMatchObject({ status: 401 });
  expect(stopFailureText(error)).toBe('Mutation token was rejected.');
});

it('maps a 404 to the update message and a bad body to a 502', async () => {
  setMutationToken('a'.repeat(64));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'not found' }, { status: 404 })));
  await expect(postJobControl('RQ-PHX-TEST1', 'stop')).rejects.toThrow('This Phantom server cannot steer jobs yet; update the app.');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ nope: true })));
  await expect(postJobControl('RQ-PHX-TEST1', 'stop')).rejects.toThrow('Invalid job control response.');
});
