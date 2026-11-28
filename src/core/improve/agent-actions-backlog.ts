/**
 * Agent-action ledger recurring adverse evidence → self-improvement
 * backlog items.
 *
 * recordAgentAction (src/core/fleet/agent-action-ledger.ts) is the
 * fleet's append-only semantic action stream — "compact, scrubbed
 * events that describe what the fleet attended to, tried, skipped,
 * produced, or blocked on", in the writer's own words analytics and
 * learning input that never grants authority and never throws. Every
 * call site — the daemon loop's tick/selection/dispatch/repair
 * records, the sandboxed engine's per-run telemetry, leader-seat role
 * completions, merge and judge surfaces — appends one sanitized
 * AgentActionEvent to <ashlr>/agent-actions/<UTC-date>.jsonl, one
 * file per UTC day partitioned by the row's own timestamp, never
 * rotated and never deleted. schemaVersion 2 marks rows whose
 * runEventSummary carries token evidence; every field this fold
 * consumes is sanitized identically in both versions, and the
 * provenance-bearing extras are never read.
 *
 * Until now the journal's only readers were point-in-time surfaces:
 * the web workspace card and control recent-actions list
 * (readAgentWorkspace/readAgentActions), the verse outcome-task
 * context and fleet-live projections, and the autonomy attempt and
 * trajectory record folds — all bounded recent-window views for
 * display or per-run reconstruction, none a recurrence fold. An
 * action that keeps ending 'failed' — engine-failed dispatches, a
 * tick whose state persistence keeps failing — or keeps landing in
 * the writer's honest 'unknown' bucket looked like a string of
 * one-off rows in a viewer someone had to open, never a pattern,
 * never work. The ledger IS the fleet's own record of which actions
 * run and which keep failing, so its recurring adverse cells are
 * the lane's most direct evidence.
 *
 * agentActionsBacklogItems carries the same journal into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the sibling audit, daemon-tick,
 * agent-diagnostics and custody feeds beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. Only date-named partitions inside the evidence window
 *    are read, each once through readLedgerTail's bounded no-follow
 *    tail; nothing is written and no lock, process or network is
 *    touched. A missing directory or an unreadable partition yields
 *    no items while the rest still fold — unknown stays unknown,
 *    never a guessed tally — and a truncated tail folds the retained
 *    rows with the prompts stating the counts as lower bounds.
 *  - Rows count only under the writer's contract: schemaVersion 1 or
 *    2, a parseable `ts`, actor/kind/outcome inside the writer's
 *    closed vocabularies, an `action` code matching the writer's
 *    ACTION_CODE_RE shape, a `summary` string, and reason/backend/
 *    source/tier/repo/durationMs validated as the writer bounds them
 *    (reason is canonicalized to a closed code or cooldown slug at
 *    write time but legacy partitions carry freer text, so it is
 *    treated as bounded untrusted text, never a vocabulary). Malformed
 *    lines are counted, never guessed.
 *  - Only 'failed' and 'unknown' rows are evidence. 'failed' is the
 *    writer's recorded failure vocabulary (engine-failed,
 *    sandbox-failed, state-persistence-failed, proposal-capture-error
 *    and friends). 'unknown' is the writer's honest unclassified
 *    bucket — an action that settled without a recognized outcome —
 *    so recurrence means outcomes the classifiers do not name yet or
 *    genuinely ambiguous endings, never a hidden failure count.
 *    'skipped', 'blocked', 'no-proposal' and the lifecycle/success
 *    outcomes are the deliberate-hold and normal-flow vocabulary —
 *    kill-switch, pause and verify-only ticks, cooldowns, aborts,
 *    quality gates, dispatches that correctly produced nothing —
 *    working as configured, the same exclusion the audit feed applies
 *    to its 'ok' rows.
 *  - Recurring means recorded across days at a rate that cannot be a
 *    transient burst: a cell emits only when its in-window records
 *    reach AGENT_ACTION_MIN_UNITS across AGENT_ACTION_MIN_DAYS
 *    distinct UTC days — a single failure or a one-day burst stays
 *    quiet. The 14-day window is double the sibling 7-day convention
 *    because adverse outcomes on this high-volume stream are sparse:
 *    a healthy fleet records single digits a week, and a fortnight
 *    still expires month-old bursts. The window is anchored on the
 *    clock with the sibling feeds' future-skew allowance, and a
 *    partition tail that dropped older rows still folds with
 *    lower-bound counts.
 *  - The evidence is this install's action ledger: rows span every
 *    repo the daemon touches but describe Phantom's own machinery,
 *    so items emit only when the backlog target's repository name is
 *    'phantom', the same last-segment rule the sibling fleet-evidence
 *    sources apply. Recorded `repo` fields are quoted as bounded
 *    samples inside prompts, never as item attribution.
 *  - Dedup is downstream. Item ids key on the cell — actor, kind,
 *    action, outcome, reason, backend, source and tier — never the
 *    counts or timestamps, so a refresh re-derives the same ids and
 *    appendUserBacklogItems adds only what is new; an action that
 *    recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, journal strings are scrubbed, flattened
 *    and capped before they reach a prompt, and the brief carries the
 *    usual no-change escape when the window no longer reproduces.
 */
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ashlrHome, CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the cap bounds the open-ended action cells. */
export const AGENT_ACTIONS_BACKLOG_MAX_ITEMS = 12;
const AGENT_ACTION_ITEM_HARD_MAX = 25;
/**
 * Evidence window: fourteen days. Adverse outcomes on this
 * high-volume stream are sparse — single digits a week on a healthy
 * fleet — so the sibling feeds' 7-day convention would almost never
 * reach the recurring bars; a fortnight still expires month-old
 * bursts.
 */
