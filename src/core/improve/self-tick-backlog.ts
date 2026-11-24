/**
 * Fleet self-tick run-record journal recurring adverse evidence →
 * self-improvement backlog items.
 *
 * `ashlr fleet self-tick` is the fleet's scheduled maintenance pass —
 * the launchd/systemd timer self-tick-schedule.ts installs runs it every
 * SELF_TICK_DEFAULT_INTERVAL_SECONDS (900s, configurable 300–3600). Each
 * run executes the fixed fifteen-step order in src/core/fleet/self-tick.ts
 * (SELF_TICK_STEP_ORDER: reset-release, lane-autohold, stray-stop,
 * meter-incident, planner-tick, inbox-acks, owner-live, order-notices,
 * board-notify, recheck-record, needs-triage, waste-incident,
 * teammate-overdue, landed-sweep, cos-work) under a single-runner lock,
 * then — ran or bounced — appendSelfTickLine in
 * src/core/fleet/self-tick-last.ts appends one
 * `fleet.self-tick-record.v1` line to `queue/self-tick.jsonl` under the
 * fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), keeping the
 * newest 500. The record carries the run's mode, its ran/busy state,
 * the failed steps with their error text, the planner-tick intake
 * hooks' folded outcomes (hooksFromPlannerReport in
 * src/core/fleet/self-tick-hooks.ts: autofill, gaps, reap,
 * stranded-requeue — each ran, skipped, failed or not-recorded) and
 * any empty-family auto-stop proposals the planner's empty-stop stage
 * wrote that tick.
 *
 * Until now the history file had no reader at all — its only consumer
 * was the writer's own 500-line trim and a test asserting the append.
 * `phm fleet self-tick --last`/`--status` and the Verse self-tick card
 * read queue/self-tick-last.json, which names only the LAST run: a
 * step that fails every tick, a pass that keeps bouncing off its lock,
 * an intake hook that keeps throwing or silently stops being recorded,
 * or an empty producer family that keeps re-earning its 12-hour
 * auto-stop each expiry looked like a string of one-off bad ticks —
 * never a pattern, never work. The self-tick IS the self-improvement
 * cadence (planner-tick harvests gaps and applies autofill inside it),
 * so its own recurring failures are the lane's most direct evidence.
 *
 * selfTickBacklogItems carries the same journal into discoverBacklog,
 * so `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the sibling daemon-tick, worktree-reap and host-load
 * sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail; nothing is written and no lock, process
 *    or network is touched. A missing, non-file or unreadable journal
 *    yields no items — unknown stays unknown, never a guessed tally —
 *    while a truncated tail still folds the retained rows with the
 *    prompts stating the counts as lower bounds.
 *  - Rows count only under the writer's contract: schema
 *    'fleet.self-tick-record.v1', a parseable `at`, mode inside
 *    {apply, dry-run} and state inside {ran, busy}, with failedSteps
 *    and hooks arrays of on-contract entries (step names inside
 *    SELF_TICK_STEP_ORDER, hook names inside the SelfTickHookName
 *    vocabulary, hook states inside the writer's four) and familyStops
 *    absent, null or an array of {family, until, why} rows — the field
 *    postdates the journal, so older rows legitimately lack it.
 *    Malformed lines,
 *    foreign shapes and off-contract rows are skipped, never guessed;
 *    entries inside a valid row that fail their own contract are
 *    dropped, not folded.
 *  - Deliberate states never emit: 'skipped' steps and 'skipped' hooks
 *    are the writer's own deliberate-off vocabulary (dry-run modes,
 *    upstream skips, wait windows, custom-runs-dir guards), 'ran'
 *    hooks and clean runs are the machinery working, and a 'busy'
 *    record is only evidence in recurrence — one collided tick is
 *    normal overlap, never a finding.
 *  - Recurring means recorded across days at a rate that cannot be a
 *    transient burst: a cell emits only when its in-window records
 *    reach SELF_TICK_MIN_UNITS across SELF_TICK_MIN_DAYS distinct UTC
 *    days — a single bad tick or a one-day burst stays quiet. The
 *    window is anchored on the clock with the sibling feeds'
 *    future-skew allowance, and the 500-line retention means a
 *    faster schedule can leave too little history to prove two days
 *    of recurrence — the source then stays quiet rather than claim
 *    what the retained tail cannot show.
 *  - The evidence carries no repository dimension — it describes this
 *    install's fleet machinery. Items therefore emit only when the
 *    backlog target's repository name is 'phantom', the same
 *    last-segment rule the sibling fleet-evidence sources apply.
 *  - Dedup is downstream. Item ids key on the cell — step name, the
 *    fixed busy cell, hook name + adverse state, or a hash of the
 *    family id — never the counts or timestamps, so a refresh
 *    re-derives the same ids and appendUserBacklogItems adds only
 *    what is new; a step that recovers or a family that stops
 *    re-qualifying simply stops re-adding.
 *  - Every journal string is untrusted text: step errors, hook notes
 *    and family names/whys are scrubbed, flattened and capped before
 *    they reach a prompt, and family ids are hashed into item ids so
 *    raw text never becomes an identifier.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { SELF_TICK_HISTORY } from '../fleet/self-tick-last.js';
import { SELF_TICK_STEP_ORDER } from '../fleet/self-tick.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the cap bounds the open-ended family cells. */
export const SELF_TICK_BACKLOG_MAX_ITEMS = 12;
const SELF_TICK_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const SELF_TICK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, same convention the sibling folds tolerate. */
const SELF_TICK_FUTURE_SKEW_MS = 60_000;
/** In-window records a cell needs before its outcome counts as recurring. */
export const SELF_TICK_MIN_UNITS = 3;
/** Distinct UTC days the records must span — recurring means recorded across days. */
export const SELF_TICK_MIN_DAYS = 2;
/**
 * Bounded tail for the journal; the writer keeps the newest 500 records
 * of a few hundred bytes each, so 512 KiB retains the whole live file.
 */
