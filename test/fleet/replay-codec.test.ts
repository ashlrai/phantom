import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  decodeReplayFleet, encodeReplayFleet, REPLAY_MAX_BYTES, REPLAY_MAX_CALLS,
  replayValue, type ReplayFleet,
} from '../../src/fleet/replay-codec.js';
import { readReplayFleet, recordFleetSession, replayFleetSession } from '../../src/fleet/replay.js';

function fleet(): ReplayFleet {
  return { schema: 'phantom-fleet-replay/v1', sessions: [{ jobId: 'example', input: null, calls: [], outcome: { status: 'returned', value: 1 } }] };
}

describe('fleet replay capture validation', () => {
  it('round trips canonical captures independently of object insertion order', () => {
    const one = fleet();
    one.sessions[0].input = { b: 2, a: 1 };
    const two = fleet();
    two.sessions[0].input = { a: 1, b: 2 };
    expect(encodeReplayFleet(one)).toBe(encodeReplayFleet(two));
    expect(decodeReplayFleet(encodeReplayFleet(one))).toEqual(one);
  });

  it.each([undefined, NaN, Infinity, -0, 1n, new Date(), new Map(), () => 1, Symbol('x'), [undefined], Array(2)]
    .map((value) => ({ value })))('refuses unsupported JSON values (case %#)', ({ value }) => {
    expect(() => replayValue(value)).toThrow('Fleet replay refused: invalid');
  });

  it('refuses cycles, custom array properties, symbols and getters without invoking them', () => {
    const cycle: unknown[] = [];
    cycle.push(cycle);
    const getter = vi.fn(() => 'do not run');
    expect(() => replayValue(cycle)).toThrow('invalid');
    expect(() => replayValue(Object.defineProperty({}, 'field', { enumerable: true, get: getter }))).toThrow('invalid');
    expect(getter).not.toHaveBeenCalled();
    expect(() => replayValue(Object.assign([1], { custom: 2 }))).toThrow('invalid');
    expect(() => replayValue({ [Symbol('field')]: 2 })).toThrow('invalid');
    expect(() => replayValue(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow('invalid');
  });

  it('bounds depth, payload size, call count and parser input before recursive hashing', () => {
    const nested = '{"schema":"phantom-fleet-replay/v1","sha256":"fake","sessions":[{"jobId":"one","input":' +
      '['.repeat(10000) + '0' + ']'.repeat(10000) + ',"calls":[],"outcome":null}]}';
    expect(() => decodeReplayFleet(nested)).toThrow('Fleet replay refused: invalid');
    expect(() => replayValue('x'.repeat(REPLAY_MAX_BYTES + 1))).toThrow('invalid');
    expect(() => decodeReplayFleet(' '.repeat(REPLAY_MAX_BYTES + 1))).toThrow('invalid');
    const many = fleet();
    many.sessions[0].calls = Array.from({ length: REPLAY_MAX_CALLS + 1 }, () => ({ operation: 'tool', input: null, outcome: null }));
    expect(() => encodeReplayFleet(many)).toThrow('invalid');
  });

  it('rejects unknown fields, duplicate jobs, invalid terminal shapes and pending calls in completed jobs', () => {
    expect(() => encodeReplayFleet({ ...fleet(), extra: true } as ReplayFleet)).toThrow('invalid');
    const duplicate = fleet();
    duplicate.sessions.push(duplicate.sessions[0]);
    expect(() => encodeReplayFleet(duplicate)).toThrow('invalid');
    const pending = fleet();
    pending.sessions[0].calls.push({ operation: 'tool', input: null, outcome: null });
    expect(() => encodeReplayFleet(pending)).toThrow('invalid');
    const malformed = fleet();
    malformed.sessions[0].outcome = { status: 'threw', error: { name: 'Error', message: 3, code: null } } as any;
    expect(() => encodeReplayFleet(malformed)).toThrow('invalid');
  });

  it('rejects credentials and ambient environment maps, but accepts Phantom Secrets references', () => {
    const fake = 'sk-' + 'fixture'.repeat(6);
    for (const value of [fake, { password: 'short' }, { headers: { Authorization: 'short' } }, { env: {} }, { apiKey: 'short' }]) {
      expect(() => replayValue(value)).toThrow('secret');
    }
    expect(replayValue({ apiKey: 'phm_example_reference' })).toEqual({ apiKey: 'phm_example_reference' });
  });

  it('refuses unsafe calls before effects, unsafe outputs before persistence, and scrubs recorded failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-replay-secrets-'));
    const path = join(root, 'fleet.json');
    const fake = 'sk-' + 'fixture'.repeat(6);
    const adapter = vi.fn(async () => 1);
    try {
      await expect(recordFleetSession({ path, jobId: 'unsafe-input', input: null }, async ({ call }) => {
        try { await call('tool', { password: 'short' }); } catch { /* cannot make this recording valid */ }
        return null;
      }, adapter)).rejects.toMatchObject({ code: 'secret' });
      expect(adapter).not.toHaveBeenCalled();
      await expect(recordFleetSession({ path, jobId: 'unsafe-output', input: null }, async ({ call }) => call('tool', null),
        async () => fake)).rejects.toMatchObject({ code: 'secret' });
      expect(readFileSync(path, 'utf8')).not.toContain(fake);
      const run = async () => { throw new Error(`failure with ${fake}`); };
      const result = await recordFleetSession({ path, jobId: 'safe-error', input: null }, run, adapter);
      expect(result).toMatchObject({ status: 'threw', error: { message: 'failure with [REDACTED]' } });
      expect(await replayFleetSession({ path, jobId: 'safe-error' }, run)).toEqual(result);
      expect(readFileSync(path, 'utf8')).not.toContain(fake);
      expect(readReplayFleet(path).sessions.filter((s) => s.outcome === null)).toHaveLength(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
