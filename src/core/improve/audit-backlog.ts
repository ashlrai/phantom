/**
 * Autonomous-action audit journal recurring adverse evidence →
 * self-improvement backlog items.
 *
 * `audit()` in src/core/sandbox/audit.ts is the fleet's append-only
 * audit trail for autonomous and sandbox actions: every call site —
 * the daemon loop's tick/dispatch/persistence records, the inbox
 * apply and merge path's proposal and auto-merge rows, plugin
 * capability and command records, sandbox create/remove, verify
 * command outcomes, verse control surfaces and the confinement
 * wrapper — appends one `{ts, action, repo, sandboxId, summary,
 * result}` line to `~/.ashlr/audit/<UTC-date>.jsonl`, one file per
 * UTC day, never rotated, never deleted, summaries scrubbed of
 * secret-shaped values at write time. `result` is the writer's
 * closed outcome vocabulary: 'ok' the action completed, 'refused' a
 * policy gate declined it before it ran, 'error' it failed.
 *
 * Until now the journal's only readers were point-in-time surfaces:
 * `ashlr audit` tails the files for a human, the verse control-api
 * folds a bounded recent window for its card, and `phm fleet` status
 * shows the newest eight actions. None of them fold recurrence: an
 * action that keeps being refused — a gate misfiring on valid work,
 * or a hold nobody revisited — or keeps erroring — a call path that
 * throws, times out or exits nonzero day after day — looked like a
 * string of one-off rows in a viewer someone had to open, never a
 * pattern, never work. The audit trail IS the fleet's own record of
 * which machinery acts and which machinery fails, so its recurring
 * adverse cells are the lane's most direct evidence.
 *
 * auditBacklogItems carries the same journal into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the sibling daemon-tick, self-tick and custody feeds
 * beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. Only date-named partitions inside the evidence window
 *    are read, each once through readLedgerTail's bounded no-follow
 *    tail; nothing is written and no lock, process or network is
 *    touched. A missing directory or an unreadable partition yields
 *    no items while the rest still fold — unknown stays unknown,
 *    never a guessed tally — and a truncated tail folds the retained
 *    rows with the prompts stating the counts as lower bounds.
 *  - Rows count only under the writer's contract: a parseable `ts`,
 *    a non-empty `action` string, a `summary` string and `result`
 *    inside {ok, refused, error}; `repo`/`sandboxId` are accepted as
 *    string-or-null context the fold never emits (they carry absolute
 *    local paths, not owner/name pairs). Malformed lines are counted,
 *    never guessed.
 *  - Only 'refused' and 'error' rows are evidence: 'ok' is the action
 *    completing — including the writer's deliberate-off vocabulary,
 *    which several call sites record as 'ok' with an explanatory
 *    summary (budget pauses, kill-switch holds, skipped ticks) — so
 *    an operator state that is working as configured never emits.
 *  - Recurring means recorded across days at a rate that cannot be a
 *    transient burst: a cell emits only when its in-window records
 *    reach AUDIT_MIN_UNITS across AUDIT_MIN_DAYS distinct UTC days —
 *    a single failure or a one-day burst stays quiet. The window is
 *    anchored on the clock with the sibling feeds' future-skew
 *    allowance, and a partition tail that dropped older rows still
 *    folds with lower-bound counts.
 *  - The evidence is this install's audit trail: rows span every repo
 *    the daemon touches but describe Phantom's own machinery, so
 *    items emit only when the backlog target's repository name is
 *    'phantom', the same last-segment rule the sibling fleet-evidence
 *    sources apply.
 *  - Dedup is downstream. Item ids key on the cell — the action plus
 *    its refused/error outcome — never the counts or timestamps, so a
 *    refresh re-derives the same ids and appendUserBacklogItems adds
 *    only what is new; an action that recovers simply stops
 *    re-adding.
 *  - Every journal string is untrusted text: action names and
 *    summaries are scrubbed, flattened and capped before they reach a
 *    prompt, and cell identity hashes the raw pair so journal text
 *    never becomes an identifier.
 */
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { auditDir } from '../sandbox/audit.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the cap bounds the open-ended action cells. */
export const AUDIT_BACKLOG_MAX_ITEMS = 12;
const AUDIT_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const AUDIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, same convention the sibling folds tolerate. */
const AUDIT_FUTURE_SKEW_MS = 60_000;
/** In-window records a cell needs before its outcome counts as recurring. */
export const AUDIT_MIN_UNITS = 3;
/** Distinct UTC days the records must span — recurring means recorded across days. */
export const AUDIT_MIN_DAYS = 2;
/**
 * Bounded tail per date partition; audit rows run a few hundred bytes
 * each, so 1 MiB retains well over a thousand rows of the busiest
 * partition while keeping a discovery pass cheap.
 */
