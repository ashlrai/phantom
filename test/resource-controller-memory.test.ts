import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readResourceView } from '../src/core/fabric/resource-view-store.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'controller-memory-'))); roots.push(root);
  const fleet = join(root, 'fleet'), runs = join(root, 'runs'), queue = join(runs, 'queue');
  for (const dir of [fleet, runs, queue]) mkdirSync(dir, { mode: 0o700 });
  const now = Date.now(), tick = new Date(Math.floor(now / 1000) * 1000 - 5 * 3_600_000).toISOString().replace('.000Z', '-0500');
  const status = { schema: 'dispatchd.status.v1', last_tick: tick, mem_free_pct: 46, swap_gb: 1.71,
    machine_sample: { schema: 'dispatchd.machine-sample.v1', startedAtMs: now - 1000, memoryPressureFreePct: 46, swapUsedGiB: 1.71 },
    recent_events: ['FIXTURE_PRIVATE_BODY'], budget: { secret: 'FIXTURE_PRIVATE_CREDENTIAL' } };
  const path = join(queue, 'status.json');
  const save = (value: unknown = status) => { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); chmodSync(path, 0o600); utimesSync(path, (now - 100) / 1000, (now - 100) / 1000); };
  const readDevin = async () => ({ status: 'unknown' as const, reason: 'missing-key' });
  return { root, fleet, runs, queue, now, status, path, save, read: () => readResourceView(fleet, now, runs, readDevin) };
}
describe('bounded controller memory advisory', () => {
  it('projects a current producer sample without exposing unrelated fields or changing pool and admission facts', async () => {
    const f = fixture();
    writeFileSync(join(f.fleet, 'fleet.json'), JSON.stringify({ readings: { 'codex-cmp': { pool: 'codex-cmp', pctUsed: 12,
      fetchedAt: new Date(f.now - 1000).toISOString(), resetAt: new Date(f.now + 60_000).toISOString(), source: 'codex-cmp-reader', burnRatePctPerHour: 0 } } }), { mode: 0o600 });
    const baseline = await f.read(); f.save(); const view = await f.read();
    expect(view.controllerMemory).toEqual({ pressureFreePct: 46, observedAt: new Date(f.now - 1000).toISOString() });
    expect(view.pools).toEqual(baseline.pools); expect(view.machine).toEqual(baseline.machine);
    expect(view.machine).toMatchObject({ memFreePct: null, swapUsedPct: null, diskFreePct: null, admission: 'unknown' });
    expect(JSON.stringify(view)).not.toContain('FIXTURE_PRIVATE');
  });
  it.each(['missing','legacy','wrong-schema','wrong-sample-schema','stale-sample','future-sample','stale-tick','future-tick','malformed-tick','stale-file','future-file','invalid-memory','invalid-swap','extra-sample','malformed-json','symlink','hardlink','writable','unsafe-parent'])('withholds %s instead of inventing a current observation', async kind => {
    const f = fixture();
    if (kind === 'legacy') delete (f.status as { machine_sample?: unknown }).machine_sample;
    if (kind === 'wrong-schema') f.status.schema = 'other';
    if (kind === 'wrong-sample-schema') f.status.machine_sample.schema = 'other';
    if (kind === 'stale-sample') f.status.machine_sample.startedAtMs = f.now - 60_000;
    if (kind === 'future-sample') f.status.machine_sample.startedAtMs = f.now + 1000;
    if (kind === 'stale-tick') f.status.last_tick = new Date(f.now - 61_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    if (kind === 'future-tick') f.status.last_tick = new Date(f.now + 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    if (kind === 'malformed-tick') f.status.last_tick = '2026-02-30T20:00:00Z';
    if (kind === 'invalid-memory') f.status.machine_sample.memoryPressureFreePct = 101;
    if (kind === 'invalid-swap') f.status.machine_sample.swapUsedGiB = -1;
    if (kind === 'extra-sample') Object.assign(f.status.machine_sample, { extra: 'unsafe' });
    if (kind !== 'missing') f.save();
    if (kind === 'malformed-json') writeFileSync(f.path, '{');
    if (kind === 'stale-file') utimesSync(f.path, (f.now - 60_000) / 1000, (f.now - 60_000) / 1000);
    if (kind === 'future-file') utimesSync(f.path, (f.now + 60_000) / 1000, (f.now + 60_000) / 1000);
    if (kind === 'symlink') { rmSync(f.path); symlinkSync(join(f.root, 'missing'), f.path); }
    if (kind === 'hardlink') linkSync(f.path, join(f.root, 'alias'));
    if (kind === 'writable') chmodSync(f.path, 0o666);
    if (kind === 'unsafe-parent') chmodSync(f.queue, 0o777);
    expect((await f.read()).controllerMemory).toBeUndefined();
  });
});
