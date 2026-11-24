import { localModelsVitals } from '../core/resources/local-memory-fit.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { readSource } from '../core/fleet/runs-parked-queue.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { readLaunchCosts } from '../core/fleet/launch-cost.js';
import { readLocalGateEvidence, type LocalGateEvidence } from '../core/fleet/local-gate.js';
import { readSwapoutRateEvidence, type SwapoutRateEvidence } from '../core/fleet/swapout-sync.js';
import { MEMORY_GUARD } from '../core/resources/lane-autopilot.js';
import { readLaunchVitals, type LaunchVitals } from '../core/fleet/launch-vitals.js';
import { readEmptyCauses, topEmptyCauses, type EmptyCause } from '../core/fleet/empty-cause.js';
import { stuckSummaryLine } from '../core/fleet/stuck-jobs.js';
import { leaderLivenessLine, readLeaderLiveness, type LeaderLiveness } from '../core/fleet/leader-liveness-evidence.js';
import { readStuckJobs } from './fleet-stuck.js';

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
  local_models: ReturnType<typeof localModelsVitals>;
  launch: LaunchVitals;
  launchCost: Awaited<ReturnType<typeof readLaunchCosts>>;
  /** Top three causes of empty jobs in the last 24 hours (legacy log-tail diagnostic); total null = ledger unreadable. */
  emptyCauses: { window_hours: 24; total: number | null; top: Array<{ cause: EmptyCause; count: number }> };
  /** Jobs that keep being refused or failing and never launch (`phm fleet stuck` has the detail); count null = event log unreadable. */
  stuck: { count: number | null; oldestAgeSeconds: number | null };
}
export async function readHostVitals(root = join(homedir(), '.ashlr-runs'), now = Date.now()): Promise<HostVitals> {
  const [disk, launch, launchCost, empties, stuck] = await Promise.all([readFleetVitals(root, now), readLaunchVitals(root), readLaunchCosts(root), readEmptyCauses(root, now, 24), readStuckJobs({ runsDir: root }, now)]);
  return { ...disk, launch, launchCost, local_models: localModelsVitals(root, now), emptyCauses: { window_hours: 24, total: empties.total, top: topEmptyCauses(empties) },
    stuck: { count: stuck.count, oldestAgeSeconds: stuck.oldestAgeSeconds } };
}

/**
 * `phm fleet vitals` view: HostVitals unchanged plus independent leader and
 * local-gate ledger evidence. Kept out of readHostVitals so that exported
 * shape (and its exact-key contract test) stays byte-compatible.
 * Unknown is null; a stale planner is evidence only and grants no authority.
 */
export type FleetVitalsView = HostVitals & { leader_liveness: LeaderLiveness; local_gate: LocalGateEvidence; swapout_rate: SwapoutRateEvidence };
export async function readFleetVitalsView(root = join(homedir(), '.ashlr-runs'), now = Date.now()): Promise<FleetVitalsView> {
  const [host, leader_liveness, local_gate, swapout_rate] = await Promise.all([readHostVitals(root, now), readLeaderLiveness(root, now), readLocalGateEvidence(root), readSwapoutRateEvidence(root, { guard: MEMORY_GUARD })]);
  return { ...host, leader_liveness, local_gate, swapout_rate };
}

const USAGE = 'Usage: phm fleet vitals [--runs-dir <directory>] [--json]\nDisk sizes and change since the previous host sample, plus launch queue, first-minute launch cost, the top three causes of empty jobs in 24 hours and how many jobs are stuck. Missing readings are unknown.';
export async function cmdFleetVitals(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  let root = join(homedir(), '.ashlr-runs'), json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg) || !['--json', '--runs-dir'].includes(arg)) { console.error(USAGE); return 2; }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (args[i + 1] && !args[i + 1]!.startsWith('-')) root = args[++i]!;
    else { console.error(USAGE); return 2; }
  }
  const report = sanitizePublicJson(await readFleetVitalsView(root)) as FleetVitalsView;
  if (json) console.log(JSON.stringify(report));
  else {
    console.log(`Disk growth: ${report.status}; free ${report.disk?.free_gb ?? 'unknown'} GB`);
    for (const row of report.disk?.directories ?? [])
      console.log(`${row.path}: ${row.size_gb ?? 'unknown'} GB; change ${row.delta_gb ?? 'unknown'} GB`);
    console.log(`Launch queue: ${report.launch.queued ?? 'unknown'} queued; reason ${report.launch.reason ?? 'unknown'}`);
    console.log(`Next launch window: ${report.launch.nextWindowSeconds === null ? 'unknown' : `${report.launch.nextWindowSeconds} seconds`}`);
    for (const lane of report.launch.lanes) console.log(`${lane.lane}: ${lane.running ?? 'unknown'} running of ${lane.target ?? 'unknown'} target; ${lane.queued ?? 'unknown'} queued`);
    console.log(`Launch cost: ${report.launchCost.state} (source ${report.launchCost.source})`);
    const local = report.local_models.models.find(row => row.verdict !== 'fits') ?? report.local_models.models[0];
    console.log(local ? `${local.reason}${local.verdict === 'fits' ? '' : '; local routing withheld'}` : 'Local models: loaded models, memory fit and last unload reason unknown');
    for (const r of report.launchCost.launches)
      console.log(`${r.launchId} / ${r.lane}: ${r.status}; peak processes ${r.peakProcesses ?? 'unknown'}; mean CPU ${r.meanCpuPercentOneCore ?? 'unknown'}%; peak CPU ${r.peakCpuPercentOneCore ?? 'unknown'}%; ${r.sampledSeconds}/60s sampled`);
    const gate = report.local_gate;
    const failingSteps = gate.steps.filter(step => step.failures > 0).slice(0, 3).map(step => `${step.name} x${step.failures}`);
    console.log(gate.state === 'known'
      ? `Local gate: ${gate.passed}/${gate.reports} reports passed (source ${gate.source})${failingSteps.length ? `; failing ${failingSteps.join(', ')}` : ''}`
      : `Local gate: unknown (source ${gate.source})`);
    const mem = report.swapout_rate;
    console.log(mem.state === 'known'
      ? `Memory samples: ${mem.samples} recorded (${mem.oldestAt?.slice(0, 10) ?? 'unknown'} to ${mem.newestAt?.slice(0, 10) ?? 'unknown'}); swapouts/min mean ${mem.swapoutsMean ?? 'unknown'}, max ${mem.swapoutsMax ?? 'unknown'}, ${mem.swapoutsPositive} above zero`
      : `Memory samples: unknown (source ${mem.source})`);
    const guard = mem.memoryGuard;
    if (mem.state === 'known' && guard !== null) {
      const c = guard.constants;
      const pct = (share: number | null) => share === null ? 'unknown' : `${Math.round(share * 100)}%`;
      console.log(`Memory guard: free<${c.lowFreePct}% ${pct(guard.freeBelowLowShare)}, free>${c.raiseFreePct}% ${pct(guard.freeAboveRaiseShare)}, swapouts≥${c.growingSwapoutsPerMin}/min ${pct(guard.swapoutsGrowingShare)}, swap>${c.swapBackstopGb}GB ${pct(guard.swapAboveBackstopShare)} (share of samples carrying each field)`);
    }
    const empties = report.emptyCauses;
    console.log(`Empty causes (24h): ${empties.total === null ? 'unknown' : empties.top.length
      ? `${empties.top.map(c => `${c.cause} ${c.count}`).join(', ')} of ${empties.total}` : 'none'}`);
    console.log(stuckSummaryLine(report.stuck));
    console.log(leaderLivenessLine(report.leader_liveness));
  }
  return 0;
}
