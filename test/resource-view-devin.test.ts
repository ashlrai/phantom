import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEVIN_READ_BOUND_MS, readResourceView } from '../src/core/fabric/resource-view-store.js';
import type { DevinUsageResult } from '../src/core/fabric/readers/devin-usage.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(now: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resource-view-devin-'))); roots.push(root);
  const fleet = join(root, 'fleet'), runs = join(root, 'runs');
  for (const dir of [fleet, runs]) mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(fleet, 'fleet.json'), JSON.stringify({ readings: { 'codex-cmp': { pool: 'codex-cmp', pctUsed: 12,
    fetchedAt: new Date(now - 1000).toISOString(), resetAt: new Date(now + 60_000).toISOString(), source: 'codex-cmp-reader', burnRatePctPerHour: 0 } } }), { mode: 0o600 });
  return { fleet, runs, read: (devinRead?: () => Promise<DevinUsageResult>) => readResourceView(fleet, now, runs, devinRead) };
}
const devinRow = (now: number, pctUsed: number | null, acuLimit = 50): DevinUsageResult => ({
  pool: 'devin', acuUsed: 20, acuLimit, pctUsed,
  resetAt: new Date(now + 86_400_000).toISOString(), source: 'devin-api-v3-org-cycle',
  fetchedAt: new Date(now - 30_000).toISOString(),
});

describe('live Devin usage in resource.v1', () => {
  it('surfaces the org-cycle reading the custody reader produced, without touching other pools', async () => {
    const now = Date.now(), f = fixture(now);
    const view = await f.read(async () => devinRow(now, 40));
    const devin = view.pools.find((pool) => pool.pool === 'devin');
    expect(devin).toMatchObject({ pctUsed: 40, source: 'devin-api-v3-org-cycle',
      fetchedAt: new Date(now - 30_000).toISOString(), resetAt: new Date(now + 86_400_000).toISOString() });
    expect(view.pools.find((pool) => pool.pool === 'codex-cmp')).toMatchObject({ pctUsed: 12 });
  });
  it('keeps the zero-limit (unmetered) reading honest: the provider reported, no percentage exists', async () => {
    const now = Date.now(), f = fixture(now);
    const view = await f.read(async () => devinRow(now, null, 0));
    expect(view.pools.find((pool) => pool.pool === 'devin')).toMatchObject({
      pctUsed: null, status: 'unknown', source: 'devin-api-v3-org-cycle', resetAt: new Date(now + 86_400_000).toISOString() });
    expect(JSON.stringify(view)).not.toContain('acuUsed');
  });
  it.each([{ status: 'unknown' as const, reason: 'missing-key' }, new Error('reader threw')])('keeps the lane unknown without leaking a reader failure detail: %j', async failure => {
    const now = Date.now(), f = fixture(now);
    const view = await f.read(async (): Promise<DevinUsageResult> => {
      if (failure instanceof Error) throw failure;
      return failure;
    });
    expect(view.pools.find((pool) => pool.pool === 'devin')).toMatchObject({ pctUsed: null, status: 'unknown', source: null });
    expect(JSON.stringify(view)).not.toContain('missing-key');
    expect(JSON.stringify(view)).not.toContain('reader threw');
  });
  it('never stalls the view on a slow custody read; the lane reports unknown until the reader lands', async () => {
    const now = Date.now(), f = fixture(now);
    const view = await f.read(async () => new Promise<DevinUsageResult>(() => undefined));
    expect(view.pools.find((pool) => pool.pool === 'devin')).toMatchObject({ pctUsed: null, status: 'unknown' });
    expect(view.pools.find((pool) => pool.pool === 'codex-cmp')).toMatchObject({ pctUsed: 12 });
  }, DEVIN_READ_BOUND_MS * 3);
  it('runs no custody read when the lane is not requested', async () => {
    const now = Date.now(), f = fixture(now);
    const view = await f.read();
    expect(view.pools.find((pool) => pool.pool === 'devin')).toMatchObject({ pctUsed: null, status: 'unknown', source: null });
  });
});
