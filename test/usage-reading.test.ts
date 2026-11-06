import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cmdUsage } from '../src/cli/usage.js';
import { usageReadingV1Schema } from '../src/core/usage/usage-reading.js';

const reading = { pool: 'grok-ultra', pctUsed: 23, resetAt: null, source: 'grok-reader', fetchedAt: '2026-10-26T12:00:00.000Z' };
const root = mkdtempSync(join(tmpdir(), 'usage-validator-'));
afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('usage-reading.v1', () => {
  it('accepts reader and journal records', () => {
    expect(usageReadingV1Schema.safeParse(reading).success).toBe(true);
    expect(usageReadingV1Schema.safeParse({ ...reading, writtenAt: reading.fetchedAt, event: '429', burnRatePctPerHour: null, projected100At: null, cutActive: false }).success).toBe(true);
    expect(usageReadingV1Schema.safeParse({ ...reading, pctUsed: null, terraResetAt: null }).success).toBe(true);
  });
  it('rejects missing and extra fields and invalid values', () => {
    const { source: _source, ...missing } = reading;
    expect(usageReadingV1Schema.safeParse(missing).success).toBe(false);
    expect(usageReadingV1Schema.safeParse({ ...reading, extra: 'secret' }).success).toBe(false);
    expect(usageReadingV1Schema.safeParse({ ...reading, pctUsed: 101 }).success).toBe(false);
  });
  it('validates all lines without printing input, keys or paths', async () => {
    const log = join(root, 'sensitive-path');
    writeFileSync(log, [JSON.stringify(reading), JSON.stringify({ ...reading, 'sensitive-key': 'sensitive-value' }), '{sensitive-value'].join('\n'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdUsage(['validate', log])).toBe(1);
    expect(error.mock.calls).toEqual([['Invalid usage reading at line 2.'], ['Invalid usage reading at line 3.']]);
    writeFileSync(log, JSON.stringify(reading) + '\n');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdUsage(['validate', log])).toBe(0);
    expect(await cmdUsage(['validate'])).toBe(2);
    rmSync(log);
    expect(await cmdUsage(['validate', log])).toBe(1);
  });
});
