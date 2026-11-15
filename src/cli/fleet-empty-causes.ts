/**
 * `phm fleet empty-causes`: read-only cause breakdown of one lane's empty runs
 * (RQ-CODEXP-EMPTY-1). Logic lives in core/fleet/lane-empty-causes.ts; this file
 * only parses argv and does bounded, no-follow reads under the runs dir.
 */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildLaneEmptyCauses,
  EMPTY_CAUSES_DEFAULT_LIMIT,
  EMPTY_CAUSES_DEFAULT_RATE_WINDOW,
  EMPTY_CAUSES_MAX,
  laneEmptyCandidates,
  type EmptyJobEvidence,
  type LaneEmptyCausesV1,
} from '../core/fleet/lane-empty-causes.js';
import { readDispatchEventsLog } from './fleet-lane-streaks.js';

const LEDGER_TAIL = 8 * 1024 * 1024;
const FILE_TAIL = 64 * 1024;
const LANE = /^[a-z][a-z0-9-]{0,39}$/;
const usage = `phm fleet empty-causes --lane <lane> [--last N] [--rate-window N] [--max-rate R] [--json]
Read-only. Classifies the lane's newest N (default ${EMPTY_CAUSES_DEFAULT_LIMIT}) empty runs as
duplicate-landed, prompt-unclear, launch-auth-error, timeout or no-diff, and reports the
empty rate over its newest --rate-window (default ${EMPTY_CAUSES_DEFAULT_RATE_WINDOW}) ended launches.
Exit 2 when --max-rate is given and the rate is above it.`;

/** Tail of a regular file (no symlinks); null when absent or unreadable. */
export async function readTail(path: string, size: number): Promise<string | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile()) return null;
    const length = Math.min(info.size, size);
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await file.read(bytes, 0, length, info.size - length);
    const text = bytes.subarray(0, bytesRead).toString('utf8');
    // A cut tail starts mid-line; drop the torn first line.
    return info.size > size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return null; } finally { await file?.close(); }
}

async function isFile(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile(); } catch { return false; }
}

/** Job ids are SAFE_ID-checked in core before they reach any of these paths. */
async function jobEvidence(runs: string, worktrees: string, job: string): Promise<EmptyJobEvidence> {
  const [log, notes, launched, queued, timedOut] = await Promise.all([
    readTail(join(runs, `${job}.log`), FILE_TAIL),
    readTail(join(worktrees, job, 'BRIDGE_NOTES.md'), FILE_TAIL),
    readTail(join(runs, `${job}.prompt`), FILE_TAIL),
    readTail(join(runs, 'queue', 'prompts', `${job}.md`), FILE_TAIL),
    isFile(join(runs, 'queue', 'run', `${job}.timeout`)),
  ]);
  // launch.sh's copy carries the appended RULES block, so prefer it for echo removal.
  return { log, notes, prompt: launched ?? queued, timedOut };
}

export interface FleetEmptyCausesDeps {
  runsDir?: string;
  worktreesDir?: string;
  now?: () => number;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

function count(value: string | undefined, max: number): number | null {
  return value !== undefined && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= max ? Number(value) : null;
}

export async function cmdFleetEmptyCauses(args: string[], deps: FleetEmptyCausesDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { out(usage); return 0; }
  let lane: string | null = null;
  let limit = EMPTY_CAUSES_DEFAULT_LIMIT;
  let rateWindow = EMPTY_CAUSES_DEFAULT_RATE_WINDOW;
  let maxRate: number | null = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = args[i + 1];
    if (arg === '--json') json = true;
    else if (arg === '--lane' && value !== undefined && LANE.test(value)) { lane = value; i++; }
    else if (arg === '--last' && count(value, EMPTY_CAUSES_MAX) !== null) { limit = count(value, EMPTY_CAUSES_MAX)!; i++; }
    else if (arg === '--rate-window' && count(value, EMPTY_CAUSES_MAX) !== null) { rateWindow = count(value, EMPTY_CAUSES_MAX)!; i++; }
    else if (arg === '--max-rate' && value !== undefined && /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)) { maxRate = Number(value); i++; }
    else { err(`fleet empty-causes: bad flag or value: ${arg}\n${usage}`); return 1; }
  }
  if (!lane) { err(`fleet empty-causes: --lane is required\n${usage}`); return 1; }

  const runs = deps.runsDir ?? (process.env.ASHLR_RUNS_DIR?.trim() || join(homedir(), '.ashlr-runs'));
  const worktrees = deps.worktreesDir ?? (process.env.ASHLR_WT_DIR?.trim() || join(homedir(), 'Projects/ashlrai/wt'));
  const nowMs = (deps.now ?? Date.now)();
  const [eventsText, jobsText] = await Promise.all([
    readDispatchEventsLog(runs).catch(() => null),
    readTail(join(runs, 'metrics', 'jobs.jsonl'), LEDGER_TAIL),
  ]);
  const candidates = laneEmptyCandidates(eventsText, jobsText, lane, limit);
  const evidence = new Map<string, EmptyJobEvidence>();
  for (let offset = 0; offset < candidates.length; offset += 16) {
    const batch = candidates.slice(offset, offset + 16);
    const read = await Promise.all(batch.map(candidate => jobEvidence(runs, worktrees, candidate.job)));
    batch.forEach((candidate, index) => evidence.set(candidate.job, read[index]!));
  }
  const report = buildLaneEmptyCauses({ lane, nowMs, limit, rateWindow, eventsText, jobsText, candidates, evidence });
  if (json) out(JSON.stringify(report));
  else for (const line of humanLines(report)) out(line);
  return maxRate !== null && report.rate.rate !== null && report.rate.rate > maxRate ? 2 : 0;
}

function humanLines(report: LaneEmptyCausesV1): string[] {
  const { rate } = report;
  const lines = [
    report.sources.events === 'unavailable'
      ? `${report.lane}: dispatch events unavailable, rate unknown`
      : `${report.lane}: empty rate ${rate.rate ?? 'unknown'} (${rate.empties} of ${rate.ended} ended launches, window ${rate.window})`,
    `${report.total} empty runs classified (newest ${report.limit})${report.sources.jobs === 'unavailable' ? ', jobs ledger unavailable' : ''}`,
  ];
  for (const cause of report.causes) {
    lines.push(`${cause.cause}: ${cause.count} (${Math.round(cause.share * 100)}%), fix area ${cause.fixArea}, e.g. ${cause.exampleJobs.join(', ')}`);
  }
  for (const job of report.jobs) lines.push(`${job.job} ${job.at.slice(0, 16)} ${job.cause}: ${job.reason}`);
  return lines;
}
