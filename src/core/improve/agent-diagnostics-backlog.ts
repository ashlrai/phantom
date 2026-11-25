/**
 * Agent-invocation diagnostics journal evidence → self-improvement backlog items.
 *
 * Every engine retry attempt runEngine makes in the sandboxed engine path
 * (src/core/run/sandboxed-engine.ts) appends one fixed-schema,
 * value-free diagnostic record through recordAgentDiagnostic
 * (src/core/run/agent-diagnostics.ts) to <runRef>.jsonl under the
 * agent-logs directory of the Ashlr home ($ASHLR_HOME-aware,
 * ~/.ashlr/agent-logs otherwise): {schemaVersion, ts, runRef, engine, ok,
 * terminationReason?, errorClass, durationMs, attempt, maxAttempts,
 * configRecoveryAttempts?, tokensIn?, tokensOut?, output, error} — the
 * run id hashed to runRef, output/error reduced to byte/line/present
 * shapes, never content. Files are capped at 64 KiB, the store at 2,000
 * files / 64 MiB with a 30-day TTL, and writes are bounded, locked and
 * refuse symlinks.
 *
 * Until now the journal's only reader was ingestFleetAgentLogs
 * (src/core/reasoning/ingest-fleet.ts), which folds rows into the
 * reasoning store's TurnFeatures struggle evidence — a projection no
 * backlog source reads — so an engine whose invocations kept failing
 * the same way (rejected credentials, provider rate limits, stall
 * detectors firing, config drift needing mid-run recovery respawns)
 * looked like ordinary per-run noise, never work.
 *
 * agentDiagnosticsBacklogItems carries the recorded failure and
 * config-recovery signals into discoverBacklog, so `phm improve
 * discover` and the scheduler's autoDiscover queue them exactly like
 * the sibling feeds beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The agent-logs directory is scanned with bounded
 *    lstat/read calls; nothing is written and no network is touched.
 *    Legacy .log files (the pre-.jsonl format, frozen) and lock files
 *    are not folded.
 *  - Recorded rows only. A row counts only under the writer's contract —
 *    schemaVersion 1, a parseable ts, a 64-hex runRef, an engine
 *    matching the writer's charset, boolean ok, errorClass in the
 *    writer's closed vocabulary, terminationReason in the persisted
 *    set when present, bounded durationMs/attempt/maxAttempts with
 *    attempt <= maxAttempts, optional bounded counters, and the
 *    output/error text shapes. Malformed lines are skipped, never
 *    guessed.
 *  - Recurring means recorded across days. A cell emits only at
 *    AGENTDIAG_MIN_ROWS adverse rows spanning AGENTDIAG_MIN_DAYS
 *    distinct UTC days inside the window, so one bad afternoon or a
 *    single misconfigured run never queues a session.
 *  - One outcome signal per failed invocation. When the stall monitor
 *    named an adverse termination (idle-stall, loop-stall,
 *    no-diff-stall) that verdict is the cell — it is the proximate
 *    cause; otherwise the recorded errorClass names the cell, with
 *    error-exit and unclassified as the residual buckets. Separately,
 *    an invocation that needed configRecoveryAttempts > 0 feeds the
 *    (engine, config-recovery) cell whether or not it ultimately
 *    succeeded — recurring mid-run config repair is its own signal.
 *  - Truncation is stated, never hidden. The scan is bounded by
 *    directory-entry, per-file and total byte caps; unread candidates
 *    and oversized files make every emitted count a lower bound the
 *    prompt names (the fleet-controller feed's convention).
 *  - Items emit only for the fleet's own repository — the journal
 *    carries no repo column and describes this install's engine
 *    invocations.
 *  - Dedup is downstream. The item id hashes the cell identity (engine
 *    + signal — never counts or timestamps), so a refresh re-derives
 *    the same id and appendUserBacklogItems adds only what is new; a
 *    gap that closes simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, engine strings are shape-bounded by the
 *    writer's contract, signal text is the closed vocabulary, and the
 *    brief carries the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { parseLedgerTs } from '../metrics/loop.js';
import {
  AGENT_DIAGNOSTIC_ERROR_CLASSES,
  AGENT_DIAGNOSTIC_TERMINATION_REASONS,
  agentDiagnosticsDir,
  type AgentDiagnosticErrorClass,
} from '../run/agent-diagnostics.js';
import type { TerminationReason } from '../run/run-monitor.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; cells are bounded by engine×signal diversity. */
export const AGENTDIAG_BACKLOG_MAX_ITEMS = 8;
const AGENTDIAG_ITEM_HARD_MAX = 25;
/** Evidence window: a week of invocations gives recurring failure modes room without letting stale evidence linger. */
export const AGENTDIAG_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Adverse rows one cell needs inside the window before it counts as recurring. */
export const AGENTDIAG_MIN_ROWS = 3;
/** Distinct UTC days those rows must span — recurring means recorded across days. */
export const AGENTDIAG_MIN_DAYS = 2;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Engine strings already match the writer's charset (64 chars, safe charset); flatten, scrub and cap at that bound. */
const MAX_ENGINE_CHARS = 64;
/** The fleet's own repository label: diagnostics evidence is this install's engine invocations, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** The writer's engine-name charset, mirrored from agent-diagnostics.ts's closed ENGINE_IDS (every EngineId matches it). */
const ENGINE_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;
/** The writer names each run's file <runRef>.jsonl where runRef is the sha256 hex of the run id. */
const DIAGNOSTIC_FILE_RE = /^[0-9a-f]{64}\.jsonl$/;
const RUN_REF_SHAPE = /^[0-9a-f]{64}$/;
/** Directory candidates stat'ed per call — the writer's own store cap is 4,096 entries. */
const MAX_DIR_CANDIDATES = 4_096;
/** Per-file read bound: twice the writer's 64 KiB file cap, so every writer-produced file reads whole. */
const FILE_READ_BYTES = 128 * 1024;
/** Total bytes read across all candidate files — newest first; exhaustion is stated as a lower bound. */
const TOTAL_READ_BYTES = 16 * 1024 * 1024;
/**
 * Termination reasons the stall monitor names as adverse endings. A
 * failed invocation carrying one of these keeps it as its cell signal —
 * the verdict is the proximate cause and beats the error text class.
 */
