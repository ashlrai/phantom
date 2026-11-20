/**
 * `phm leader brief` (this file; `phm fleet brief` is the separate overall status brief): what happened to the leader's last bets and what to queue next, in one read.
 * It composes the readers that already exist and adds no new source of truth:
 *   bets    -> leader-batches.ts (src=leader jobs and their stage), plus the first gap sentence of a
 *              no-change job from the same notes and log tail `phm jobs gaps` reads (job-gaps.ts)
 *   lanes + admission -> explainFleetAdmission (`phm fleet admission`) over queue/status.json
 *   pools   -> buildPoolsView (`phm pools`): used %, hours to reset, waste risk
 *   gaps    -> readJobGaps (`phm jobs gaps`): the top open candidates
 * Each section fails on its own: a source that cannot be read is `known: false` with a reason, never
 * zero or a guess. Reading never throws; the exit code is 0 unless the usage is wrong.
 */
import { join } from 'node:path';
import { explainFleetAdmission, type FleetAdmissionReport } from '../../cli/fleet-admission.js';
import { runsRoot } from '../metrics/loop-collect.js';
import { scrubSecrets } from '../util/scrub.js';
import { ledgerFinishes } from './empties.js';
import { EMPTY_CAUSE_TAIL_LINES, readText } from './empty-cause.js';
import { extractAllGaps, readJobGaps, type GapCandidate, type JobGapsReport } from './job-gaps.js';
import { leaderBets, type LeaderBetStage } from './leader-batches.js';
import type { PoolRow, PoolsViewV1, PoolWasteRisk } from './pools-view.js';

export const LEADER_BRIEF_SCHEMA = 'leader.brief.v1';
export const BRIEF_DEFAULT_HOURS = 24;
export const BRIEF_MAX_HOURS = 8760;
export const BRIEF_TOP_GAPS = 5;
const GAP_WINDOW_HOURS = 24;

export type BriefJobResult = 'published' | 'no_change' | 'running' | 'queued' | 'failed';
export interface BriefJob {
  id: string;
  result: BriefJobResult;
  /** Where the PR is: "open" or "merged"; null unless published. */
  pr_state: 'open' | 'merged' | null;
  pr_url: string | null;
  /** First gap sentence of a no-change job; null when it wrote none or the notes are unreadable. */
  gap: string | null;
  /** Why it ended with no change, when the ledger says. */
  reason: string | null;
  at: string | null;
}
export interface BriefLane { lane: string; running: number; target: number; queued: number; held: boolean }
export interface BriefPool { id: string; used_pct: number | null; hours_to_reset: number | null; waste_risk: PoolWasteRisk; verdict: string }
export interface BriefGap { title: string; repo: string | null; source_job: string; why: string }
/** A section is `known: false` with a plain `reason` when its source could not be read. */
interface Section { known: boolean; reason: string | null }
export interface LeaderBriefV1 {
  schema: typeof LEADER_BRIEF_SCHEMA;
  version: 1;
  generated_at: string;
  window_hours: number;
  jobs: Section & { rows: BriefJob[] };
  lanes: Section & { rows: BriefLane[] };
  /** `closed` means the dispatcher launches nothing new this tick; `why` is one plain phrase. */
  admission: Section & { state: 'open' | 'closed' | 'unknown'; why: string | null };
  pools: Section & { rows: BriefPool[] };
  gaps: Section & { total: number | null; top: BriefGap[] };
  summary: string;
}

export interface JobBriefInputs {
  /** Raw file text; null when the file could not be read. */
  queue: string | null;
  ledger: string | null;
  status: string | null;
  /** Notes and log tail by job id, for no-change jobs only; a missing entry means unreadable. */
  notes: ReadonlyMap<string, { notes: string | null; log: string | null }>;
  pools: PoolsViewV1 | null;
  gaps: JobGapsReport | null;
  now: number;
  hours: number;
}

const clip = (text: string, max = 160): string => scrubSecrets(text).replace(/\s+/g, ' ').trim().slice(0, max);

const RESULT_OF: Record<LeaderBetStage, BriefJobResult> = { queued: 'queued', running: 'running', pr_open: 'published', merged: 'published', empty: 'no_change' };

/** Ids of the leader jobs that ended with no change inside the window, so the caller reads only their notes. */
export function noChangeIds(queue: string | null, ledger: string | null, now: number, hours: number): string[] {
  return leaderBets(queue, ledger, now, hours).batches.flatMap(b => b.bets).filter(b => b.stage === 'empty').map(b => b.id);
}

