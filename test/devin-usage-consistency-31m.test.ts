import { describe, expect, it, vi } from 'vitest';
import { createDevinUsageReader, DEVIN_USAGE_TTL_MS } from '../src/core/fabric/readers/devin-usage.js';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const reading = (fields: Record<string, unknown> = {}) => ({
  pool: 'devin', acuUsed: 25, acuLimit: 100, pctUsed: 25,
  resetAt: '2026-11-01T08:00:00.000Z', source: 'devin-api-v3-org-cycle',
  fetchedAt: new Date(NOW).toISOString(), ...fields,
});
const resultFor = (body: unknown) => createDevinUsageReader({
  run: async () => JSON.stringify(body), now: () => NOW,
})();

describe('Devin usage evidence consistency', () => {
  it.each([
    { pctUsed: 0 }, { pctUsed: null }, { pctUsed: 26 },
    { acuLimit: 0, pctUsed: 0 }, { acuUsed: 150, pctUsed: 100 },
  ])('rejects a percentage inconsistent with ACUs: %j', async fields => {
    expect(await resultFor(reading(fields))).toEqual({ status: 'unknown', reason: 'inconsistent-percentage' });
  });

  it('preserves a zero limit and a legitimate overage', async () => {
    expect(await resultFor(reading({ acuUsed: 20, acuLimit: 0, pctUsed: null })))
      .toMatchObject({ acuUsed: 20, acuLimit: 0, pctUsed: null });
    expect(await resultFor(reading({ acuUsed: 150, pctUsed: 150 })))
      .toMatchObject({ acuUsed: 150, acuLimit: 100, pctUsed: 150 });
    expect(await resultFor(reading({ acuUsed: 1, acuLimit: 3, pctUsed: 1 / 3 * 100 })))
      .toMatchObject({ pctUsed: 1 / 3 * 100 });
  });

  it.each([
    ['resetAt', '2026-02-29T00:00:00.000Z'], ['resetAt', '2026-04-31T00:00:00.000Z'],
    ['fetchedAt', '2026-02-30T12:00:00.000Z'], ['fetchedAt', '2026-10-26T24:00:00.000Z'],
    ['fetchedAt', '2026-10-26T12:00:60.000Z'],
  ])('rejects impossible calendar instant %s = %s', async (field, value) => {
    expect(await resultFor(reading({ [field]: value }))).toEqual({ status: 'unknown', reason: 'malformed-body' });
  });

  it('accepts a real leap day and rejects non-finite derived percentages', async () => {
    expect(await resultFor(reading({ fetchedAt: '2024-02-29T00:00:00.000Z' }))).toMatchObject({ pool: 'devin' });
    expect(await resultFor(reading({ acuUsed: Number.MAX_VALUE, acuLimit: Number.MIN_VALUE, pctUsed: 0 })))
      .toEqual({ status: 'unknown', reason: 'malformed-body' });
  });

  it('rejects future observations and cycles expired at or before the current instant', async () => {
    expect(await resultFor(reading({ fetchedAt: new Date(NOW + 1).toISOString() })))
      .toEqual({ status: 'unknown', reason: 'future-fetched-at' });
    for (const offset of [0, -1]) {
      expect(await resultFor(reading({ resetAt: new Date(NOW + offset).toISOString() })))
        .toEqual({ status: 'unknown', reason: 'expired-cycle' });
    }
  });

  it('coalesces concurrent reads and expires a successful cache at cycle end', async () => {
    let clock = NOW;
    let resolve!: (value: string) => void;
    const run = vi.fn(() => new Promise<string>(done => { resolve = done; }));
    const read = createDevinUsageReader({ run, now: () => clock });
    const first = read(); const second = read();
    expect(run).toHaveBeenCalledTimes(1);
    resolve(JSON.stringify(reading({ resetAt: new Date(NOW + 10_000).toISOString() })));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b); expect(a).not.toBe(b);
    clock += 9_999; await read(); expect(run).toHaveBeenCalledTimes(1);
    clock += 1;
    const next = read(); expect(run).toHaveBeenCalledTimes(2);
    resolve(JSON.stringify(reading({ resetAt: new Date(NOW + 10_000).toISOString() })));
    expect(await next).toEqual({ status: 'unknown', reason: 'expired-cycle' });
  });

  it('retains the successful five-minute TTL and recovers quickly after a transient failure', async () => {
    let clock = NOW;
    const run = vi.fn().mockRejectedValueOnce(new Error('transient')).mockImplementation(async () => JSON.stringify(reading()));
    const read = createDevinUsageReader({ run, now: () => clock });
    expect(await read()).toEqual({ status: 'unknown', reason: 'custody-unavailable' });
    clock += 29_999; await read(); expect(run).toHaveBeenCalledTimes(1);
    clock += 1; expect(await read()).toMatchObject({ pctUsed: 25 });
    expect(run).toHaveBeenCalledTimes(2);
    clock += DEVIN_USAGE_TTL_MS - 1; await read(); expect(run).toHaveBeenCalledTimes(2);
    clock += 1; await read(); expect(run).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['past', NOW - 1, 30_000], ['invalid', 'invalid', 30_000],
    ['ordinary', NOW + 600_000, 600_000], ['far future', Number.MAX_SAFE_INTEGER, 86_400_000],
  ])('bounds %s rate-limit retry time', async (_label, retryAt, delay) => {
    let clock = NOW;
    const run = vi.fn(async () => JSON.stringify({ status: 'unknown', reason: 'rate-limited', retryAt }));
    const read = createDevinUsageReader({ run, now: () => clock });
    expect(await read()).toEqual({ status: 'unknown', reason: 'rate-limited' });
    clock += delay - 1; await read(); expect(run).toHaveBeenCalledTimes(1);
    clock += 1; await read(); expect(run).toHaveBeenCalledTimes(2);
  });
});
