import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import type { RuntimeSnapshot } from '../src/core/fleet/runtime-snapshot.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { createFleetRuntimeSnapshotApi, VERSE_FLEET_RUNTIME_SNAPSHOT_PATH as PATH } from '../src/core/verse/fleet-runtime-snapshot-api.js';

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const at = (ms: number) => new Date(ms).toISOString();
function fixture(host: string, asOf: string): RuntimeSnapshot {
  return { host, tailnetName: 'synthetic-tailnet', installedVersion: '1.2.3', pid: 475,
    uptimeSeconds: 5, platform: 'fake', arch: 'fake', stateRoot: '~/fake',
    lastFleetStateRead: { mtime: asOf, ageSeconds: 0 },
    coordination: { state: 'known', activeClaims: 0, newestReturnAgeSeconds: 0 }, asOf, reasons: [] };
}
function call(api: ApiModule) {
  const state = { status: 0, text: '', ends: 0 };
  const res = { writeHead(code: number) { state.status = code; return this; },
    end(body: string) { state.text = body; state.ends++; } } as unknown as ServerResponse;
  const done = api({} as VerseApiContext, {} as IncomingMessage, res, PATH, 'GET');
  return { state, done, body: () => JSON.parse(state.text) };
}
afterEach(() => vi.useRealTimers());

it.each(['resolve', 'reject'] as const)('isolates overlapping requests after a late %s', async kind => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    let resolveFirst!: (snapshot: RuntimeSnapshot) => void;
    let rejectFirst!: (error: Error) => void;
    const pending = new Promise<RuntimeSnapshot>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
    const secondSnapshot = fixture('synthetic-second', at(NOW + 10));
    const thirdSnapshot = fixture('synthetic-third', at(NOW + 50));
    const readSnapshot = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(secondSnapshot).mockResolvedValueOnce(thirdSnapshot);
    const api = createFleetRuntimeSnapshotApi({ now: () => new Date(), readDeadlineMs: 50, readSnapshot });
    const first = call(api);
    await vi.advanceTimersByTimeAsync(10);
    const second = call(api);
    expect(await second.done).toBe(true);
    expect(first.state.ends).toBe(0);
    expect(second.state).toMatchObject({ status: 200, ends: 1 });
    expect(second.body()).toEqual({ v: 1, authority: 'none', generatedAt: at(NOW + 10), snapshot: secondSnapshot });
    await vi.advanceTimersByTimeAsync(40);
    expect(await first.done).toBe(true);
    expect(first.state).toMatchObject({ status: 200, ends: 1 });
    expect(first.body()).toMatchObject({ authority: 'none', generatedAt: at(NOW + 50), snapshot: {
      host: 'UNKNOWN', asOf: 'UNKNOWN', reasons: ['runtime snapshot: read deadline exceeded; all fields unknown'],
    } });
    const firstText = first.state.text;
    const secondText = second.state.text;
    if (kind === 'resolve') resolveFirst(fixture('synthetic-late', at(NOW)));
    else rejectFirst(new Error('synthetic-late-error'));
    await vi.advanceTimersByTimeAsync(0);
    expect(first.state).toMatchObject({ ends: 1, text: firstText });
    expect(second.state).toMatchObject({ ends: 1, text: secondText });
    expect(firstText).not.toContain('synthetic-second');
    expect(secondText).not.toContain('synthetic-late');
    expect(unhandled).not.toHaveBeenCalled();
    const third = call(api);
    expect(await third.done).toBe(true);
    expect(third.state).toMatchObject({ status: 200, ends: 1 });
    expect(third.body()).toEqual({ v: 1, authority: 'none', generatedAt: at(NOW + 50), snapshot: thirdSnapshot });
    expect(readSnapshot).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  } finally { process.off('unhandledRejection', unhandled); vi.clearAllTimers(); }
});
