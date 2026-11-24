/**
 * Incident-gate decision ledger recurring evidence → self-improvement backlog items.
 *
 * `ashlr fleet incident-gate --apply` (src/cli/fleet-incident-gate.ts over
 * src/core/fleet/incident-gate.ts) mines metrics/jobs.jsonl and
 * dispatch-events.log under the fleet runs directory for repeated failure
 * classes — lane-error (lane-attributed finish/task/precheck/dispatch
 * failures), test-failure (repo+kind-attributed work failures) and
 * merge-conflict (pull requests closed unmerged) — and, for every class
 * that crosses the >=3-fresh-signals bar, tightens the gate that owns it:
 * a bounded lane hold for lane-error, a bounded repo cooldown for the
 * repo-scoped classes. Every decision is appended to
 * ~/.ashlr/fleet/incident-gates.jsonl as one scrubbed row —
 * {v:1, ts, kind:'incident-gate', cls, key, gate, scope, count, result,
 * until?, detail?} — and the class's firedAt watermark advances only when
 * the tightening reaches a terminal state (applied, or a lane-hold
 * refusal that records manual-hold/unknown-lane). Two evidence kinds in
 * that ledger never became work — the file had no reader at all:
 *
 *  - Classes that keep recurring: a row whose tightening advanced the
 *    watermark proves the NEXT fire needed fresh failure signals, so a
 *    class key firing on two or more distinct UTC days inside the window
 *    is a failure signature the fleet's bounded holds keep treating
 *    while the cause stays unfixed — a lane that keeps erroring, a repo
 *    whose work keeps failing the same way, a merge pipeline whose PRs
 *    keep closing unmerged.
 *  - Tightenings that never land: rows whose result is 'error' (the
 *    placeLaneHold/setRepoHold call threw) or a repo-cooldown 'refused'
 *    (setRepoHold declined) never advance the watermark, so the same
 *    signals re-fire on every --apply run — the fleet detects the
 *    incident but its protection is stuck, not absent. Recurring across
 *    distinct UTC days, that is a broken apply path (slots.json or
 *    runs-dir writability, the repo-hold store's health, the KILL
 *    switch), not a transient.
 *
 * Until now all of it existed only as append-only audit;
 * appendIncidentGateLedger has no reader, `phm fleet incident-gate`
 * itself has no report mode, and the firedAt state file is per-class
 * watermarks, not history. incidentGateBacklogItems carries the same
 * ledger into discoverBacklog, so `phm improve discover` and the
 * scheduler's autoDiscover queue it exactly like the fleet outcome-
 * learning, nightly retro, policy, local-gate, pass^k, friction,
 * tick-health, cross-review, empty-tag, post-merge, ci-rerun,
 * lost-launch, memory, controller, skill-outcome, precheck-skip,
 * source-yield, gateway-shadow, recheck, stuck-job, lesson-trial,
 * unfed, dupcheck-gate, proposal-outcome, typed-route, branch-gardener,
 * reward, job-control, usage-gap and runtime-journal sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The ledger is read through readLedgerTail's bounded
 *    no-follow tail; nothing is written and no network is touched.
 *    Missing or unreadable evidence yields no items — an absent ledger
 *    reads as an empty file, and 'unreadable'/'not-file' cannot be told
 *    apart from "no rows".
 *  - Repo matching follows the row's own class. lane-error rows carry a
 *    lane scope — this install's dispatch machinery — so they emit only
 *    for the fleet's own repository (the same last-segment 'phantom'
 *    rule the sibling fleet-evidence sources apply). test-failure and
 *    merge-conflict rows carry an owner/repo scope, so they emit only
 *    when it matches the discovery target exactly, case-insensitive —
 *    evidence recorded against another repository's production never
 *    lands on this one.
 *  - Recurring means recorded fires, not inferred ones. Only rows the
 *    writer appended count — dry-run evaluations leave no trace, and a
 *    class that never crossed the bar has no row. The recurring bucket
 *    counts only watermark-advancing rows (the writer's own `advances`
 *    rule: applied, or refused on the lane-hold gate), because those are
 *    the fires that required fresh signals; error and repo-cooldown-
 *    refused rows re-fire on stale signals by construction and fold into
 *    the tighten-failed bucket instead, so a stuck class never
 *    double-counts as healthy recurrence.
 *  - Unknown stays unknown. Malformed lines, foreign kinds, non-v1
 *    rows, unknown cls/gate/result values, cls↔gate mismatches and rows
 *    missing their key/scope fields are skipped, never guessed; a
 *    truncated tail still yields honest lower-bound counts and says so
 *    in the prompt.
 *  - Dedup is downstream. Item ids hash the bucket + class key (never
 *    the counts or timestamps), so a refresh re-derives the same id and
 *    appendUserBacklogItems adds only what is new; shifted tallies do
 *    not spawn twin items, and a class that recovers simply stops
 *    re-adding.
 *  - Every emitted prompt keeps the evidence framing: keys, scopes and
 *    recorded details are scrubbed, flattened and capped before they
 *    reach the prompt, counts are quoted only as recorded, and the
 *    brief names the ledger, the verb, the mining sources and the
 *    apply-path modules with the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the class-key space is bounded by the writer's MAX_CLASSES. */
