import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetTickCost } from '../src/cli/fleet-tick-cost.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const dirs: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tick-cost-758-'));
  dirs.push(dir);
  vi.stubEnv('ASHLR_RUNS_DIR', dir);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 21, 19));
  return dir;
}
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function report() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const code = await cmdFleetTickCost(['--json']);
  return { code, data: JSON.parse(String(log.mock.calls.at(-1)![0])) };
}
it('reports fractional wall percentiles and hourly counts within the explicit window', async () => {
  const dir = fixture();
  writeFileSync(join(dir, 'dispatchd.log'), [
    '2026-11-21 16:59:00 old evidence',
    '2026-11-21 17:30:00 tick wall=1.25s',
    '2026-11-21 18:20:00 tick q=4 wall=2.75s',
    '2026-11-21 18:21:00 SLOW timeout',
    '2026-11-21 16:00:00 SLOW old',
    '2026-11-21 20:00:00 SLOW future',
    '2026-11-31 18:00:00 SLOW invalid',
    'bad tick wall=99s',
  ].join('\n'));
  const { code, data } = await report();
  expect(code).toBe(0);
  expect(data).toMatchObject({ known: true, coverageComplete: true, tickCount: 2, tickWallP50: 1.25, tickWallP95: 2.75, slowCount: 1, slowByHour: { '2026-11-21 18': 1 }, slowPerHour: 0.5 });
  expect(Date.parse(data.windowEnd) - Date.parse(data.windowStart)).toBe(2 * 3_600_000);
});
it('keeps missing, empty and truncated coverage rates unknown', async () => {
  const dir = fixture();
  expect((await report())).toMatchObject({ code: 1, data: { known: false, slowPerHour: null, coverageComplete: false } });
  writeFileSync(join(dir, 'dispatchd.log'), '');
  expect((await report()).data).toMatchObject({ known: true, tickCount: 0, tickWallP50: null, slowPerHour: null, coverageComplete: false });
  writeFileSync(join(dir, 'dispatchd.log'), 'x'.repeat(256 * 1024) + '\n2026-11-21 18:00:00 SLOW timeout\n');
  expect((await report()).data).toMatchObject({ truncated: true, slowCount: 1, slowPerHour: null, coverageComplete: false });
});
it('handles help and invalid options and identifies the executable registration dependency', async () => {
  fixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await cmdFleetTickCost(['--help'])).toBe(0);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  expect(await cmdFleetTickCost(['--bad'])).toBe(2);
  expect(error).toHaveBeenCalled();
  expect(resolveFleetSubcommand('tick-cost')).toEqual({ module: './fleet-tick-cost.js', exportName: 'cmdFleetTickCost' });
  expect(FLEET_SUBCOMMAND_LOADERS['tick-cost']).toBeUndefined();
});
