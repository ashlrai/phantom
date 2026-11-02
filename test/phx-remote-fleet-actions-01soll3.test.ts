import { describe, expect, expectTypeOf, it } from 'vitest';
import type { LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';
import type { RunsSwitchesV1 } from '../src/core/fleet/runs-switches.js';
import { createRemoteFleetFeed } from '../src/core/web/remote-fleet-feed.js';
import { classifyRemoteRoute, validateRemoteMutation } from '../src/core/web/remote-gateway-policy.js';

type Call = { method: string; path: string; body?: unknown };

function fixture(result: unknown = { fixture: 'fake' }, failure?: unknown) {
  const calls: Call[] = [];
  function respond<T>(): T {
    if (failure !== undefined) throw failure;
    return result as T;
  }
  const feed = createRemoteFleetFeed({
    async get<T>(path: string): Promise<T> {
      expect(classifyRemoteRoute('GET', path)).toEqual({ kind: 'read', path: path.split('?')[0] });
      calls.push({ method: 'GET', path });
      return respond<T>();
    },
    async mutate<T>(method: 'POST', path: string, body: unknown): Promise<T> {
      const decision = classifyRemoteRoute(method, path);
      expect(decision).toEqual({ kind: 'write', path, stepUp: true });
      expect(validateRemoteMutation(decision, body)).toBe(true);
      calls.push({ method, path, body });
      return respond<T>();
    },
  });
  return { feed, calls };
}

describe('remote fleet actions', () => {
  it('exposes the existing API response types', () => {
    const { feed } = fixture();
    expectTypeOf(feed.readLaneHolds).returns.toEqualTypeOf<Promise<LaneTargetsV1>>();
    expectTypeOf(feed.setLaneTarget).returns.toEqualTypeOf<Promise<LaneTargetsV1>>();
    expectTypeOf(feed.setSwitch).returns.toEqualTypeOf<Promise<RunsSwitchesV1>>();
    expectTypeOf(feed.releaseLaneHold).returns.toEqualTypeOf<Promise<LaneTargetsV1>>();
  });

  it('sends exact reviewed requests and returns transport snapshots unchanged', async () => {
    const result = { fixture: 'fake' };
    const { feed, calls } = fixture(result);
    const responses = await Promise.all([
      feed.readLaneHolds(), feed.setLaneTarget('codex-personal', 0),
      feed.setLaneTarget(`a${'b'.repeat(40)}`, 64), feed.setSwitch('PAUSE', true),
      feed.setSwitch(`A${'b'.repeat(40)}`, false), feed.releaseLaneHold('codex-personal'),
      feed.releaseLaneHold('codex-personal', ''), feed.releaseLaneHold('codex-personal', 'x'.repeat(120)),
      feed.list(), feed.laneTargets(), feed.switches(), feed.pause(), feed.resume(), feed.kill(),
    ]);
    expect(responses.every((response) => response === result)).toBe(true);
    expect(calls).toEqual([
      { method: 'GET', path: '/api/verse/fleet/control/holds' },
      { method: 'POST', path: '/api/verse/fleet/control/lanes', body: { lane: 'codex-personal', target: 0 } },
      { method: 'POST', path: '/api/verse/fleet/control/lanes', body: { lane: `a${'b'.repeat(40)}`, target: 64 } },
      { method: 'POST', path: '/api/verse/fleet/control/switches', body: { id: 'PAUSE', on: true } },
      { method: 'POST', path: '/api/verse/fleet/control/switches', body: { id: `A${'b'.repeat(40)}`, on: false } },
      { method: 'POST', path: '/api/verse/fleet/control/holds', body: { lane: 'codex-personal', action: 'release' } },
      { method: 'POST', path: '/api/verse/fleet/control/holds', body: { lane: 'codex-personal', action: 'release', reason: '' } },
      { method: 'POST', path: '/api/verse/fleet/control/holds', body: { lane: 'codex-personal', action: 'release', reason: 'x'.repeat(120) } },
      { method: 'GET', path: '/api/verse/fleet/live' },
      { method: 'GET', path: '/api/verse/fleet/control/lanes' },
      { method: 'GET', path: '/api/verse/fleet/control/switches' },
      { method: 'POST', path: '/api/verse/daemon', body: { action: 'pause' } },
      { method: 'POST', path: '/api/verse/daemon', body: { action: 'resume' } },
      { method: 'POST', path: '/api/verse/authority', body: { action: 'stop' } },
    ]);
  });

  it('rejects invalid values and unsupported arguments before transport', () => {
    const { feed, calls } = fixture();
    for (const lane of ['', 'a', 'A1', 'a_', 'a/b', `a${'b'.repeat(41)}`, null, 1, {}]) {
      expect(() => Reflect.apply(feed.setLaneTarget, undefined, [lane, 1])).toThrow();
      expect(() => Reflect.apply(feed.releaseLaneHold, undefined, [lane])).toThrow();
    }
    for (const target of [-1, 65, 1.5, NaN, Infinity, '1', null, {}]) {
      expect(() => Reflect.apply(feed.setLaneTarget, undefined, ['lane', target])).toThrow();
    }
    for (const id of ['', 'A', '1A', 'A/B', `A${'b'.repeat(41)}`, null, 1, {}]) {
      expect(() => Reflect.apply(feed.setSwitch, undefined, [id, true])).toThrow();
    }
    for (const on of [0, 1, 'true', null, {}]) {
      expect(() => Reflect.apply(feed.setSwitch, undefined, ['PAUSE', on])).toThrow();
    }
    for (const reason of ['x'.repeat(121), null, 1, {}]) {
      expect(() => Reflect.apply(feed.releaseLaneHold, undefined, ['lane', reason])).toThrow();
    }
    for (const [method, args] of [
      [feed.readLaneHolds, [{}]], [feed.setLaneTarget, ['lane', 1, {}]],
      [feed.setSwitch, ['PAUSE', true, {}]], [feed.releaseLaneHold, ['lane', undefined, {}]],
    ] as const) {
      expect(() => Reflect.apply(method, undefined, args)).toThrow();
    }
    expect(calls).toEqual([]);
  });

  it('propagates step-up, manual-hold and network failures without retrying', async () => {
    for (const failure of [
      Object.assign(new Error('step-up required'), { code: 'STEP_UP_REQUIRED' }),
      Object.assign(new Error('held by a person'), { code: 'manual-hold' }),
      new Error('network failure'),
    ]) {
      const { feed, calls } = fixture(undefined, failure);
      await expect(feed.releaseLaneHold('codex-personal', 'reviewed')).rejects.toBe(failure);
      expect(calls).toEqual([
        { method: 'POST', path: '/api/verse/fleet/control/holds', body: { lane: 'codex-personal', action: 'release', reason: 'reviewed' } },
      ]);
    }
    const refusal = { code: 'manual-hold', error: 'held by a person' };
    const { feed, calls } = fixture(refusal);
    expect(await feed.releaseLaneHold('codex-personal')).toBe(refusal);
    expect(calls).toHaveLength(1);
  });
});
