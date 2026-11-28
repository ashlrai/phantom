/**
 * Job steering-notes ledger → self-improvement backlog items.
 *
 * `phm job say` (src/core/fleet/job-notes.ts) appends one JSON line per
 * accepted note to <runsDir>/queue/job-notes.jsonl — the job's steering
 * record a runner reads between steps:
 *   {schema: 'fleet.job.say.v1', job, id, at, text, by}
 * A note is the operator's or another agent's mid-flight redirect — "also
 * update the docs", "that approach is wrong, use the other one". Finished
 * and unknown jobs refuse notes, and a repeated identical text is one
 * note, so every recorded line is a distinct steering act somebody
 * decided a running job needed.
 *
 * A job that accumulates several notes inside the window is evidence the
 * fleet's own machinery should have caught earlier: the job spec was
 * ambiguous about scope or acceptance, the lane/model mismatched the
 * task, the job was circling a problem its detectors did not name, or a
 * producer keeps minting jobs that need babysitting. Until now the
 * ledger's only readers were `phm job notes`, the job window's note box
 * and the phone screen — surfaces a human has to open per job. Nothing
 * folded the recurring pattern into work.
 *
 * jobNotesBacklogItems carries the fold into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue it like
 * the sibling fleet-evidence sources.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The notes ledger and metrics/jobs.jsonl are read through
 *    readLedgerTail's bounded windows with the same symlink and
 *    file-type refusals every ledger reader applies. Nothing is written
 *    and no network is touched.
 *  - Note text is never quoted. `text` is free operator/agent prose —
 *    it can carry anything, including secrets the writer did not scrub —
 *    so cells carry counts, sender counts, timestamps and the job id
 *    only. `by` is a surface name by contract but caller-controlled, so
 *    senders are counted, never named.
 *  - Recurring means recorded. A job emits only at
 *    JOB_NOTES_RECURRING distinct recorded notes inside the window, so
 *    one clarifying note or a single retry never queues a session.
 *  - Unknown stays unknown. A job with no jobs-ledger row reports
 *    'unknown' outcome; a missing notes ledger is an empty file — no
 *    notes, no items — while an unreadable one yields no items; a
 *    truncated tail is stated as a lower bound in the prompt.
 *  - The ledger has no repository column — notes serve every repo this
 *    install runs — so items emit only when the backlog target's
 *    repository name is 'phantom', the same last-segment rule the
 *    sibling fleet-evidence sources apply, and their prompts direct
 *    sessions to fix what this repository owns (job spec templates,
 *    dispatch hints, steering consumers, the detectors that should
 *    have caught the struggle) or report no-change.
 *  - Dedup is downstream. The item id hashes the job id — never the
 *    counts or timestamps — so a refresh re-derives the same id and
 *    appendUserBacklogItems adds only what is new; a job that stops
 *    accumulating notes simply stops re-adding.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { STRAY_ID_PATTERN } from '../fleet/stray-slots.js';
import { JOB_NOTES_FILE, JOB_SAY_SCHEMA } from '../fleet/job-notes-types.js';
import { jobTimelines, parseLedgerTs, type JobTimeline } from '../metrics/loop.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_RELATIVE } from '../router/outcomes.js';

/** Items one call may emit; cells are bounded by distinct steered job ids. */
export const JOB_NOTES_MAX_ITEMS = 8;
const JOB_NOTES_ITEM_HARD_MAX = 25;
/**
 * The recurring bar: a job needs this many distinct recorded notes
 * inside the window before its steering pattern becomes work — the
 * fleet's RECURRING_FAILURES convention the sibling feeds apply.
 */
export const JOB_NOTES_RECURRING = 3;
/** Evidence window: one week of notes gives recurring steering patterns room without letting stale evidence linger. */
export const JOB_NOTES_WINDOW_HOURS = 168;
/** Tail bound on the notes ledger — the same 256 KiB window the sibling fleet-evidence feeds apply. */
export const JOB_NOTES_MAX_BYTES = 256 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: note evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** `by` is caller-controlled surface text; only ledger-shaped tokens count as distinct senders. */
const SAFE_SENDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