export const AUDIT_FILE_TAIL_BYTES = 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are unbounded text; flatten, scrub and cap before use. */
const FIELD_MAX = 160;
/** The writer's contract calls action a "short action verb"; longer strings are off-contract. */
const MAX_ACTION_CHARS = 200;
/** Distinct sample summaries quoted inside one prompt before the rest is summarized. */
const PROMPT_SAMPLES_MAX = 4;
/** The fleet's own repository label: audit evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Date-partition file names the writer produces: one <UTC-day>.jsonl per day. */
const PARTITION_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;

type CellKind = 'refused' | 'error';

export interface AuditItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Audit directory override (default: auditDir(), the writer's own resolver); tests only. */
  auditDirPath?: string;
  /** Most items one call emits (default AUDIT_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default AUDIT_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated audit row inside the evidence window. */
export interface AuditRow {
  atMs: number;
  utcDay: string;
  action: string;
  result: CellKind | 'ok';
  summary: string;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Pure: validate one parsed journal line against the writer's entry
 * contract — the same fields readAudit() checks, plus a parseable `ts`
 * the fold needs for windowing. `repo`/`sandboxId` are validated as
 * string-or-null context but never carried: they hold absolute local
 * paths, not owner/name pairs, so the fold cannot and must not emit
 * them. Anything else is not an audit row.
 */
export function parseAuditEntry(value: unknown): AuditRow | null {
  if (!isRecord(value)) return null;
  const ts = value['ts'];
  const atMs = typeof ts === 'string' ? Date.parse(ts) : NaN;
  if (!Number.isFinite(atMs)) return null;
  const action = value['action'];
  if (typeof action !== 'string' || action.trim() === '' || action.length > MAX_ACTION_CHARS) return null;
  const summary = value['summary'];
  if (typeof summary !== 'string') return null;
  const result = value['result'];
  if (result !== 'ok' && result !== 'refused' && result !== 'error') return null;
  const repo = value['repo'];
  if (!(repo === null || repo === undefined || typeof repo === 'string')) return null;
  const sandboxId = value['sandboxId'];
  if (!(sandboxId === null || sandboxId === undefined || typeof sandboxId === 'string')) return null;
  return { atMs, utcDay: utcDayOf(atMs), action: action.trim(), result, summary };
}

/**
 * Pure: parse one partition's text into validated rows plus the count
 * of lines that were not on-contract entries — malformed JSON and
 * off-contract rows are counted, never guessed.
 */
export function parseAuditPartition(text: string): { rows: AuditRow[]; invalidRows: number } {
  const rows: AuditRow[] = [];
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
    const row = parseAuditEntry(value);
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows };
}

/** One evidence cell's recurring tally across the in-window rows. */
interface AuditCell {
  kind: CellKind;
  /** The writer's action verb exactly as recorded. */
  action: string;
  /** Records carrying this cell inside the window. */
  units: number;
  /** Distinct UTC days those records fall on. */
  days: Set<string>;
  /** Distinct scrubbed sample summaries, capped at PROMPT_SAMPLES_MAX. */
  samples: string[];
  /** True when more distinct samples existed than were kept. */
  sampleOverflow: boolean;
  firstAtMs: number;
  lastAtMs: number;
}

/** Journal-recorded strings are untrusted text; flatten, scrub and cap before use. */
function fieldText(value: string, max = FIELD_MAX): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

function cellFor(cells: Map<string, AuditCell>, action: string, result: CellKind): AuditCell {
  const key = JSON.stringify([action, result]);
  let cell = cells.get(key);
  if (cell === undefined) {
    cell = { kind: result, action, units: 0, days: new Set(), samples: [], sampleOverflow: false, firstAtMs: Infinity, lastAtMs: -Infinity };
    cells.set(key, cell);
  }
  return cell;
}

function addSample(cell: AuditCell, text: string): void {
  const cleaned = fieldText(text);
  if (cleaned === '') return;
  if (cell.samples.includes(cleaned)) return;
  if (cell.samples.length >= PROMPT_SAMPLES_MAX) { cell.sampleOverflow = true; return; }
  cell.samples.push(cleaned);
}

function touch(cell: AuditCell, row: AuditRow): void {
  cell.units += 1;
  cell.days.add(row.utcDay);
  cell.firstAtMs = Math.min(cell.firstAtMs, row.atMs);
  cell.lastAtMs = Math.max(cell.lastAtMs, row.atMs);
}

/**
 * Pure: fold validated rows into per-(action, result) tallies. Only the
 * writer's adverse vocabulary counts — 'refused' and 'error' rows;
 * 'ok' rows are the action completing, deliberate operator states
 * included, and are context, never evidence.
 */
export function foldAuditEvidence(
  rows: readonly AuditRow[],
  opts: { nowMs: number; windowMs?: number },
): { cells: AuditCell[]; records: number; outsideWindow: number } {
  const windowMs = opts.windowMs ?? AUDIT_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const cells = new Map<string, AuditCell>();
  let inWindow = 0;
  let outsideWindow = 0;
  for (const row of rows) {
    if (row.atMs < windowStart || row.atMs > opts.nowMs + AUDIT_FUTURE_SKEW_MS) {
      outsideWindow += 1;
      continue;
    }
    inWindow += 1;
    if (row.result === 'ok') continue;
    const cell = cellFor(cells, row.action, row.result);
    touch(cell, row);
    addSample(cell, row.summary);
  }
  const recurring = [...cells.values()]
    .filter((cell) => cell.units >= AUDIT_MIN_UNITS && cell.days.size >= AUDIT_MIN_DAYS)
    .sort((a, b) => b.units - a.units || a.action.localeCompare(b.action) || a.kind.localeCompare(b.kind));
  return { cells: recurring, records: inWindow, outsideWindow };
}

/** The evidence pointers every prompt shares; the journal, its writer and its existing readers are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is ~/.ashlr/audit/<UTC-date>.jsonl under the account home — the writer\'s own path (auditDir() in src/core/sandbox/audit.ts resolves the account home, never $ASHLR_HOME, so a child process cannot redirect it) — one append-only partition per UTC day, never rotated or deleted. audit() appends one {ts, action, repo, sandboxId, summary, result} line per audited action with result inside ok/refused/error; call sites span the daemon loop, the inbox apply and merge path, plugins, sandbox lifecycle, verify commands and verse surfaces (find them with a grep for the action literal under src/). Its only readers until this feed were `ashlr audit` (a human tail), the verse control-api\'s bounded recent window and `phm fleet` status\'s newest-eight list — point-in-time surfaces, never a recurrence fold.';

const NO_CHANGE = 'If the window has rolled forward, the records were a one-off burst the later rows recovered from, or the cause is owner-side or pinned ops machinery (credentials, billing, host resources, the installed schedules, the Security-reviewed files under contrib/mac and ~/.ashlr-runs/bin) — report no-change and name the evidence.';

function spanText(firstAtMs: number, lastAtMs: number): string {
  if (!Number.isFinite(firstAtMs) || !Number.isFinite(lastAtMs)) return '';
  const first = new Date(firstAtMs).toISOString();
  const last = new Date(lastAtMs).toISOString();
  return first === last ? ` Recorded ${first}.` : ` Recorded ${first} through ${last}.`;
}

function coverageNote(truncatedFiles: number, invalidRows: number, unreadableFiles: number, outsideWindow: number): string {
  const notes: string[] = [];
  if (truncatedFiles > 0) notes.push(`${truncatedFiles} partition tail(s) dropped older rows, so every count is a lower bound`);
  if (unreadableFiles > 0) notes.push(`${unreadableFiles} partition(s) unreadable`);
  if (invalidRows > 0) notes.push(`${invalidRows} malformed or off-contract lines dropped`);
  if (outsideWindow > 0) notes.push(`${outsideWindow} rows outside the window not counted`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

function samplesText(cell: AuditCell): string {
  if (cell.samples.length === 0) return 'no sample summaries were recorded';
  const joined = cell.samples.map((s) => `'${s}'`).join(', ');
  return cell.sampleOverflow ? `${joined}, and more` : joined;
}

function cellCounts(cell: AuditCell): string {
  return `${cell.units} in-window records across ${cell.days.size} UTC days`;
}

function actionText(action: string): string {
  return fieldText(action, 80) || 'unknown';
}

function refusedPrompt(cell: AuditCell, truncatedFiles: number, invalidRows: number, unreadableFiles: number, outsideWindow: number): string {
  const action = actionText(cell.action);
  return [
    `Phantom's autonomous-action audit keeps recording '${action}' refusals — ${cellCounts(cell)} inside the window, the self-improvement work this backlog exists for.`,
    '',
    `audit() records result 'refused' when a policy gate declines the action before it runs — a KILL or pause switch, the spend guard, standing-authority withdrawal, a capability or approval policy, a budget or concurrency hold. One refusal is a gate doing its job; recurrence across days means either the gate is misfiring on work it should allow, or a hold is standing that nobody revisited and the machinery it blocks keeps being attempted.${spanText(cell.firstAtMs, cell.lastAtMs)} Recorded summaries: ${samplesText(cell)}.${coverageNote(truncatedFiles, invalidRows, unreadableFiles, outsideWindow)}`,
    '',
    EVIDENCE,
    '',
    `Find which gate refuses and whether the hold is deliberate: locate the audit() call sites for '${action}' (grep the action literal under src/ — templated actions interpolate closed vocabularies), read what the recorded summaries name as the refusing condition, and check the gate's own state (KILL/pause files, spend guard, standing authority, capability declarations, budget config). If the refusal is a correctly configured hold — report no-change and name the evidence; if the gate misfires on valid work or the hold is stale machinery this repo owns — fix it. ${NO_CHANGE}`,
  ].join('\n');
}

function errorPrompt(cell: AuditCell, truncatedFiles: number, invalidRows: number, unreadableFiles: number, outsideWindow: number): string {
  const action = actionText(cell.action);
  return [
    `Phantom's autonomous-action audit keeps recording '${action}' errors — ${cellCounts(cell)} inside the window, the self-improvement work this backlog exists for.`,
    '',
    `audit() records result 'error' when the audited action itself failed — a thrown path, a nonzero exit, a timeout, a refused-then-errored transition. Recurrence across days means the action's machinery is broken in a way that keeps repeating, not a one-off fault.${spanText(cell.firstAtMs, cell.lastAtMs)} Recorded summaries: ${samplesText(cell)}.${coverageNote(truncatedFiles, invalidRows, unreadableFiles, outsideWindow)}`,
    '',
    EVIDENCE,
    '',
    `Find why the action keeps failing: locate its audit() call sites (grep the action literal under src/ — templated actions interpolate closed vocabularies), read the recorded summary's reason, and reproduce the failing path against a scratch home. Check whether the failure is a contract drift between caller and callee, an unguarded input the action does not survive, or resource exhaustion the summary names. If the errors are owner-side or pinned ops machinery rather than repo code — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function cellPrompt(cell: AuditCell, truncatedFiles: number, invalidRows: number, unreadableFiles: number, outsideWindow: number): string {
  return cell.kind === 'refused'
    ? refusedPrompt(cell, truncatedFiles, invalidRows, unreadableFiles, outsideWindow)
    : errorPrompt(cell, truncatedFiles, invalidRows, unreadableFiles, outsideWindow);
}

function cellTitle(cell: AuditCell): string {
  const action = actionText(cell.action);
  return cell.kind === 'refused'
    ? `Audit action '${action}' keeps being refused`
    : `Audit action '${action}' keeps erroring`;
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

function auditItem(cell: AuditCell, repo: string, truncatedFiles: number, invalidRows: number, unreadableFiles: number, outsideWindow: number): CloudBacklogItem {
  return {
    id: `audit-${sha(`audit:${cell.action}:${cell.kind}`)}`,
    title: cellTitle(cell).slice(0, MAX_TITLE_CHARS),
    prompt: cellPrompt(cell, truncatedFiles, invalidRows, unreadableFiles, outsideWindow),
    area: 'audit-trail',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the autonomous-action audit journal's recurring
 * adverse evidence. Total: any read or fold failure yields no items
 * rather than throwing into discovery.
 */
export async function auditBacklogItems(opts: AuditItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const dir = opts.auditDirPath ?? auditDir();
    if (typeof dir !== 'string' || dir === '') return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowMs ?? AUDIT_WINDOW_MS;
    // Only partitions whose UTC-day name can hold in-window rows are
    // read: the window's first day minus one for the writer's
    // filename/row boundary skew, through tomorrow for the same.
    const earliestDay = utcDayOf(nowMs - windowMs - DAY_MS);
    const latestDay = utcDayOf(nowMs + DAY_MS);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const files = names
      .filter((name) => PARTITION_RE.test(name))
      .map((name) => name.slice(0, 10))
      .filter((day) => day >= earliestDay && day <= latestDay)
      .sort()
      .reverse()
      .map((day) => join(dir, `${day}.jsonl`));
    if (files.length === 0) return [];

    const reads = await Promise.all(files.map((path) => readLedgerTail(path, AUDIT_FILE_TAIL_BYTES)));
    const rows: AuditRow[] = [];
    let invalidRows = 0;
    let truncatedFiles = 0;
    let unreadableFiles = 0;
    let readFiles = 0;
    for (const read of reads) {
      if (read.state !== 'read') {
        // A partition that vanished between readdir and open is a
        // non-event; anything else unreadable is stated, never guessed.
        if (read.state !== 'missing') unreadableFiles += 1;
        continue;
      }
      readFiles += 1;
      if (read.truncated) truncatedFiles += 1;
      const parsed = parseAuditPartition(read.text);
      rows.push(...parsed.rows);
      invalidRows += parsed.invalidRows;
    }
    if (readFiles === 0) return [];

    const folded = foldAuditEvidence(rows, { nowMs, windowMs });
    const items: CloudBacklogItem[] = [];
    for (const cell of folded.cells) {
      items.push(auditItem(cell, repo, truncatedFiles, invalidRows, unreadableFiles, folded.outsideWindow));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? AUDIT_BACKLOG_MAX_ITEMS, AUDIT_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
