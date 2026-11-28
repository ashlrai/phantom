/**
 * Incident-lane outcome journal recurring evidence → self-improvement
 * backlog items.
 *
 * SELF-AWARE-1 (the ops-side self_aware.py detector tick) writes
 * ~/.ashlr-runs/ledger/incidents.jsonl open/resolved/sample rows and a
 * bus/core/INCIDENT-<key>.md notice per incident; `phm autofix`
 * (src/core/autofix/run.ts) works the prefixes its fixer table owns and
 * appends outcome rows to ledger/incidents.jsonl. Whatever stays open —
 * past the 15-minute autofix grace for fixer-owned prefixes, or at once
 * for the rest — is picked up by INCIDENT-LANE-1: incident_lane.py,
 * imported by the live dispatchd once per tick, queues the incident
 * under queue/incidents/ (0700, sha-pinned per-prefix prompt templates
 * bin/incident-prompt-<a..g>.md, only the validated key substituted),
 * dispatchd launches it as an INC-<key> job on codex-personal or claude
 * inside the one-slot incident reserve, and every state transition is
 * appended to <runs>/ledger/incident-lane.jsonl as one
 * `{ts, key, event, detail}` row. The job's contract is PR-only output:
 * `RESULT PR` records 'done', any other `RESULT <token>` records 'ended'
 * with the token (the templates' designed verdict is `RESULT EMPTY` —
 * "nothing safe can be fixed in code"), a missing or unparseable result
 * records 'ended' with an empty detail, an ended job whose incident is
 * still open and under the per-key caps records 'requeued', and an
 * incident that closes or is superseded records 'closed'.
 *
 * Until now the journal had no reader at all — its only consumers were
 * incident_lane.py's own per-tick state reload and ad-hoc inspection,
 * so the lane's own outcome record never became work: jobs that kept
 * ending with no RESULT line at all, detector prefixes whose incidents
 * always ended EMPTY (the lane investigated and found no repo fix —
 * either the prefix deserves an autofix fixer in this repository's
 * src/core/autofix table or its incidents are ops-side by nature),
 * launched jobs cycling back to the queue while their incident stayed
 * open, and incidents that kept reopening after each resolution. The
 * lane IS the self-healing loop's last stage, so its recurring
 * non-convergence is the fleet's most direct self-improvement evidence.
 *
 * incidentLaneBacklogItems carries the same journal into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the sibling self-tick,
 * worktree-reap and fleet-evidence sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail; nothing is written and no lock, process
 *    or network is touched. A missing, non-file or unreadable journal
 *    yields no items — unknown stays unknown, never a guessed tally —
 *    while a truncated tail still folds the retained rows with the
 *    prompts stating the counts as lower bounds.
 *  - Rows count only under the writer's contract: a parseable `ts`, a
 *    lane key matching the writer's slug shape (first character the
 *    detector prefix letter, then '-' and the [a-z0-9-] body), an
 *    `event` inside the writer's closed vocabulary (queued, launched,
 *    done, ended, requeued, closed, report) and a string `detail` —
 *    the four fields note()/_append always write. Malformed lines,
 *    foreign shapes and off-contract rows are skipped, never guessed.
 *  - Deliberate outcomes never emit: 'done' (a PR was produced),
 *    'closed' resolutions, first-time 'queued' rows, 'launched' rows
 *    and 'report' verdicts are the lane working or its designed
 *    report-only path — context tallies in the prompts, never cells.
 *    'ended' splits three ways because the outcomes differ honestly:
 *    detail 'EMPTY' is the template's own designed verdict, detail ''
 *    means the job ended with no RESULT line at all (a contract break —
 *    crash, timeout, kill or a missing result file), and any other
 *    token is a RESULT verdict this fold does not classify, quoted as
 *    a sample. Silent endings aggregate across prefixes — a job that
 *    never reported is a lane-contract signal, not a detector one —
 *    while EMPTY, other-token, requeue and reopen cells key on the
 *    detector prefix letter so the item names which incident class
 *    keeps producing the outcome.
 *  - Recurring means recorded across days at a rate a one-off cannot
 *    fake: a cell emits only when its in-window rows reach
 *    INCIDENT_LANE_MIN_UNITS across INCIDENT_LANE_MIN_DAYS distinct UTC
 *    days — the lane's cadence is launches-per-day, not ticks-per-hour,
 *    so two recorded outcomes on separate days already rule out a
 *    single burst. The window is anchored on the clock with the
 *    sibling feeds' future-skew allowance.
 *  - The evidence carries no repository dimension — it describes this
 *    install's fleet machinery (the writer hard-codes phantom-family
 *    repos in REPOS). Items therefore emit only when the backlog
 *    target's repository name is 'phantom', the same last-segment rule
 *    the sibling fleet-evidence sources apply.
 *  - Dedup is downstream. Item ids key on the cell — kind plus prefix
 *    scope — never the counts or timestamps, so a refresh re-derives
 *    the same ids and appendUserBacklogItems adds only what is new; a
 *    detector prefix that recovers simply stops re-adding.
 *  - Every journal string is untrusted text: detail tokens are
 *    scrubbed, flattened and capped before they reach a prompt, and
 *    the prefix scope is validated against the writer's key shape
 *    before it becomes an identifier.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the cell set is prefixes × kinds, capped here. */