export const INCIDENT_GATE_MAX_ITEMS = 8;
const INCIDENT_GATE_ITEM_HARD_MAX = 25;
/** The window every fold anchors on: the fleet's recurring-evidence week. */
export const INCIDENT_GATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Distinct UTC days a bucket needs before it counts as recurring — the
 * same absolute-evidence bar the sibling feeds apply (two days of recorded
 * fires, never a same-day burst).
 */
export const INCIDENT_GATE_RECURRING_DAYS = 2;
/** Future-skew allowance on row timestamps, same convention the sibling folds apply. */
const INCIDENT_GATE_FUTURE_SKEW_MS = 60_000;
/** Bounded no-follow tail of the decision ledger; rows are ~300 bytes, so 8 MiB covers tens of thousands. */
const INCIDENT_GATE_LEDGER_MAX_BYTES = 8 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded text is bounded but still untrusted-shaped; flatten, scrub and cap before use. */
const FIELD_MAX = 200;
const KEY_MAX = 300;
/** Recorded refusal/error details quoted inside one prompt before the remainder is summarized. */
const PROMPT_DETAILS_MAX = 3;
/** The fleet's own repository label: lane-error evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** The ledger's path under the Ashlr home — the writer's own stateDir resolution (homedir()/.ashlr/fleet). */
const INCIDENT_GATE_LEDGER_RELATIVE = join('.ashlr', 'fleet', 'incident-gates.jsonl');
const LEDGER_SCHEMA = 1;
const LEDGER_KIND = 'incident-gate';
const CLASS_KINDS = new Set(['lane-error', 'test-failure', 'merge-conflict']);
const GATE_KINDS = new Set(['lane-hold', 'repo-cooldown']);
const RESULTS = new Set(['applied', 'refused', 'error']);
/** cls↔gate consistency the writer's actionFor guarantees; mismatches are malformed rows. */
const LANE_ERROR_GATE = 'lane-hold';
const REPO_CLASS_GATE = 'repo-cooldown';

type IncidentClassKind = 'lane-error' | 'test-failure' | 'merge-conflict';
type GateKind = 'lane-hold' | 'repo-cooldown';
type GateResult = 'applied' | 'refused' | 'error';

export interface IncidentGateItemsOptions {
  /** Backlog target in owner/name form; repo-class rows must name the same repository. */
  repo: string;
  /** Ledger override (default: <homeDir>/.ashlr/fleet/incident-gates.jsonl). */
  ledgerPath?: string;
  /** Home for the default ledger path — the writer resolves stateDir from homedir(), so this mirrors it (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default INCIDENT_GATE_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default INCIDENT_GATE_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window (default: now, ms epoch). */
  now?: number;
}