export interface JobNotesItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding queue/job-notes.jsonl; $ASHLR_RUNS_DIR wins when set, else <home>/.ashlr-runs — the writer's own resolveRunsDir precedence. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default JOB_NOTES_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default JOB_NOTES_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One job's recorded steering notes inside the window. */
export interface JobNotesCell {
  /** The job id every note named. */
  job: string;
  /** Distinct recorded notes inside the window. */
  count: number;
  /** Distinct ledger-shaped `by` surfaces; anything else folds into the count only. */
  senders: number;
  /** ISO bounds of the job's recorded notes. */
  firstSeen: string;
  lastSeen: string;
  /** The jobs-ledger lifecycle verdict; 'unknown' when no row exists. */
  outcome: string;
}

/** The repository name the fleet machinery records: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

interface NoteRow {
  job: string;
  by: string;
  ms: number;
}

/** One validated ledger row: schema, ledger-shaped job id, recorded note text, parseable timestamp, recorded sender. */
function parseNoteRows(text: string): NoteRow[] {
  const rows: NoteRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { continue; }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (row['schema'] !== JOB_SAY_SCHEMA) continue;
    const job = row['job'];
    if (typeof job !== 'string' || !STRAY_ID_PATTERN.test(job)) continue;
    if (typeof row['text'] !== 'string' || row['text'] === '') continue;
    const ms = parseLedgerTs(row['at']);
    if (ms === null) continue;
    const by = typeof row['by'] === 'string' && SAFE_SENDER.test(row['by']) ? row['by'] : 'unrecorded';
    rows.push({ job, by, ms });
  }
  return rows;
}

/**
 * Pure: fold the notes ledger's text into per-job cells inside the
 * window. Rows are validated against the writer's own record shape;
 * rows whose timestamp cannot be placed inside [nowMs - windowMs,
 * nowMs] never reach a cell.
 */
export function foldJobNotesCells(text: string, nowMs: number, windowMs: number): JobNotesCell[] {
  const cells = new Map<string, { count: number; senders: Set<string>; firstMs: number; lastMs: number }>();
  for (const row of parseNoteRows(text)) {
    if (row.ms > nowMs || row.ms < nowMs - windowMs) continue;
    let cell = cells.get(row.job);
    if (cell === undefined) {
      cell = { count: 0, senders: new Set<string>(), firstMs: row.ms, lastMs: row.ms };
      cells.set(row.job, cell);
    }
    cell.count += 1;
    cell.senders.add(row.by);
    cell.firstMs = Math.min(cell.firstMs, row.ms);
    cell.lastMs = Math.max(cell.lastMs, row.ms);
  }
  return [...cells.entries()]
    .map(([job, cell]) => ({
      job,
      count: cell.count,
      senders: cell.senders.size,
      firstSeen: new Date(cell.firstMs).toISOString(),
      lastSeen: new Date(cell.lastMs).toISOString(),
      outcome: 'unknown',
    }))
    .sort((a, b) => b.count - a.count || a.job.localeCompare(b.job));
}

/** The jobs-ledger lifecycle verdict for one job id, honest 'unknown' when no row exists. */
function outcomeText(timeline: JobTimeline | undefined): string {
  if (timeline === undefined) return 'unknown — no jobs-ledger row';
  if (timeline.mergedAt !== null) return `merged${timeline.prUrl !== null ? ` (${timeline.prUrl})` : ''}`;
  if (timeline.finishedAt !== null) return 'finished without a recorded merge';
  if (timeline.launchedAt !== null) return 'launched; no finish recorded';
  if (timeline.enqueuedAt !== null) return 'enqueued; never launched';
  return 'unknown — ledger row carries no lifecycle stamps';
}

/** Candidate runs dirs for metrics/jobs.jsonl: the notes dir's own root plus the writer-pinned ~/.ashlr-runs when they differ (dispatchd ignores ASHLR_RUNS_DIR). */
function jobsLedgerDirs(notesRunsDir: string, home: string): string[] {
  const dirs = [notesRunsDir];
  const pinned = join(home, '.ashlr-runs');
  if (resolve(pinned) !== resolve(notesRunsDir)) dirs.push(pinned);
  return dirs;
}

/** Bounded tail of metrics/jobs.jsonl under each candidate runs dir, folded through the canonical jobTimelines dialect; empty on any read failure — attribution degrades to 'unknown', never blocks the note evidence. */
async function readJobTimelines(runsDirs: readonly string[], nowMs: number): Promise<ReadonlyMap<string, JobTimeline>> {
  try {
    const texts: string[] = [];
    for (const runsDir of runsDirs) {
      const tail = await readLedgerTail(join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE));
      if (tail.state === 'read') texts.push(tail.text);
    }
    if (texts.length === 0) return new Map();
    return jobTimelines(texts.join('\n'), nowMs);
  } catch {
    return new Map();
  }
}