export const INCIDENT_LANE_BACKLOG_MAX_ITEMS = 8;
const INCIDENT_LANE_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const INCIDENT_LANE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on row timestamps, same convention the sibling folds tolerate. */
const INCIDENT_LANE_FUTURE_SKEW_MS = 60_000;
/** In-window rows a cell needs before its outcome counts as recurring. */
export const INCIDENT_LANE_MIN_UNITS = 2;
/** Distinct UTC days the rows must span — recurring means recorded across days. */
export const INCIDENT_LANE_MIN_DAYS = 2;
/**
 * Bounded tail for the journal; the writer appends ~50 small rows a day
 * (~10KB), so 1 MiB retains far more than the window needs even unrotated.
 */
const INCIDENT_LANE_TAIL_BYTES = 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are unbounded text; flatten, scrub and cap before use. */
const FIELD_MAX = 120;
/** The fleet's own repository label: incident-lane evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';

/**
 * The writer's lane-key shape (incident_lane.py slug()): detector prefix
 * letter a–g (RAW_KEY_RE), then the dash-joined slug body — alnum
 * segments, never consecutive or trailing dashes — closed by the 8-hex
 * sha256 suffix, all inside KEY_RE's 64-char bound.
 */
const LANE_KEY_RE = /^[a-g](?:-[a-z0-9]+)+-[0-9a-f]{8}$/;
const LANE_KEY_MAX_CHARS = 64;
/** The writer's event vocabulary (incident_lane.py note()/note_launched call sites). */
const EVENT_VOCABULARY = new Set(['queued', 'launched', 'done', 'ended', 'requeued', 'closed', 'report']);
/** The 'ended' detail the templates design as the nothing-to-fix verdict. */
const ENDED_EMPTY_DETAIL = 'EMPTY';
/** The detector prefixes the lane key can carry (incident_lane.py PREFIXES). */
const PREFIX_SCOPE = /^[a-g]$/;

type CellKind = 'ended-silent' | 'ended-empty' | 'ended-other' | 'requeued' | 'reopened';