const STALL_REASONS: ReadonlySet<string> = new Set(['idle-stall', 'loop-stall', 'no-diff-stall']);
/** 'config-recovery' is the one signal that is not an outcome — it groups invocations that needed mid-run config repair. */
const CONFIG_RECOVERY_SIGNAL = 'config-recovery';

export interface AgentDiagnosticItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /**
   * Directory holding the per-run <runRef>.jsonl files; default
   * agentDiagnosticsDir() — $ASHLR_HOME/agent-logs when set, else
   * ~/.ashlr/agent-logs.
   */
  logsDir?: string;
  /** Evidence window in ms (default AGENTDIAG_WINDOW_MS). */
  windowMs?: number;
  /** Most items one call emits (default AGENTDIAG_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated diagnostic row: when the attempt ran, which engine, and the recorded outcome fields the fold consumes. */
export interface AgentDiagnosticRow {
  tsMs: number;
  /** UTC day (YYYY-MM-DD) of tsMs — the recurrence bar's day spread. */
  utcDay: string;
  engine: string;
  ok: boolean;
  errorClass: AgentDiagnosticErrorClass;
  /** The persisted termination verdict; null when the record carries none. */
  terminationReason: TerminationReason | null;
  /** Mid-run config-repair respawns the invocation needed (0 when absent). */
  configRecoveryAttempts: number;
}

