import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { readSource } from '../core/fleet/runs-parked-queue.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { readLaunchCosts } from '../core/fleet/launch-cost.js';
import { readLaunchVitals, type LaunchVitals } from '../core/fleet/launch-vitals.js';
import { readProcessVitals } from '../core/fleet/process-vitals.js';

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

/** Disk contract (above) is unchanged; launch evidence is additive and carries its own state. */
export interface HostVitals extends FleetVitals {
  processes: Awaited<ReturnType<typeof readProcessVitals>>;
  launch: LaunchVitals;
  launchCost: Awaited<ReturnType<typeof readLaunchCosts>>;
}
export async function readHostVitals(root = join(homedir(), '.ashlr-runs'), now = Date.now(), apply?: string): Promise<HostVitals> {
  const [disk, launch, launchCost, processes] = await Promise.all([readFleetVitals(root, now), readLaunchVitals(root), readLaunchCosts(root), readProcessVitals(root, apply)]);
  return { ...disk, launch, launchCost, processes };
}

const USAGE = 'Usage: phm fleet vitals [--runs-dir <directory>] [--json] [--apply <orphan-plan>]\nPreview CPU and memory owners and orphan roots. Apply the preview plan to send SIGTERM to verified terminal-job roots. Missing readings are unknown.';
export async function cmdFleetVitals(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  let root = join(homedir(), '.ashlr-runs'), json = false;
  let apply: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg) || !['--json', '--runs-dir', '--apply'].includes(arg)) { console.error(USAGE); return 2; }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--apply' && /^sha256:[a-f0-9]{64}$/.test(args[i + 1] ?? '')) apply = args[++i];
    else if (arg === '--apply') { console.error(USAGE); return 2; }
    else if (args[i + 1] && !args[i + 1]!.startsWith('-')) root = args[++i]!;
    else { console.error(USAGE); return 2; }
  }
  let report: HostVitals;
  try { report = sanitizePublicJson(await readHostVitals(root, Date.now(), apply)) as HostVitals; }
  catch { const error = 'Orphan plan could not be applied; preview fleet vitals again.'; if (json) console.log(JSON.stringify({ error })); else console.error(error); return 1; }
  if (json) console.log(JSON.stringify(report));
  else {
    console.log(`Disk growth: ${report.status}; free ${report.disk?.free_gb ?? 'unknown'} GB`);
    const p = report.processes, cpu = p.topCpu?.map(r => `${r.owner} ${r.cpuPercentOneCore.toFixed(1)}%`).join(', ') ?? 'unknown';
    const memory = p.topMemory?.map(r => `${r.owner} ${(r.rssBytes / 1024 ** 2).toFixed(1)} MiB`).join(', ') ?? 'unknown';
    console.log(`Process load as of ${p.asOf} (${p.state}): CPU ${cpu}; memory ${memory}; orphan roots ${p.reaper.candidates.length}; SIGTERM sent ${p.reaper.signalled.length}; skipped ${p.reaper.skipped.length}; apply with --apply ${p.reaper.plan}`);
    for (const row of report.disk?.directories ?? [])
      console.log(`${row.path}: ${row.size_gb ?? 'unknown'} GB; change ${row.delta_gb ?? 'unknown'} GB`);
    console.log(`Launch queue: ${report.launch.queued ?? 'unknown'} queued; reason ${report.launch.reason ?? 'unknown'}`);
    console.log(`Next launch window: ${report.launch.nextWindowSeconds === null ? 'unknown' : `${report.launch.nextWindowSeconds} seconds`}`);
    for (const lane of report.launch.lanes) console.log(`${lane.lane}: ${lane.running ?? 'unknown'} running of ${lane.target ?? 'unknown'} target; ${lane.queued ?? 'unknown'} queued`);
    console.log(`Launch cost: ${report.launchCost.state} (source ${report.launchCost.source})`);
    for (const r of report.launchCost.launches)
      console.log(`${r.launchId} / ${r.lane}: ${r.status}; peak processes ${r.peakProcesses ?? 'unknown'}; mean CPU ${r.meanCpuPercentOneCore ?? 'unknown'}%; peak CPU ${r.peakCpuPercentOneCore ?? 'unknown'}%; ${r.sampledSeconds}/60s sampled`);
  }
  return 0;
}