export interface IncidentLaneItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding ledger/incident-lane.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default INCIDENT_LANE_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default INCIDENT_LANE_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated journal row inside the evidence window. */
export interface IncidentLaneRow {
  atMs: number;
  utcDay: string;
  /** Detector prefix letter (a–g) or 'other' when the key's shape is foreign. */
  prefix: string;
  key: string;
  event: string;
  detail: string;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Pure: validate one parsed journal line against the writer's row
 * contract — parseable `ts`, a lane key inside the slug shape, an event
 * inside the closed vocabulary and a string `detail`. Anything else is
 * not an incident-lane record.
 */
export function parseIncidentLaneRow(value: unknown): IncidentLaneRow | null {
  if (!isRecord(value)) return null;
  const ts = value['ts'];
  const atMs = typeof ts === 'string' ? Date.parse(ts) : NaN;
  if (!Number.isFinite(atMs)) return null;
  const key = value['key'];
  if (typeof key !== 'string' || key.length > LANE_KEY_MAX_CHARS || !LANE_KEY_RE.test(key)) return null;
  const event = value['event'];
  if (typeof event !== 'string' || !EVENT_VOCABULARY.has(event)) return null;
  const detail = value['detail'];
  if (typeof detail !== 'string') return null;
  const prefix = PREFIX_SCOPE.test(key[0] ?? '') ? key[0]! : 'other';
  return { atMs, utcDay: utcDayOf(atMs), prefix, key, event, detail };
}

/**
 * Pure: parse journal text into validated rows plus the count of lines
 * that were not on-contract records — malformed JSON, foreign shapes
 * and off-contract rows are counted, never guessed.
 */
export function parseIncidentLaneJournal(text: string): { rows: IncidentLaneRow[]; invalidRows: number } {
  const rows: IncidentLaneRow[] = [];
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
    const row = parseIncidentLaneRow(value);
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows };
}

/** One evidence cell's recurring tally across the in-window rows. */
export interface IncidentLaneCell {
  kind: CellKind;
  /** Detector prefix scope ('a'–'g', 'other', or 'all' for the silent-ending aggregate). */
  prefix: string;
  /** In-window rows carrying this cell. */
  units: number;
  /** Distinct UTC days those rows fall on. */
  days: Set<string>;
  /** Distinct scrubbed detail tokens, capped at PROMPT_SAMPLES_MAX. */
  samples: string[];
  /** True when more distinct samples existed than were kept. */
  sampleOverflow: boolean;
  firstAtMs: number;
  lastAtMs: number;
}

/** Per-prefix windowed context tallies quoted inside prompts. */
export interface IncidentLanePrefixTotals {
  launches: number;
  done: number;
  ended: number;
  requeued: number;
  reopened: number;
  closed: number;
}

export interface IncidentLaneFold {
  cells: IncidentLaneCell[];
  /** In-window rows that passed the row contract. */
  records: number;
  /** Parsed rows outside the window or past the future skew. */
  outsideWindow: number;
  /** Windowed per-prefix context tallies (launches/done are the success side). */
  prefixes: Map<string, IncidentLanePrefixTotals>;
}

/** Journal-recorded strings are untrusted text; flatten, scrub and cap before use. */
function fieldText(value: string, max = FIELD_MAX): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const PROMPT_SAMPLES_MAX = 4;

function emptyTotals(): IncidentLanePrefixTotals {
  return { launches: 0, done: 0, ended: 0, requeued: 0, reopened: 0, closed: 0 };
}

/**
 * Pure: fold validated rows into per-cell tallies plus per-prefix
 * context. Only the adverse vocabulary counts: 'ended' rows split by
 * their detail (EMPTY per prefix, other tokens per prefix, empty detail
 * as one cross-prefix aggregate), 'requeued' and reopened 'queued' rows
 * per prefix. Done, launched, closed, report and first-time queued rows
 * are context only.
 */
