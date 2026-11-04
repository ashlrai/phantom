/** Read-only detection of old unfinished jobs on lanes reporting no running work. */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USAGE = 'Usage: ashlr fleet lane-stall [--min-minutes N] [--json]\n'
  + 'List unfinished jobs older than N minutes (default 45) on lanes with running 0, grouped by lane. '
  + 'Age uses the .line file modification time. N must be a finite nonnegative number. '
  + 'Reads <ASHLR_RUNS_DIR or ~/.ashlr-runs>/queue. Exits 0 none, 1 stalled or unreadable, 2 bad usage.';

export interface LaneStallReader {
  runLines(): Promise<Array<{ text: string; mtimeMs: number }>>;
  finishedJobs(): Promise<ReadonlySet<string>>;
  queueStatus(): Promise<string>;
}
export interface FleetLaneStallDeps {
  reader?: LaneStallReader;
  runsDir?: string;
  now?: () => number;
}
export interface FleetLaneStallView {
  v: 1;
  minMinutes: number;
  lanes: Array<{ lane: string; jobs: Array<{ job: string; ageMinutes: number }> }>;
}

export function fsLaneStallReader(runsDir: string): LaneStallReader {
  const run = join(runsDir, 'queue', 'run');
  return {
    async runLines() {
      const rows = [];
      for (const name of (await readdir(run)).filter(n => n.endsWith('.line'))) {
        const path = join(run, name);
        rows.push({ text: await readFile(path, 'utf8'), mtimeMs: (await stat(path)).mtimeMs });
      }
      return rows;
    },
    async finishedJobs() {
      return new Set((await readdir(run)).filter(n => n.endsWith('.fin')).map(n => n.slice(0, -4)));
    },
    queueStatus: () => readFile(join(runsDir, 'queue', 'status.json'), 'utf8'),
  };
}

/** Missing or invalid running counts are unknown, never inferred to be zero. */
export async function readFleetLaneStall(reader: LaneStallReader, now: number, minMinutes = 45): Promise<FleetLaneStallView> {
  const status = JSON.parse(await reader.queueStatus()) as { lanes?: Record<string, { running?: unknown } | null> } | null;
  if (!status?.lanes || typeof status.lanes !== 'object' || Array.isArray(status.lanes)) throw new Error('invalid lane status');
  const rows = await reader.runLines();
  // Read markers after rows, so jobs completed during the scan are excluded.
  const finished = await reader.finishedJobs();
  const groups = new Map<string, Array<{ job: string; ageMinutes: number }>>();
  for (const row of rows) {
    const fields = row.text.trimEnd().split('\t');
    const job = fields[0]?.trim(), lane = fields[2]?.trim();
    const age = (now - row.mtimeMs) / 60_000;
    if (!job || !lane || finished.has(job) || !Number.isFinite(age) || age <= minMinutes
      || !Object.hasOwn(status.lanes, lane) || status.lanes[lane]?.running !== 0) continue;
    const jobs = groups.get(lane) ?? [];
    jobs.push({ job, ageMinutes: Math.round(age * 10) / 10 });
    groups.set(lane, jobs);
  }
  return { v: 1, minMinutes, lanes: [...groups].sort(([a], [b]) => a.localeCompare(b))
    .map(([lane, jobs]) => ({ lane, jobs: jobs.sort((a, b) => b.ageMinutes - a.ageMinutes || a.job.localeCompare(b.job)) })) };
}

export async function cmdFleetLaneStall(args: string[], deps: FleetLaneStallDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  let minMinutes = 45, json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!['--json', '--min-minutes'].includes(flag) || seen.has(flag)) { console.error(USAGE); return 2; }
    seen.add(flag);
    if (flag === '--json') { json = true; continue; }
    const raw = args[++i];
    if (raw === undefined || !/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(Number(raw))) {
      console.error(`error: --min-minutes needs a finite nonnegative number\n${USAGE}`); return 2;
    }
    minMinutes = Number(raw);
  }
  try {
    const reader = deps.reader ?? fsLaneStallReader(deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'));
    const view = await readFleetLaneStall(reader, (deps.now ?? Date.now)(), minMinutes);
    if (json) console.log(JSON.stringify(view));
    else if (!view.lanes.length) console.log('No stalled lane jobs.');
    else for (const group of view.lanes) {
      console.log(`${group.lane} (running 0):`);
      for (const job of group.jobs) console.log(`  ${job.job}: ${job.ageMinutes} min old`);
    }
    return view.lanes.length ? 1 : 0;
  } catch { console.error('error: cannot read lane stall state from queue/run and queue/status.json'); return 1; }
}
