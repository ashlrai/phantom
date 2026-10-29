import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  QUEUE_EVENT_NAME, emitQueueEvent, enterQueueStation, parseQueueEventV1, withQueueStation,
  type QueueEventV1, type QueueStationIdentity,
} from '../src/core/observability/queue-events.js';

const START = '2026-10-26T12:00:00.000Z';
const END = '2026-10-26T12:01:00.000Z';
const identity: QueueStationIdentity = { job_id: 'RQ-QUEUE-1', pr: null, station: 'work', pool: 'codex-cmp', tier: 'work' };
const event = (overrides: Partial<QueueEventV1> = {}): QueueEventV1 => ({ ...identity, enter_ts: START, exit_ts: null, ...overrides });
const clock = () => {
  let calls = 0;
  return () => new Date(calls++ === 0 ? START : END);
};

describe('queue.v1 wire schema', () => {
  it('copies exactly the seven fields for entries and completed visits', () => {
    for (const input of [event(), event({ pr: 912, exit_ts: END })]) {
      expect(parseQueueEventV1(input)).toEqual(input);
      expect(parseQueueEventV1(input)).not.toBe(input);
    }
    expect(parseQueueEventV1(event({ exit_ts: START }))).not.toBeNull();
  });

  it.each([
    null, undefined, [], 'queue.v1', {},
    { ...event(), prompt: 'private task content' },
    { ...event(), model: 'unknown-extra-metadata' },
    { ...event(), pr: 0 }, { ...event(), pr: -1 }, { ...event(), pr: 1.5 },
    { ...event(), pr: Number.MAX_SAFE_INTEGER + 1 }, { ...event(), pr: '912' },
    { ...event(), job_id: '' }, { ...event(), job_id: 'a'.repeat(129) },
    { ...event(), pool: '../account' }, { ...event(), station: 'work\nsecret' },
    { ...event(), tier: 'a tier' }, { ...event(), job_id: 'https://private.example/task' },
    { ...event(), enter_ts: '2026-02-30T12:00:00.000Z' },
    { ...event(), enter_ts: '2026-10-26T12:00:00Z' },
    { ...event(), enter_ts: '2026-10-26T08:00:00.000-04:00' },
    { ...event(), enter_ts: 'invalid' },
    { ...event(), exit_ts: '2026-10-26T11:59:59.999Z' },
    { ...event(), exit_ts: undefined }, { ...event(), exit_ts: 123 },
  ])('rejects malformed or content-bearing properties %# before capture', async (input) => {
    const capture = vi.fn();
    expect(parseQueueEventV1(input)).toBeNull();
    expect(await emitQueueEvent(capture, input)).toEqual({ ok: false, detail: 'invalid queue.v1 event' });
    expect(capture).not.toHaveBeenCalled();
  });

  it('rejects missing fields, symbol extras, getters, and hostile proxies without reading them', () => {
    const missing = { ...event() } as Partial<QueueEventV1>;
    delete missing.exit_ts;
    expect(parseQueueEventV1(missing)).toBeNull();
    expect(parseQueueEventV1({ ...event(), [Symbol('private')]: 'private' })).toBeNull();
    const getter = vi.fn(() => { throw new Error('private'); });
    const accessor = Object.defineProperty(event(), 'pool', { get: getter });
    expect(parseQueueEventV1(accessor)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    expect(parseQueueEventV1(new Proxy({}, { ownKeys() { throw new Error('private'); } }))).toBeNull();
  });

  it('matches the published closed JSON schema and boundary identifiers', () => {
    const schema = JSON.parse(readFileSync(new URL('../schema/queue.v1.json', import.meta.url), 'utf8'));
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(Object.keys(event()));
    expect(Object.keys(schema.properties)).toEqual(schema.required);
    const maximum = event({ job_id: 'a'.repeat(128), pool: 'a'.repeat(128), pr: Number.MAX_SAFE_INTEGER });
    expect(parseQueueEventV1(maximum)).toEqual(maximum);
    expect(new RegExp(schema.$defs.identifier.pattern).test(maximum.job_id)).toBe(true);
  });
});

describe('queue.v1 capture and station visits', () => {
  it('uses the existing capture callback with the versioned event name', async () => {
    const capture = vi.fn();
    expect(await emitQueueEvent(capture, event())).toEqual({ ok: true, detail: 'captured queue.v1 event' });
    expect(capture).toHaveBeenCalledExactlyOnceWith(QUEUE_EVENT_NAME, event());
  });

  it.each(['sync', 'async'])('contains %s capture exceptions without exposing response or secret text', async (mode) => {
    const capture = mode === 'sync'
      ? () => { throw new Error('provider-private-value'); }
      : async () => { throw new Error('provider-private-value'); };
    const result = await emitQueueEvent(capture, event());
    expect(result).toEqual({ ok: false, detail: 'queue.v1 capture failed' });
    expect(JSON.stringify(result)).not.toContain('provider-private-value');
  });

  it('pairs entry and exit, permits a PR discovered during work, and deduplicates concurrent exits', async () => {
    const capture = vi.fn();
    const station = await enterQueueStation(capture, identity, clock());
    expect(station.enterResult.ok).toBe(true);
    const first = station.exit({ pr: 912 });
    const duplicate = station.exit({ pr: 913 });
    expect(first).toBe(duplicate);
    await Promise.all([first, duplicate]);
    expect(capture.mock.calls).toEqual([
      [QUEUE_EVENT_NAME, event()],
      [QUEUE_EVENT_NAME, event({ pr: 912, exit_ts: END })],
    ]);
    expect(station.enter.pr).toBeNull();
    expect(Object.isFrozen(station.enter)).toBe(true);
  });

  it('does not let capture mutation change the entry identity or exit timestamp basis', async () => {
    const received: QueueEventV1[] = [];
    const station = await enterQueueStation((_name, properties) => {
      received.push({ ...properties });
      properties.job_id = 'mutated';
      properties.enter_ts = END;
    }, identity, clock());
    await station.exit();
    expect(received).toEqual([event(), event({ exit_ts: END })]);
  });

  it('rejects an inverted exit or changed known PR without consuming the valid exit attempt', async () => {
    const capture = vi.fn();
    const station = await enterQueueStation(capture, { ...identity, pr: 912 }, clock());
    expect((await station.exit({ pr: 913 })).ok).toBe(false);
    expect((await station.exit({ pr: null })).ok).toBe(false);
    expect((await station.exit({ exit_ts: '2026-10-26T11:00:00.000Z' })).ok).toBe(false);
    expect((await station.exit({ exit_ts: END })).ok).toBe(true);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[1][1]).toEqual(event({ pr: 912, exit_ts: END }));
  });

  it('returns a safe failure if the exit clock fails and allows an explicit timestamp', async () => {
    const capture = vi.fn();
    let calls = 0;
    const station = await enterQueueStation(capture, identity, () => {
      if (calls++ > 0) throw new Error('private-clock-error');
      return new Date(START);
    });
    expect(await station.exit()).toEqual({ ok: false, detail: 'invalid queue.v1 event' });
    expect((await station.exit({ exit_ts: END })).ok).toBe(true);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('does not retry a failed capture on repeated exit calls', async () => {
    const capture = vi.fn().mockRejectedValue(new Error('private-provider-error'));
    const station = await enterQueueStation(capture, identity, clock());
    expect(station.enterResult.ok).toBe(false);
    const result = await station.exit();
    expect(result.ok).toBe(false);
    expect(await station.exit()).toBe(result);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('deduplicates a synchronous capture callback reentering station exit', async () => {
    let nested: Promise<unknown> | undefined;
    const capture = vi.fn((_name, properties: QueueEventV1) => {
      if (properties.exit_ts !== null) nested = station.exit();
    });
    const station = await enterQueueStation(capture, identity, clock());
    const attempt = station.exit();
    await attempt;
    expect(nested).toBe(attempt);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('always emits exit when work throws and preserves the original error', async () => {
    const capture = vi.fn();
    const failure = new Error('work failed');
    await expect(withQueueStation(capture, identity, () => { throw failure; }, clock())).rejects.toBe(failure);
    expect(capture.mock.calls).toEqual([[QUEUE_EVENT_NAME, event()], [QUEUE_EVENT_NAME, event({ exit_ts: END })]]);
  });

  it('returns successful work even when both analytics captures fail', async () => {
    const capture = vi.fn().mockRejectedValue(new Error('private-provider-error'));
    expect(await withQueueStation(capture, identity, () => 42, clock())).toBe(42);
    expect(capture).toHaveBeenCalledTimes(2);
    const failure = new Error('work failed');
    await expect(withQueueStation(capture, identity, async () => { throw failure; }, clock())).rejects.toBe(failure);
  });

  it('rejects invalid entry metadata or clocks before executing work', async () => {
    const capture = vi.fn();
    const work = vi.fn();
    await expect(withQueueStation(capture, { ...identity, pool: 'private account text' }, work, clock())).rejects.toThrow('Invalid queue station metadata.');
    await expect(withQueueStation(capture, identity, work, () => new Date('invalid'))).rejects.toThrow('Invalid queue station metadata.');
    expect(work).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('queue.v1 fixture replay', () => {
  it('replays exact ordered callbacks for interleaved pools, PR discovery, and station reentry', async () => {
    const fixture: QueueEventV1[] = JSON.parse(readFileSync(new URL('./fixtures/queue-events/replay.json', import.meta.url), 'utf8'));
    const capture = vi.fn();
    for (const observation of fixture) expect((await emitQueueEvent(capture, observation)).ok).toBe(true);
    expect(capture.mock.calls).toEqual(fixture.map((observation) => [QUEUE_EVENT_NAME, observation]));
    expect(fixture).toHaveLength(10);
    expect(new Set(fixture.map((row) => row.pool))).toEqual(new Set(['codex-cmp', 'claude']));
    const open = new Map<string, QueueEventV1>();
    for (const observation of fixture) {
      const key = `${observation.job_id}/${observation.station}/${observation.enter_ts}`;
      if (observation.exit_ts === null) {
        expect(open.has(key)).toBe(false);
        open.set(key, observation);
      } else {
        expect(open.get(key)).toMatchObject({ job_id: observation.job_id, station: observation.station, pool: observation.pool, tier: observation.tier });
        open.delete(key);
      }
    }
    expect(open.size).toBe(0);
  });
});