const SELF_TICK_TAIL_BYTES = 512 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are unbounded text; flatten, scrub and cap before use. */
const FIELD_MAX = 160;
/** Distinct sample texts quoted inside one prompt before the rest is summarized. */
const PROMPT_SAMPLES_MAX = 4;
/** The fleet's own repository label: self-tick evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';

/** The record schema the writer stamps on every history line. */
const RECORD_SCHEMA = 'fleet.self-tick-record.v1';
const RECORD_MODES = new Set(['apply', 'dry-run']);
const RECORD_STATES = new Set(['ran', 'busy']);
/**
 * The planner-tick intake hook vocabulary — mirrors SelfTickHookName in
 * src/core/fleet/self-tick-hooks.ts (a type-only export, so the set is
 * spelled out here against the writer's four hooks).
 */
const HOOK_NAMES = new Set(['autofill', 'gaps', 'reap', 'stranded-requeue']);
/** The hook states the writer records; only 'failed' and 'not-recorded' are adverse. */
const HOOK_STATES = new Set(['ran', 'skipped', 'failed', 'not-recorded']);
const HOOK_ADVERSE_STATES = new Set(['failed', 'not-recorded']);

type CellKind = 'step-failed' | 'tick-busy' | 'hook-failed' | 'hook-unrecorded' | 'family-stop';

export interface SelfTickItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding queue/self-tick.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default SELF_TICK_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default SELF_TICK_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One failedSteps entry that passed the writer's contract. */
export interface SelfTickFailedStep {
  step: string;
  error: string | null;
}

/** One hooks entry that passed the writer's contract. */
export interface SelfTickHookRow {
  hook: string;
  state: string;
  note: string | null;
}

/** One familyStops entry that passed the writer's contract. */
export interface SelfTickFamilyStop {
  family: string;
  until: number;
  why: string;
}

