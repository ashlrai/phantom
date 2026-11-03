import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const usage = 'Usage: phm fleet job-latency [--jobs <jobs.jsonl>] [--json]';
const phases = [
  ['queue_wait', 'queued', 'launch', 'Measure admission delays and remove the largest queue bottleneck.'],
  ['checkout', 'launch', 'checkout_complete', 'Profile checkout and reuse safe local worktree preparation.'],
  ['model', 'checkout_complete', 'finish', 'Profile model execution and reduce repeated context and tool work.'],
  ['ci', 'ci_start', 'ci_complete', 'Profile CI critical path and eliminate duplicate work.'],
  ['merge', 'ci_complete', 'merged', 'Profile post-CI merge delays and unblock the merge queue.'],
] as const;

type Events = Map<string, number[]>;

/** A job ID must identify one attempt; ambiguous repeated boundaries are never paired. */
export function jobLatency(text: string) {
  const jobs = new Map<string, Events>();
  let ignored = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      row = value as Record<string, unknown>;
    } catch { ignored++; continue; }
    const id = row.job ?? row.job_id ?? row.jobId;
    let event = row.event ?? row.type;
    if (event === 'outcome' && String(row.outcome ?? row.state).toLowerCase() === 'merged') event = 'merged';
    const time = row.ts ?? row.timestamp ?? row.at;
    const at = typeof time === 'string' ? Date.parse(time) : NaN;
    if (typeof id !== 'string' || !id || typeof event !== 'string' || !Number.isFinite(at)) { ignored++; continue; }
    const events = jobs.get(id) ?? new Map<string, number[]>();
    const times = events.get(event) ?? [];
    if (!times.includes(at)) times.push(at);
    events.set(event, times); jobs.set(id, events);
  }
  const results = phases.map(([phase, start, end, fix]) => {
    const samples: number[] = [];
    for (const events of jobs.values()) {
      const a = events.get(start), b = events.get(end);
      if (a?.length === 1 && b?.length === 1 && b[0]! >= a[0]!) samples.push((b[0]! - a[0]!) / 1000);
    }
    return { phase, measured_jobs: samples.length, missing_jobs: jobs.size - samples.length,
      total_seconds: samples.length ? samples.reduce((a, b) => a + b, 0) : null, fix_line: fix };
  });
  return { schema: 'fleet.job-latency.v1', jobs: jobs.size, ignored_events: ignored, phases: results,
    top_wastes: results.filter(r => r.total_seconds !== null).sort((a, b) => b.total_seconds! - a.total_seconds!) };
}

export async function cmdFleetJobLatency(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let path = join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl');
  let json = false, seenPath = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--jobs' && !seenPath && args[i + 1] && !args[i + 1]!.startsWith('--')) { path = args[++i]!; seenPath = true; }
    else { console.error(usage); return 2; }
  }
  try {
    const report = jobLatency(await readFile(path, 'utf8'));
    console.log(json ? JSON.stringify(report) : JSON.stringify(report, null, 2));
    return 0;
  } catch { console.error('error: unable to read jobs ledger'); return 1; }
}
