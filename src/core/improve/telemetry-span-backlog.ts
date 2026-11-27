/**
 * GenAI telemetry span journal → self-improvement backlog items.
 *
 * Every completed run and swarm task that carries usage emits one
 * GenAiSpan per task through the telemetry seam: the orchestrator
 * (src/core/run/orchestrator.ts) calls spansFromRun(state) and the swarm
 * runner calls spansFromSwarm(run) — both in
 * src/core/observability/otlp.ts — and hands them to getSink(cfg)'s
 * emit. Unless a pulse endpoint and PAT are configured, getSink
 * returns LocalFileSink (src/core/observability/telemetry-sink.ts),
 * which appends each span verbatim as one JSON line to
 * telemetry-YYYY-MM-DD.jsonl under localTelemetryDir() —
 * <homedir()>/.ashlr/telemetry, resolved per emit and ignoring
 * ASHLR_HOME. A span is METADATA ONLY by contract: name (task id),
 * runId, model, provider, tier, tokensIn/tokensOut, estCostUsd,
 * status and startTs/endTs — never prompt or response text, tool
 * args, file contents or secrets.
 *
 * Until now the journal's only reader was `ashlr telemetry status`
 * (src/cli/telemetry.ts), which counts the daily files for its status
 * display and never parses a single row — write-only evidence. The
 * span's status field is the task's terminal outcome ('done',
 * 'failed', 'skipped', 'cancelled', 'aborted', …), and
 * src/core/observability/otlp.ts's own statusCode maps exactly
 * 'failed' and 'aborted' to the OTLP error code — the codebase's own
 * definition of an adverse span outcome. A provider/model/tier lane
 * whose spans keep landing failed or aborted across days is outcome
 * evidence the router catalog and outcome-driven tuning have never
 * seen: jobs.jsonl records job-level dispatch state, the seat-router
 * shadow journal records what the router would have picked, and the
 * reward fold records merge verdicts — none of them sees that a
 * model lane itself keeps failing inside otherwise "successful"
 * runs. This feed folds that gap.
 *
 * Designed non-answers never emit. 'done' spans are delivered
 * context; 'skipped' (dependency-skipped), 'cancelled' (driver or
 * user stop) and every other non-error status are counted as context,
 * never as cells — the same failed|aborted error mapping otlp.ts
 * applies. A span whose status string is unrecognized still counts
 * under its own name in the cell's status mix but is never adverse.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. Each daily file inside the window is read once
 *    through readLedgerTail's bounded no-follow tail; nothing is
 *    written and no lock, process or network is touched. A missing
 *    file is a day with no emitted spans — normal, skipped silently.
 *    A file that exists but cannot be read is counted and named in
 *    the prompts; when no daily file reads at all the fold yields no
 *    items — unknown stays unknown, never a guessed tally — and a
 *    truncated tail folds the retained rows with the prompts stating
 *    the counts as lower bounds.
 *  - Rows count only under the writer's contract: a span carries
 *    non-empty name, runId, provider, model, tier and status strings
 *    plus a parseable endTs (startTs is the fallback clock). Malformed
 *    lines and off-contract rows are counted, never guessed. Spans
 *    dedupe on runId+name+status+timestamp — a retried emit folds
 *    once, first wins.
 *  - Recurring means recorded across days. A cell emits only after
 *    SPAN_MIN_ROWS failed/aborted spans inside the retained 7-day
 *    window span SPAN_MIN_DAYS distinct UTC days — one bad run is an
 *    incident, not a pattern. Done and other-status spans count as
 *    per-lane delivered context; the prompts carry the full mix so
 *    the investigating session sees the failure share, never a bare
 *    adverse tally.
 *  - The journal is this install's run telemetry and carries no
 *    repository dimension — a run's repo is not a span field — and
 *    the lanes it records are this factory's own machinery, so items
 *    emit only when the backlog target's repository name is 'phantom'
 *    — the same last-segment rule the sibling fleet-evidence sources
 *    apply.
 *  - estCostUsd is summed only over adverse spans and only where the
 *    writer recorded a finite non-negative value; adverse spans
 *    lacking it are counted separately so the prompt never presents
 *    a partial cost sum as complete.
 *  - Dedup is downstream. The item id embeds a stable hash of the
 *    cell's lane identity (never the counts or timestamps), so a
 *    refresh re-derives the same id and appendUserBacklogItems adds
 *    only what is new; shifted tallies do not spawn twin items.
 *  - No span content is ever emitted: the journal is metadata-only
 *    by contract, lane labels are bounded identifier strings, run and
 *    task ids are counted never quoted, and every prompt string is a
 *    fixed literal.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit; lane cells are bounded by the provider/model vocabulary the fleet actually runs. */
