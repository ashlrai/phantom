import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { readSource } from '../core/fleet/runs-parked-queue.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const number = z.number().finite();
const diskSchema = z.object({
  sampled_at: number, previous_sampled_at: number.nullable(), free_gb: number.nonnegative(),
  directories: z.array(z.object({ path: z.string(), size_gb: number.nonnegative().nullable(), delta_gb: number.nullable() })),
  growth_gb_per_h: number.nullable(), hours_to_reuse_only: number.nonnegative().nullable(), timed_out: z.boolean(),
});
export interface FleetVitals {
  schema: 'fleet.vitals.v1';
  status: 'ok' | 'partial' | 'stale' | 'unknown';
  disk: z.infer<typeof diskSchema> | null;
}

/** Read the bounded host sample; no traversal or cleanup happens in this view. */
export async function readFleetVitals(root = join(homedir(), '.ashlr-runs'), now = Date.now()): Promise<FleetVitals> {
  const report: FleetVitals = { schema: 'fleet.vitals.v1', status: 'unknown', disk: null };
  try {
    const source = await readSource(join(root, 'queue/disk-growth.json'), 1024 * 1024, false);
    if (source.state !== 'healthy') return report;
    const disk = diskSchema.parse(JSON.parse(source.text));
    if (disk.sampled_at * 1000 > now) return report;
    return { ...report, disk, status: now - disk.sampled_at * 1000 > 900_000 ? 'stale'
      : disk.timed_out || disk.directories.some(row => row.size_gb === null) ? 'partial' : 'ok' };
  } catch { return report; }
}

export async function cmdFleetVitals(args: string[]): Promise<number> {
  const usage = 'Usage: phm fleet vitals [--json]\nDisk sizes and change since the previous host sample. Missing readings are unknown.';
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(usage); return 2; }
  const report = sanitizePublicJson(await readFleetVitals()) as FleetVitals;
  if (args.includes('--json')) console.log(JSON.stringify(report));
  else {
    console.log(`Disk growth: ${report.status}; free ${report.disk?.free_gb ?? 'unknown'} GB`);
    for (const row of report.disk?.directories ?? [])
      console.log(`${row.path}: ${row.size_gb ?? 'unknown'} GB; change ${row.delta_gb ?? 'unknown'} GB`);
  }
  return 0;
}