function jobsSection(i: JobBriefInputs): LeaderBriefV1['jobs'] {
  if (i.ledger === null) return { known: false, reason: 'the job metrics file could not be read', rows: [] };
  const report = leaderBets(i.queue, i.ledger, i.now, i.hours);
  const failed = new Set(ledgerFinishes(i.ledger, i.now, i.hours).finishes
    .filter(f => !f.empty && !f.skipped && f.exitCode !== null && f.exitCode !== 0).map(f => f.id));
  const rows = report.batches.flatMap(b => b.bets).map((bet): BriefJob => {
    const stuck = failed.has(bet.id) && (bet.stage === 'running' || bet.stage === 'queued');
    const result = stuck ? 'failed' : RESULT_OF[bet.stage];
    const gaps = result === 'no_change' ? i.notes.get(bet.id) : undefined;
    const first = gaps ? extractAllGaps(gaps.notes ?? '', gaps.log ? gaps.log.split(/\r?\n/).slice(-EMPTY_CAUSE_TAIL_LINES).join('\n') : '')[0] : undefined;
    return {
      id: bet.id, result, at: bet.at, reason: result === 'no_change' ? bet.reason : null, gap: first ? clip(first.title) : null,
      pr_state: result !== 'published' ? null : bet.stage === 'merged' ? 'merged' : 'open', pr_url: result === 'published' ? bet.url : null,
    };
  }).sort((a, b) => (b.at ?? '9').localeCompare(a.at ?? '9') || a.id.localeCompare(b.id));
  return { known: true, reason: i.queue === null ? 'the router queue could not be read, so queued bets are missing' : null, rows };
}

function statusSections(status: string | null): Pick<LeaderBriefV1, 'lanes' | 'admission'> {
  const none = (reason: string): Pick<LeaderBriefV1, 'lanes' | 'admission'> => ({
    lanes: { known: false, reason, rows: [] }, admission: { known: false, reason, state: 'unknown', why: null },
  });
  if (status === null) return none('queue/status.json could not be read');
  let report: FleetAdmissionReport;
  try { report = explainFleetAdmission(JSON.parse(status)); } catch { return none('queue/status.json is unreadable or invalid'); }
  const g = report.global;
  const why = g.non_cap_closed ? `closed${g.admit_reason ? `: ${clip(g.admit_reason, 80)}` : ' by the load gate or a pause'}`
    : g.at_cap ? `closed at the global cap (${g.running} of ${g.cap} running)` : `${g.running} of ${g.cap} running`;
  return {
    lanes: { known: true, reason: null, rows: report.lanes.map(l => ({ lane: l.lane, running: l.running, target: l.target, queued: l.queued, held: l.held })) },
    admission: { known: true, reason: null, state: g.closed ? 'closed' : 'open', why },
  };
}

function poolRow(p: PoolRow): BriefPool {
  return { id: p.id, used_pct: p.usedPct, hours_to_reset: p.hoursLeft, waste_risk: p.wasteRisk, verdict: p.summary };
}

function gapsSection(report: JobGapsReport | null): LeaderBriefV1['gaps'] {
  if (!report || !report.known) return { known: false, reason: 'the job metrics file could not be read, so no gaps are known', total: null, top: [] };
  const top = report.candidates.slice(0, BRIEF_TOP_GAPS).map((g: GapCandidate): BriefGap => ({ title: g.title, repo: g.repo, source_job: g.sourceJob, why: clip(g.why, 240) }));
  return { known: true, reason: report.unknownSources.length ? `not checked against: ${report.unknownSources.join(', ')}` : null, total: report.candidates.length, top };
}

const count = (rows: BriefJob[], r: BriefJobResult): number => rows.filter(j => j.result === r).length;

/** Pure: assemble the brief from already-read sources. */
export function buildJobBrief(i: JobBriefInputs): LeaderBriefV1 {
  const jobs = jobsSection(i);
  const { lanes, admission } = statusSections(i.status);
  const pools: LeaderBriefV1['pools'] = i.pools
    ? { known: true, reason: null, rows: i.pools.pools.map(poolRow) }
    : { known: false, reason: 'the resource ledger could not be read', rows: [] };
  const gaps = gapsSection(i.gaps);
  const summary = jobs.known
    ? `Last ${i.hours}h: ${count(jobs.rows, 'published')} published, ${count(jobs.rows, 'no_change')} no change, ${count(jobs.rows, 'failed')} failed, ${count(jobs.rows, 'running')} running, ${count(jobs.rows, 'queued')} queued. Admission ${admission.state}. ${gaps.known ? `${gaps.total} open gap${gaps.total === 1 ? '' : 's'}.` : 'Open gaps unknown.'}`
    : `Leader jobs unknown (${jobs.reason}). Admission ${admission.state}.`;
  return { schema: LEADER_BRIEF_SCHEMA, version: 1, generated_at: new Date(i.now).toISOString(), window_hours: i.hours, jobs, lanes, admission, pools, gaps, summary };
}

const RESULT_TEXT: Record<BriefJobResult, string> = { published: 'published', no_change: 'no change', running: 'running', queued: 'queued', failed: 'failed' };