/** One validated run record inside the evidence window. */
export interface SelfTickRecord {
  atMs: number;
  utcDay: string;
  mode: string;
  state: string;
  failedSteps: SelfTickFailedStep[];
  hooks: SelfTickHookRow[];
  familyStops: SelfTickFamilyStop[];
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const nullableString = (value: unknown): string | null | undefined =>
  value === null || typeof value === 'string' ? value : undefined;

/**
 * Pure: validate one parsed ledger line against the writer's record
 * contract. The schema stamp, a parseable `at`, the mode/state
 * vocabularies and the three evidence collections must all hold —
 * anything else is not a self-tick record. Entries inside the
 * collections that fail their own contract are dropped; a collection
 * that is not the writer's array-or-null shape rejects the row.
 */
export function parseSelfTickRecord(value: unknown): SelfTickRecord | null {
  if (!isRecord(value)) return null;
  if (value['schema'] !== RECORD_SCHEMA) return null;
  const at = value['at'];
  const atMs = typeof at === 'string' ? Date.parse(at) : NaN;
  if (!Number.isFinite(atMs)) return null;
  const mode = value['mode'];
  const state = value['state'];
  if (typeof mode !== 'string' || !RECORD_MODES.has(mode)) return null;
  if (typeof state !== 'string' || !RECORD_STATES.has(state)) return null;

  const failedRaw = value['failedSteps'];
  const hooksRaw = value['hooks'];
  const familyRaw = value['familyStops'];
  if (!Array.isArray(failedRaw) || !Array.isArray(hooksRaw)) return null;
  // familyStops postdates the journal itself: rows written before the
  // empty-family auto-stop landed carry no such key, and absent means
  // that run recorded no stop proposals — not a contract violation.
  if (!(familyRaw === undefined || familyRaw === null || Array.isArray(familyRaw))) return null;

  const failedSteps: SelfTickFailedStep[] = [];
  for (const entry of failedRaw) {
    if (!isRecord(entry)) continue;
    const step = entry['step'];
    const error = nullableString(entry['error']);
    if (typeof step !== 'string' || error === undefined) continue;
    // The writer only ever records SELF_TICK_STEP_ORDER names; a foreign
    // name is not this contract's evidence.
    if (!SELF_TICK_STEP_ORDER.includes(step as (typeof SELF_TICK_STEP_ORDER)[number])) continue;
    failedSteps.push({ step, error });
  }

  const hooks: SelfTickHookRow[] = [];
  for (const entry of hooksRaw) {
    if (!isRecord(entry)) continue;
    const hook = entry['hook'];
    const hookState = entry['state'];
    const note = nullableString(entry['note']);
    if (typeof hook !== 'string' || !HOOK_NAMES.has(hook)) continue;
    if (typeof hookState !== 'string' || !HOOK_STATES.has(hookState)) continue;
    if (note === undefined) continue;
    hooks.push({ hook, state: hookState, note });
  }

  const familyStops: SelfTickFamilyStop[] = [];
  for (const entry of familyRaw ?? []) {
    if (!isRecord(entry)) continue;
    const family = entry['family'];
    const until = entry['until'];
    const why = entry['why'];
    if (typeof family !== 'string' || family.trim() === '') continue;
    if (typeof until !== 'number' || !Number.isFinite(until)) continue;
    if (typeof why !== 'string') continue;
    familyStops.push({ family: family.trim(), until, why });
  }

  return { atMs, utcDay: utcDayOf(atMs), mode, state, failedSteps, hooks, familyStops };
}

/**
 * Pure: parse journal text into validated records plus the count of
 * lines that were not on-contract records — malformed JSON, foreign
 * shapes and off-contract rows are counted, never guessed.
 */
export function parseSelfTickJournal(text: string): { records: SelfTickRecord[]; invalidRows: number } {
  const records: SelfTickRecord[] = [];
  let invalidRows = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      invalidRows += 1;
      continue;
    }
    const record = parseSelfTickRecord(value);
    if (record === null) { invalidRows += 1; continue; }
    records.push(record);
  }
  return { records, invalidRows };
}

/** One evidence cell's recurring tally across the in-window records. */
interface SelfTickCell {
  kind: CellKind;
  /** Stable cell key: dedupes the fold and orders the emission. */
  key: string;
  /** Display name — a step/hook vocabulary word or the raw family id. */
  name: string;
  /** Records carrying this cell inside the window. */
  units: number;
  /** Distinct UTC days those records fall on. */
  days: Set<string>;
  /** Distinct scrubbed sample texts, capped at PROMPT_SAMPLES_MAX. */
  samples: string[];
  /** True when more distinct samples existed than were kept. */
  sampleOverflow: boolean;
  firstAtMs: number;
  lastAtMs: number;
}