/** One validated decision row — only the fields the fold consumes. */
interface GateRow {
  atMs: number;
  utcDay: string;
  cls: IncidentClassKind;
  key: string;
  gate: GateKind;
  scope: string;
  /** Fresh signals the fire recorded (the writer's `count`). */
  count: number;
  result: GateResult;
  /** Scrubbed refusal/error detail the writer recorded, or null. */
  detail: string | null;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded text is unbounded-shaped; flatten, scrub and cap before use. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Pure-ish: one ledger line → a row the fold can use, or null. Mirrors the
 * writer's closed contract: v1, kind 'incident-gate', a parseable ts, a
 * known cls/gate/result triple consistent with the writer's cls↔gate
 * mapping, and non-empty bounded key/scope fields. `until` is accepted
 * but unused — hold expiry is pacing, not evidence.
 */
function parseIncidentGateLine(line: string): Omit<GateRow, 'utcDay'> | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!isObj(value) || value['v'] !== LEDGER_SCHEMA || value['kind'] !== LEDGER_KIND) return null;
  if (typeof value['ts'] !== 'string') return null;
  const atMs = Date.parse(value['ts']);
  if (!Number.isFinite(atMs)) return null;
  const cls = value['cls'];
  const gate = value['gate'];
  const result = value['result'];
  if (typeof cls !== 'string' || !CLASS_KINDS.has(cls)) return null;
  if (typeof gate !== 'string' || !GATE_KINDS.has(gate)) return null;
  if (typeof result !== 'string' || !RESULTS.has(result)) return null;
  // The writer maps lane-error → lane-hold and the repo classes →
  // repo-cooldown; a mismatch cannot be a real decision row.
  const expectedGate = cls === 'lane-error' ? LANE_ERROR_GATE : REPO_CLASS_GATE;
  if (gate !== expectedGate) return null;
  const key = value['key'];
  const scope = value['scope'];
  if (typeof key !== 'string' || key.trim() === '' || key.length > KEY_MAX) return null;
  // Every writer-built key is cls-prefixed (lane-error:<lane>:<code>,
  // test-failure:<repo>:<kind>:<code>, merge-conflict:<repo>).
  if (!key.trim().startsWith(`${cls}:`)) return null;
  if (typeof scope !== 'string' || scope.trim() === '' || scope.length > FIELD_MAX) return null;
  const count = value['count'];
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) return null;
  const detail = value['detail'];
  return {
    atMs,
    cls: cls as IncidentClassKind,
    key: key.trim(),
    gate: gate as GateKind,
    scope: scope.trim(),
    count,
    result: result as GateResult,
    detail: typeof detail === 'string' && detail.trim() !== '' ? fieldText(detail, 200) : null,
  };
}

/**
 * Whether a validated row's evidence belongs to the discovery target.
 * lane-error rows describe this install's lanes (fleet machinery), so
 * they emit only for the fleet's own repository; repo-class rows carry
 * the qualified owner/repo scope and match the target exactly.
 */
function rowMatchesRepo(row: GateRow, repo: string): boolean {
  if (row.cls === 'lane-error') return fleetRepoName(repo) === FLEET_REPO_NAME;
  return row.scope.toLowerCase() === repo.trim().toLowerCase();
}

/** One side of a class key's fold: fires that moved the watermark vs tightenings that never landed. */
interface KeySide {
  rows: number;
  days: Set<string>;
  /** Result tallies inside the side, for prompt evidence. */
  applied: number;
  refused: number;
  errors: number;
  /** Largest single-fire fresh-signal count recorded. */
  maxCount: number;
  latestMs: number;
  /** Distinct scrubbed details recorded (stuck side only), capped for prompts. */
  details: string[];
}

const newSide = (): KeySide => ({
  rows: 0, days: new Set(), applied: 0, refused: 0, errors: 0,
  maxCount: 0, latestMs: 0, details: [],
});

/** A recurring cell: what it is, how the window's rows split, and the newest fire. */
interface KeyFold {
  cls: IncidentClassKind;
  key: string;
  gate: GateKind;
  scope: string;
  /** Watermark-advancing fires (applied, or refused on lane-hold) — recurrence evidence. */
  advancing: KeySide;
  /** Tightenings that never landed (error, or refused on repo-cooldown) — stuck-gate evidence. */
  stuck: KeySide;
  /** Every in-window matched row, advancing or stuck, for prompt context. */
  totalRows: number;
}

/**
 * Pure: fold validated, in-window, repo-matched rows into per-class-key
 * tallies. The advancing/stuck split mirrors the writer's own `advances`
 * rule (src/cli/fleet-incident-gate.ts): applied always advances, refused
 * advances only on the lane-hold gate, error never does — so advancing
 * fires are the ones that required fresh signals to recur, while stuck
 * rows re-fire on stale signals by construction.
 */