/** Plain words, one section each; unknown says unknown and why. */
export function jobBriefLines(b: LeaderBriefV1): string[] {
  const lines = [b.summary, '', 'Leader jobs'];
  if (!b.jobs.known) lines.push(`  unknown: ${b.jobs.reason}`);
  else {
    if (!b.jobs.rows.length) lines.push('  none in this window');
    for (const j of b.jobs.rows) {
      const tail = j.result === 'published' ? `${j.pr_state === 'merged' ? 'merged' : 'PR open'}${j.pr_url ? `  ${j.pr_url}` : ''}`
        : j.result === 'no_change' ? `gap: ${j.gap ?? `unknown (no gap in the notes or log${j.reason ? `; ledger says: ${j.reason}` : ''})`}` : '';
      lines.push(`  ${j.id}  ${RESULT_TEXT[j.result]}${tail ? `  ${tail}` : ''}`);
    }
    if (b.jobs.reason) lines.push(`  note: ${b.jobs.reason}`);
  }
  lines.push('', 'Lanes (running/target, queued)');
  if (!b.lanes.known) lines.push(`  unknown: ${b.lanes.reason}`);
  else for (const l of b.lanes.rows) lines.push(`  ${l.lane}  ${l.running}/${l.target}  ${l.queued} queued${l.held ? '  held' : ''}`);
  lines.push('', `Admission: ${b.admission.known ? `${b.admission.state}, ${b.admission.why}` : `unknown (${b.admission.reason})`}`);
  lines.push('', 'Pools');
  if (!b.pools.known) lines.push(`  unknown: ${b.pools.reason}`);
  else for (const p of b.pools.rows) {
    lines.push(`  ${p.id}  ${p.used_pct === null ? 'used unknown' : `${Math.round(p.used_pct)}% used`}, ${p.hours_to_reset === null ? 'reset unknown' : `resets in ${Math.round(p.hours_to_reset)} h`}, waste risk ${p.waste_risk}`);
  }
  lines.push('', `Open gaps (top ${BRIEF_TOP_GAPS}, what to queue next)`);
  if (!b.gaps.known) lines.push(`  unknown: ${b.gaps.reason}`);
  else {
    if (!b.gaps.top.length) lines.push('  none');
    for (const g of b.gaps.top) lines.push(`  ${g.title}  (from ${g.source_job}${g.repo ? `, ${g.repo}` : ''})`);
    if (b.gaps.reason) lines.push(`  note: ${b.gaps.reason}`);
  }
  return lines;
}

export interface ReadJobBriefOptions {
  runsDir?: string;
  wtDir?: string;
  hours?: number;
  now?: number;
  read?: (path: string, max: number) => Promise<string | null>;
  pools?: (now: number) => Promise<PoolsViewV1 | null>;
  gaps?: (hours: number) => Promise<JobGapsReport | null>;
}

async function defaultPools(now: number): Promise<PoolsViewV1 | null> {
  const [{ readResourceLedger }, { buildPoolsView }, { readUsageSamples }] = await Promise.all([
    import('./runs-resource-ledger.js'), import('./pools-view.js'), import('./usage-history.js'),
  ]);
  return buildPoolsView(await readResourceLedger({ now: () => now }), now, await readUsageSamples({ nowMs: now }));
}

/** Reads every source on its own; a failed one is passed on as null and shown as unknown. */
export async function readJobBrief(opts: ReadJobBriefOptions = {}): Promise<LeaderBriefV1> {
  const runs = opts.runsDir ?? runsRoot();
  const wt = opts.wtDir ?? (process.env.ASHLR_WT_DIR?.trim() || join(process.env.HOME ?? '', 'Projects/ashlrai/wt'));
  const now = opts.now ?? Date.now(), hours = opts.hours ?? BRIEF_DEFAULT_HOURS;
  const read = opts.read ?? readText;
  const safe = async <T>(f: () => Promise<T>): Promise<T | null> => { try { return await f(); } catch { return null; } };
  const [queue, ledger, status, pools, gaps] = await Promise.all([
    safe(() => read(join(runs, 'queue', 'router-queue.md'), 2 * 1024 * 1024)),
    safe(() => read(join(runs, 'metrics', 'jobs.jsonl'), 8 * 1024 * 1024)),
    safe(() => read(join(runs, 'queue', 'status.json'), 1024 * 1024)),
    safe(() => (opts.pools ?? defaultPools)(now)),
    safe(() => (opts.gaps ?? ((h: number) => readJobGaps(h, { runsDir: runs, wtDir: wt, now, read })))(Math.max(hours, GAP_WINDOW_HOURS))),
  ]);
  const notes = new Map<string, { notes: string | null; log: string | null }>();
  for (const id of noChangeIds(queue, ledger, now, hours)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) continue;
    const [n, log] = await Promise.all([safe(() => read(join(wt, id, 'BRIDGE_NOTES.md'), 65536)), safe(() => read(join(runs, `${id}.log`), 16384))]);
    notes.set(id, { notes: n, log });
  }
  return buildJobBrief({ queue, ledger, status, notes, pools, gaps, now, hours });
}