export const AGENT_ACTIONS_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, same convention the sibling folds tolerate. */
const AGENT_ACTION_FUTURE_SKEW_MS = 60_000;
/** In-window records a cell needs before its outcome counts as recurring. */
export const AGENT_ACTION_MIN_UNITS = 3;
/** Distinct UTC days the records must span — recurring means recorded across days. */
export const AGENT_ACTION_MIN_DAYS = 2;
/**
 * Bounded tail per date partition. Observed partitions run to ~2.2 MiB
 * on busy days (semantic events and work transitions inflate rows), so
 * 4 MiB retains a full busy partition while keeping a discovery pass
 * cheap; a larger one folds its retained tail as a stated lower bound.
 */
export const AGENT_ACTION_FILE_TAIL_BYTES = 4 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are untrusted text; flatten, scrub and cap before use. */
const FIELD_MAX = 160;
/** Reason text is canonicalized at write time but legacy rows carry freer text; cap before it keys a cell. */
const MAX_REASON_CHARS = 200;
/** Distinct recorded repo samples quoted inside one prompt before the rest is summarized. */
const PROMPT_REPO_SAMPLES_MAX = 4;
/** The fleet's own repository label: agent-action evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Date-partition file names the writer produces: one <UTC-day>.jsonl per day. */
const PARTITION_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// Local copies of the writer's closed vocabularies — the same precedent
// xreview-backlog sets for the cross-review ledger. The sets are
// module-private in agent-action-ledger.ts, so they are mirrored here
// with their source; a writer-side addition makes in-window rows of the
// new value count as malformed (evidence under-counts, never invents).
const AGENT_ACTION_ACTORS = new Set([
  'daemon', 'agent', 'judge', 'verifier', 'merge', 'fleet', 'system',
]);
const AGENT_ACTION_KINDS = new Set([
  'tick', 'selection', 'route', 'dispatch', 'proposal', 'verification',
  'judge', 'merge', 'guard', 'maintenance', 'context-rollup', 'reflection',
]);
const AGENT_ACTION_OUTCOMES = new Set([
  'started', 'ok', 'skipped', 'blocked', 'failed', 'proposal-created',
  'no-proposal', 'verified', 'judged', 'merged', 'rejected', 'unknown',
]);
/** The writer's ENGINE_IDS (agent-action-ledger.ts): backends it will record. */
const AGENT_ACTION_BACKENDS = new Set([
  'builtin', 'local-coder', 'llama-server', 'ashlrcode', 'aw', 'claude',
  'codex', 'hermes', 'kimi', 'nim', 'opencode', 'meta-muse', 'grok',
]);
const AGENT_ACTION_TIERS = new Set(['local', 'mid', 'frontier']);
const AGENT_ACTION_SOURCES = new Set([
  'issue', 'todo', 'test', 'dep', 'doc', 'security', 'plugin', 'self',
  'lint', 'goal', 'hygiene', 'invent',
]);
/** The writer's ACTION_CODE_RE: lowercase machine codes, colon-namespaced. */
const ACTION_CODE_RE = /^[a-z0-9][a-z0-9:._-]{0,119}$/;

