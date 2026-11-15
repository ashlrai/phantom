import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { SURFACES, type SurfaceOwnerReport } from '../src/core/fleet/surface-owner.js';
import { createFleetSurfaceOwnerApi, FLEET_SURFACE_OWNER_READ_DEADLINE_MS, VERSE_FLEET_SURFACE_OWNER_PATH as PATH } from '../src/core/verse/fleet-surface-owner-api.js';

const now = () => new Date('2026-11-15T00:00:00Z');
const good = (surface: string): SurfaceOwnerReport => ({
  schemaVersion: 1, authority: 'none', surface, asOf: now().toISOString(),
  owner: 'synthetic-agent', ownerSource: 'advisory-claim',
  liveClaims: [{ id: 'synthetic-claim', agent: 'synthetic-agent', expiresInSeconds: 60 }],
  lastLanded: { jobId: 'RQ-SYNTHETIC', pr: 1, date: now().toISOString(), path: 'docs/FAKE.md' },
  scannedPaths: [], reasons: [],
});
const stalled = () => new Promise<SurfaceOwnerReport>(() => {});
function call(api: ReturnType<typeof createFleetSurfaceOwnerApi>, query = '?surface=slack-bridge', method = 'GET') {
  const end = vi.fn();
  const writeHead = vi.fn();
  const done = api({} as VerseApiContext, { url: PATH + query } as IncomingMessage,
    { writeHead, end } as unknown as ServerResponse, PATH, method);
  return { done, end, writeHead, body: () => JSON.parse(end.mock.calls[0]![0] as string) };
}
function unknown(report: SurfaceOwnerReport, reason = 'surface owner: read deadline exceeded') {
  expect(report).toMatchObject({ owner: 'UNKNOWN', ownerSource: 'none', authority: 'none',
    liveClaims: [], lastLanded: null, reasons: [reason], asOf: now().toISOString() });
}
afterEach(() => vi.useRealTimers());

it('bounds a stalled selected read at the default budget and clears its timer', async () => {
  vi.useFakeTimers();
  expect(FLEET_SURFACE_OWNER_READ_DEADLINE_MS).toBe(5000);
  const r = call(createFleetSurfaceOwnerApi({ read: stalled, now }));
  await vi.advanceTimersByTimeAsync(4999);
  expect(r.end).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await r.done).toBe(true);
  unknown(r.body().report);
  expect(r.end).toHaveBeenCalledTimes(1);
  expect(r.writeHead).toHaveBeenCalledWith(200, expect.anything());
  expect(vi.getTimerCount()).toBe(0);
});
it('shares one short list budget while preserving successful advisory and historical evidence', async () => {
  vi.useFakeTimers();
  const read = vi.fn((surface: string) => surface === 'coordination' ? Promise.resolve(good(surface))
    : surface === 'dot-handoff' ? Promise.reject(new Error('private reader detail')) : stalled());
  const r = call(createFleetSurfaceOwnerApi({ read, now, deadlineMs: 20 }), '');
  await vi.advanceTimersByTimeAsync(20);
  await r.done;
  expect(read).toHaveBeenCalledTimes(Object.keys(SURFACES).length);
  const reports = r.body().surfaces as SurfaceOwnerReport[];
  expect(reports[0]).toEqual(good('coordination'));
  unknown(reports[1]!, 'surface owner: reader failed');
  reports.slice(2).forEach(report => unknown(report));
  expect(r.body()).toMatchObject({ authority: 'none', generatedAt: now().toISOString() });
  expect(r.end).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(r.body())).not.toContain('private reader detail');
  expect(vi.getTimerCount()).toBe(0);
});
it('consumes late rejection without another write or a retained result on the next request', async () => {
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const read = vi.fn().mockImplementationOnce(() => new Promise<SurfaceOwnerReport>((_resolve, fail) => { reject = fail; }))
    .mockImplementation((surface: string) => Promise.resolve(good(surface)));
  const api = createFleetSurfaceOwnerApi({ read, now, deadlineMs: 10 });
  const r = call(api);
  await vi.advanceTimersByTimeAsync(10);
  await r.done;
  unknown(r.body().report);
  reject(new Error('private late error'));
  await vi.advanceTimersByTimeAsync(0);
  expect(r.end).toHaveBeenCalledTimes(1);
  const next = call(api);
  await next.done;
  expect(next.body().report).toEqual(good('slack-bridge'));
  expect(next.end).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it.each([['?surface=unknown', 'GET', 400], ['?surface=slack-bridge&surface=coordination', 'GET', 400], ['', 'POST', 405]])(
  'validates %s %s before reading', async (query, method, status) => {
    const read = vi.fn(stalled);
    const r = call(createFleetSurfaceOwnerApi({ read, now, deadlineMs: 10 }), query as string, method as string);
    await r.done;
    expect(read).not.toHaveBeenCalled();
    expect(r.writeHead).toHaveBeenCalledWith(status, expect.anything());
    expect(r.end).toHaveBeenCalledTimes(1);
  });