/** One (engine, signal) cell: recurring adverse invocations plus the engine's total invocation context. */
export interface AgentDiagnosticCell {
  /** Sanitized recorded engine name. */
  engine: string;
  /**
   * The recurring signal: an adverse terminationReason when the stall
   * monitor named one, else the recorded errorClass, else 'error-exit'
   * or 'unclassified' — or 'config-recovery' for the repair axis.
   */
  signal: string;
  /** 'failure' cells group failed invocations; 'config-recovery' cells group invocations needing mid-run config repair. */
  kind: 'failure' | 'config-recovery';
  /** Adverse rows for this cell inside the window. */
  rows: number;
  /** Distinct UTC days those rows span. */
  days: number;
  /** All validated in-window diagnostic rows recorded for this engine — the denominator the prompt quotes. */
  engineRuns: number;
  /** Successful in-window rows for this engine. */
  engineOk: number;
  /** Failed in-window rows for this engine. */
  engineFailed: number;
  /** Total configRecoveryAttempts across the cell's rows (config-recovery cells only; 0 otherwise). */
  recoveryAttempts: number;
  /** ISO bounds of the cell's recorded rows. */
  firstSeen: string;
  lastSeen: string;
  /** True when the bounded scan left candidates unread: counts are a lower bound. */
  lowerBound: boolean;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Journal-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

/** The writer's boundedCounter: a finite non-negative number truncated to a safe integer, else undefined. */
function boundedCounter(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

/** The writer's positiveAttempt: a bounded counter in [1, 100]. */
function positiveAttempt(value: unknown): number | undefined {
  const count = boundedCounter(value);
  return count !== undefined && count >= 1 && count <= 100 ? count : undefined;
}

/** The writer's sanitizeShape invariant: {bytes, lines, present} with present === (bytes > 0) and lines consistent. */
function validTextShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const shape = value as Record<string, unknown>;
  const bytes = boundedCounter(shape['bytes']);
  const lines = boundedCounter(shape['lines']);
  if (bytes === undefined || lines === undefined || typeof shape['present'] !== 'boolean') return false;
  return shape['present'] === (bytes > 0) && (bytes === 0 ? lines === 0 : lines >= 1);
}

/**
 * Pure: one journal line → a validated row, or null when it fails the
 * writer's contract. Mirrors sanitizeRecord's emitted shape:
 * schemaVersion 1, parseable ts, 64-hex runRef, engine in the writer's
 * charset, boolean ok, errorClass in the closed vocabulary,
 * terminationReason in the persisted set when present, bounded
 * durationMs and attempt/maxAttempts with attempt <= maxAttempts,
 * optional bounded counters, and the output/error text shapes. Extra
 * fields are ignored for forward compatibility.
 */
export function parseAgentDiagnosticLine(line: string): AgentDiagnosticRow | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let value: unknown;
  try { value = JSON.parse(trimmed); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row['schemaVersion'] !== 1) return null;
  const tsMs = parseLedgerTs(row['ts']);
  if (tsMs === null) return null;
  const runRef = row['runRef'];
  if (typeof runRef !== 'string' || !RUN_REF_SHAPE.test(runRef)) return null;
  const engine = row['engine'];
  if (typeof engine !== 'string' || !ENGINE_SHAPE.test(engine)) return null;
  const ok = row['ok'];
  if (typeof ok !== 'boolean') return null;
  const errorClass = row['errorClass'];
  if (typeof errorClass !== 'string' || !AGENT_DIAGNOSTIC_ERROR_CLASSES.has(errorClass)) return null;
  const rawTerm = row['terminationReason'];
  let terminationReason: TerminationReason | null = null;
  if (rawTerm !== undefined) {
    if (typeof rawTerm !== 'string' || !AGENT_DIAGNOSTIC_TERMINATION_REASONS.has(rawTerm)) return null;
    terminationReason = rawTerm as TerminationReason;
  }
  if (boundedCounter(row['durationMs']) === undefined) return null;
  const attempt = positiveAttempt(row['attempt']);
  const maxAttempts = positiveAttempt(row['maxAttempts']);
  if (attempt === undefined || maxAttempts === undefined || attempt > maxAttempts) return null;
  for (const key of ['configRecoveryAttempts', 'tokensIn', 'tokensOut'] as const) {
    const counter = row[key];
    if (counter !== undefined && boundedCounter(counter) === undefined) return null;
  }
  if (!validTextShape(row['output']) || !validTextShape(row['error'])) return null;
  return {
    tsMs,
    utcDay: new Date(tsMs).toISOString().slice(0, 10),
    engine,
    ok,
    errorClass: errorClass as AgentDiagnosticErrorClass,
    terminationReason,
    configRecoveryAttempts: boundedCounter(row['configRecoveryAttempts']) ?? 0,
  };
}

/**
 * Pure: the validated diagnostic rows of one file's text. Contract rows
 * outside the window are skipped silently; malformed or off-contract
 * lines are counted, never guessed.
 */
export function parseAgentDiagnosticRows(
  text: string,
  cutoffMs: number,
  nowMs: number,
): { rows: AgentDiagnosticRow[]; invalid: number } {
  const rows: AgentDiagnosticRow[] = [];
  let invalid = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = parseAgentDiagnosticLine(line);
    if (row === null) { invalid += 1; continue; }
    if (row.tsMs < cutoffMs || row.tsMs > nowMs) continue;
    rows.push(row);
  }
  return { rows, invalid };
}

/**
 * Pure: the outcome signal one failed invocation feeds. A stall-monitor
 * verdict (idle-stall, loop-stall, no-diff-stall) is the proximate cause
 * and wins over the error text class; otherwise the recorded errorClass
 * names the failure, with error-exit and unclassified as residual
 * buckets. 'clean-exit' on a failed row contradicts the record and lands
 * in unclassified rather than being guessed.
 */
