import { expect, it, vi } from 'vitest';
import { diskForecast } from '../src/core/fleet/disk-forecast.js';
import { cmdFleetDiskForecast } from '../src/cli/fleet-disk-forecast.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const history = JSON.stringify([{ at: 1000, free_gb: 250 }, { at: 4600, free_gb: 200 }]);
const jobs = [JSON.stringify({ job: 'a', event: 'launch', ts: new Date(2000 * 1000).toISOString() }),
  JSON.stringify({ job: 'a', event: 'launch', ts: new Date(2000 * 1000).toISOString() })].join('\n');

it('projects the 150 GB free threshold from storage history and counts distinct launches', () => {
  expect(diskForecast(history, jobs, 4600000)).toMatchObject({ status: 'projected', samples: 2, freeGb: 200,
    consumptionGbPerHour: 50, hoursUntilThreshold: 1, crossingAt: new Date(8200 * 1000).toISOString(), launchedJobs: 1 });
});
it('reports unknown, reached, and non-falling evidence without inventing a crossing', () => {
  expect(diskForecast(null, null)).toMatchObject({ status: 'unknown', freeGb: null });
  expect(diskForecast(JSON.stringify([{ at: 1, free_gb: 200 }]), null)).toMatchObject({ status: 'unknown', hoursUntilThreshold: null });
  expect(diskForecast(JSON.stringify([{ at: 1, free_gb: 150 }]), null)).toMatchObject({ status: 'reached', hoursUntilThreshold: 0 });
  expect(diskForecast(JSON.stringify([{ at: 1, free_gb: 200 }, { at: 2, free_gb: 210 }]), null)).toMatchObject({ status: 'not-falling', launchedJobs: null });
  expect(diskForecast('invalid', jobs)).toMatchObject({ status: 'unknown' });
});
it('exposes typed JSON through the CLI and rejects invalid options', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await cmdFleetDiskForecast(['--storage', '/missing/forecast', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ schema: 'fleet.disk-forecast.v1', status: 'unknown' });
    expect(await cmdFleetDiskForecast(['--bad'])).toBe(2);
    expect(typeof (await FLEET_SUBCOMMAND_LOADERS['disk-forecast']!()).cmdFleetDiskForecast).toBe('function');
  } finally { log.mockRestore(); error.mockRestore(); }
});
