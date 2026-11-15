import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readResourceView } from '../src/core/fabric/resource-view-store.js';
import type { DevinUsage, DevinUsageResult } from '../src/core/fabric/readers/devin-usage.js';
import type { ResourceView } from '../src/core/fabric/resource-view.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const NOW = Date.parse('2026-10-26T16:00:00.000Z');
const live: DevinUsage = { pool: 'devin', acuUsed: 40, acuLimit: 100, pctUsed: 40,
  resetAt: new Date(NOW + 3_600_000).toISOString(), source: 'devin-api-v3-org-cycle',
  fetchedAt: new Date(NOW - 1_000).toISOString() };
const codexReading = { pool: 'codex-cmp', pctUsed: 12, resetAt: new Date(NOW + 3_600_000).toISOString(),
  fetchedAt: new Date(NOW - 1_000).toISOString(), source: 'codex-cmp-reader' };

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-devin-'))); roots.push(root);
  const fleet = join(root, 'fleet'), runs = join(root, 'runs');
  for (const dir of [fleet, runs]) mkdirSync(dir, { mode: 0o700 });
  return { root, fleet, runs };
}
function devinPool(view: ResourceView) {
  const pool = view.pools.find(row => row.pool === 'devin');
  if (!pool) throw new Error('devin pool missing');
  return pool;
}
function codexPool(view: ResourceView) {
  const pool = view.pools.find(row => row.pool === 'codex-cmp');
  if (!pool) throw new Error('codex-cmp pool missing');
  return pool;
}
const liveRead = () => vi.fn(async (): Promise<DevinUsageResult> => live);

describe('readResourceView independent live Devin read', () => {
  // RQ-SWE3-RESBAR-FIX-1 / PR #4083 rework: an absent or corrupt fleet.json used
  // to return before the live reader ran, leaving the Devin bar empty.
  it.each(['missing', 'corrupt', 'invalid-shape'])('consults the live reader when fleet.json is %s', async kind => {
    const f = fixture();
    const file = join(f.fleet, 'fleet.json');
    if (kind === 'corrupt') writeFileSync(file, '{ resources:', { mode: 0o600 });
    if (kind === 'invalid-shape') writeFileSync(file, JSON.stringify({ resources: [live] }), { mode: 0o600 });
    const read = liveRead();
    const view = await readResourceView(f.fleet, NOW, f.runs, read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(devinPool(view)).toMatchObject({ pctUsed: 40, resetAt: live.resetAt,
      source: 'devin-api-v3-org-cycle', fetchedAt: live.fetchedAt });
    for (const pool of view.pools) if (pool.pool !== 'devin') expect(pool.status).toBe('unknown');
  });

  it('still refuses unsafe file contents while reporting the live reading', async () => {
    const f = fixture();
    const file = join(f.fleet, 'fleet.json');
    writeFileSync(file, JSON.stringify({ readings: { 'codex-cmp': { ...codexReading, pctUsed: 99 } } }), { mode: 0o666 });
    chmodSync(file, 0o666);
    const read = liveRead();
    const view = await readResourceView(f.fleet, NOW, f.runs, read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(devinPool(view).pctUsed).toBe(40);
    expect(codexPool(view).pctUsed).toBeNull();
  });

  it('merges the live reading over a valid snapshot without touching other pools', async () => {
    const f = fixture();
    writeFileSync(join(f.fleet, 'fleet.json'), JSON.stringify({
      readings: { 'codex-cmp': codexReading },
      resources: { devin: { pool: 'devin', pctUsed: 99, resetAt: live.resetAt,
        fetchedAt: live.fetchedAt, source: 'devin-api-v3-org-cycle' } },
    }), { mode: 0o600 });
    const read = liveRead();
    const view = await readResourceView(f.fleet, NOW, f.runs, read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(devinPool(view).pctUsed).toBe(40);
    expect(codexPool(view).pctUsed).toBe(12);
  });

  it('reports Devin unknown, never fabricated, when the live read fails', async () => {
    const f = fixture();
    const read = vi.fn(async (): Promise<DevinUsageResult> => { throw new Error('TEST-custody-down'); });
    const view = await readResourceView(f.fleet, NOW, f.runs, read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(devinPool(view)).toMatchObject({ pctUsed: null, status: 'unknown', source: null });
    expect(JSON.stringify(view)).not.toContain('TEST-custody-down');
  });

  it('bounds a hung live read instead of stalling the view', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const read = vi.fn(() => new Promise<DevinUsageResult>(() => {}));
      let settled = false;
      const pending = readResourceView(f.fleet, NOW, f.runs, read).then(view => { settled = true; return view; });
      for (let i = 0; i < 8 && !settled; i += 1) await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toBe(true);
      expect(read).toHaveBeenCalledTimes(1);
      expect(devinPool(await pending)).toMatchObject({ pctUsed: null, status: 'unknown' });
    } finally { vi.useRealTimers(); }
  });
});