export function foldIncidentLaneEvidence(
  rows: readonly IncidentLaneRow[],
  opts: { nowMs: number; windowMs?: number },
): IncidentLaneFold {
  const windowMs = opts.windowMs ?? INCIDENT_LANE_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const cells = new Map<string, IncidentLaneCell>();
  const prefixes = new Map<string, IncidentLanePrefixTotals>();
  let inWindow = 0;
  let outsideWindow = 0;
  const cellFor = (kind: CellKind, prefix: string): IncidentLaneCell => {
    const key = `${kind}:${prefix}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = { kind, prefix, units: 0, days: new Set(), samples: [], sampleOverflow: false, firstAtMs: Infinity, lastAtMs: -Infinity };
      cells.set(key, cell);
    }
    return cell;
  };
  const totalsFor = (prefix: string): IncidentLanePrefixTotals => {
    let totals = prefixes.get(prefix);
    if (totals === undefined) {
      totals = emptyTotals();
      prefixes.set(prefix, totals);
    }
    return totals;
  };
  const touch = (cell: IncidentLaneCell, row: IncidentLaneRow): void => {
    cell.units += 1;
    cell.days.add(row.utcDay);
    cell.firstAtMs = Math.min(cell.firstAtMs, row.atMs);
    cell.lastAtMs = Math.max(cell.lastAtMs, row.atMs);
  };
  const addSample = (cell: IncidentLaneCell, detail: string): void => {
    const cleaned = fieldText(detail);
    if (cleaned === '') return;
    if (cell.samples.includes(cleaned)) return;
    if (cell.samples.length >= PROMPT_SAMPLES_MAX) { cell.sampleOverflow = true; return; }
    cell.samples.push(cleaned);
  };

  for (const row of rows) {
    if (row.atMs < windowStart || row.atMs > opts.nowMs + INCIDENT_LANE_FUTURE_SKEW_MS) {
      outsideWindow += 1;
      continue;
    }
    inWindow += 1;
    const totals = totalsFor(row.prefix);
    switch (row.event) {
      case 'launched': totals.launches += 1; break;
      case 'done': totals.done += 1; break;
      case 'ended': {
        totals.ended += 1;
        if (row.detail === ENDED_EMPTY_DETAIL) {
          const cell = cellFor('ended-empty', row.prefix);
          touch(cell, row);
        } else if (row.detail === '') {
          const cell = cellFor('ended-silent', 'all');
          touch(cell, row);
        } else {
          const cell = cellFor('ended-other', row.prefix);
          touch(cell, row);
          addSample(cell, row.detail);
        }
        break;
      }
      case 'requeued': {
        totals.requeued += 1;
        const cell = cellFor('requeued', row.prefix);
        touch(cell, row);
        break;
      }
      case 'queued': {
        if (row.detail === 'reopened') {
          totals.reopened += 1;
          const cell = cellFor('reopened', row.prefix);
          touch(cell, row);
        }
        break;
      }
      case 'closed': totals.closed += 1; break;
      default: break; // 'report' verdicts are the designed read-only path — context only.
    }
  }

  const recurring = [...cells.values()]
    .filter((cell) => cell.units >= INCIDENT_LANE_MIN_UNITS && cell.days.size >= INCIDENT_LANE_MIN_DAYS)
    .sort((a, b) => b.units - a.units || a.kind.localeCompare(b.kind) || a.prefix.localeCompare(b.prefix));
  return { cells: recurring, records: inWindow, outsideWindow, prefixes };
}

/** The evidence pointers every prompt shares; the journal, its writer and its existing readers are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is ledger/incident-lane.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR) — one {ts, key, event, detail} row per INCIDENT-LANE-1 state transition appended by incident_lane.py (imported by the live dispatchd once per tick; ops-side machinery, not this repository). The lane queues SELF-AWARE-1 incidents still open under queue/incidents/, launches them as INC-<key> jobs on codex-personal or claude inside the one-slot incident reserve, and records queued/launched/done/ended/requeued/closed/report per key. incident_lane.py\'s own per-tick state reload is the journal\'s only consumer; nothing else folds it.';

const NO_CHANGE = 'If the window has rolled forward, the named INC-* jobs have since produced PRs or the incidents stayed closed, the endings were a one-off burst the lane absorbed, or the cause is owner-side or pinned ops machinery (the installed dispatchd/incident_lane.py, the sha-pinned prompt templates, launchd jobs outside this repository, credentials, billing, host resources) — report no-change and name the evidence.';

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
  if (outsideWindow > 0) notes.push(`${outsideWindow} rows outside the window not counted`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

function samplesText(cell: IncidentLaneCell): string {
  if (cell.samples.length === 0) return 'no detail tokens were recorded';
  const joined = cell.samples.map((s) => `'${s}'`).join(', ');
  return cell.sampleOverflow ? `${joined}, and more` : joined;
}

function cellCounts(cell: IncidentLaneCell): string {
  return `${cell.units} in-window rows across ${cell.days.size} UTC days`;
}

/** Detector prefix letters are journal text; scrub, flatten and cap before they reach a prompt or an id. */
function prefixText(prefix: string): string {
  return fieldText(prefix, 20) || 'unknown';
}

function prefixTotalsText(prefix: string, totals: IncidentLanePrefixTotals | undefined): string {
  if (totals === undefined) return '';
  return ` For prefix '${prefix}' the window also recorded ${totals.launches} launch(es), ${totals.done} done(PR), ${totals.ended} ended, ${totals.requeued} requeue(s), ${totals.reopened} reopen(s) and ${totals.closed} close(s).`;
}

function silentPrompt(cell: IncidentLaneCell, truncated: boolean, invalidRows: number, outsideWindow: number): string {
  return [
    `Phantom's incident lane keeps launching fix jobs that end with no RESULT line at all — ${cellCounts(cell)} inside the window record 'ended' rows with an empty detail, the self-improvement work this backlog exists for.`,
    '',
    `An 'ended' row means the INC-<key> job left the alive set without a 'RESULT PR' verdict: detail carries the RESULT line's second token when one parsed, and an empty detail means no usable RESULT was recorded at all — the job crashed, timed out, was killed, or its result file was missing or unparseable. 'EMPTY' is the templates' designed nothing-to-fix verdict and is folded per prefix separately; this cell is only the silent endings, aggregated across detector prefixes because a job that never reported is a lane-contract break, not a detector signal.${spanText(cell.firstAtMs, cell.lastAtMs)}${coverageNote(truncated, invalidRows, outsideWindow)}`,
    '',
    EVIDENCE,
    '',
    `Find why incident jobs end silently: the launched INC-* ids are 'INC-' + the lane key, so check metrics/jobs.jsonl under the same runs dir for those jobs' finish rows — exit status, timeout kills, empty output captures — and whether the lane's result-file contract (what dispatchd passes as \`result\` into incident_lane.py's tick) still matches what codex-personal/claude jobs write. If the jobs are being killed by host pressure, lane holds or the incident reserve rather than a contract bug — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function endedEmptyPrompt(cell: IncidentLaneCell, truncated: boolean, invalidRows: number, outsideWindow: number, prefixes: Map<string, IncidentLanePrefixTotals>): string {
  const prefix = prefixText(cell.prefix);
  return [
    `Phantom's incident lane jobs for detector '${prefix}' keep ending EMPTY — ${cellCounts(cell)} inside the window record the templates' designed nothing-safe-to-fix verdict, the self-improvement work this backlog exists for.`,
    '',
    `'RESULT EMPTY' is incident-prompt-<prefix>.md's own escape: the job investigated the SELF-AWARE-1 incident and found no safe code fix in this repository — the cause is ops-side, pinned machinery, host state or owner-only. Recurring EMPTY on one detector prefix means that incident class keeps reaching the lane (past the 15-minute autofix grace where one exists) and every launch concludes the same thing: either the prefix deserves an autofix fixer in this repository's src/core/autofix table so incidents resolve before a lane job is spent, or its incidents are genuinely outside repo code and the lane spend is the designed cost of certainty.${spanText(cell.firstAtMs, cell.lastAtMs)}${prefixTotalsText(prefix, prefixes.get(cell.prefix))}${coverageNote(truncated, invalidRows, outsideWindow)}`,
    '',
    EVIDENCE,
    '',
    `Decide which side the recurrence belongs on: read src/core/autofix/incidents.ts's INCIDENT_FIXER_TABLE and fixers.ts — if prefix '${prefix}''s incidents have a repo-side fix shape (a stuck draft, a crashlooping label, a stalled lane, outside load), an autofix fixer resolves them without spending a lane launch; if every EMPTY is correct because the cause lives in pinned ops files or host state, check whether the detector's threshold or the lane's eligibility rule is what needs the note — the detector and templates are ops-side, so repo work here is the autofix table or an honest no-change. ${NO_CHANGE}`,
  ].join('\n');
}

function endedOtherPrompt(cell: IncidentLaneCell, truncated: boolean, invalidRows: number, outsideWindow: number, prefixes: Map<string, IncidentLanePrefixTotals>): string {
  const prefix = prefixText(cell.prefix);
  return [
    `Phantom's incident lane jobs for detector '${prefix}' keep ending on RESULT verdicts this fold does not classify — ${cellCounts(cell)} inside the window record 'ended' rows carrying detail tokens outside the EMPTY/silent split, the self-improvement work this backlog exists for.`,
    '',
    `An 'ended' row means the INC-<key> job finished without 'RESULT PR'; the detail is the RESULT line's second token truncated to 12 characters — a verdict the current templates do not emit ('EMPTY' and PR are the documented pair), so either the job invented a new verdict or the result contract drifted. Recorded tokens: ${samplesText(cell)}.${spanText(cell.firstAtMs, cell.lastAtMs)}${prefixTotalsText(prefix, prefixes.get(cell.prefix))}${coverageNote(truncated, invalidRows, outsideWindow)}`,
    '',
    EVIDENCE,
    '',
    `Find what the tokens mean: the job prompts are the sha-pinned bin/incident-prompt-<prefix>.md templates (ops-side) and the RESULT contract is whatever the lane's job wrapper writes — check metrics/jobs.jsonl for the INC-* rows' recorded outputs and whether a template or wrapper revision introduced a verdict the lane's parser treats as non-PR. If the tokens are a benign designed verdict the fold simply has not named, report no-change and say which token means what. ${NO_CHANGE}`,
  ].join('\n');
}