function outcomeSignal(row: AgentDiagnosticRow): string {
  const term = row.terminationReason;
  if (term !== null && STALL_REASONS.has(term)) return term;
  if (row.errorClass !== 'none') return row.errorClass;
  if (term === 'backstop-timeout' || term === 'error-exit') return term;
  return 'unclassified';
}

/**
 * Pure: fold validated diagnostic rows into per-(engine, signal) cells.
 * Successful rows never form failure cells but count toward each
 * engine's invocation totals — the denominator the prompts quote — and
 * any row with configRecoveryAttempts > 0 feeds the config-recovery
 * cell whether or not it succeeded. A cell carries its UTC-day spread
 * so the recurring bar can require recurrence across days.
 */
export function foldAgentDiagnosticCells(rows: readonly AgentDiagnosticRow[], lowerBound = false): AgentDiagnosticCell[] {
  const cells = new Map<string, {
    engine: string;
    signal: string;
    kind: 'failure' | 'config-recovery';
    rows: number;
    days: Set<string>;
    recoveryAttempts: number;
    firstMs: number;
    lastMs: number;
  }>();
  const engineRuns = new Map<string, number>();
  const engineOk = new Map<string, number>();
  const engineFailed = new Map<string, number>();
  const add = (engine: string, signal: string, kind: 'failure' | 'config-recovery', row: AgentDiagnosticRow, recovery: number): void => {
    const key = `${engine} ${signal}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = { engine, signal, kind, rows: 0, days: new Set(), recoveryAttempts: 0, firstMs: row.tsMs, lastMs: row.tsMs };
      cells.set(key, cell);
    }
    cell.rows += 1;
    cell.days.add(row.utcDay);
    cell.recoveryAttempts += recovery;
    cell.firstMs = Math.min(cell.firstMs, row.tsMs);
    cell.lastMs = Math.max(cell.lastMs, row.tsMs);
  };
  for (const row of rows) {
    const engine = fieldText(row.engine, MAX_ENGINE_CHARS) || 'unknown';
    engineRuns.set(engine, (engineRuns.get(engine) ?? 0) + 1);
    if (row.ok) engineOk.set(engine, (engineOk.get(engine) ?? 0) + 1);
    else engineFailed.set(engine, (engineFailed.get(engine) ?? 0) + 1);
    if (row.configRecoveryAttempts > 0) {
      add(engine, CONFIG_RECOVERY_SIGNAL, 'config-recovery', row, row.configRecoveryAttempts);
    }
    if (row.ok) continue;
    add(engine, outcomeSignal(row), 'failure', row, 0);
  }
  return [...cells.values()]
    .map((cell) => ({
      engine: cell.engine,
      signal: cell.signal,
      kind: cell.kind,
      rows: cell.rows,
      days: cell.days.size,
      engineRuns: engineRuns.get(cell.engine) ?? 0,
      engineOk: engineOk.get(cell.engine) ?? 0,
      engineFailed: engineFailed.get(cell.engine) ?? 0,
      recoveryAttempts: cell.recoveryAttempts,
      firstSeen: new Date(cell.firstMs).toISOString(),
      lastSeen: new Date(cell.lastMs).toISOString(),
      lowerBound,
    }))
    .sort((a, b) => b.rows - a.rows || a.engine.localeCompare(b.engine) || a.signal.localeCompare(b.signal));
}

/** What each recorded signal means at the invocation — the failure mode the cell groups on. */
const SIGNAL_TEXT: Record<string, string> = {
  'authentication': 'the engine\'s credentials were rejected or missing',
  'configuration': 'the engine\'s config or flags were invalid or pointed at something absent',
  'command-missing': 'the engine binary or command was not found',
  'rate-limit': 'the provider rate-limited the invocation',
  'timeout': 'the invocation timed out',
  'terminated': 'the invocation was killed or terminated externally',
  'execution': 'the invocation failed with an unclassified execution error',
  'idle-stall': 'the run-monitor idle detector fired — the agent went quiet',
  'loop-stall': 'the loop detector fired — the agent repeated itself',
  'no-diff-stall': 'the no-diff detector fired — the run produced no changes',
  'backstop-timeout': 'the run hit its wall-clock backstop',
  'error-exit': 'the engine process exited nonzero with no classed error',
  'unclassified': 'the invocation failed without a classed error or adverse termination',
  'config-recovery': 'the engine needed mid-run config-repair respawns',
};

const NO_CHANGE = 'If the window has rolled forward, the failures were a one-off burst the fleet recovered from, the error classes reflect provider-side outages or owner-side credential and config state no repository change can fix — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the reasoning-store-only gap is named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is the agent-logs directory of the Phantom state home ($ASHLR_HOME/agent-logs, else ~/.ashlr/agent-logs) — one <runRef>.jsonl per run, each line a fixed-schema diagnostic record recordAgentDiagnostic in src/core/run/agent-diagnostics.ts writes once per engine retry attempt from the sandboxed engine path in src/core/run/sandboxed-engine.ts: schemaVersion, ts, runRef (the run id hashed — never the id itself), engine, ok, terminationReason, errorClass, durationMs, attempt/maxAttempts, optional configRecoveryAttempts and token counts, and output/error reduced to byte/line/present shapes. Files cap at 64 KiB, the store at 2,000 files with a 30-day TTL. Until this feed the journal\'s only reader was ingestFleetAgentLogs (src/core/reasoning/ingest-fleet.ts), which folds rows into the reasoning store\'s TurnFeatures — a projection no backlog source reads — so recurring per-engine failure modes never became work.';

interface Coverage {
  invalidRows: number;
  unreadableFiles: number;
}

function coverageNote(coverage: Coverage): string {
  const notes: string[] = [];
  if (coverage.invalidRows > 0) notes.push(`${coverage.invalidRows} malformed or off-contract lines dropped`);
  if (coverage.unreadableFiles > 0) notes.push(`${coverage.unreadableFiles} diagnostic file(s) unreadable`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

function seenText(cell: AgentDiagnosticCell): string {
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function boundText(cell: AgentDiagnosticCell): string {
  return cell.lowerBound ? ' The directory scan hit its read bound, so these counts are a lower bound.' : '';
}

function failurePrompt(cell: AgentDiagnosticCell, coverage: Coverage): string {
  const context = ` — ${cell.engineFailed} of ${cell.engineRuns} recorded in-window invocations for that engine failed, ${cell.engineOk} succeeded`;
  return [
    `Phantom's agent invocations keep failing the same way — ${cell.rows} recorded '${cell.signal}' failure(s) for engine '${cell.engine}' across ${cell.days} UTC day(s) inside the window${context}, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one retry attempt recordAgentDiagnostic persisted: ${SIGNAL_TEXT[cell.signal] ?? 'the recorded signal'}${seenText(cell)}${boundText(cell)}${coverageNote(coverage)}`,
    '',
    EVIDENCE,
    '',
    `The diagnostics store and the sandboxed engine path are this repository's — src/core/run/agent-diagnostics.ts owns the record and src/core/run/sandboxed-engine.ts owns the retry loop, stall monitors and config recovery — while provider credentials, rate limits and host state are owner-side. What this repository owns is everything between the engine's raw failure and the recorded class: the error classifier's coverage, the stall detectors' thresholds, the retry and config-recovery machinery, and the engine adapters' failure modes.`,
    '',
    `Find why engine '${cell.engine}' keeps recording '${cell.signal}': join the engine adapter, the stall monitor and the classifier that produced the signal and check whether the cause is a coverage gap, a threshold, a retry policy or an adapter defect this repository owns — or report no-change naming provider-side or owner-side causes. ${NO_CHANGE}`,
  ].join('\n');
}

