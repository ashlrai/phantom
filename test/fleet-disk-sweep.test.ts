import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetDiskSweep, type FleetDiskSweepDeps } from '../src/cli/fleet-disk-sweep.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

function setup(free: number | null, over: Partial<FleetDiskSweepDeps> = {}) {
  const wtCache = vi.fn(async (_apply: boolean) => ({ code: 0, freedGb: 12.34 }));
  const worktreeStale = vi.fn(async (_apply: boolean) => ({ code: 0, freedGb: 3 }));
  const deps: FleetDiskSweepDeps = {
    now: () => Date.parse('2026-11-04T00:00:00Z'), freeGb: async () => free, freezeBelowGb: async () => 60,
    wtCache, worktreeStale, ...over,
  };
  return { deps, wtCache, worktreeStale };
}

async function run(args: string[], deps: FleetDiskSweepDeps) {
  const out: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m)); });
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => { out.push(String(c)); return true; }) as never);
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const code = await cmdFleetDiskSweep(args, deps);
  log.mockRestore(); write.mockRestore();
  return { code, out: out.join('\n'), err: err.mock.calls.flat().join('\n') };
}

afterEach(() => vi.restoreAllMocks());

describe('fleet disk-sweep', () => {
  it('does nothing when disk is above the freeze line', async () => {
    const { deps, wtCache, worktreeStale } = setup(100);
    const r = await run([], deps);
    expect(r.code).toBe(0);
    expect(r.out).toContain('disk ok: 100 GB free');
    expect(wtCache).not.toHaveBeenCalled();
    expect(worktreeStale).not.toHaveBeenCalled();
  });

  it('sweeps both steps in order below the line and passes --apply', async () => {
    const order: string[] = [];
    const { deps } = setup(40, {
      wtCache: vi.fn(async () => { order.push('cache'); return { code: 0, freedGb: 12.34 }; }),
      worktreeStale: vi.fn(async () => { order.push('stale'); return { code: 0, freedGb: 3 }; }),
    });
    const r = await run(['--apply'], deps);
    expect(order).toEqual(['cache', 'stale']);
    expect(deps.wtCache).toHaveBeenCalledWith(true);
    expect(deps.worktreeStale).toHaveBeenCalledWith(true);
    expect(r.out).toContain('wt-cache: ok, 12.3 GB freed');
    expect(r.out).toContain('worktree-stale: ok, 3 GB freed');
    expect(r.out).toContain('freed: 15.3 GB');
  });

  it('is a dry run without --apply', async () => {
    const { deps, wtCache } = setup(10);
    const r = await run([], deps);
    expect(wtCache).toHaveBeenCalledWith(false);
    expect(r.out).toContain('dry run');
  });

  it('--force sweeps even when disk is fine', async () => {
    const { deps, wtCache, worktreeStale } = setup(500);
    await run(['--force'], deps);
    expect(wtCache).toHaveBeenCalledOnce();
    expect(worktreeStale).toHaveBeenCalledOnce();
  });

  it('uses the configured freeze line and sweeps when free disk is unreadable', async () => {
    const a = setup(70, { freezeBelowGb: async () => 80 });
    await run([], a.deps);
    expect(a.wtCache).toHaveBeenCalledOnce();
    const b = setup(null);
    await run([], b.deps);
    expect(b.wtCache).toHaveBeenCalledOnce();
  });

  it('measures worktree-stale GB from the free-disk change when the step reports NaN', async () => {
    const reads = [40, 47];
    const { deps } = setup(40, {
      freeGb: async () => reads.shift() ?? 47,
      worktreeStale: async () => ({ code: 0, freedGb: Number.NaN }),
      wtCache: async () => ({ code: 0, freedGb: 1 }),
    });
    const r = await run(['--apply', '--json'], deps);
    const view = JSON.parse(r.out);
    expect(view.steps[1]).toMatchObject({ name: 'worktree-stale', freedGb: 7 });
    expect(view.freedGb).toBe(8);
  });

  it('keeps going and exits 1 when a step fails or throws', async () => {
    const { deps, worktreeStale } = setup(10, { wtCache: async () => { throw new Error('boom'); } });
    const r = await run([], deps);
    expect(r.code).toBe(1);
    expect(worktreeStale).toHaveBeenCalledOnce();
    expect(r.out).toContain('wt-cache: FAILED (exit 1)');
  });

  it('--json prints the typed view', async () => {
    const r = await run(['--json'], setup(100).deps);
    expect(JSON.parse(r.out)).toMatchObject({ v: 1, swept: false, freeGb: 100, freezeBelowGb: 60, freedGb: 0 });
  });

  it('rejects bad usage with exit 2 and prints help with exit 0', async () => {
    expect((await run(['--nope'], setup(1).deps)).code).toBe(2);
    expect((await run(['--force', '--force'], setup(1).deps)).code).toBe(2);
    expect((await run(['extra'], setup(1).deps)).code).toBe(2);
    expect((await run(['--help'], setup(1).deps)).code).toBe(0);
  });

  it('is registered as a fleet subcommand', async () => {
    expect(typeof (await FLEET_SUBCOMMAND_LOADERS['disk-sweep']!()).cmdFleetDiskSweep).toBe('function');
  });
});