function requeuedPrompt(cell: IncidentLaneCell, truncated: boolean, invalidRows: number, outsideWindow: number, prefixes: Map<string, IncidentLanePrefixTotals>): string {
  const prefix = prefixText(cell.prefix);
  return [
    `Phantom's incident lane jobs for detector '${prefix}' keep cycling back to the queue — ${cellCounts(cell)} inside the window record 'requeued' rows, launches that ended while their incident stayed open and under the per-key caps, the self-improvement work this backlog exists for.`,
    '',
    `A 'requeued' row means the launched INC-<key> job ended (any non-PR outcome) while the SELF-AWARE-1 incident was still open, inside PER_KEY_MAX_LAUNCHES_24H and past the 6-hour cooldown — the lane deliberately retries rather than giving up. Recurring requeues on one prefix mean the incident's condition outlives each job's attempt: the fix does not address what the detector measures, the job ends EMPTY/silent while the condition persists, or the incident reopens faster than a fix can land. Each cycle spends a codex-personal or claude launch inside the one-slot reserve.${spanText(cell.firstAtMs, cell.lastAtMs)}${prefixTotalsText(prefix, prefixes.get(cell.prefix))}${coverageNote(truncated, invalidRows, outsideWindow)}`,
    '',
    EVIDENCE,
    '',
    `Find why the incident outlives its jobs: pair the requeued keys' INC-* job ids with their metrics/jobs.jsonl finish rows and the queue/incidents/<key>.json records — did the job produce a fix that missed the detector's actual condition, end EMPTY on a cause no code fixes, or die silently? If the recurrence is correct lane behavior on an ops-side condition the repo cannot fix, report no-change and name the evidence; if the job scope (the pinned template's ask) systematically misses the detector's measurement, that is the ops-side note this item exists to file. ${NO_CHANGE}`,
  ].join('\n');
}

