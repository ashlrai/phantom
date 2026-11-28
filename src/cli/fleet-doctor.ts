/** Read-only fleet doctor: one ok/warn/red line per existing fleet reader. Never writes, never removes. */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFleetLeaderHealth, type FleetLeaderHealthOptions } from './fleet-leader-health.js';
import { fsHeartbeatReader, readFleetHeartbeat, type HeartbeatReader } from './fleet-heartbeat.js';
import { stuckPrs } from './fleet-stuck-prs.js';
import { fleetWaste } from './fleet-waste.js';
import { readTaskCheckJobs, type TaskCheckReader } from './fleet-task-check.js';
import { findStaleWorktrees, type FleetWorktreeStaleFs } from './fleet-worktree-stale.js';
import { summarizeFleetSlowPrs } from './fleet-slow-prs.js';
import { parseKeptWorktrees, summarizeFleetKept } from './fleet-kept.js';
import { parseIdleLanes } from '../core/fleet/idle-lanes.js';
import { readGuardianDoctorCheck } from '../core/fleet/guardian-doctor.js';
import { readTickState, type FleetTickStateV1 } from '../core/fleet/fleet-runtime-journal.js';
import type { FleetPausedRepoKind } from '../core/fleet/fleet-types.js';
import { readFile, readdir, stat } from 'node:fs/promises';

const USAGE = 'Usage: ashlr fleet doctor [--json]\nRead-only health check: one line per check (leader, heartbeat, stuck-prs, slow-prs, waste, kept, worktrees, guardian, lanes, repos) as ok, warn or red, with the reason. Checks run together with a 2.5 second deadline each. Exits 1 when any check is red, 2 on bad usage.';

export type DoctorLevel = 'ok' | 'warn' | 'red';
export interface DoctorCheck { name: string; level: DoctorLevel; reason: string; nextStep?: string }
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
  readLaneStatus?: () => Promise<string>;
  readGuardian?: typeof readGuardianDoctorCheck;
  /** Queue status text for the kept check; defaults to reading queue/status.json. */
  readKeptStatus?: () => Promise<string>;
  /** Last standing tick for the repos check; defaults to reading fleet/runtime/tick.json. */
  readTick?: () => FleetTickStateV1 | null;
  now?: () => number;
}

const HEARTBEAT_MAX_MIN = 30;
const STUCK_RED = 5;
const SLOW_PRS_RED = 5;
const POOL_ERROR_RED = 5;
const LEADER_RED = 3;
const KEPT_WARN = 20;
const KEPT_RED = 60;
/** Same freshness window the Fleet live snapshot gives tick state. */
const TICK_FRESH_MS = 10 * 60_000;
/** Pause kinds that are policy or throttle outcomes, not faults; anything else (or unreported) needs a look. */
const POLICY_PAUSE_KINDS = new Set<FleetPausedRepoKind>(['stage', 'hold', 'backpressure']);

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
    if (q.reason === 'timeout') return check('heartbeat', 'red', 'queue status probe timed out');
    return check('heartbeat', 'red', `queue tick ${q.ageMinutes === null ? q.reason : `${q.ageMinutes} min old`}`);
  }
  if (stale.length) return check('heartbeat', 'warn', `stale: ${stale.map(s => s.source + (s.reason === 'timeout' ? ' (probe timed out)' : '')).join(', ')}`);
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

/** Default reader for the queue status file, shared by the kept and lanes checks. */
const readQueueStatus = (): Promise<string> =>
  readFile(join(process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'queue', 'status.json'), 'utf8');

async function slowPrsCheck(read: TaskCheckReader): Promise<DoctorCheck> {
  const text = await read();
  if (text === null) return check('slow-prs', 'warn', 'jobs ledger unreadable');
  const n = summarizeFleetSlowPrs(text).repos.reduce((sum, group) => sum + group.count, 0);
  if (n === 0) return check('slow-prs', 'ok', 'no PR open over 30 min');
  return check('slow-prs', n >= SLOW_PRS_RED ? 'red' : 'warn', `${n} PR${n === 1 ? '' : 's'} open over 30 min (see fleet slow-prs)`);
}

async function keptCheck(o: FleetDoctorOptions, readJobs: TaskCheckReader): Promise<DoctorCheck> {
  let ids: string[];
  try { ids = parseKeptWorktrees(await (o.readKeptStatus ?? readQueueStatus)()); }
  catch { return check('kept', 'warn', 'queue status unreadable'); }
  // The count comes from the status list; the ledger only classifies reasons, so an unreadable ledger cannot change it.
  const n = summarizeFleetKept(ids, (await readJobs()) ?? '').kept;
  const detail = `${n} kept worktree${n === 1 ? '' : 's'}`;
  if (n >= KEPT_RED) return check('kept', 'red', `${detail} (see fleet kept)`);
  if (n >= KEPT_WARN) return check('kept', 'warn', `${detail} (see fleet kept)`);
  return check('kept', 'ok', n === 0 ? 'no kept worktrees' : detail);
}

