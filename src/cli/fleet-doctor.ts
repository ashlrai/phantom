/** Read-only fleet doctor: one ok/warn/red line per existing fleet reader. Never writes, never removes. */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFleetLeaderHealth, type FleetLeaderHealthOptions } from './fleet-leader-health.js';
import { fsHeartbeatReader, readFleetHeartbeat, type HeartbeatReader } from './fleet-heartbeat.js';
import { stuckPrs } from './fleet-stuck-prs.js';
import { fleetWaste } from './fleet-waste.js';
import { readTaskCheckJobs, type TaskCheckReader } from './fleet-task-check.js';
import { findStaleWorktrees, type FleetWorktreeStaleFs } from './fleet-worktree-stale.js';
import { readdir, stat } from 'node:fs/promises';

const USAGE = 'Usage: ashlr fleet doctor [--json]\nRead-only health check: one line per check (leader, heartbeat, stuck-prs, waste, worktrees) as ok, warn or red, with the reason. Exits 1 when any check is red, 2 on bad usage.';

export type DoctorLevel = 'ok' | 'warn' | 'red';
export interface DoctorCheck { name: string; level: DoctorLevel; reason: string }
export interface FleetDoctorReport { v: 1; generatedAt: string; level: DoctorLevel; checks: DoctorCheck[] }

/** Every reader is injectable so tests use fixtures and never touch ~/.ashlr-runs. */
export interface FleetDoctorOptions {
  leader?: FleetLeaderHealthOptions;
  heartbeat?: HeartbeatReader;
  /** Raw metrics/jobs.jsonl text for stuck-prs; null or a rejection means unreadable. */
  readJobs?: TaskCheckReader;
  /** Waste ledger reader; defaults to readJobs. */
  readWaste?: TaskCheckReader;
  worktreeFs?: FleetWorktreeStaleFs;
  worktreeRoot?: string;
  now?: () => number;
}

const HEARTBEAT_MAX_MIN = 30;
const STUCK_RED = 5;
const POOL_ERROR_RED = 5;
const LEADER_RED = 3;

const defaultFs: FleetWorktreeStaleFs = {
  async listDirs(root) { return (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name); },
  async mtimeMs(path) { const s = await stat(path); return s.isDirectory() ? s.mtimeMs : null; },
};

const check = (name: string, level: DoctorLevel, reason: string): DoctorCheck => ({ name, level, reason });
const unavailable = (name: string, error: unknown): DoctorCheck =>
  check(name, 'warn', `could not read (${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'})`);

async function leaderCheck(o: FleetDoctorOptions, now: number): Promise<DoctorCheck> {
  const h = await readFleetLeaderHealth({ ...o.leader, now: o.leader?.now ?? now });
  if (h.source === 'unknown') return check('leader', 'warn', 'no dispatch log evidence');
  const n = h.consecutiveFailures;
  if (n !== null && n >= LEADER_RED) return check('leader', 'red', `${n} failures in a row`);
  if (n !== null && n > 0) return check('leader', 'warn', `${n} failure${n === 1 ? '' : 's'} in a row`);
  if (n === null) return check('leader', 'warn', 'outcome unknown');
  return check('leader', 'ok', `last success ${(h.hoursSinceLastSuccess ?? 0).toFixed(1)}h ago`);
}

async function heartbeatCheck(o: FleetDoctorOptions, now: number): Promise<DoctorCheck> {
  const reader = o.heartbeat ?? fsHeartbeatReader(process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'));
  const view = await readFleetHeartbeat(reader, now, HEARTBEAT_MAX_MIN);
  const stale = view.sources.filter(s => s.stale);
  // A dead queue tick stops all dispatch; a stale supervisor file only degrades visibility.
  if (stale.some(s => s.source === 'queue/status.json')) {
    const q = stale.find(s => s.source === 'queue/status.json')!;
    return check('heartbeat', 'red', `queue tick ${q.ageMinutes === null ? q.reason : `${q.ageMinutes} min old`}`);
  }
  if (stale.length) return check('heartbeat', 'warn', `stale: ${stale.map(s => s.source).join(', ')}`);
  return check('heartbeat', 'ok', `${view.sources.length} source${view.sources.length === 1 ? '' : 's'} fresh`);
}

async function stuckCheck(read: TaskCheckReader, now: number): Promise<DoctorCheck> {
  const text = await read();
  if (text === null) return check('stuck-prs', 'warn', 'jobs ledger unreadable');
  const n = stuckPrs(text, now, 60).length;
  if (n === 0) return check('stuck-prs', 'ok', 'no PR open over 60 min');
  return check('stuck-prs', n >= STUCK_RED ? 'red' : 'warn', `${n} PR${n === 1 ? '' : 's'} open over 60 min`);
}

async function wasteCheck(read: TaskCheckReader, now: number): Promise<DoctorCheck> {
  const r = await fleetWaste(read, 6, now);
  if (!r.totals) return check('waste', 'warn', 'jobs ledger unreadable');
  const { empty, pool_error: pool, no_pr: noPr } = r.totals;
  const detail = `${pool} pool errors, ${empty} empty, ${noPr} without a PR in 6h`;
  if (pool >= POOL_ERROR_RED) return check('waste', 'red', detail);
  return check('waste', pool + empty + noPr > 0 ? 'warn' : 'ok', pool + empty + noPr > 0 ? detail : 'no waste in 6h');
}

async function worktreeCheck(o: FleetDoctorOptions, readJobs: TaskCheckReader, now: number): Promise<DoctorCheck> {
  const root = resolve(o.worktreeRoot ?? join(homedir(), 'Projects', 'ashlrai', 'wt'));
  // Dry run only: findStaleWorktrees lists; nothing here can remove a worktree.
  const stale = await findStaleWorktrees(root, { fs: o.worktreeFs ?? defaultFs, readJobs: async () => (await readJobs()) ?? '', now });
  return stale.length === 0 ? check('worktrees', 'ok', 'no stale worktrees')
    : check('worktrees', 'warn', `${stale.length} stale worktree${stale.length === 1 ? '' : 's'} (see fleet worktree-stale)`);
}

/** Typed API behind the verb; agents call this directly. A throwing reader degrades to warn, never crashes. */
export async function runFleetDoctor(o: FleetDoctorOptions = {}): Promise<FleetDoctorReport> {
  const now = (o.now ?? Date.now)();
  const readJobs = o.readJobs ?? readTaskCheckJobs;
  const readWaste = o.readWaste ?? readJobs;
  const safe = async (name: string, run: () => Promise<DoctorCheck>): Promise<DoctorCheck> => {
    try { return await run(); } catch (error) { return unavailable(name, error); }
  };
  const checks = [
    await safe('leader', () => leaderCheck(o, now)),
    await safe('heartbeat', () => heartbeatCheck(o, now)),
    await safe('stuck-prs', () => stuckCheck(readJobs, now)),
    await safe('waste', () => wasteCheck(readWaste, now)),
    await safe('worktrees', () => worktreeCheck(o, readJobs, now)),
  ];
  const level: DoctorLevel = checks.some(c => c.level === 'red') ? 'red' : checks.some(c => c.level === 'warn') ? 'warn' : 'ok';
  return { v: 1, generatedAt: new Date(now).toISOString(), level, checks };
}

export async function cmdFleetDoctor(args: string[], opts: FleetDoctorOptions = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(USAGE); return 2; }
  const report = await runFleetDoctor(opts);
  if (args[0] === '--json') console.log(JSON.stringify(report));
  else for (const c of report.checks) console.log(`${c.level} ${c.name}: ${c.reason}`);
  return report.level === 'red' ? 1 : 0;
}