export const TELEMETRY_SPAN_BACKLOG_MAX_ITEMS = 8;
const TELEMETRY_SPAN_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const TELEMETRY_SPAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on span timestamps, same convention the sibling folds tolerate. */
const TELEMETRY_SPAN_FUTURE_SKEW_MS = 60_000;
/** Adverse spans a lane needs before its recurrence counts. */
export const TELEMETRY_SPAN_MIN_ROWS = 3;
/** Distinct UTC days those spans must span — recurring means recorded across days. */
export const TELEMETRY_SPAN_MIN_DAYS = 2;
/**
 * Bounded tail per daily file; one span line is roughly half a
 * kilobyte, so 4 MiB retains on the order of eight thousand spans —
 * far past any observed day — and truncation is stated, never silent.
 */
const TELEMETRY_SPAN_TAIL_BYTES = 4 * 1024 * 1024;
/**
 * Daily files the fold reads: the UTC dates the 7-day window touches,
 * today through seven days back — the writer names each file by its
 * emit date (`telemetry-YYYY-MM-DD.jsonl` in LocalFileSink.emit).
 */
const TELEMETRY_SPAN_FILE_DAYS = 8;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: span evidence is this install's run telemetry, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/**
 * The adverse status set — exactly the mapping statusCode in
 * src/core/observability/otlp.ts applies when it marks an OTLP span
 * error: 'failed' and 'aborted'. Every other status ('done',
 * 'skipped', 'cancelled', 'pending', 'running' and anything a future
 * writer adds) is context, never a cell.
 */
const ADVERSE_STATUSES = new Set(['failed', 'aborted']);

export interface TelemetrySpanItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Telemetry dir override (default: <homeDir>/.ashlr/telemetry — localTelemetryDir's own resolution). */
  telemetryDir?: string;
  /** Home for the default dir — the writer resolves homedir()/.ashlr/telemetry and ignores ASHLR_HOME (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default TELEMETRY_SPAN_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window and the file dates read (default: now). */
  now?: Date;
  /** Window in ms (default TELEMETRY_SPAN_WINDOW_MS). */
  windowMs?: number;
}