async function lanesCheck(o: FleetDoctorOptions): Promise<DoctorCheck> {
  const lanes = parseIdleLanes(await (o.readLaneStatus ?? readQueueStatus)());
  if (lanes.length === 0) return check('lanes', 'ok', 'no lanes with queued work and room to launch');
  const red = lanes.filter(lane => lane.status === 'red');
  if (red.length) return check('lanes', 'red', `room and queued work: ${red.map(lane => `${lane.lane} ${lane.running}/${lane.target} running, ${lane.queued} queued`).join('; ')}`);
  return check('lanes', 'warn', `held with queued work: ${lanes.map(lane => `${lane.lane} (${lane.queued})`).join(', ')}`);
}

const shortReason = (reason: string): string => (reason.length > 100 ? `${reason.slice(0, 99)}…` : reason);
const pausedName = (p: { repo: string; reason: string }): string => `${p.repo} (${shortReason(p.reason)})`;

/** The last standing tick's paused repos: faults warn, policy pauses inform, a stale tick warns. */
async function reposCheck(o: FleetDoctorOptions, now: number): Promise<DoctorCheck> {
  const tick = (o.readTick ?? readTickState)();
  if (tick === null) return check('repos', 'ok', 'no standing tick recorded');
  const at = Date.parse(tick.at);
  const ageMs = Number.isFinite(at) ? now - at : NaN;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > TICK_FRESH_MS) {
    return check('repos', 'warn', Number.isFinite(ageMs) && ageMs >= 0
      ? `last standing tick is ${Math.round(ageMs / 60_000)} min old; paused repos unknown`
      : 'standing tick has no readable time; paused repos unknown');
  }
  if (!Array.isArray(tick.pausedRepos)) return check('repos', 'warn', 'tick state has no paused-repo record');
  const paused = tick.pausedRepos.filter((p): p is { repo: string; reason: string; kind?: FleetPausedRepoKind } =>
    typeof p === 'object' && p !== null && typeof p.repo === 'string' && typeof p.reason === 'string');
  if (paused.length === 0) return check('repos', 'ok', 'nothing paused this tick');
  const attention = paused.filter(p => p.kind === undefined || !POLICY_PAUSE_KINDS.has(p.kind));
  const policy = paused.length - attention.length;
  if (attention.length > 0) {
    const shown = attention.slice(0, 2).map(pausedName).join('; ');
    const more = attention.length > 2 ? `; +${attention.length - 2} more` : '';
    return check('repos', 'warn', `${attention.length} repo${attention.length === 1 ? '' : 's'} cannot produce: ${shown}${more}${policy > 0 ? `; ${policy} more paused by policy` : ''}`);
  }
  const shown = paused.slice(0, 2).map(pausedName).join('; ');
  const more = paused.length > 2 ? `; +${paused.length - 2} more` : '';
  return check('repos', 'ok', `${paused.length} repo${paused.length === 1 ? '' : 's'} paused by hold, stage or backpressure: ${shown}${more}`);
}

/** Typed API behind the verb; agents call this directly. A throwing reader degrades to warn, never crashes. */
export async function runFleetDoctor(o: FleetDoctorOptions = {}): Promise<FleetDoctorReport> {
  const now = (o.now ?? Date.now)();
  const readJobs = o.readJobs ?? readTaskCheckJobs;
  const readWaste = o.readWaste ?? readJobs;
  const safe = async (name: string, run: () => Promise<DoctorCheck>): Promise<DoctorCheck> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(run),
        new Promise<DoctorCheck>(resolve => {
          timer = setTimeout(() => resolve(check(name, name === 'heartbeat' ? 'red' : 'warn', 'probe timed out after 2500 ms')), 2_500);
        }),
      ]);
    } catch (error) { return unavailable(name, error); }
    finally { clearTimeout(timer); }
  };
  const checks = await Promise.all([
    safe('leader', () => leaderCheck(o, now)),
    safe('heartbeat', () => heartbeatCheck(o, now)),
    safe('stuck-prs', () => stuckCheck(readJobs, now)),
    safe('slow-prs', () => slowPrsCheck(readJobs)),
    safe('waste', () => wasteCheck(readWaste, now)),
    safe('kept', () => keptCheck(o, readJobs)),
    safe('worktrees', () => worktreeCheck(o, readJobs, now)),
    safe('guardian', () => (o.readGuardian ?? readGuardianDoctorCheck)({ now: () => now })),
    safe('lanes', () => lanesCheck(o)),
    safe('repos', () => reposCheck(o, now)),
  ]);
  const level: DoctorLevel = checks.some(c => c.level === 'red') ? 'red' : checks.some(c => c.level === 'warn') ? 'warn' : 'ok';
  return { v: 1, generatedAt: new Date(now).toISOString(), level, checks };
}

export async function cmdFleetDoctor(args: string[], opts: FleetDoctorOptions = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(USAGE); return 2; }
  const report = await runFleetDoctor(opts);
  if (args[0] === '--json') console.log(JSON.stringify(report));
  else for (const c of report.checks) console.log(`${c.level} ${c.name}: ${c.reason}${c.nextStep ? ` Next: ${c.nextStep}` : ''}`);
  return report.level === 'red' ? 1 : 0;
}
