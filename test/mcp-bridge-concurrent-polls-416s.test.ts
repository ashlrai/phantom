import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import { readFleetBridgeCheck } from '../src/mcp/fleet-bridge-check.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

it('keeps concurrent bridge checks independent across a stalled runtime read', async () => {
  vi.useFakeTimers();
  const times = ['2026-11-15T00:00:00.000Z', '2026-11-15T00:01:00.000Z', '2026-11-15T00:02:00.000Z'];
  let invocation = 0;
  let releaseRuntime!: (value: unknown) => void;
  const stalledRuntime = new Promise<unknown>(resolve => { releaseRuntime = resolve; });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({
    status: async () => ({}),
    loop: async () => ({}),
    bridgeCheck: () => {
      const index = invocation++;
      const asOf = times[index]!;
      return readFleetBridgeCheck({
        now: () => Date.parse(asOf),
        deadlineMs: 100,
        runtime: () => index === 0 ? stalledRuntime : Promise.resolve({
          host: `fake-host-${index}`, asOf, lastFleetStateRead: { ageSeconds: 1 },
        }),
        claims: () => ({ state: 'known', asOf, claims: Array.from({ length: index + 1 }, (_, row) => ({
          id: `claim-${index}-${row}`, repo: 'example/fixture', task: 'fixture task', agent: 'fake-agent',
          claimedAt: asOf, expiresAt: '2026-11-15T02:00:00.000Z', expiresInSeconds: 3600,
        })) }),
        peers: () => ({ status: 'ok', asOf, liveRows: index + 10 }),
      });
    },
  });
  const client = new Client({ name: 'concurrent-bridge-test', version: '1.0.0' });
  const call = async () => {
    const result = await client.callTool({ name: 'fleet_bridge_check', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    return { result, value: JSON.parse(text) };
  };

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const firstPromise = call();
    await vi.advanceTimersByTimeAsync(0);
    expect(invocation).toBe(1);
    let secondFinished = false;
    const secondPromise = call().then(value => { secondFinished = true; return value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(secondFinished).toBe(true);
    const second = await secondPromise;
    expect(second.result.isError).not.toBe(true);
    expect(second.value).toMatchObject({
      verdict: 'READY', asOf: times[1], missing: [],
      runtime: { status: 'ok', host: 'fake-host-1', asOf: times[1] },
      claims: { status: 'ok', live: 2, asOf: times[1] },
      peers: { status: 'ok', liveRows: 11, asOf: times[1] },
    });

    await vi.advanceTimersByTimeAsync(100);
    const first = await firstPromise;
    expect(first.result.isError).not.toBe(true);
    expect(first.value).toMatchObject({
      verdict: 'BLOCKED', asOf: times[0], missing: ['runtime'],
      runtime: { status: 'unavailable', reason: 'runtime-reader-timeout', asOf: times[0] },
      claims: { status: 'ok', live: 1, asOf: times[0] },
      peers: { status: 'ok', liveRows: 10, asOf: times[0] },
    });
    const firstSnapshot = structuredClone(first.value);
    const secondSnapshot = structuredClone(second.value);
    releaseRuntime({ host: 'fake-host-late', asOf: times[0], lastFleetStateRead: { ageSeconds: 1 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(first.value).toEqual(firstSnapshot);
    expect(second.value).toEqual(secondSnapshot);

    const thirdPromise = call();
    await vi.advanceTimersByTimeAsync(0);
    const third = await thirdPromise;
    expect(third.result.isError).not.toBe(true);
    expect(third.value).toMatchObject({
      verdict: 'READY', asOf: times[2], missing: [],
      runtime: { status: 'ok', host: 'fake-host-2', asOf: times[2] },
      claims: { status: 'ok', live: 3, asOf: times[2] },
      peers: { status: 'ok', liveRows: 12, asOf: times[2] },
    });
    expect(invocation).toBe(3);
  } finally {
    releaseRuntime({});
    await client.close();
    await server.close();
    vi.useRealTimers();
  }
});