/** One validated span row. `costUsd` stays null when the writer recorded no finite non-negative estCostUsd. */
export interface TelemetrySpanRow {
  /** The run or swarm id the span belongs to — counted for distinct-run context, never emitted. */
  runId: string;
  /** Task id — metadata, never the task's goal text. */
  name: string;
  provider: string;
  model: string;
  tier: string;
  /** Terminal status string exactly as the writer recorded it. */
  status: string;
  /** Span end (or start fallback) in epoch ms — the outcome's own clock. */
  atMs: number;
  /** Recorded estCostUsd when finite and non-negative, else null — never fabricated. */
  costUsd: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

const parseIso = (value: unknown): number =>
  typeof value === 'string' ? Date.parse(value) : NaN;

const finiteCost = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

/**
 * Pure: classify one parsed journal line against the writer's span
 * contract (GenAiSpan in src/core/types/observability.ts). A valid row
 * carries non-empty name, runId, provider, model, tier and status
 * strings and a parseable endTs — startTs stands in when endTs is
 * absent or unparseable, matching the writer's own timestamp pair.
 * Unknown extra fields (memory, tokenEvidence) are tolerated so a
 * writer that adds metadata later does not invalidate its history.
 */
export function parseTelemetrySpanEntry(value: unknown): TelemetrySpanRow | null {
  if (!isRecord(value)) return null;
  const name = value['name'];
  const runId = value['runId'];
  const provider = value['provider'];
  const model = value['model'];
  const tier = value['tier'];
  const status = value['status'];
  if (!nonEmpty(name) || !nonEmpty(runId) || !nonEmpty(provider) ||
      !nonEmpty(model) || !nonEmpty(tier) || !nonEmpty(status)) return null;
  const endMs = parseIso(value['endTs']);
  const startMs = parseIso(value['startTs']);
  const atMs = Number.isFinite(endMs) ? endMs : startMs;
  if (!Number.isFinite(atMs)) return null;
  return { runId, name, provider, model, tier, status, atMs, costUsd: finiteCost(value['estCostUsd']) };
}

/**
 * Pure: parse one daily file's text into validated span rows plus the
 * count of lines that were not on-contract spans — malformed JSON and
 * off-contract rows are counted, never guessed.
 */
export function parseTelemetrySpanText(text: string): {
  spans: TelemetrySpanRow[];
  invalidRows: number;
} {
  const spans: TelemetrySpanRow[] = [];
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
    const row = parseTelemetrySpanEntry(value);
    if (row === null) { invalidRows += 1; continue; }
    spans.push(row);
  }
  return { spans, invalidRows };
}

/** One evidence cell's tally: every in-window span on one provider/model/tier lane. */
export interface TelemetrySpanCell {
  /** Stable cell identity for item ids and dedupe: provider|model|tier. */
  key: string;
  provider: string;
  model: string;
  tier: string;
  /** Every validated in-window span on the lane. */
  spans: number;
  /** Spans whose status is 'done'. */
  done: number;
  /** Spans whose status is 'failed' or 'aborted' — the otlp.ts error mapping. */
  adverse: number;
  /** Spans with any other status ('skipped', 'cancelled', unrecognized) — context, never adverse. */
  other: number;
  /** Distinct UTC days (of span end/start) the adverse spans fall on. */
  days: Set<string>;
  /** Distinct run ids among the adverse spans — counted, never emitted. */
  runs: Set<string>;
  firstAtMs: number;
  lastAtMs: number;
  /** Sum of finite estCostUsd over adverse spans — a floor when costUnknown > 0. */
  costUsd: number;
  /** Adverse spans lacking a finite non-negative estCostUsd. */
  costUnknown: number;
}

/**
 * Pure: fold validated spans into per-lane adverse cells. Windowing is
 * on the span's own end (start fallback) stamp; duplicate emits fold
 * once on runId+name+status+timestamp; the recurring bars are applied
 * here so callers see only cells that cleared them.
 */
