/**
 * `phm bets`, `GET /api/fleet/leader-bets` and the Feed's "Leader bets" card: what the leader decided each pass
 * and whether it worked. A batch is every `src=leader` job whose id ends in the same `N<day><letter>Q8` suffix
 * (RQ-FEEDBETSN21IQ8 is batch N21I). A job is the leader's when its queue line (or launch row) says `src=leader`;
 * the id suffix only decides it when nothing names a producer. Ids without the suffix group under batch `other`.
 * Each bet shows one stage: queued, running, PR open, merged, empty or ended (died with no result).
 * A launched job with no finish row is `ended` when its run sidecar holds an exit code (queue/run/<id>.rc), or when it
 * has run longer than the stale limit (default 3 h) with no live process record; `ended_rule` says which fired.
 * With no evidence passed, or an unreadable folder, it stays `running`: unknown is never guessed as dead.
 * Pure: the caller passes the router queue text and the jobs ledger text; a missing source is `null`, never zero.
 * The hit rate is merged / (merged + empty); with nothing judged yet it is `null` (unknown), never 0%.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runsRoot } from '../metrics/loop-collect.js';
import { scrubSecrets } from '../util/scrub.js';
import { readHostLoadJobRoots } from './host-load.js';
import { queueProducers } from './job-producers.js';
import { isPrecheckSkipRow } from './jobs-ledger-dialect.js';
import { readSource } from './runs-parked-queue.js';

export const LEADER_BETS_SCHEMA = 'fleet.leader-bets.v1';
export const LEADER_BET_STAGES = ['queued', 'running', 'pr_open', 'merged', 'empty', 'ended'] as const;
export type LeaderBetStage = typeof LEADER_BET_STAGES[number];
export const LEADER_BETS_DEFAULT_HOURS = 24;
export const LEADER_BETS_MAX_HOURS = 8760;
export const LEADER_STALE_AFTER_HOURS = 3;
export const OTHER_BATCH = 'other';
export type EndedRule = 'exit_code' | 'stale';
/** What the run folder says. `null` means that part could not be read. */
export interface LeaderRunEvidence {
  /** Job id to the exit code in queue/run/<id>.rc. */
  rc: ReadonlyMap<string, number> | null;
  /** Ids with a live process record (queue/run/resource-sessions/<id>.json whose process is alive). */
  live: ReadonlySet<string> | null;
  staleAfterHours: number;
}

export interface LeaderBet { id: string; stage: LeaderBetStage; /** Why it ended empty or died, when known; else null. */ reason: string | null; /** Which rule ended a job with no result; null for every other stage. */ ended_rule: EndedRule | null; url: string | null; at: string | null }
export interface LeaderBatch {
  /** `N<day><letter>`, the shared id suffix without `Q8`. */
  batch: string;
  /** Newest ledger activity in the batch; null while every bet is still only queued. */
  at: string | null;
  bets: LeaderBet[];
  counts: Record<LeaderBetStage, number>;
  /** Bets with a final answer: merged or empty. */
  judged: number;
  /** merged / judged, null while nothing is judged. */
  hit_rate: number | null;
}
export interface LeaderBetsReport {
  schema: typeof LEADER_BETS_SCHEMA; version: 1; window_hours: number;
  /** False when the jobs ledger could not be read: stages beyond queued are then unknown. */
  known: boolean; queue_known: boolean;
  batches: LeaderBatch[];
  summary: string;
}

/** `3h`, `90m` or `1d` as hours; null when it is not a positive amount up to a year. */
export function parseStaleAfter(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([mhd])$/.exec(text);
  const hours = m ? Number(m[1]) * (m[2] === 'm' ? 1 / 60 : m[2] === 'd' ? 24 : 1) : NaN;
  return hours > 0 && hours <= LEADER_BETS_MAX_HOURS ? hours : null;
}

const SUFFIX = /N(\d{1,2})([A-Z])Q8$/;
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
type Row = Record<string, unknown>;
interface Seen { launched: boolean; started: number; src: string | null; state: string; url: string | null; skip: boolean; empty: boolean; reason: string | null; at: number }