const NO_CHANGE = 'If the window has rolled forward, the notes were a one-off clarification burst on legitimately hard work, every note was answered and the job landed cleanly, or the cause is owner-only or pinned ops machinery (credentials, billing, host state, the Security-reviewed dispatcher files under contrib/mac and ~/.ashlr-runs/bin) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the folding commands are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is queue/job-notes.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR — the same precedence `phm job say` resolves), one JSON line per accepted note: {schema: \'fleet.job.say.v1\', job, id, at, text, by}. `phm job notes <job>` reads one job\'s recorded notes and `phm job say <job> <text>` is the writer; metrics/jobs.jsonl under the same runs roots carries the job\'s launch/finish/merge lifecycle the outcome line quotes. Note text is deliberately never quoted here — it is free prose that can carry anything; counts, surfaces, timestamps and the jobs-ledger verdict are the whole evidence.';

function seenText(cell: JobNotesCell): string {
  return cell.firstSeen === cell.lastSeen
    ? ` First and last note ${cell.firstSeen}.`
    : ` First note ${cell.firstSeen}, last ${cell.lastSeen}.`;
}

function jobNotesPrompt(cell: JobNotesCell, truncated: boolean): string {
  return [
    `Fleet job '${cell.job}' accumulated ${cell.count} recorded steering note(s) inside the window — ${cell.senders} distinct recorded surface(s) — the self-improvement work this backlog exists for.`,
    '',
    `Every queue/job-notes.jsonl row is one accepted \`phm job say\` note: a mid-flight redirect somebody decided a running or queued job needed. Finished jobs refuse notes and a repeated identical text records once, so ${cell.count} rows are ${cell.count} distinct steering acts. Jobs-ledger outcome: ${cell.outcome}.${seenText(cell)}${truncated ? ' The notes tail was truncated, so these counts are a lower bound.' : ''}`,
    '',
    EVIDENCE,
    '',
    `A job needing repeated steering is a signal the fleet's own machinery should have caught earlier. Find which side owns the cause: the job spec or queue row that left scope or acceptance ambiguous (queue producers, backlog item prompts, router-queue rows this repository writes); the lane/model choice that mismatched the task (metrics/jobs.jsonl attribution and route receipts); a detector gap — stuck-job, anomaly or friction feeds that should have named the struggle before a human did; or a runner that never reads its notes, so steering could not land. If the notes were a one-off clarification burst on legitimately hard work that then landed cleanly — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function jobNotesItem(cell: JobNotesCell, repo: string, truncated: boolean): CloudBacklogItem {
  const id = `fleet-job-notes-${createHash('sha256').update(`job-notes:${cell.job}`).digest('hex').slice(0, 16)}`;
  const title = `Job ${cell.job} needed ${cell.count} steering notes`;
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: jobNotesPrompt(cell, truncated),
    area: 'job-notes',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for jobs whose steering-notes ledger shows recurring
 * recorded notes inside the window. Total: any read or fold failure
 * yields no items rather than throwing into discovery.
 */
export async function jobNotesBacklogItems(opts: JobNotesItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence job-notes.ts resolveRunsDir applies: explicit dir,
    // then a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an empty env
    // value is no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = (opts.windowHours ?? JOB_NOTES_WINDOW_HOURS) * 3_600_000;
    const tail = await readLedgerTail(join(runsDir, JOB_NOTES_FILE), JOB_NOTES_MAX_BYTES);
    if (tail.state === 'unreadable' || tail.state === 'not-file') return [];
    if (tail.state !== 'read') return [];
    const truncated = tail.truncated;
    const cells = foldJobNotesCells(tail.text, nowMs, windowMs)
      .filter((cell) => cell.count >= JOB_NOTES_RECURRING);
    if (cells.length === 0) return [];
    const timelines = await readJobTimelines(jobsLedgerDirs(runsDir, home), nowMs);
    const limit = Math.max(1, Math.min(opts.limit ?? JOB_NOTES_MAX_ITEMS, JOB_NOTES_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) =>
      jobNotesItem({ ...cell, outcome: outcomeText(timelines.get(cell.job)) }, repo, truncated));
  } catch {
    return [];
  }
}