export function foldTelemetrySpanCells(
  spans: readonly TelemetrySpanRow[],
  nowMs: number,
  windowMs: number = TELEMETRY_SPAN_WINDOW_MS,
): TelemetrySpanCell[] {
  const windowStart = nowMs - windowMs;
  const futureCeil = nowMs + TELEMETRY_SPAN_FUTURE_SKEW_MS;
  const cells = new Map<string, TelemetrySpanCell>();
  const seen = new Set<string>();
  for (const span of spans) {
    const dedupe = JSON.stringify([span.runId, span.name, span.status, span.atMs]);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    if (span.atMs < windowStart || span.atMs > futureCeil) continue;
    const key = `${span.provider}|${span.model}|${span.tier}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = {
        key, provider: span.provider, model: span.model, tier: span.tier,
        spans: 0, done: 0, adverse: 0, other: 0,
        days: new Set(), runs: new Set(),
        firstAtMs: Infinity, lastAtMs: -Infinity,
        costUsd: 0, costUnknown: 0,
      };
      cells.set(key, cell);
    }
    cell.spans += 1;
    if (ADVERSE_STATUSES.has(span.status)) {
      cell.adverse += 1;
      cell.days.add(utcDayOf(span.atMs));
      cell.runs.add(span.runId);
      cell.firstAtMs = Math.min(cell.firstAtMs, span.atMs);
      cell.lastAtMs = Math.max(cell.lastAtMs, span.atMs);
      if (span.costUsd === null) cell.costUnknown += 1;
      else cell.costUsd += span.costUsd;
    } else if (span.status === 'done') {
      cell.done += 1;
    } else {
      cell.other += 1;
    }
  }
  return [...cells.values()]
    .filter((cell) => cell.adverse >= TELEMETRY_SPAN_MIN_ROWS && cell.days.size >= TELEMETRY_SPAN_MIN_DAYS)
    .sort((a, b) => b.adverse - a.adverse || b.lastAtMs - a.lastAtMs || a.key.localeCompare(b.key));
}

/** The evidence pointers every prompt shares; the writer, its store contract and its consumers are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is telemetry-YYYY-MM-DD.jsonl under ~/.ashlr/telemetry — localTelemetryDir in src/core/observability/telemetry-sink.ts resolves homedir()/.ashlr/telemetry per emit and ignores ASHLR_HOME. LocalFileSink.emit appends one GenAiSpan per line — the normalized metadata-only shape (name, runId, model, provider, tier, tokensIn/tokensOut, estCostUsd, status, startTs/endTs; never prompt or response text) that spansFromRun and spansFromSwarm in src/core/observability/otlp.ts derive at run/swarm completion and the orchestrator (src/core/run/orchestrator.ts) and swarm runner emit through getSink(cfg). Until this feed the journal\'s only reader was `ashlr telemetry status` (src/cli/telemetry.ts) counting the daily files for its display — no reader ever parsed a span.';

const NO_CHANGE = 'If the telemetry directory is absent because no run or swarm has completed on this install inside the window, every counted failure traces to designed stops the journal cannot distinguish (driver cancellation lands as \'cancelled\'/\'skipped\', never adverse), the lane was retired from the router catalog, or the recorded window no longer reproduces on the default branch — report no-change and name the evidence.';

function coverageNote(truncated: boolean, unreadableFiles: number, invalidRows: number): string {
  const notes: string[] = [];
  if (truncated) notes.push('the bounded tails dropped older rows, so every count is a lower bound');
  if (unreadableFiles > 0) notes.push(`${unreadableFiles} daily span file(s) existed but could not be read — counts may understate`);
  if (invalidRows > 0) notes.push(`${invalidRows} malformed or off-contract lines dropped`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

function spanText(cell: TelemetrySpanCell): string {
  if (!Number.isFinite(cell.firstAtMs) || !Number.isFinite(cell.lastAtMs)) return '';
  const first = new Date(cell.firstAtMs).toISOString();
  const last = new Date(cell.lastAtMs).toISOString();
  return first === last ? ` First recorded ${first}.` : ` First recorded ${first}, last ${last}.`;
}

function mixText(cell: TelemetrySpanCell): string {
  return ` The same lane also recorded ${cell.done} 'done' span(s) and ${cell.other} other-status span(s) in the window — delivered and designed-stop context, not adverse.`;
}

function costText(cell: TelemetrySpanCell): string {
  const known = cell.adverse - cell.costUnknown;
  if (known === 0) return ' No adverse span recorded a cost.';
  const cost = cell.costUsd > 0 ? `an estimated $${cell.costUsd.toFixed(4)}` : 'a recorded $0.0000';
  const unknown = cell.costUnknown > 0 ? ` (cost unknown for ${cell.costUnknown} span(s))` : '';
  return ` The adverse spans carry ${cost}${unknown}.`;
}

function cellTitle(cell: TelemetrySpanCell): string {
  return `GenAI span outcomes keep failing for ${cell.provider}/${cell.model} (${cell.tier}) — ${cell.adverse} failed/aborted span(s) across ${cell.days.size} day(s)`.slice(0, MAX_TITLE_CHARS);
}

function cellPrompt(cell: TelemetrySpanCell, truncated: boolean, unreadableFiles: number, invalidRows: number): string {
  return [
    `Phantom's GenAI telemetry span journal shows the ${cell.provider}/${cell.model} lane (${cell.tier}) keep ending tasks 'failed' or 'aborted' — per-task model outcome evidence the improvement loop has never folded.`,
    '',
    `Inside the 7-day window the journal recorded ${cell.adverse} failed/aborted span(s) for this lane across ${cell.days.size} distinct UTC day(s), from ${cell.runs.size} distinct run(s), out of ${cell.spans} total span(s) on the lane.${spanText(cell)}${mixText(cell)}${costText(cell)}${coverageNote(truncated, unreadableFiles, invalidRows)}`,
    '',
    'A span is one run or swarm task\'s terminal outcome; \'failed\' and \'aborted\' are the error statuses src/core/observability/otlp.ts\'s statusCode maps to OTLP error — the same definition this fold applies. The lane label is the span\'s own provider/model/tier triple: for orchestrated runs model mirrors provider (modelForProvider) and tier is cloud/local (tierForProvider); swarm spans record provider \'ashlr-swarm\', model \'swarm\', tier \'local\'.',
    '',
    EVIDENCE,
    '',
    `Find why this lane keeps failing: join the span window against metrics/jobs.jsonl and the run/swarm journals for the same run ids to see whether failures cluster on one error class, one repo area or one engine backend; check the router catalog and seat-router shadow journal (src/core/routing/) for whether this lane is being picked for work it cannot finish; check whether recent catalog or config changes correlate with the first adverse day. 'failed' and 'aborted' are already separated in the journal — weigh whether aborts look like infrastructure kills rather than model errors. Fix the cause in this repository — catalog entry, routing weight, lane health gate — rather than muting the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

function telemetrySpanCellItem(cell: TelemetrySpanCell, repo: string, truncated: boolean, unreadableFiles: number, invalidRows: number): CloudBacklogItem {
  return {
    id: `telspan-${sha(`telspan:${cell.key}`)}`,
    title: cellTitle(cell),
    prompt: cellPrompt(cell, truncated, unreadableFiles, invalidRows),
    area: 'telemetry-spans',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/**
 * Backlog items for the telemetry span journal's recurring
 * failed/aborted lane cells. Total: any read or fold failure yields
 * no items rather than throwing into discovery.
 */
export async function telemetrySpanBacklogItems(opts: TelemetrySpanItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const dir = opts.telemetryDir ?? join(opts.homeDir ?? homedir(), '.ashlr', 'telemetry');
    if (typeof dir !== 'string' || dir === '') return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowMs ?? TELEMETRY_SPAN_WINDOW_MS;
    const spans: TelemetrySpanRow[] = [];
    let invalidRows = 0;
    let truncated = false;
    let unreadableFiles = 0;
    let readFiles = 0;
    for (let i = 0; i < TELEMETRY_SPAN_FILE_DAYS; i += 1) {
      const date = new Date(nowMs - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const read = await readLedgerTail(join(dir, `telemetry-${date}.jsonl`), TELEMETRY_SPAN_TAIL_BYTES);
      if (read.state === 'missing') continue;
      if (read.state !== 'read') { unreadableFiles += 1; continue; }
      readFiles += 1;
      if (read.truncated) truncated = true;
      const parsed = parseTelemetrySpanText(read.text);
      invalidRows += parsed.invalidRows;
      spans.push(...parsed.spans);
    }
    if (readFiles === 0) return [];
    const cells = foldTelemetrySpanCells(spans, nowMs, windowMs);
    const limit = Math.max(1, Math.min(opts.limit ?? TELEMETRY_SPAN_BACKLOG_MAX_ITEMS, TELEMETRY_SPAN_ITEM_HARD_MAX));
    const items: CloudBacklogItem[] = [];
    for (const cell of cells) {
      if (items.length >= limit) break;
      items.push(telemetrySpanCellItem(cell, repo, truncated, unreadableFiles, invalidRows));
    }
    return items;
  } catch {
    return [];
  }
}