function recoveryPrompt(cell: AgentDiagnosticCell, coverage: Coverage): string {
  const context = ` — ${cell.engineFailed} of ${cell.engineRuns} recorded in-window invocations for that engine failed, ${cell.engineOk} succeeded`;
  return [
    `Phantom's agent invocations keep needing mid-run config recovery — ${cell.rows} recorded invocation(s) for engine '${cell.engine}' needed ${cell.recoveryAttempts} total config-repair respawn(s) across ${cell.days} UTC day(s) inside the window${context}, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one retry attempt recordAgentDiagnostic persisted whose engine result reported configRecoveryAttempts above zero: ${SIGNAL_TEXT[CONFIG_RECOVERY_SIGNAL]}${seenText(cell)}${boundText(cell)}${coverageNote(coverage)}`,
    '',
    EVIDENCE,
    '',
    `The diagnostics store and the sandboxed engine path are this repository's — src/core/run/agent-diagnostics.ts owns the record and src/core/run/sandboxed-engine.ts owns the retry loop and the config-recovery machinery that produces these respawns — while provider credentials, installed engine versions and host config are owner-side. What this repository owns is the recovery path itself: which config faults trigger a respawn, whether the repair is durable or repeats every run, and whether the engine adapters hand it a fixable cause.`,
    '',
    `Find why engine '${cell.engine}' keeps needing config recovery: join the config-recovery path in the sandboxed engine and the engine adapter that reports it, and check whether the cause is a repair that never sticks, a missing preflight check, or an adapter defect this repository owns — or report no-change naming owner-side causes. ${NO_CHANGE}`,
  ].join('\n');
}

