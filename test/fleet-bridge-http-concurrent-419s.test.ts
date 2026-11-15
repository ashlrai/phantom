import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { createFleetBridgeCheckApi, VERSE_FLEET_BRIDGE_CHECK_PATH as path } from '../src/core/verse/fleet-bridge-check-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { readFleetBridgeCheck } from '../src/mcp/fleet-bridge-check.js';

const times = ['2026-11-15T00:00:00.000Z', '2026-11-15T00:01:00.000Z'];
const runtime = (i: number) => ({ host: `synthetic-${i}`, stateRoot: `/synthetic/${i}`,
  asOf: times[i], lastFleetStateRead: { ageSeconds: i === 0 ? 901 : 1 } });
const reader = (i: number, readRuntime: () => Promise<unknown>) => readFleetBridgeCheck({
  now: () => Date.parse(times[i]!), runtime: readRuntime,
  claims: () => ({ state: 'known', source: `synthetic-claims-${i}`, asOf: times[i],
    claims: Array.from({ length: i + 1 }, (_, n) => ({ id: `claim-${n}`, repo: 'example/repo',
      task: 'test', agent: 'synthetic', claimedAt: times[i], expiresAt: '2026-11-15T01:00:00.000Z', expiresInSeconds: 60 })) }),
  peers: () => ({ status: 'ok', asOf: times[i] }),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function request(api: ReturnType<typeof createFleetBridgeCheckApi>) {
  let status = 0;
  let text = '';
  const response = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const done = api({} as VerseApiContext, {} as IncomingMessage, response, path, 'GET');
  return { response, done, result: () => ({ status, text, body: JSON.parse(text) }) };
}

it('isolates overlapping HTTP observations even when the older runtime finishes last', async () => {
  const slow = deferred<unknown>();
  let index = 0;
  const api = createFleetBridgeCheckApi({ read: () => {
    const i = index++;
    return reader(i, () => i === 0 ? slow.promise : Promise.resolve(runtime(i)));
  } });
  const first = request(api);
  const second = request(api);
  expect(first.response).not.toBe(second.response);
  expect(await second.done).toBe(true);
  const newer = second.result();
  expect(newer).toMatchObject({ status: 200, body: { v: 1, authority: 'none', check: {
    verdict: 'READY', asOf: times[1], missing: [], runtime: { ...runtime(1), source: 'fleet-runtime' },
    claims: { source: 'synthetic-claims-1', asOf: times[1], live: 2 }, peers: { source: 'peer-ledger', asOf: times[1] },
  } } });
  slow.resolve(runtime(0));
  expect(await first.done).toBe(true);
  expect(first.result()).toMatchObject({ status: 200, body: { v: 1, authority: 'none', check: {
    verdict: 'BLOCKED', asOf: times[0], missing: ['runtime.fleet-state-stale'], runtime: { ...runtime(0), source: 'fleet-runtime' },
    claims: { source: 'synthetic-claims-0', asOf: times[0], live: 1 }, peers: { source: 'peer-ledger', asOf: times[0] },
  } } });
  expect(second.result()).toEqual(newer);
});

it('contains a rejected HTTP read to its fixed fallback while the other request succeeds', async () => {
  const slow = deferred<unknown>();
  let index = 0;
  const api = createFleetBridgeCheckApi({ now: () => new Date(times[0]!), read: () =>
    index++ === 0 ? slow.promise : reader(1, async () => runtime(1)) });
  const first = request(api);
  const second = request(api);
  expect(await second.done).toBe(true);
  slow.reject(new Error('private diagnostic sentinel'));
  expect(await first.done).toBe(true);
  expect(first.result()).toMatchObject({ status: 200, body: { v: 1, authority: 'none', check: {
    verdict: 'BLOCKED', asOf: times[0], missing: ['bridge-check'], reason: 'bridge-check-reader-failed',
  } } });
  expect(second.result()).toMatchObject({ status: 200, body: { v: 1, authority: 'none', check: { verdict: 'READY', claims: { live: 2 } } } });
  expect(first.result().text + second.result().text).not.toContain('private diagnostic sentinel');
});