/** Journal-recorded strings are untrusted text; flatten, scrub and cap before use. */
function fieldText(value: string | null, max = FIELD_MAX): string {
  if (value === null) return '';
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

function cellFor(cells: Map<string, SelfTickCell>, kind: CellKind, key: string, name: string): SelfTickCell {
  let cell = cells.get(key);
  if (cell === undefined) {
    cell = { kind, key, name, units: 0, days: new Set(), samples: [], sampleOverflow: false, firstAtMs: Infinity, lastAtMs: -Infinity };
    cells.set(key, cell);
  }
  return cell;
}

function addSample(cell: SelfTickCell, text: string): void {
  const cleaned = fieldText(text);
  if (cleaned === '') return;
  if (cell.samples.includes(cleaned)) return;
  if (cell.samples.length >= PROMPT_SAMPLES_MAX) { cell.sampleOverflow = true; return; }
  cell.samples.push(cleaned);
}

function touch(cell: SelfTickCell, record: SelfTickRecord): void {
  cell.units += 1;
  cell.days.add(record.utcDay);
  cell.firstAtMs = Math.min(cell.firstAtMs, record.atMs);
  cell.lastAtMs = Math.max(cell.lastAtMs, record.atMs);
}

/**
 * Pure: fold validated in-window records into per-cell tallies. Only
 * the writer's adverse vocabulary counts: failedSteps entries, 'busy'
 * run states, hooks in 'failed'/'not-recorded' and familyStops
 * proposals. Skipped steps/hooks, ran hooks, clean runs and busy
 * records below the recurrence bars are context, never evidence.
 */
export function foldSelfTickEvidence(
  records: readonly SelfTickRecord[],
  opts: { nowMs: number; windowMs?: number },
): { cells: SelfTickCell[]; records: number; outsideWindow: number } {
  const windowMs = opts.windowMs ?? SELF_TICK_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const cells = new Map<string, SelfTickCell>();
  let inWindow = 0;
  let outsideWindow = 0;
  for (const record of records) {
    if (record.atMs < windowStart || record.atMs > opts.nowMs + SELF_TICK_FUTURE_SKEW_MS) {
      outsideWindow += 1;
      continue;
    }
    inWindow += 1;
    for (const step of record.failedSteps) {
      const cell = cellFor(cells, 'step-failed', `step:${step.step}`, step.step);
      touch(cell, record);
      addSample(cell, step.error ?? 'no error text recorded (nonzero exit or unparsed report)');
    }
    if (record.state === 'busy') {
      const cell = cellFor(cells, 'tick-busy', 'busy', '');
      touch(cell, record);
    }
    for (const hook of record.hooks) {
      if (!HOOK_ADVERSE_STATES.has(hook.state)) continue;
      const kind: CellKind = hook.state === 'failed' ? 'hook-failed' : 'hook-unrecorded';
      const cell = cellFor(cells, kind, `hook:${hook.hook}:${hook.state}`, hook.hook);
      touch(cell, record);
      addSample(cell, hook.note ?? (hook.state === 'failed' ? 'failed with no note recorded' : 'no note recorded'));
    }
    for (const stop of record.familyStops) {
      const cell = cellFor(cells, 'family-stop', `family:${stop.family}`, stop.family);
      touch(cell, record);
      addSample(cell, stop.why);
    }
  }
  const recurring = [...cells.values()]
    .filter((cell) => cell.units >= SELF_TICK_MIN_UNITS && cell.days.size >= SELF_TICK_MIN_DAYS)
    .sort((a, b) => b.units - a.units || a.key.localeCompare(b.key));
  return { cells: recurring, records: inWindow, outsideWindow };
}

/** The evidence pointers every prompt shares; the journal, its writer and its existing readers are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is queue/self-tick.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), schema fleet.self-tick-record.v1 — one record per `ashlr fleet self-tick` run appended by appendSelfTickLine in src/core/fleet/self-tick-last.ts, ran or bounced off the single-runner lock, newest 500 kept — carrying the run\'s mode, ran/busy state, failedSteps, the planner-tick intake hooks\' outcomes and any empty-family auto-stop proposals. `phm fleet self-tick --last` and `--status` read only queue/self-tick-last.json, the LAST run; nothing else folds this history.';

const NO_CHANGE = 'If the window has rolled forward, the failures were a one-off burst the later records recovered from, or the cause is owner-side or pinned ops machinery (the installed launchd/systemd schedule, credentials, billing, host resources, the Security-reviewed files under contrib/mac and ~/.ashlr-runs/bin) — report no-change and name the evidence.';

function spanText(firstAtMs: number, lastAtMs: number): string {
  if (!Number.isFinite(firstAtMs) || !Number.isFinite(lastAtMs)) return '';
  const first = new Date(firstAtMs).toISOString();
  const last = new Date(lastAtMs).toISOString();
  return first === last ? ` Recorded ${first}.` : ` Recorded ${first} through ${last}.`;
}

function coverageNote(truncated: boolean, invalidRows: number, outsideWindow: number): string {
  const notes: string[] = [];
  if (truncated) notes.push('the bounded tail dropped older rows, so every count is a lower bound');
  if (invalidRows > 0) notes.push(`${invalidRows} malformed or off-contract lines dropped`);
  if (outsideWindow > 0) notes.push(`${outsideWindow} records outside the window not counted`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

function samplesText(cell: SelfTickCell): string {
  if (cell.samples.length === 0) return 'no sample texts were recorded';
  const joined = cell.samples.map((s) => `'${s}'`).join(', ');
  return cell.sampleOverflow ? `${joined}, and more` : joined;
}

function cellCounts(cell: SelfTickCell): string {
  return `${cell.units} in-window records across ${cell.days.size} UTC days`;
}

/** Family ids are unbounded journal text; scrub, flatten and cap before they reach a prompt or an id. */
function familyText(family: string): string {
  return fieldText(family, 80) || 'unnamed';
}

function stepPrompt(cell: SelfTickCell, truncated: boolean, invalidRows: number, outsideWindow: number): string {
  const step = fieldText(cell.name, 60) || 'unknown';
  return [
    `Phantom's fleet self-tick keeps failing at step '${step}' — ${cellCounts(cell)} inside the window carry it in failedSteps, the self-improvement work this backlog exists for.`,
    '',
    `The self-tick is the fleet's scheduled maintenance pass (src/core/fleet/self-tick.ts, installed by self-tick-schedule.ts): every run executes the fixed fifteen-step order and journals each failure here. Step names are the writer's fixed vocabulary (SELF_TICK_STEP_ORDER); a step that cannot be configured on this install records a 'step-not-configured' failure, and a nonzero exit or thrown verb records the same cell with whatever error text survived.${spanText(cell.firstAtMs, cell.lastAtMs)} Recorded samples: ${samplesText(cell)}.${coverageNote(truncated, invalidRows, outsideWindow)}`,
    '',
    EVIDENCE,
    '',
    `Find why the step keeps failing: run its verb with --json against a scratch runs dir and read the failure its report carries — a missing step seam, a thrown verb, a nonzero exit the verb reports, or machinery this repo owns (planner intake, reaps, sweeps, notices, the cos turn). If the recurring cause is the installed schedule, host resources or pinned ops machinery rather than repo code — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function busyPrompt(cell: SelfTickCell, truncated: boolean, invalidRows: number, outsideWindow: number): string {
  return [
    `Phantom's fleet self-tick keeps reporting busy — ${cellCounts(cell)} inside the window bounced off the single-runner lock, so the scheduled maintenance pass's steps did not execute on those ticks.`,
    '',
    `A 'busy' record means runSelfTick's acquire on queue/self-tick.lock resolved contended or unavailable and the run returned without stepping — the lock holder was still live, the lock infrastructure failed, or the dead-owner reclaim had not yet freed a stale lock. One collision is normal overlap; recurrence across days means ticks are consistently starving or a lock is wedged.${spanText(cell.firstAtMs, cell.lastAtMs)}${coverageNote(truncated, invalidRows, outsideWindow)}`,
    '',
    EVIDENCE,
    '',
    `Find what keeps the lock from freeing: a wedged queue/self-tick.lock whose dead-owner reclaim (src/core/fleet/local-store-lock.ts) is not firing, overlapping schedulers on this host, or runs that legitimately outlast the interval (SELF_TICK_DEFAULT_INTERVAL_SECONDS is 900s, configurable 300–3600). The lock and reclaim machinery and the self-tick steps live in this repo; the installed launchd/systemd schedule is ops machinery — if the evidence says the interval itself is too short for the work, report no-change and name the measurement. ${NO_CHANGE}`,
  ].join('\n');
}

function hookFailedPrompt(cell: SelfTickCell, truncated: boolean, invalidRows: number, outsideWindow: number): string {
  const hook = fieldText(cell.name, 60) || 'unknown';
  return [
    `Phantom's self-tick planner intake hook '${hook}' keeps failing — ${cellCounts(cell)} inside the window recorded state 'failed' for it, the self-improvement work this backlog exists for.`,
    '',
    `The planner-tick step wraps four intake hooks — autofill, gaps, reap and stranded-requeue — folded by hooksFromPlannerReport in src/core/fleet/self-tick-hooks.ts onto every run record. 'failed' means the hook threw or its stage reported an error; the recorded note is the error text the fold survived. 'skipped' is the writer's deliberate-off vocabulary and never counts here, so this cell is thrown errors only.${spanText(cell.firstAtMs, cell.lastAtMs)} Recorded notes: ${samplesText(cell)}.${coverageNote(truncated, invalidRows, outsideWindow)}`,
    '',
    EVIDENCE,
    '',
    `Find why the hook keeps throwing: its stage runs inside the planner-tick step in src/cli/fleet-self-tick.ts (runAutofillStage, runWorktreeReapStage, runStrandedRequeueStage and the asks sync) over core modules in src/core/fleet/ — a missing dependency, an unreadable input the stage does not guard, or a contract drift between the stage's report and the hook fold. If the note names a custom-runs-dir guard, missing config or an unavailable external dependency rather than repo code — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function hookUnrecordedPrompt(cell: SelfTickCell, truncated: boolean, invalidRows: number, outsideWindow: number): string {
  const hook = fieldText(cell.name, 60) || 'unknown';
  return [
    `Phantom's self-tick planner report stopped carrying '${hook}'s outcome — ${cellCounts(cell)} inside the window recorded 'not-recorded' for it, so what the intake hook did is unverifiable on those runs.`,
    '',
    `'not-recorded' is hooksFromPlannerReport's mark for a hook whose block the planner-tick step's --json report does not carry in a recognizable shape — the step exited clean but its output no longer matches the contract the record fold reads, or the installed planner predates the hook entirely (stranded-requeue is the newest of the four). The hook's work may still run; its outcome is simply absent from the evidence.${spanText(cell.firstAtMs, cell.lastAtMs)} Recorded notes: ${samplesText(cell)}.${coverageNote(truncated, invalidRows, outsideWindow)}`,
    '',
    EVIDENCE,
    '',
    `Find whether the planner verb's report shape drifted (the planner-tick step in src/cli/fleet-self-tick.ts and the fold in src/core/fleet/self-tick-hooks.ts must agree on the hook blocks) or the installed build is older than the record contract — install lag is ops-side, a shape drift in this repo is the fix. If every hook is unrecorded together, suspect the planner report itself went unparseable while the step still exited 0. ${NO_CHANGE}`,
  ].join('\n');
}

function familyPrompt(cell: SelfTickCell, truncated: boolean, invalidRows: number, outsideWindow: number): string {
  const family = familyText(cell.name);
  return [
    `Phantom's empty-family brake keeps firing for '${family}' — ${cellCounts(cell)} inside the window proposed a fresh 12-hour auto-stop for it, the self-improvement work this backlog exists for.`,
    '',
    `runEmptyApplyTick — the empty-stop stage inside the planner-tick step, src/core/fleet/empty-family-apply.ts — proposes a family auto-stop when the brief window shows the family minting empty finishes with no pull requests and no merges (familyAutoStop in src/core/fleet/family-auto-stop.ts), writes it to queue/family-stop.tsv and lets it expire after 12 hours. A family that keeps re-qualifying after each expiry is a producer whose launches keep ending empty: the stop treats the symptom, and this recurrence is the brake's own measure that the cause persists.${spanText(cell.firstAtMs, cell.lastAtMs)} Recorded proposals: ${samplesText(cell)}.${coverageNote(truncated, invalidRows, outsideWindow)}`,
    '',
    EVIDENCE,
    '',
    `Find the producer: which queue source or generator keeps minting this family's jobs and why they finish empty — the underlying yield evidence is metrics/jobs.jsonl (phm jobs yield --by source, the sibling source-yield, empty-tag and precheck-skip feeds tally the same empties from other angles). Fix the producer or its prompt in this repo; if the family is deliberately parked, its empties are correct DONE-NOOPs, or the stop file itself is the problem — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function cellSlug(cell: SelfTickCell): string {
  switch (cell.kind) {
    case 'step-failed': return `step-${cell.name}`;
    case 'tick-busy': return 'busy';
    case 'hook-failed': return `hook-${cell.name}-failed`;
    case 'hook-unrecorded': return `hook-${cell.name}-unrecorded`;
    case 'family-stop': return `family-${createHash('sha256').update(cell.name).digest('hex').slice(0, 12)}`;
  }
}

function cellTitle(cell: SelfTickCell): string {
  switch (cell.kind) {
    case 'step-failed': return `Fleet self-tick step '${fieldText(cell.name, 60)}' keeps failing`;
    case 'tick-busy': return 'Fleet self-tick keeps reporting busy — scheduled steps are not running';
    case 'hook-failed': return `Self-tick planner hook '${fieldText(cell.name, 60)}' keeps failing`;
    case 'hook-unrecorded': return `Self-tick planner hook '${fieldText(cell.name, 60)}' outcome is never recorded`;
    case 'family-stop': return `Empty-family auto-stop keeps firing for '${familyText(cell.name)}'`;
  }
}

function cellPrompt(cell: SelfTickCell, truncated: boolean, invalidRows: number, outsideWindow: number): string {
  switch (cell.kind) {
    case 'step-failed': return stepPrompt(cell, truncated, invalidRows, outsideWindow);
    case 'tick-busy': return busyPrompt(cell, truncated, invalidRows, outsideWindow);
    case 'hook-failed': return hookFailedPrompt(cell, truncated, invalidRows, outsideWindow);
    case 'hook-unrecorded': return hookUnrecordedPrompt(cell, truncated, invalidRows, outsideWindow);
    case 'family-stop': return familyPrompt(cell, truncated, invalidRows, outsideWindow);
  }
}

function selfTickItem(cell: SelfTickCell, repo: string, truncated: boolean, invalidRows: number, outsideWindow: number): CloudBacklogItem {
  return {
    id: `selftick-${cellSlug(cell)}`,
    title: cellTitle(cell).slice(0, MAX_TITLE_CHARS),
    prompt: cellPrompt(cell, truncated, invalidRows, outsideWindow),
    area: 'fleet-self-tick',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the self-tick run-record journal's recurring
 * adverse evidence. Total: any read or fold failure yields no items
 * rather than throwing into discovery.
 */
export async function selfTickBacklogItems(opts: SelfTickItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the self-tick and vitals reads apply: explicit
    // dir, then a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an
    // empty env value is no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const ledger = await readLedgerTail(join(runsDir, SELF_TICK_HISTORY), SELF_TICK_TAIL_BYTES);
    if (ledger.state !== 'read') return [];
    const { records, invalidRows } = parseSelfTickJournal(ledger.text);
    const folded = foldSelfTickEvidence(records, { nowMs, windowMs: opts.windowMs });
    const items: CloudBacklogItem[] = [];
    for (const cell of folded.cells) {
      items.push(selfTickItem(cell, repo, ledger.truncated, invalidRows, folded.outsideWindow));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? SELF_TICK_BACKLOG_MAX_ITEMS, SELF_TICK_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