export function foldIncidentGateRows(
  rows: readonly GateRow[],
  repo: string,
): Map<string, KeyFold> {
  const folds = new Map<string, KeyFold>();
  for (const row of rows) {
    if (!rowMatchesRepo(row, repo)) continue;
    let fold = folds.get(row.key);
    if (fold === undefined) {
      fold = { cls: row.cls, key: row.key, gate: row.gate, scope: row.scope, advancing: newSide(), stuck: newSide(), totalRows: 0 };
      folds.set(row.key, fold);
    }
    fold.totalRows += 1;
    const advancing = row.result === 'applied' || (row.result === 'refused' && row.gate === LANE_ERROR_GATE);
    const side = advancing ? fold.advancing : fold.stuck;
    side.rows += 1;
    side.days.add(row.utcDay);
    if (row.result === 'applied') side.applied += 1;
    else if (row.result === 'refused') side.refused += 1;
    else side.errors += 1;
    side.maxCount = Math.max(side.maxCount, row.count);
    side.latestMs = Math.max(side.latestMs, row.atMs);
    if (!advancing && row.detail !== null && !side.details.includes(row.detail) && side.details.length < PROMPT_DETAILS_MAX * 4) {
      side.details.push(row.detail);
    }
  }
  return folds;
}

const WINDOW_DAYS = Math.round(INCIDENT_GATE_WINDOW_MS / 86_400_000);

const NO_CHANGE = 'If the window has rolled forward, the class stopped recurring or its tightenings now land, or the cause is owner-only (credentials, billing, a protected gate or sandbox profile) — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is fleet/incident-gates.jsonl under the Ashlr home (~/.ashlr/fleet/incident-gates.jsonl): `ashlr fleet incident-gate --apply` (src/cli/fleet-incident-gate.ts over src/core/fleet/incident-gate.ts) mines metrics/jobs.jsonl and dispatch-events.log under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR) for repeated failure signatures — lane-error classes get a bounded lane hold through the guarded slots.json writer, test-failure and merge-conflict classes a bounded repo cooldown through setRepoHold — and appends one scrubbed decision row per tripped class; the same verb without --apply is a dry run that prints the classes current evidence would trip. Until now appendIncidentGateLedger had no reader and the verb has no report mode, so recorded tightenings never became work.';

const truncationNote = (truncated: boolean): string =>
  truncated ? ' The ledger tail was truncated, so these counts cover only the retained bytes — treat every tally as a lower bound.' : '';

const latestIso = (ms: number): string => (ms > 0 ? new Date(ms).toISOString() : 'unrecorded');

function recurringPrompt(fold: KeyFold, truncated: boolean): string {
  const side = fold.advancing;
  const parts = [
    `Phantom's incident gate keeps firing on the same repeated failure class — every recorded tightening let the class watermark move, so each fire after the first needed fresh failure signals, and the class kept supplying them.`,
    '',
    `Class '${fieldText(fold.key, KEY_MAX)}' (${fold.cls}) reached a terminal tightening ${side.rows} time(s) across ${side.days.size} distinct UTC day(s) inside the ${WINDOW_DAYS}-day window: ${side.applied} applied, ${side.refused} refused; the largest fire recorded ${side.maxCount} fresh signals and the newest landed ${latestIso(side.latestMs)}. Scope '${fieldText(fold.scope, FIELD_MAX)}' through the '${fold.gate}' gate; ${fold.totalRows} decision row(s) were recorded for the class in the window.${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `Investigate why '${fieldText(fold.key, KEY_MAX)}' keeps recurring on ${fieldText(fold.scope, FIELD_MAX)}: the class key and scope carry the normalized failure signature — pool/class errors, exit codes, empty diffs, auth/usage/capacity events, launch failures and deferrals, precheck skips, task failures, or pull requests closed unmerged. Read the matching rows in metrics/jobs.jsonl and dispatch-events.log, check whether the bounded holds are masking a broken lane, credential, quota, test or merge path, and fix the root cause in this repository — or the lane or repository it names. \`ashlr fleet incident-gate --json\` (dry run, no --apply) prints the classes the current evidence would trip. ${NO_CHANGE}`,
  ];
  return parts.join('\n');
}