const parseTs = (v: unknown): number => typeof v === 'string' ? Date.parse(v.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2').replace(/ (?=\d{2}:)/, 'T')) : NaN;
const text = (v: unknown, max = 160): string | null => typeof v === 'string' && v.trim() ? scrubSecrets(v.trim()).slice(0, max) : null;

/** The batch key of a job id, or null when the id has no `N<day><letter>Q8` suffix. */
export function leaderBatchOf(id: string): string | null {
  const m = SUFFIX.exec(id);
  return m ? `N${m[1]}${m[2]}` : null;
}

function emptyCounts(): Record<LeaderBetStage, number> { return { queued: 0, running: 0, pr_open: 0, merged: 0, empty: 0, ended: 0 }; }

export function leaderBets(queue: string | null, ledger: string | null, now: number, hours = LEADER_BETS_DEFAULT_HOURS, evidence?: LeaderRunEvidence): LeaderBetsReport {
  if (!Number.isFinite(hours) || hours <= 0) throw new RangeError('Hours must be positive.');
  const producers = queueProducers(queue ?? '');
  const queued = new Set(queue === null ? [] : [...queue.matchAll(/^\s*-\s+[A-Z]+\s+(RQ-[\w-]+)/gm)].map(m => m[1]!));
  const seen = new Map<string, Seen>();
  for (const line of (ledger ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Row;
    try {
      const v: unknown = JSON.parse(line);
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      row = v as Row;
    } catch { continue; }
    const id = row.job ?? row.job_id ?? row.jobId ?? row.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) continue;
    const at = parseTs(row.ts);
    if (!Number.isFinite(at) || at > now) continue;
    const cur = seen.get(id) ?? { launched: false, started: Infinity, src: null, state: '', url: null, skip: false, empty: false, reason: null, at: -Infinity };
    seen.set(id, cur);
    const event = [row.event, row.type, row.kind].find((v): v is string => typeof v === 'string') ?? '';
    const state = String([row.state, row.outcome, row.status, row.phase, row.result, row.conclusion].find((v): v is string => typeof v === 'string') ?? '').toUpperCase();
    const url = [row.url, row.pr_url, row.prUrl, row.pr, row.html_url].find((u): u is string => typeof u === 'string' && PR_URL.test(u));
    // A launch row may carry its own producer tag; the queue line is the other source.
    const rowSrc = [row.src, row.producer].find((v): v is string => typeof v === 'string' && v.trim() !== '');
    if (rowSrc) cur.src ??= rowSrc.trim();
    if (event === 'launch') { cur.launched = true; cur.started = Math.min(cur.started, at); }
    if (url && (event === 'publish' || event === 'outcome' || event === 'finish')) cur.url = url;
    if (event === 'outcome' && ['MERGED', 'OPEN', 'CLOSED', 'EMPTY', 'EMPTY_DONE'].includes(state)) cur.state = state;
    if (typeof row.merged_at === 'string') cur.state = 'MERGED';
    if (isPrecheckSkipRow(row)) {
      cur.skip = true;
      cur.reason ??= text(row.reason) ?? (typeof row.code === 'string' || typeof row.code === 'number' ? `precheck ${String(row.code).slice(0, 40)}` : 'precheck skip');
    }
    if ((event === 'finish' || event === 'outcome') && row.empty === true) cur.empty = true;
    const why = text(row.empty_reason) ?? (state.startsWith('EMPTY') || row.empty === true ? text(row.reason) : null);
    if (why) cur.reason = why;
    if (at >= cur.at) cur.at = at;
  }
  const bets = new Map<string, LeaderBet[]>();
  const batchAt = new Map<string, number>();
  // The tag decides first (queue line, then launch row); the suffix only decides when no producer is named.
  const leaderIds = [...new Set([...queued, ...seen.keys()])].filter(id => {
    const src = producers.get(id) ?? seen.get(id)?.src ?? null;
    return src === null ? leaderBatchOf(id) !== null : src === 'leader';
  }).sort();
  for (const id of leaderIds) {
    const s = seen.get(id);
    let stage: LeaderBetStage = 'queued', reason: string | null = null, rule: EndedRule | null = null;
    if (s) {
      if (s.state === 'MERGED') stage = 'merged';
      else if (s.state === 'CLOSED') { stage = 'empty'; reason = s.reason ?? 'PR closed without merging'; }
      else if (s.state === 'OPEN' || s.url) stage = 'pr_open';
      else if (s.state.startsWith('EMPTY') || s.empty || s.skip) { stage = 'empty'; reason = s.reason; }
      else if (s.launched) {
        stage = 'running';
        const code = evidence?.rc?.get(id);
        if (code !== undefined) { stage = 'ended'; rule = 'exit_code'; reason = `exit code ${code} recorded, no result`; }
        else if (evidence?.live && !evidence.live.has(id) && now - s.started > evidence.staleAfterHours * 3_600_000) {
          stage = 'ended'; rule = 'stale'; reason = `running over ${+evidence.staleAfterHours.toFixed(2)} h with no live process`;
        }
      }
    }
    // Only bets with ledger activity inside the window place a batch there; queued-only bets are live now.
    const inWindow = !s || (s.at >= now - hours * 3_600_000);
    const key = leaderBatchOf(id) ?? OTHER_BATCH;
    if (!inWindow) continue;
    const list = bets.get(key) ?? [];
    list.push({ id: scrubSecrets(id), stage, reason, ended_rule: rule, url: s?.url ?? null, at: s && Number.isFinite(s.at) ? new Date(s.at).toISOString() : null });
    bets.set(key, list);
    if (s && Number.isFinite(s.at)) batchAt.set(key, Math.max(batchAt.get(key) ?? -Infinity, s.at));
  }
  const batches: LeaderBatch[] = [...bets].map(([batch, list]) => {
    const counts = emptyCounts();
    for (const bet of list) counts[bet.stage]++;
    const judged = counts.merged + counts.empty;
    const at = batchAt.get(batch);
    return { batch, at: at === undefined ? null : new Date(at).toISOString(), bets: list, counts, judged, hit_rate: judged ? counts.merged / judged : null };
  }).sort((a, b) => (b.at ?? new Date(now).toISOString()).localeCompare(a.at ?? new Date(now).toISOString()) || b.batch.localeCompare(a.batch));
  const known = ledger !== null;
  return { schema: LEADER_BETS_SCHEMA, version: 1, window_hours: hours, known, queue_known: queue !== null, batches, summary: leaderBetsSummary(batches[0], known) };
}

/** One plain sentence about the latest batch. */
export function leaderBetsSummary(batch: LeaderBatch | undefined, known = true): string {
  if (!batch) return known ? 'No leader bets in this window.' : 'Leader bets: unknown (job metrics file unreadable).';
  return `Latest batch ${batch.batch}: ${batch.bets.length} bets, ${hitRateText(batch)}.`;
}

export function hitRateText(batch: Pick<LeaderBatch, 'judged' | 'hit_rate' | 'counts'>): string {
  return batch.hit_rate === null ? 'hit rate unknown (nothing judged yet)'
    : `hit rate ${Math.round(batch.hit_rate * 100)}% (${batch.counts.merged} of ${batch.judged} judged merged)`;
}

const STAGE_TEXT: Record<LeaderBetStage, string> = { queued: 'queued', running: 'running', pr_open: 'PR open', merged: 'merged', empty: 'empty', ended: 'ended, no result' };
export function leaderBetsLines(report: LeaderBetsReport): string[] {
  if (!report.batches.length) return [report.summary];
  const lines: string[] = [];
  for (const batch of report.batches) {
    lines.push(`Batch ${batch.batch} (${batch.bets.length} bets): ${hitRateText(batch)}`);
    for (const bet of batch.bets) lines.push(`  ${bet.id}  ${STAGE_TEXT[bet.stage]}${bet.stage === 'empty' || bet.stage === 'ended' ? ` (${bet.reason ?? 'reason unknown'})` : ''}${bet.url ? `  ${bet.url}` : ''}`);
  }
  if (!report.known) lines.push('Job metrics file unreadable: only queued bets can be shown.');
  return lines;
}

/** Reads queue/run/<id>.rc exit codes and the live process records; each part is null when its folder cannot be read. */
export async function readLeaderRunEvidence(root: string, staleAfterHours = LEADER_STALE_AFTER_HOURS): Promise<LeaderRunEvidence> {
  const runDir = join(root, 'queue', 'run');
  let rc: Map<string, number> | null = null;
  try {
    rc = new Map();
    for (const name of (await readdir(runDir)).filter(n => n.endsWith('.rc')).sort().slice(0, 2048)) {
      const text = (await readFile(join(runDir, name), 'utf8').catch(() => '')).slice(0, 32);
      const code = /^\s*(-?\d{1,3})\s*$/.exec(text)?.[1];
      if (code !== undefined) rc.set(name.slice(0, -3), Number(code));
    }
  } catch { rc = null; }
  const roots = readHostLoadJobRoots(root);
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
  return { rc, live: roots === null ? null : new Set(roots.filter(r => alive(r.pid)).map(r => r.jobId)), staleAfterHours };
}

/** Reads the router queue and jobs ledger under the runs root; each source fails on its own. */
export async function readLeaderBets(opts: { root?: string; hours?: number; now?: number; staleAfterHours?: number } = {}): Promise<LeaderBetsReport> {
  const root = opts.root ?? runsRoot();
  const [queue, ledger, evidence] = await Promise.all([
    readSource(join(root, 'queue', 'router-queue.md'), 2 * 1024 * 1024, false),
    readSource(join(root, 'metrics', 'jobs.jsonl'), 8 * 1024 * 1024, true),
    readLeaderRunEvidence(root, opts.staleAfterHours),
  ]);
  return leaderBets(queue.state === 'healthy' ? queue.text : null, ledger.state === 'healthy' ? ledger.text : null, opts.now ?? Date.now(), opts.hours, evidence);
}
