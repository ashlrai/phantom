import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { PROCESS_SNAPSHOT_MAX_AGE_MS } from '../src/core/fleet/claim-execution-evidence.js';
import type { RuntimeSnapshot } from '../src/core/fleet/runtime-snapshot.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { createFleetRuntimeSnapshotApi, VERSE_FLEET_RUNTIME_SNAPSHOT_PATH as PATH } from '../src/core/verse/fleet-runtime-snapshot-api.js';

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const at = (ms: number) => new Date(ms).toISOString();
function fixture(asOf: unknown = at(NOW)): RuntimeSnapshot {
  return {
    host: 'synthetic-host', tailnetName: 'synthetic-tailnet', installedVersion: '1.2.3',
    pid: 426, uptimeSeconds: 5, platform: 'fake', arch: 'fake', stateRoot: '~/fake',
    lastFleetStateRead: { mtime: at(NOW), ageSeconds: 0 },
    coordination: { state: 'known', activeClaims: 7, newestReturnAgeSeconds: 0 },
    execution: { state: 'known', running: 7, claimedNoWorker: 0, unknown: 0 },
    asOf: asOf as string, reasons: ['arbitrary-input-text'],
  };
}
function call(api: ApiModule, method = 'GET', path = PATH) {
  const state = { status: 0, text: '', ends: 0 };
  const res = {
    writeHead(code: number) { state.status = code; return this; },
    end(body: string) { state.text = body; state.ends++; },
  } as unknown as ServerResponse;
  const done = api({} as VerseApiContext, {} as IncomingMessage, res, path, method);
  return { state, done, body: () => JSON.parse(state.text) };
}
function expectUnknown(snapshot: ReturnType<typeof call>, reason: string) {
  expect(snapshot.state).toMatchObject({ status: 200, ends: 1 });
  expect(snapshot.body().snapshot).toEqual({
    host: 'UNKNOWN', tailnetName: 'UNKNOWN', installedVersion: 'UNKNOWN', sourceVersion: 'UNKNOWN',
    pid: 'UNKNOWN', uptimeSeconds: 'UNKNOWN', platform: 'UNKNOWN', arch: 'UNKNOWN', stateRoot: 'UNKNOWN',
    lastFleetStateRead: { mtime: 'UNKNOWN', ageSeconds: 'UNKNOWN' },
    coordination: { state: 'UNKNOWN', activeClaims: 'UNKNOWN', newestReturnAgeSeconds: 'UNKNOWN' },
    asOf: 'UNKNOWN', reasons: [reason],
  });
}
afterEach(() => vi.useRealTimers());

it('stamps delayed fresh success at completion and preserves valid observations', async () => {
  let clock = NOW;
  let settle!: (value: RuntimeSnapshot) => void;
  const now = vi.fn(() => new Date(clock));
  const result = call(createFleetRuntimeSnapshotApi({ now,
    readSnapshot: () => new Promise(resolve => { settle = resolve; }),
  }));
  await Promise.resolve();
  expect(now).not.toHaveBeenCalled();
  clock += 2000;
  const fresh = fixture(at(clock));
  settle(fresh);
  expect(await result.done).toBe(true);
  expect(now).toHaveBeenCalledTimes(1);
  expect(result.body()).toEqual({ v: 1, authority: 'none', generatedAt: at(clock), snapshot: fresh });
});

it.each([0, PROCESS_SNAPSHOT_MAX_AGE_MS])('accepts observation age %i ms', async age => {
  const snapshot = fixture(at(NOW - age));
  const result = call(createFleetRuntimeSnapshotApi({ now: () => new Date(NOW), readSnapshot: async () => snapshot }));
  await result.done;
  expect(result.body().snapshot).toEqual(snapshot);
});

it.each([at(NOW - PROCESS_SNAPSHOT_MAX_AGE_MS - 1), at(NOW + 1), undefined, null, '', 'arbitrary-invalid-stamp', 42])(
  'degrades unqualified asOf %s without retaining identity, counts or arbitrary text', async asOf => {
    const snapshot = fixture();
    snapshot.asOf = asOf as string;
    const result = call(createFleetRuntimeSnapshotApi({ now: () => new Date(NOW), readSnapshot: async () => snapshot }));
    await result.done;
    expectUnknown(result, 'runtime snapshot: missing, invalid or stale asOf; all fields unknown');
    expect(result.state.text).not.toMatch(/synthetic|arbitrary|RUNNING|"running"|426/);
  },
);

it.each(['resolve', 'reject'] as const)('stamps timeout once and consumes late %s', async kind => {
  vi.useFakeTimers();
  let clock = NOW;
  let settle!: () => void;
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    const result = call(createFleetRuntimeSnapshotApi({ now: () => new Date(clock), readDeadlineMs: 50,
      readSnapshot: () => new Promise((resolve, reject) => {
        settle = () => kind === 'resolve' ? resolve(fixture()) : reject(new Error('arbitrary-late-error'));
      }),
    }));
    await Promise.resolve();
    clock += 50;
    await vi.advanceTimersByTimeAsync(50);
    await result.done;
    expectUnknown(result, 'runtime snapshot: read deadline exceeded; all fields unknown');
    expect(result.body().generatedAt).toBe(at(clock));
    const original = result.state.text;
    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(result.state).toMatchObject({ ends: 1, text: original });
    expect(unhandled).not.toHaveBeenCalled();
  } finally { process.off('unhandledRejection', unhandled); }
});