function tightenFailedPrompt(fold: KeyFold, truncated: boolean): string {
  const side = fold.stuck;
  const shown = side.details.slice(0, PROMPT_DETAILS_MAX).map((d) => `'${fieldText(d, 200)}'`);
  const rest = side.details.length > shown.length ? `, and ${side.details.length - shown.length} more distinct detail(s)` : '';
  const detailText = shown.length > 0 ? ` Recorded details include ${shown.join(', ')}${rest}.` : '';
  return [
    `Phantom's incident gate keeps detecting a repeated failure class but cannot land its tightening — errored rows and repo-cooldown refusals never advance the class watermark, so the same signals re-fire on every --apply run: the fleet sees the incident but its protection is stuck, not absent.`,
    '',
    `Class '${fieldText(fold.key, KEY_MAX)}' (${fold.cls}) recorded ${side.rows} tightening(s) that never landed across ${side.days.size} distinct UTC day(s) inside the ${WINDOW_DAYS}-day window through the '${fold.gate}' gate on '${fieldText(fold.scope, FIELD_MAX)}': ${side.errors} errored, ${side.refused} refused.${detailText}${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `Find why the tightening keeps failing for '${fieldText(fold.key, KEY_MAX)}': the recorded detail carries the thrown error or refusal reason — check slots.json and runs-dir writability for lane holds (placeLaneHold), the repo-hold store's health under the Ashlr authority state for cooldowns (setRepoHold in src/core/fleet/quarantine.ts), or the fleet KILL switch; then re-run \`ashlr fleet incident-gate --apply\` and confirm the class's next row records 'applied'. ${NO_CHANGE}`,
  ].join('\n');
}

function itemId(bucket: 'recurring' | 'tighten-failed', key: string): string {
  const hash = createHash('sha256').update(`incident-gate:${bucket}:${key}`).digest('hex').slice(0, 16);
  return `incident-gate-${bucket}-${hash}`;
}

function makeItem(bucket: 'recurring' | 'tighten-failed', fold: KeyFold, repo: string, title: string, prompt: string): CloudBacklogItem {
  return {
    id: itemId(bucket, fold.key),
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'incident-gate',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the incident-gate ledger's recurring failure classes
 * and stuck tightenings on `repo`. Total: any read or fold failure
 * yields no items rather than throwing into discovery.
 */
export async function incidentGateBacklogItems(opts: IncidentGateItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '') return [];
    const nowMs = opts.now ?? Date.now();
    const ledgerPath = opts.ledgerPath ?? join(opts.homeDir ?? homedir(), INCIDENT_GATE_LEDGER_RELATIVE);
    const tail = await readLedgerTail(ledgerPath, INCIDENT_GATE_LEDGER_MAX_BYTES);
    if (tail.state !== 'read') return [];
    const windowMs = opts.windowMs ?? INCIDENT_GATE_WINDOW_MS;
    const windowStart = nowMs - windowMs;
    const rows: GateRow[] = [];
    for (const line of tail.text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const row = parseIncidentGateLine(trimmed);
      if (row === null) continue;
      if (row.atMs < windowStart || row.atMs > nowMs + INCIDENT_GATE_FUTURE_SKEW_MS) continue;
      rows.push({ ...row, utcDay: utcDayOf(row.atMs) });
    }
    const folds = foldIncidentGateRows(rows, repo);

    const recurring: KeyFold[] = [];
    const tightenFailed: KeyFold[] = [];
    for (const fold of folds.values()) {
      if (fold.advancing.days.size >= INCIDENT_GATE_RECURRING_DAYS) recurring.push(fold);
      if (fold.stuck.days.size >= INCIDENT_GATE_RECURRING_DAYS) tightenFailed.push(fold);
    }
    recurring.sort((a, b) => b.advancing.rows - a.advancing.rows || a.key.localeCompare(b.key));
    tightenFailed.sort((a, b) => b.stuck.rows - a.stuck.rows || a.key.localeCompare(b.key));

    const candidates: CloudBacklogItem[] = [];
    for (const fold of recurring) {
      candidates.push(makeItem(
        'recurring',
        fold,
        repo,
        `Incident-gate class keeps recurring: ${fieldText(fold.key, KEY_MAX)}`,
        recurringPrompt(fold, tail.truncated),
      ));
    }
    for (const fold of tightenFailed) {
      candidates.push(makeItem(
        'tighten-failed',
        fold,
        repo,
        `Incident gate keeps failing to tighten ${fieldText(fold.key, KEY_MAX)}`,
        tightenFailedPrompt(fold, tail.truncated),
      ));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? INCIDENT_GATE_MAX_ITEMS, INCIDENT_GATE_ITEM_HARD_MAX));
    return candidates.slice(0, limit);
  } catch {
    return [];
  }
}