function agentDiagnosticItem(cell: AgentDiagnosticCell, repo: string, coverage: Coverage): CloudBacklogItem {
  const id = `fleet-agentdiag-${createHash('sha256').update(`agentdiag:${cell.engine}:${cell.signal}`).digest('hex').slice(0, 16)}`;
  const title = cell.kind === 'config-recovery'
    ? `Engine '${cell.engine}' keeps needing agent config recovery`
    : `Engine '${cell.engine}' keeps failing agent invocations (${cell.signal})`;
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: cell.kind === 'config-recovery' ? recoveryPrompt(cell, coverage) : failurePrompt(cell, coverage),
    area: 'agent-diagnostics',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the agent-invocation diagnostics journal's recurring
 * (engine, signal) cells. Total: any read or fold failure yields no
 * items rather than throwing into discovery.
 */
export async function agentDiagnosticsBacklogItems(opts: AgentDiagnosticItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const dir = typeof opts.logsDir === 'string' && opts.logsDir !== '' ? opts.logsDir : agentDiagnosticsDir();
    const nowMs = (opts.now ?? new Date()).getTime();
    const cutoffMs = nowMs - (opts.windowMs ?? AGENTDIAG_WINDOW_MS);

    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }

    // Candidates are the writer's per-run <runRef>.jsonl files only —
    // legacy .log files, lock files and anything else are not folded.
    // A file's mtime bounds every row's ts (the record is stamped before
    // its append), so a file last written before the cutoff cannot hold
    // an in-window row and is skipped without a read.
    const matched = names.filter((name) => DIAGNOSTIC_FILE_RE.test(name));
    const scanTruncated = matched.length > MAX_DIR_CANDIDATES;
    if (scanTruncated) matched.length = MAX_DIR_CANDIDATES;
    const candidates: { path: string; mtimeMs: number }[] = [];
    let unreadableFiles = 0;
    for (const name of matched) {
      const path = join(dir, name);
      let stat;
      try {
        stat = await lstat(path);
      } catch (error) {
        // A file that vanished between readdir and lstat is a non-event;
        // anything else unreadable is stated, never guessed.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadableFiles += 1;
        continue;
      }
      if (!stat.isFile() || stat.mtimeMs < cutoffMs) continue;
      candidates.push({ path, mtimeMs: stat.mtimeMs });
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));

    const rows: AgentDiagnosticRow[] = [];
    let invalidRows = 0;
    let truncated = scanTruncated;
    let totalBytes = 0;
    for (const candidate of candidates) {
      if (totalBytes >= TOTAL_READ_BYTES) {
        truncated = true;
        break;
      }
      const read = await readLedgerTail(candidate.path, FILE_READ_BYTES);
      if (read.state !== 'read') {
        if (read.state !== 'missing') unreadableFiles += 1;
        continue;
      }
      totalBytes += Buffer.byteLength(read.text, 'utf8');
      if (read.truncated) truncated = true;
      const parsed = parseAgentDiagnosticRows(read.text, cutoffMs, nowMs);
      rows.push(...parsed.rows);
      invalidRows += parsed.invalid;
    }
    if (rows.length === 0) return [];

    const cells = foldAgentDiagnosticCells(rows, truncated)
      .filter((cell) => cell.rows >= AGENTDIAG_MIN_ROWS && cell.days >= AGENTDIAG_MIN_DAYS);
    if (cells.length === 0) return [];

    const limit = Math.max(1, Math.min(opts.limit ?? AGENTDIAG_BACKLOG_MAX_ITEMS, AGENTDIAG_ITEM_HARD_MAX));
    const coverage: Coverage = { invalidRows, unreadableFiles };
    return cells.slice(0, limit).map((cell) => agentDiagnosticItem(cell, repo, coverage));
  } catch {
    return [];
  }
}