type AdverseOutcome = 'failed' | 'unknown';
/** The writer's AgentActionOutcome vocabulary, mirrored for row typing. */
type AgentActionOutcome =
  | 'started' | 'ok' | 'skipped' | 'blocked' | 'failed' | 'proposal-created'
  | 'no-proposal' | 'verified' | 'judged' | 'merged' | 'rejected' | 'unknown';

export interface AgentActionsItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Agent-actions directory override (default: <ashlrHome()>/agent-actions — agentActionsDir()'s own resolution); tests only. */
  agentActionsDirPath?: string;
  /** Most items one call emits (default AGENT_ACTIONS_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default AGENT_ACTIONS_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated agent-action row; `outcome` is any on-contract outcome — the fold keeps only the adverse pair. */
export interface AgentActionRow {
  atMs: number;
  utcDay: string;
  actor: string;
  kind: string;
  action: string;
  outcome: AgentActionOutcome;
  reason: string;
  backend: string;
  source: string;
  tier: string;
  /** Recorded work-item repo when present; prompt sample context only, never cell identity. */
  repo: string;
  /** Recorded durationMs when finite and non-negative; prompt context only. */
  durationMs: number | null;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Journal-recorded strings are untrusted text; flatten runs of whitespace before use. */
function flatText(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/**
 * Pure: validate one parsed journal line against the writer's event
 * contract — the fields this fold consumes plus the schema literal and
 * timestamp the window needs. Only 'failed' and 'unknown' outcomes are
 * kept as rows; every other outcome parses as valid-but-not-evidence is
 * handled by the caller filtering, so this returns the row for any
 * on-contract event and lets the fold decide. Anything off-contract —
 * wrong schema, unparseable ts, out-of-vocabulary actor/kind/outcome,
 * a non-code action, a non-string summary, or a mistyped optional field —
 * is not an agent-action row.
 */
export function parseAgentActionEntry(value: unknown): AgentActionRow | null {
  if (!isRecord(value)) return null;
  const schemaVersion = value['schemaVersion'];
  if (schemaVersion !== 1 && schemaVersion !== 2) return null;
  const ts = value['ts'];
  const atMs = typeof ts === 'string' ? Date.parse(ts) : NaN;
  if (!Number.isFinite(atMs)) return null;
  const actor = value['actor'];
  if (typeof actor !== 'string' || !AGENT_ACTION_ACTORS.has(actor)) return null;
  const kind = value['kind'];
  if (typeof kind !== 'string' || !AGENT_ACTION_KINDS.has(kind)) return null;
  const outcome = value['outcome'];
  if (typeof outcome !== 'string' || !AGENT_ACTION_OUTCOMES.has(outcome)) return null;
  const action = value['action'];
  if (typeof action !== 'string' || !ACTION_CODE_RE.test(action)) return null;
  const summary = value['summary'];
  if (typeof summary !== 'string') return null;

  // Optional consumed fields, each validated as the writer bounds it.
  let reason = '';
  const rawReason = value['reason'];
  if (rawReason !== undefined && rawReason !== null) {
    if (typeof rawReason !== 'string') return null;
    reason = scrubSecrets(flatText(rawReason)).slice(0, MAX_REASON_CHARS);
  }
  let backend = '';
  const rawBackend = value['backend'];
  if (rawBackend !== undefined && rawBackend !== null) {
    if (typeof rawBackend !== 'string' || !AGENT_ACTION_BACKENDS.has(rawBackend)) return null;
    backend = rawBackend;
  }
  let source = '';
  const rawSource = value['source'];
  if (rawSource !== undefined && rawSource !== null) {
    if (typeof rawSource !== 'string' || !AGENT_ACTION_SOURCES.has(rawSource)) return null;
    source = rawSource;
  }
  let tier = '';
  const rawTier = value['tier'];
  if (rawTier !== undefined && rawTier !== null) {
    if (typeof rawTier !== 'string' || !AGENT_ACTION_TIERS.has(rawTier)) return null;
    tier = rawTier;
  }
  let repo = '';
  const rawRepo = value['repo'];
  if (rawRepo !== undefined && rawRepo !== null) {
    if (typeof rawRepo !== 'string') return null;
    repo = scrubSecrets(flatText(rawRepo)).slice(0, FIELD_MAX);
  }
  let durationMs: number | null = null;
  const rawDuration = value['durationMs'];
  if (rawDuration !== undefined && rawDuration !== null) {
    if (typeof rawDuration !== 'number' || !Number.isFinite(rawDuration) || rawDuration < 0) return null;
    durationMs = rawDuration;
  }

  return {
    atMs,
    utcDay: utcDayOf(atMs),
    actor,
    kind,
    action,
    outcome: outcome as AgentActionOutcome,
    reason,
    backend,
    source,
    tier,
    repo,
    durationMs,
  };
}

/**
 * Pure: parse one partition's text into validated rows plus the count
 * of lines that were not on-contract entries — malformed JSON and
 * off-contract rows are counted, never guessed. Rows whose outcome is
 * outside the adverse vocabulary still parse (they are valid records);
 * the fold windows and filters them.
 */
export function parseAgentActionPartition(text: string): { rows: AgentActionRow[]; invalidRows: number } {
  const rows: AgentActionRow[] = [];
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
    const row = parseAgentActionEntry(value);
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows };
}

/** One evidence cell's recurring tally across the in-window rows. */
interface AgentActionCell {
  actor: string;
  kind: string;
  action: string;
  outcome: AdverseOutcome;
  reason: string;
  backend: string;
  source: string;
  tier: string;
  /** Records carrying this cell inside the window. */
  units: number;
  /** Distinct UTC days those records fall on. */
  days: Set<string>;
  /** Distinct recorded work-item repos, capped at PROMPT_REPO_SAMPLES_MAX. */
  repos: string[];
  repoOverflow: boolean;
  /** Longest recorded durationMs inside the cell, when any row carried one. */
  maxDurationMs: number | null;
  firstAtMs: number;
  lastAtMs: number;
}

/** Journal-recorded strings are untrusted text; flatten, scrub and cap before use. */
function fieldText(value: string, max = FIELD_MAX): string {
  return scrubSecrets(flatText(value)).slice(0, max);
}

function cellFor(cells: Map<string, AgentActionCell>, row: AgentActionRow & { outcome: AdverseOutcome }): AgentActionCell {
  const key = JSON.stringify([row.actor, row.kind, row.action, row.outcome, row.reason, row.backend, row.source, row.tier]);
  let cell = cells.get(key);
  if (cell === undefined) {
    cell = {
      actor: row.actor, kind: row.kind, action: row.action, outcome: row.outcome,
      reason: row.reason, backend: row.backend, source: row.source, tier: row.tier,
      units: 0, days: new Set(), repos: [], repoOverflow: false,
      maxDurationMs: null, firstAtMs: Infinity, lastAtMs: -Infinity,
    };
    cells.set(key, cell);
  }
  return cell;
}

function touch(cell: AgentActionCell, row: AgentActionRow & { outcome: AdverseOutcome }): void {
  cell.units += 1;
  cell.days.add(row.utcDay);
  cell.firstAtMs = Math.min(cell.firstAtMs, row.atMs);
  cell.lastAtMs = Math.max(cell.lastAtMs, row.atMs);
  if (row.durationMs !== null && (cell.maxDurationMs === null || row.durationMs > cell.maxDurationMs)) {
    cell.maxDurationMs = row.durationMs;
  }
  if (row.repo !== '' && !cell.repos.includes(row.repo)) {
    if (cell.repos.length >= PROMPT_REPO_SAMPLES_MAX) { cell.repoOverflow = true; }
    else { cell.repos.push(row.repo); }
  }
}

/**
 * Pure: fold validated rows into per-cell tallies. Only the writer's
 * adverse vocabulary counts — 'failed' and 'unknown' rows; every other
 * outcome is the deliberate-hold or normal-flow vocabulary and is
 * context, never evidence.
 */
export function foldAgentActionEvidence(
  rows: readonly AgentActionRow[],
  opts: { nowMs: number; windowMs?: number },
): { cells: AgentActionCell[]; records: number; outsideWindow: number } {
  const windowMs = opts.windowMs ?? AGENT_ACTIONS_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const cells = new Map<string, AgentActionCell>();
  let inWindow = 0;
  let outsideWindow = 0;
  for (const row of rows) {
    if (row.atMs < windowStart || row.atMs > opts.nowMs + AGENT_ACTION_FUTURE_SKEW_MS) {
      outsideWindow += 1;
      continue;
    }
    inWindow += 1;
    if (row.outcome !== 'failed' && row.outcome !== 'unknown') continue;
    const adverse: AgentActionRow & { outcome: AdverseOutcome } = { ...row, outcome: row.outcome };
    touch(cellFor(cells, adverse), adverse);
  }
  const recurring = [...cells.values()]
    .filter((cell) => cell.units >= AGENT_ACTION_MIN_UNITS && cell.days.size >= AGENT_ACTION_MIN_DAYS)
    .sort((a, b) => b.units - a.units || a.action.localeCompare(b.action) || a.outcome.localeCompare(b.outcome));
  return { cells: recurring, records: inWindow, outsideWindow };
}

/** The evidence pointers every prompt shares; the journal, its writer and its existing readers are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is <ashlr>/agent-actions/<UTC-date>.jsonl under the Phantom state directory ($ASHLR_HOME when absolute, else ~/.ashlr — agentActionsDir() in src/core/fleet/agent-action-ledger.ts) — one append-only partition per UTC day named for the row\'s own timestamp, never rotated or deleted. recordAgentAction appends one sanitized AgentActionEvent per fleet action — actor, kind, outcome, action code, reason, backend, source, tier, bounded repo/item/run ids, tags and counts — written by the daemon loop\'s tick/selection/dispatch/repair records (src/core/daemon/loop.ts), the sandboxed engine\'s per-run telemetry (src/core/run/sandboxed-engine.ts), leader-seat role completions (src/core/vision/leader-seat.ts) and the merge/judge surfaces; find a cell\'s call sites with a grep for the action literal under src/. Its only readers until this feed were the web workspace card and control recent-actions list, the verse outcome-task context and fleet-live projections, and the autonomy attempt/trajectory record folds — bounded recent-window views for display or per-run reconstruction, never a recurrence fold.';

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

function reposText(cell: AgentActionCell): string {
  if (cell.repos.length === 0) return 'no work-item repos were recorded on these rows';
  const joined = cell.repos.map((r) => `'${r}'`).join(', ');
  return cell.repoOverflow ? `recorded work-item repos include ${joined}, and more` : `recorded work-item repos: ${joined}`;
}

function cellCounts(cell: AgentActionCell): string {
  return `${cell.units} in-window records across ${cell.days.size} UTC days`;
}

function actionText(action: string): string {
  return fieldText(action, 80) || 'unknown';
}

/** The cell's recorded qualifiers, quoted exactly as the journal stored them. */
function qualifiersText(cell: AgentActionCell): string {
  const parts: string[] = [];
  if (cell.reason !== '') parts.push(`reason '${fieldText(cell.reason, MAX_REASON_CHARS)}'`);
  if (cell.backend !== '') parts.push(`backend '${cell.backend}'`);
  if (cell.source !== '') parts.push(`source '${cell.source}'`);
  if (cell.tier !== '') parts.push(`tier '${cell.tier}'`);
  parts.push(`${cell.actor}:${cell.kind}`);
  return parts.length === 0 ? 'no qualifiers were recorded' : parts.join(', ');
}

function durationText(cell: AgentActionCell): string {
  if (cell.maxDurationMs === null) return '';
  return ` Longest recorded duration ${Math.round(cell.maxDurationMs)} ms.`;
}

function failedPrompt(cell: AgentActionCell, truncatedFiles: number, invalidRows: number, unreadableFiles: number, outsideWindow: number): string {
  const action = actionText(cell.action);
  return [
    `Phantom's agent-action ledger keeps recording '${action}' failures — ${cellCounts(cell)} inside the window (${qualifiersText(cell)}), the self-improvement work this backlog exists for.`,
    '',
    `recordAgentAction writes outcome 'failed' when the action itself failed — an engine-failed or sandbox-failed dispatch, a sandboxed-engine run whose engine, sandbox or proposal capture broke, a tick whose state persistence failed, a role completion that ended failed. One failure is a fault; recurrence across days means the action's machinery is broken in a way that keeps repeating, not a one-off.${spanText(cell.firstAtMs, cell.lastAtMs)}${durationText(cell)} ${reposText(cell)}.${coverageNote(truncatedFiles, invalidRows, unreadableFiles, outsideWindow)}`,
    '',
    EVIDENCE,
    '',
    `Find why the action keeps failing: locate its recordAgentAction call sites (grep the action literal under src/ — the daemon loop for daemon:* actions, src/core/run/sandboxed-engine.ts for sandboxed-engine:*, src/core/vision/leader-seat.ts for role:completion), read the recorded reason as the failure kind, and reproduce the failing path against a scratch home where one exists. Check whether paired actions record the same incident (a sandboxed-engine:run failure and its daemon:dispatch engine-failed wrapper are one event seen twice) and whether a sibling feed already carries the per-invocation engine diagnostics for the same window. If the failures are owner-side or pinned ops machinery rather than repo code — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function unknownPrompt(cell: AgentActionCell, truncatedFiles: number, invalidRows: number, unreadableFiles: number, outsideWindow: number): string {
  const action = actionText(cell.action);
  return [
    `Phantom's agent-action ledger keeps recording '${action}' outcomes the writer could not classify — ${cellCounts(cell)} inside the window (${qualifiersText(cell)}), the self-improvement work this backlog exists for.`,
    '',
    `recordAgentAction's outcome vocabulary is closed — ok, started, skipped, blocked, failed, proposal-created, no-proposal, verified, judged, merged, rejected, unknown — and 'unknown' is the honest bucket for an action that settled without a recognized outcome: tick reasons outside tickAgentOutcome's map, dispatch event outcomes outside agentOutcomeFromDispatchEvent's, role-completion endings the metrics do not name. Recurrence across days means either outcomes the classifiers do not name yet — a vocabulary gap this repo owns — or genuinely ambiguous endings worth understanding, never a hidden failure count.${spanText(cell.firstAtMs, cell.lastAtMs)}${durationText(cell)} ${reposText(cell)}.${coverageNote(truncatedFiles, invalidRows, unreadableFiles, outsideWindow)}`,
    '',
    EVIDENCE,
    '',
    `Find which endings land in the bucket: locate the action's outcome mapping (tickAgentOutcome, agentOutcomeFromDispatchEvent and agentActionFromDispatchEvent in src/core/daemon/loop.ts for daemon:* actions, sandboxAgentOutcome in src/core/run/sandboxed-engine.ts, the role-completion metrics mapping in src/core/vision/leader-seat.ts), enumerate the upstream values that can reach it, and check the recorded reason and tags on the journal rows for the unnamed cases. If the unnamed outcomes are deliberate states the classifiers should name — extend the mapping so the ledger stops recording 'unknown' for them; if they are genuinely ambiguous endings — investigate what the action actually did and whether the outcome should have been failed, skipped or ok. If the rows reflect pinned ops machinery or owner-side states — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function cellPrompt(cell: AgentActionCell, truncatedFiles: number, invalidRows: number, unreadableFiles: number, outsideWindow: number): string {
  return cell.outcome === 'failed'
    ? failedPrompt(cell, truncatedFiles, invalidRows, unreadableFiles, outsideWindow)
    : unknownPrompt(cell, truncatedFiles, invalidRows, unreadableFiles, outsideWindow);
}

function cellTitle(cell: AgentActionCell): string {
  const action = actionText(cell.action);
  const qualifier = cell.reason !== '' && cell.reason !== cell.outcome ? ` (${fieldText(cell.reason, 60)})` : '';
  return cell.outcome === 'failed'
    ? `Agent action '${action}' keeps recording 'failed'${qualifier}`
    : `Agent action '${action}' keeps recording unclassified 'unknown' outcomes${qualifier}`;
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

function agentActionItem(cell: AgentActionCell, repo: string, truncatedFiles: number, invalidRows: number, unreadableFiles: number, outsideWindow: number): CloudBacklogItem {
  const key = JSON.stringify([cell.actor, cell.kind, cell.action, cell.outcome, cell.reason, cell.backend, cell.source, cell.tier]);
  return {
    id: `agent-actions-${sha(key)}`,
    title: cellTitle(cell).slice(0, MAX_TITLE_CHARS),
    prompt: cellPrompt(cell, truncatedFiles, invalidRows, unreadableFiles, outsideWindow),
    area: 'agent-actions',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the agent-action ledger's recurring adverse
 * evidence. Total: any read or fold failure yields no items rather
 * than throwing into discovery.
 */
export async function agentActionsBacklogItems(opts: AgentActionsItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const dir = opts.agentActionsDirPath ?? join(ashlrHome(), 'agent-actions');
    if (typeof dir !== 'string' || dir === '') return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowMs ?? AGENT_ACTIONS_WINDOW_MS;
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

    const reads = await Promise.all(files.map((path) => readLedgerTail(path, AGENT_ACTION_FILE_TAIL_BYTES)));
    const rows: AgentActionRow[] = [];
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
      const parsed = parseAgentActionPartition(read.text);
      rows.push(...parsed.rows);
      invalidRows += parsed.invalidRows;
    }
    if (readFiles === 0) return [];

    const folded = foldAgentActionEvidence(rows, { nowMs, windowMs });
    const items: CloudBacklogItem[] = [];
    for (const cell of folded.cells) {
      items.push(agentActionItem(cell, repo, truncatedFiles, invalidRows, unreadableFiles, folded.outsideWindow));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? AGENT_ACTIONS_BACKLOG_MAX_ITEMS, AGENT_ACTION_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