function reopenedPrompt(cell: IncidentLaneCell, truncated: boolean, invalidRows: number, outsideWindow: number, prefixes: Map<string, IncidentLanePrefixTotals>): string {
  const prefix = prefixText(cell.prefix);
  return [
    `Phantom's detector '${prefix}' incidents keep reopening after they close — ${cellCounts(cell)} inside the window record 'queued' rows with detail 'reopened', the lane re-arming incidents whose previous record had already ended, the self-improvement work this backlog exists for.`,
    '',
    `A 'reopened' queue row means the incident's opened timestamp moved past the lane record's — the SELF-AWARE-1 condition cleared (resolved, autofix 'fixed'/'intentional', or superseded) and then recurred. For prefixes inside the autofix fixer table (a, b, d, e) a reopen after a 'fixed' outcome is the fixer table's own hold failing; for the rest it is the detector's condition genuinely cycling. Either way the lane sees the same incident class over and over, and each reopen can spend another launch.${spanText(cell.firstAtMs, cell.lastAtMs)}${prefixTotalsText(prefix, prefixes.get(cell.prefix))}${coverageNote(truncated, invalidRows, outsideWindow)}`,
    '',
    EVIDENCE,
    '',
    `Find why the condition recurs: for fixer-owned prefixes check src/core/autofix/fixers.ts — does the fixer's 'fixed' verdict match what the detector re-measures (a restart that only pauses the crashloop, a lane target restored then drained again, a draft that re-forms on the next release)? For the rest, check whether the detector's threshold sits inside normal operating noise — the detector itself is ops-side self_aware.py, so repo work is the autofix hold or an honest no-change naming the recurrence. ${NO_CHANGE}`,
  ].join('\n');
}

function cellSlug(cell: IncidentLaneCell): string {
  return `${cell.kind}-${cell.prefix}`;
}

function cellTitle(cell: IncidentLaneCell): string {
  switch (cell.kind) {
    case 'ended-silent': return 'Incident-lane jobs keep ending with no RESULT line';
    case 'ended-empty': return `Incident-lane jobs for detector '${prefixText(cell.prefix)}' keep ending EMPTY`;
    case 'ended-other': return `Incident-lane jobs for detector '${prefixText(cell.prefix)}' end on unclassified RESULT tokens`;
    case 'requeued': return `Incident-lane jobs for detector '${prefixText(cell.prefix)}' keep cycling back to the queue`;
    case 'reopened': return `Detector '${prefixText(cell.prefix)}' incidents keep reopening after close`;
  }
}

function cellPrompt(cell: IncidentLaneCell, truncated: boolean, invalidRows: number, outsideWindow: number, prefixes: Map<string, IncidentLanePrefixTotals>): string {
  switch (cell.kind) {
    case 'ended-silent': return silentPrompt(cell, truncated, invalidRows, outsideWindow);
    case 'ended-empty': return endedEmptyPrompt(cell, truncated, invalidRows, outsideWindow, prefixes);
    case 'ended-other': return endedOtherPrompt(cell, truncated, invalidRows, outsideWindow, prefixes);
    case 'requeued': return requeuedPrompt(cell, truncated, invalidRows, outsideWindow, prefixes);
    case 'reopened': return reopenedPrompt(cell, truncated, invalidRows, outsideWindow, prefixes);
  }
}

function incidentLaneItem(cell: IncidentLaneCell, repo: string, truncated: boolean, invalidRows: number, outsideWindow: number, prefixes: Map<string, IncidentLanePrefixTotals>): CloudBacklogItem {
  return {
    id: `incidentlane-${cellSlug(cell)}`,
    title: cellTitle(cell).slice(0, MAX_TITLE_CHARS),
    prompt: cellPrompt(cell, truncated, invalidRows, outsideWindow, prefixes),
    area: 'fleet-incident-lane',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the incident-lane outcome journal's recurring
 * adverse evidence. Total: any read or fold failure yields no items
 * rather than throwing into discovery.
 */
export async function incidentLaneBacklogItems(opts: IncidentLaneItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the sibling fleet-evidence reads apply: explicit
    // dir, then a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an
    // empty env value is no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const ledger = await readLedgerTail(join(runsDir, 'ledger', 'incident-lane.jsonl'), INCIDENT_LANE_TAIL_BYTES);
    if (ledger.state !== 'read') return [];
    const { rows, invalidRows } = parseIncidentLaneJournal(ledger.text);
    const folded = foldIncidentLaneEvidence(rows, { nowMs, windowMs: opts.windowMs });
    const items: CloudBacklogItem[] = [];
    for (const cell of folded.cells) {
      items.push(incidentLaneItem(cell, repo, ledger.truncated, invalidRows, folded.outsideWindow, folded.prefixes));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? INCIDENT_LANE_BACKLOG_MAX_ITEMS, INCIDENT_LANE_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
