/**
 * Outcome learning for the shared fleet pool.
 *
 * The dispatch log is the memory. Each finished job updates a posterior for
 * (resource, model, job type, repo): merge rate, time to merge, usage, and
 * main-breakage rate. The next assignment is a Thompson draw over those
 * posteriors, so a cold resource is still tried, and the draw prefers the
 * cheapest resource that actually ships. Allowance that can be spent before
 * it resets still wins when that resource can finish the job. A critical job
 * is never held for an exhausted or too-thin resource.
 *
 * Nothing here is an operator setting. Thresholds fall out of the counts in
 * the log. This module does not read the home directory, spend, or merge.
 */
import { betaSample, createSeededRng, gammaSample, type BanditRng } from './bandit.js';
import { ledgerAtMs, ledgerEventName, ledgerJobId, ledgerLane, ledgerPhase } from '../fleet/empty-cause.js';
import { isNodePoolLedgerRow, ledgerEventTs, ledgerLifecycleEvent, ledgerOutcomeState } from '../fleet/jobs-ledger-dialect.js';
import { hasRevertEvidence } from '../fleet/slot-yield.js';
import type { MergeQueueEvidence } from '../router/outcomes.js';

export const OUTCOME_LEARNING_SCHEMA = 'routing.outcome-learning.v1' as const;

/** Three failures is the smallest run that is more than a pair of coincidences. */
const RECURRING_FAILURES = 3;

export type ImprovementPattern = 'breakage' | 'dirty' | 'fixup' | 'low-merge';
export type LearnedPriority = 'critical' | 'normal';
export type LearnedAction = 'dispatch' | 'wait' | 'nowhere';

export interface OutcomeCellView {
  resource: string;
  model: string;
  jobType: string;
  repo: string;
  attempts: number;
  /** Attempts counted as failures because the PR sat unmerged past the horizon. Included in `attempts`. */
  censored: number;
  /**
   * Attempts whose merge was recorded as reverted — the merge did not hold.
   * Counted in `attempts` as a failure, never in `merges` or `goodMerges`;
   * only the jobs-ledger dialect produces them — in-ledger revert evidence
   * plus merges the improve/revert-outcomes.jsonl scan ledger stands as
   * reverted through the verdict row's unambiguous PR claim (the dispatch
   * log has no revert signal). Zero when no revert evidence was recorded.
   */
  reverted: number;
  merges: number;
  /** Merges that did not break main. This is what routing treats as success. */
  goodMerges: number;
  breakages: number;
  /**
   * Attempts with recorded dirty evidence: the dispatch log's exclusive
   * `dirty` outcome state, plus jobs-ledger attempts whose own PR recorded
   * merge-queue conflicts, recuts or a conflict block (`mergeDirty`).
   */
  dirty: number;
  /**
   * Attempts with recorded fix-up evidence: the dispatch log's exclusive
   * `fixup` outcome state, plus jobs-ledger attempts whose own PR recorded
   * required-check failures or failed retries (`mergeFixup`).
   */
  fixups: number;
  usage: number;
  /**
   * Sum of the measured usage readings in the dispatch log's allowance unit
   * (the `usage=` field, roughly 0.04-1.2 per job). Jobs-ledger
   * `tokens_total` readings are a different unit and never land here, and
   * neither do the imputed charges reconcileUsage and the censor add for
   * attempts that carried no reading.
   */
  usageAllowance: number;
  /** Attempts that contributed a measured allowance-unit usage reading. */
  usageAllowanceKnown: number;
  mergeRate: number;
  goodMergeRate: number;
  breakageRate: number;
  dirtyRate: number;
  fixupRate: number;
  meanUsage: number;
  meanMinutesToMerge: number | null;
}

export interface ImprovementJob {
  id: string;
  repo: string;
  jobType: string;
  pattern: ImprovementPattern;
  resource: string;
  model: string;
  title: string;
  task: string;
  attempts: number;
  rate: number;
}

export interface OutcomeLearningView {
  schema: typeof OUTCOME_LEARNING_SCHEMA;
  finished: number;
  malformed: number;
  cells: OutcomeCellView[];
  improvementJobs: ImprovementJob[];
}

export interface OutcomeLearning {
  readonly finished: number;
  readonly malformed: number;
  readonly cells: readonly OutcomeCellView[];
}

export interface ResourceOffer {
  resource: string;
  model: string;
  /** 0–100. Null means the reading is unknown, not empty. */
  usageLeftPercent: number | null;
  /** ISO instant the current allowance resets. Null means no known reset. */
  resetAt: string | null;
  slots: number;
  exhausted?: boolean;
}

export interface LearnedJob {
  id: string;
  repo: string;
  jobType: string;
  priority: LearnedPriority;
}

/**
 * Censored reward. An assignment with no outcome yet is pending. Once it is
 * older than the horizon it is read as a failed attempt (reward 0, allowance
 * spent) instead of missing data. See docs/router/censored-reward.md.
 */
export interface CensorOptions {
  nowMs: number;
  /** Minutes an unresolved assignment may stay pending. Absent derives it from the log. */
  horizonMinutes?: number;
}

/** The `router` slice of the config that switches censoring on. */
export interface CensorConfig {
  censorUnmerged?: boolean;
  censorHorizonHours?: number;
}

export interface RouteLearningOptions {
  nowMs: number;
  /** Thompson sampling. Absent still explores, so a cold resource can be tried. */
  explore?: boolean;
}

export interface LearnedRoute {
  action: LearnedAction;
  resource: string | null;
  model: string | null;
  explanation: string;
  /** True when the Thompson draw disagreed with the posterior mean. */
  explored: boolean;
  score: number | null;
}

interface Cell extends OutcomeCellView {
  mergeMinutes: number;
  timedMerges: number;
  /** Attempts whose usage was measured or estimated. Internal to the fold; the view reports usage/attempts. */
  usageAttempts: number;
}

interface AssignEvent {
  kind: 'assign';
  job: string;
  resource: string;
  model: string;
  jobType: string;
  repo: string;
  atMs: number;
}

interface OutcomeEvent {
  kind: 'outcome';
  job: string;
  /**
   * 'reverted' is jobs-ledger-only: a merge verdict contradicted by revert
   * evidence recorded at or after it, or an open attempt carrying post-launch
   * revert evidence. It counts as a failed attempt — the merge did not hold —
   * and lands in the cell's `reverted` count.
   */
  state: 'merged' | 'closed' | 'dirty' | 'fixup' | 'reverted';
  /** Measured allowance spent. Null when the outcome carried no usage reading — never zeroed. */
  usage: number | null;
  /**
   * Unit of the usage reading. Absent means the dispatch log's allowance
   * unit; 'tokens' marks jobs-ledger `tokens_total` readings, which run in
   * the thousands and must never feed consumers calibrated to the
   * allowance unit.
   */
  usageUnit?: 'allowance' | 'tokens';
  minutes: number | null;
  breakage: number;
  /**
   * Merge-queue friction the attempt's own PR recorded, joined through the
   * verdict row's unambiguous PR claim against the merge-events fold:
   * `mergeDirty` marks recorded conflict/recut/blocked-on-conflict evidence
   * and `mergeFixup` recorded required-check or retry-failure evidence.
   * Additive like `breakage` — they never replace the attempt's state, so a
   * merged attempt can carry both and still count its merge. Only the
   * jobs-ledger dialect sets them; the dispatch log has no merge-queue
   * signal.
   */
  mergeDirty?: boolean;
  mergeFixup?: boolean;
}

type ParsedEvent = AssignEvent | OutcomeEvent;

const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** RQ-BATCH-* session ids are dispatch infrastructure, never task attempts. */
const BATCH_SESSION_PREFIX = 'RQ-BATCH-';
/** batcher.RETRY — per-line batch outcomes that requeue the member without a publish, so the attempt is dead. */
const BATCH_RETRY_OUTCOMES: ReadonlySet<string> = new Set(['failed', 'deferred', 'unreported']);
/** PR URL spellings the jobs ledger and its reconciler rows carry (router/outcomes.ts reads the same set). */
const PR_URL_KEYS = ['url', 'pr_url', 'prUrl', 'pr'] as const;
/** A github.com pull URL in the canonical shape dispatchd and the fleet writers emit (same grammar router/outcomes.ts applies). */
const GITHUB_PULL_URL = /^https:\/\/github\.com\/([^/?#\s]+)\/([^/?#\s]+)\/pull\/([1-9]\d*)\/?$/i;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const STAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (\S+)(?: (.*))?$/;
const RESOURCE_WORDS: Readonly<Record<string, string>> = {
  'codex-cmp': 'CMP Codex',
  'codex-personal': 'personal Codex',
  devin: 'Devin',
  claude: 'Claude',
  'local-omlx': 'local oMLX',
  'grok-build': 'Grok',
  'grok-ultra': 'Grok Ultra',
  'claude-api': 'Claude API',
};
const MODEL_WORDS: Readonly<Record<string, string>> = {
  'swe-2-max': 'SWE-2 Max',
  'swe-2-max-lightning': 'SWE-2 Max Lightning',
  'kimi-k3': 'Kimi K3',
  haiku: 'Haiku',
  sonnet: 'Sonnet',
  opus: 'Opus',
  'gpt-5.4': 'GPT-5.4',
};
const PATTERN_ORDER: Readonly<Record<ImprovementPattern, number>> = {
  breakage: 0,
  dirty: 1,
  fixup: 2,
  'low-merge': 3,
};

function ident(value: unknown): value is string {
  return typeof value === 'string' && IDENT.test(value) && !value.includes('..');
}

export function resourceWords(resource: string): string {
  return RESOURCE_WORDS[resource] ?? resource.replace(/[-_]+/g, ' ');
}

export function modelWords(model: string): string {
  return MODEL_WORDS[model] ?? model.replace(/[-_]+/g, ' ');
}

function eventMs(date: string, clock: string): number {
  if (!CLOCK.test(clock)) return NaN;
  const iso = `${date}T${clock}Z`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== `${date}T${clock}`) return NaN;
  return ms;
}

function finiteNumber(value: unknown, max = 1e12): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
}

function normalizeState(value: unknown): OutcomeEvent['state'] | null {
  if (typeof value !== 'string') return null;
  switch (value.toLowerCase().replace(/_/g, '-')) {
    case 'merged':
    case 'merge':
      return 'merged';
    case 'closed':
    case 'close':
      return 'closed';
    case 'dirty':
      return 'dirty';
    case 'fixup':
    case 'fix-up':
      return 'fixup';
    default:
      return null;
  }
}

function splitFields(rest: string): { positional: string[]; kv: Record<string, string> } | null {
  const positional: string[] = [];
  const kv: Record<string, string> = {};
  for (const token of rest.split(/\s+/).filter(Boolean)) {
    const eq = token.indexOf('=');
    if (eq === -1) {
      if (Object.keys(kv).length > 0) return null;
      positional.push(token);
      continue;
    }
    const key = token.slice(0, eq);
    const raw = token.slice(eq + 1);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || raw === '' || raw.length > 80 || Object.hasOwn(kv, key)) return null;
    kv[key] = raw;
  }
  return { positional, kv };
}

function pickIdent(kv: Record<string, string>, positional: string[], index: number, ...keys: string[]): string | null {
  for (const key of keys) {
    if (Object.hasOwn(kv, key)) return ident(kv[key]) ? kv[key]! : null;
  }
  const value = positional[index];
  return ident(value) ? value! : null;
}

function assignFrom(fields: { positional: string[]; kv: Record<string, string> }, atMs: number): AssignEvent | null {
  const job = pickIdent(fields.kv, fields.positional, 0, 'job');
  const repo = pickIdent(fields.kv, fields.positional, 1, 'repo');
  const resource = pickIdent(fields.kv, fields.positional, 2, 'resource');
  const model = pickIdent(fields.kv, fields.positional, 3, 'model');
  const jobType = pickIdent(fields.kv, fields.positional, 4, 'jobType', 'type');
  if (!job || !repo || !resource || !model || !jobType) return null;
  return { kind: 'assign', job, repo, resource, model, jobType, atMs };
}

function outcomeFrom(fields: { positional: string[]; kv: Record<string, string> }): OutcomeEvent | null {
  const job = pickIdent(fields.kv, fields.positional, 0, 'job');
  const state = normalizeState(fields.kv['state'] ?? fields.kv['outcome'] ?? fields.positional[1]);
  const usage = finiteNumber(fields.kv['usage']);
  const minutes = fields.kv['minutes'] === undefined ? null : finiteNumber(fields.kv['minutes'], 1e7);
  const breakage = fields.kv['breakage'] === undefined ? 0 : finiteNumber(fields.kv['breakage'], 1);
  if (!job || !state || usage === null || breakage === null || (breakage !== 0 && breakage !== 1)) return null;
  if (fields.kv['minutes'] !== undefined && minutes === null) return null;
  return { kind: 'outcome', job, state, usage, minutes, breakage };
}

function jsonRecord(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringField(row: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function jsonEvent(row: Record<string, unknown>): ParsedEvent | null {
  const event = (stringField(row, 'event', 'kind', 'type') ?? '').toLowerCase();
  const kv: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'string' || typeof value === 'number') kv[key] = String(value);
  }
  if (event === 'assign' || event === 'assigned' || event === 'launch' || event === 'launched') {
    return assignFrom({ positional: [], kv }, Date.parse(String(row['ts'])));
  }
  if (event === 'outcome' || event === 'result' || event === 'resolved') {
    return outcomeFrom({ positional: [], kv });
  }
  return null;
}

function parseEvents(text: string): { events: ParsedEvent[]; malformed: number } {
  const events: ParsedEvent[] = [];
  let malformed = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('{')) {
      const row = jsonRecord(trimmed);
      const event = row ? jsonEvent(row) : null;
      if (!row || !event || !Number.isFinite(Date.parse(String(row['ts'] ?? '')))) malformed += 1;
      else events.push(event);
      continue;
    }
    const match = STAMP.exec(trimmed);
    if (!match || !Number.isFinite(eventMs(match[1]!, match[2]!))) {
      malformed += 1;
      continue;
    }
    const kind = match[3]!.toUpperCase();
    if (kind !== 'ASSIGN' && kind !== 'LAUNCH' && kind !== 'OUTCOME') continue;
    const fields = splitFields(match[4] ?? '');
    if (!fields) {
      malformed += 1;
      continue;
    }
    // Older launch lines are `LAUNCH job repo lane tier`. They are not this
    // loop's assignments, and a real dispatch log is full of them.
    if (kind !== 'OUTCOME' && fields.positional.length < 5
      && !Object.hasOwn(fields.kv, 'resource') && !Object.hasOwn(fields.kv, 'model')) continue;
    const event = kind === 'OUTCOME' ? outcomeFrom(fields) : assignFrom(fields, eventMs(match[1]!, match[2]!));
    if (!event) malformed += 1;
    else events.push(event);
  }
  return { events, malformed };
}

function blankCell(resource: string, model: string, jobType: string, repo: string): Cell {
  return {
    resource, model, jobType, repo,
    attempts: 0, censored: 0, reverted: 0, merges: 0, goodMerges: 0, breakages: 0, dirty: 0, fixups: 0,
    usage: 0, usageAllowance: 0, usageAllowanceKnown: 0, mergeMinutes: 0, timedMerges: 0, usageAttempts: 0,
    mergeRate: 0, goodMergeRate: 0, breakageRate: 0, dirtyRate: 0, fixupRate: 0,
    meanUsage: 0, meanMinutesToMerge: null,
  };
}

function cellKey(resource: string, model: string, jobType: string, repo: string): string {
  return `${resource}\0${model}\0${jobType}\0${repo}`;
}

function publish(cell: Cell): OutcomeCellView {
  const attempts = cell.attempts;
  const { mergeMinutes, timedMerges, usageAttempts: _usageAttempts, ...view } = cell;
  return {
    ...view,
    mergeRate: attempts > 0 ? cell.merges / attempts : 0,
    goodMergeRate: attempts > 0 ? cell.goodMerges / attempts : 0,
    breakageRate: attempts > 0 ? cell.breakages / attempts : 0,
    dirtyRate: attempts > 0 ? cell.dirty / attempts : 0,
    fixupRate: attempts > 0 ? cell.fixups / attempts : 0,
    meanUsage: attempts > 0 ? cell.usage / attempts : 0,
    meanMinutesToMerge: timedMerges > 0 ? mergeMinutes / timedMerges : null,
  };
}

/** A day. The merge queue is not instant, so a younger unresolved PR is still pending. */
const CENSOR_FLOOR_MINUTES = 24 * 60;
/** Twice the slowest ordinary merge: past that, waiting longer is not going to merge it. */
const CENSOR_SLACK = 2;

/**
 * The horizon H, from the log: twice the 95th percentile (nearest rank) of the
 * minutes-to-merge of merged jobs, never under one day. With no timed merges it
 * is the floor.
 */
function derivedCensorHorizon(events: readonly ParsedEvent[]): number {
  const minutes = events
    .filter((e): e is OutcomeEvent => e.kind === 'outcome' && e.state === 'merged' && e.minutes !== null)
    .map((e) => e.minutes!)
    .sort((a, b) => a - b);
  if (minutes.length === 0) return CENSOR_FLOOR_MINUTES;
  const p95 = minutes[Math.max(0, Math.ceil(0.95 * minutes.length) - 1)]!;
  return Math.max(CENSOR_FLOOR_MINUTES, CENSOR_SLACK * p95);
}

/** Turn the router config into censor options. Off unless `censorUnmerged` is exactly true. */
export function censorFromConfig(router: CensorConfig | undefined, nowMs: number): CensorOptions | undefined {
  if (router?.censorUnmerged !== true) return undefined;
  const hours = router.censorHorizonHours;
  const horizonMinutes = typeof hours === 'number' && Number.isFinite(hours) && hours > 0 ? hours * 60 : undefined;
  return { nowMs, ...(horizonMinutes === undefined ? {} : { horizonMinutes }) };
}

function fold(events: readonly ParsedEvent[], malformed: number, censor?: CensorOptions): OutcomeLearning {
  const cells = new Map<string, Cell>();
  const open = new Map<string, AssignEvent>();
  let finished = 0;
  for (const event of events) {
    if (event.kind === 'assign') {
      open.set(event.job, event);
      continue;
    }
    const assign = open.get(event.job);
    if (!assign) {
      malformed += 1;
      continue;
    }
    open.delete(event.job);
    const key = cellKey(assign.resource, assign.model, assign.jobType, assign.repo);
    const cell = cells.get(key) ?? blankCell(assign.resource, assign.model, assign.jobType, assign.repo);
    cell.attempts += 1;
    if (event.usage !== null) {
      cell.usage += event.usage;
      cell.usageAttempts += 1;
      if (event.usageUnit !== 'tokens') {
        cell.usageAllowance += event.usage;
        cell.usageAllowanceKnown += 1;
      }
    }
    switch (event.state) {
      case 'merged':
        cell.merges += 1;
        if (event.breakage === 0) cell.goodMerges += 1;
        if (event.minutes !== null) {
          cell.mergeMinutes += event.minutes;
          cell.timedMerges += 1;
        }
        break;
      case 'closed':
        break;
      case 'reverted':
        cell.reverted += 1;
        break;
      case 'dirty':
        cell.dirty += 1;
        break;
      case 'fixup':
        cell.fixups += 1;
        break;
      default: {
        const neverState: never = event.state;
        void neverState;
        break;
      }
    }
    if (event.breakage === 1) cell.breakages += 1;
    // Merge-queue friction is additive evidence, not a state: a merged
    // attempt whose PR recorded conflicts counts its merge AND its dirty
    // friction, exactly like a breakage=1 merge counts both.
    if (event.mergeDirty === true) cell.dirty += 1;
    if (event.mergeFixup === true) cell.fixups += 1;
    if (!Number.isSafeInteger(cell.attempts) || !Number.isFinite(cell.usage)) {
      malformed += 1;
      continue;
    }
    cells.set(key, cell);
    finished += 1;
  }
  reconcileUsage(cells);
  if (censor !== undefined && Number.isFinite(censor.nowMs)) {
    finished += censorStale(cells, open, events, censor);
  }
  return {
    finished,
    malformed,
    cells: [...cells.values()].map(publish).sort((a, b) =>
      b.attempts - a.attempts || a.resource.localeCompare(b.resource) || a.model.localeCompare(b.model)
      || a.jobType.localeCompare(b.jobType) || a.repo.localeCompare(b.repo)),
  };
}

/**
 * Count each assignment still unresolved past the horizon as one failed attempt
 * in its cell. Younger ones stay pending and are not counted. The allowance a
 * censored attempt spent is unknown, so it is charged the mean of its cell's
 * finished attempts (the fleet mean for a cell with none): that keeps a lane
 * from looking cheap because its PRs never reported a cost. Merged scoring is
 * untouched. Returns how many attempts were added.
 */
function censorStale(
  cells: Map<string, Cell>,
  open: ReadonlyMap<string, AssignEvent>,
  events: readonly ParsedEvent[],
  censor: CensorOptions,
): number {
  const horizon = censor.horizonMinutes !== undefined && Number.isFinite(censor.horizonMinutes) && censor.horizonMinutes > 0
    ? censor.horizonMinutes
    : derivedCensorHorizon(events);
  const stale = new Map<string, { assign: AssignEvent; count: number }>();
  for (const assign of open.values()) {
    if (!((censor.nowMs - assign.atMs) / 60_000 > horizon)) continue;
    const key = cellKey(assign.resource, assign.model, assign.jobType, assign.repo);
    const entry = stale.get(key) ?? { assign, count: 0 };
    entry.count += 1;
    stale.set(key, entry);
  }
  let fleetUsage = 0;
  let fleetAttempts = 0;
  for (const cell of cells.values()) {
    fleetUsage += cell.usage;
    fleetAttempts += cell.attempts;
  }
  const fleetMean = fleetAttempts > 0 ? fleetUsage / fleetAttempts : 0;
  let added = 0;
  for (const [key, { assign, count }] of stale) {
    const cell = cells.get(key) ?? blankCell(assign.resource, assign.model, assign.jobType, assign.repo);
    const mean = cell.attempts > 0 ? cell.usage / cell.attempts : fleetMean;
    cell.attempts += count;
    cell.censored += count;
    cell.usage += mean * count;
    cell.usageAttempts += count;
    cells.set(key, cell);
    added += count;
  }
  return added;
}

/**
 * Charge each finished attempt whose outcome carried no usage reading the mean
 * of the attempts that did report one — the cell's own mean, else the fleet's.
 * When no attempt anywhere reported usage there is no measured cost to
 * project, so nothing is added: missing readings never read as zero spend.
 */
function reconcileUsage(cells: Map<string, Cell>): void {
  let fleetUsage = 0;
  let fleetMeasured = 0;
  for (const cell of cells.values()) {
    fleetUsage += cell.usage;
    fleetMeasured += cell.usageAttempts;
  }
  const fleetMean = fleetMeasured > 0 ? fleetUsage / fleetMeasured : 0;
  for (const cell of cells.values()) {
    const missing = cell.attempts - cell.usageAttempts;
    if (missing <= 0) continue;
    const mean = cell.usageAttempts > 0 ? cell.usage / cell.usageAttempts : fleetMean;
    cell.usage += mean * missing;
    cell.usageAttempts = cell.attempts;
  }
}

/**
 * Learn from a dispatch event log. Malformed lines are counted and skipped.
 * Without `censor`, an assignment with no outcome is invisible, as before.
 */
export function learnOutcomes(text: string, censor?: CensorOptions): OutcomeLearning {
  const parsed = parseEvents(text);
  return fold(parsed.events, parsed.malformed, censor);
}

/** First non-empty PR URL spelling on a ledger row; null when none is recorded. */
function rowPrUrl(row: Record<string, unknown>): string | null {
  for (const key of PR_URL_KEYS) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** `owner/repo#n` (lowercase repo) for a pull URL; null when the URL is not that shape. */
function pullRequestKey(url: string): string | null {
  const match = GITHUB_PULL_URL.exec(url);
  return match ? `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}#${match[3]}` : null;
}

/**
 * PR URL → claiming job, kept only when exactly one job claims the URL —
 * the same unambiguous-claim rule the router outcome fold applies, so a
 * contested or foreign URL never resolves to a job. Batch session ids are
 * infrastructure and never claim. Built only when the caller supplied
 * standing revert keys; the scan itself is a best-effort evidence pass
 * (malformed lines are the main pass's count, not this one's).
 */
function prUrlClaims(lines: readonly string[]): Map<string, string> {
  const claims = new Map<string, Set<string>>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let row: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      row = value as Record<string, unknown>;
    } catch { continue; }
    if (isNodePoolLedgerRow(row)) continue;
    const job = ledgerJobId(row);
    const url = rowPrUrl(row);
    if (job === null || job.startsWith(BATCH_SESSION_PREFIX) || url === null) continue;
    const set = claims.get(url) ?? new Set<string>();
    set.add(job);
    claims.set(url, set);
  }
  const urlToJob = new Map<string, string>();
  for (const [url, jobs] of claims) {
    if (jobs.size === 1) urlToJob.set(url, [...jobs][0]!);
  }
  return urlToJob;
}

/**
 * The jobs-ledger dialect: dispatchd's `launch` rows are the assigns — `lane`
 * is the resource and `tier` keys job type, the only work-shape field the
 * ledger records — `finish` rows carry the token reading (`tokens_total`) an
 * outcome joins by job id, and the metrics-outcomes reconciler's terminal
 * rows are the merge verdicts. A `finish` row recording `empty: true` is the
 * attempt's own death certificate — the diff check found nothing publishable,
 * so no PR can ever carry a verdict — and resolves its open assign as a
 * closed non-merge charged with the row's own `tokens_total`; `empty`
 * absent, `false` or `null` (unmeasured) leaves the attempt open, and
 * `pool_error`/`failure_class`/`failure_reason`/`empty_class` can ride a
 * finish whose diff still publishes so they never close on their own.
 * `launch_failed`/`launch_terminal` rows are the
 * recorded death of an attempt: each resolves its open assign as a closed
 * non-merge so a requeued relaunch counts as a second attempt instead of
 * silently overwriting the first in the fold's open map. Only rows naming a
 * job whose `launch` assign is still open in this window resolve — spawn
 * failures that never wrote a `launch` row, sibling terminal rows for the
 * same dead attempt, and tails truncated before the assign all skip without
 * counting as malformed. Operational rows (concurrency, posture, route
 * decisions, claims that never launched) are not outcome evidence and are
 * skipped without counting as malformed.
 *
 * Node-pool producer rows (`fleet.session-pool.v1`,
 * `phm-node-runner.v1` — jobs-ledger-dialect.isNodePoolLedgerRow) are a
 * different dialect entirely: `job` is the per-attempt id and `jobId` the
 * logical `ready:*` queue id, and no row carries the assign fields a cell
 * needs, so a session-pool `launch` — which reuses the dispatchd event
 * name — would otherwise count malformed and every `finish` would key
 * usage on a phantom claim id. They are node-execution evidence the
 * router outcome fold already consumes; here they skip like any other
 * operational row.
 *
 * Batch sessions (RQ-BATCH-*) launch under the session id, which is
 * infrastructure and never an attempt — member jobs get `batch_claim` rows
 * instead of `launch` rows. A claim is held until the session's own `launch`
 * row, which opens one attempt per recorded member at the session's stamp,
 * so a bundle released before launch (spawn failure, route-lock busy) counts
 * nothing exactly like a solo launch that never wrote its `launch` row. A
 * member's `task_outcome` row closes its attempt as unmerged only for the
 * requeue words (`failed`/`deferred`/`unreported`); `done`/`skipped` members
 * still publish on their own and resolve on the reconciler verdict. A
 * `launch_failed`/`launch_terminal` row naming the session id closes every
 * member attempt it opened. Members get no per-member `finish` row, so
 * their usage stays unmeasured and reconcileUsage charges the cell mean.
 *
 * Revert evidence is job-scoped and read across the whole retained window
 * before any verdict resolves — the same vocabulary slot-yield,
 * reward-feed and the router outcome fold share (`hasRevertEvidence`:
 * reverted:true, a parseable reverted_at/revertedAt stamp, or a
 * revert/reverted event or state name; explicit reverted:false is not
 * evidence). A MERGED verdict recorded at or before the job's newest
 * revert-evidence line resolves as `reverted`, never a held merge: the
 * merge did not hold, the attempt still spent its recorded usage, and the
 * cell's `reverted` count keeps the discount visible. Revert evidence
 * older than the verdict belongs to an earlier merge era and does not
 * discount it — a later merge is a fresh held merge, matching
 * reward-feed's merge-after-revert rule. An attempt still open at the end
 * of the window whose job carries revert evidence recorded after its own
 * launch resolves `reverted` too: the revert proves a merge existed and
 * did not hold, so the attempt is a recorded failure rather than missing
 * data for the censor horizon.
 *
 * A second revert source joins when the caller supplies the standing keys
 * resolved from `improve/revert-outcomes.jsonl` (`phm fleet reverts
 * --record` detections — reverts only git history proves, which the jobs
 * ledger and dispatch log never record): a MERGED verdict whose own PR URL
 * is claimed by exactly that job (`prUrlClaims`, the same unambiguous-claim
 * rule the router outcome fold applies) and whose `owner/repo#n` key stands
 * in the set resolves `reverted` instead of a held merge. The check reads
 * the verdict row's own URL, so a relaunch's merge of a different PR is a
 * fresh held merge exactly like the in-ledger era rule, and a contested or
 * foreign claim never discounts. Keys that are absent, empty or unmatched
 * change nothing — git-only reverts the ledger never wrote still count as
 * the merges they were.
 *
 * Merge-queue friction joins through the same claim rule when the caller
 * supplies the per-PR evidence `foldMergeEvents` produces from
 * metrics/merge-events.jsonl (`mergeQueue`, keyed `owner/repo#n`): a verdict
 * whose own PR URL is claimed by exactly that job reads the PR's recorded
 * rows — conflicts, recuts or a conflict `blocked` reason mark the attempt
 * `mergeDirty`, and required-check failures or retry failures mark it
 * `mergeFixup`. The flags are additive like `breakage`: the attempt keeps
 * its merged/closed/reverted state while the cell's dirty/fixups counts —
 * which the dirty and fixup improvement patterns read — finally see fleet
 * evidence instead of only the dispatch log's exclusive dirty/fixup states.
 * Non-required check observations, plain retries, pending checks and every
 * PR no verdict claims unambiguously contribute nothing; absent, empty or
 * unmatched evidence changes nothing.
 */
function ledgerAssign(row: Record<string, unknown>): AssignEvent | null {
  const job = ledgerJobId(row);
  const repo = row['repo'];
  const resource = ledgerLane(row);
  const model = row['model'];
  const jobType = row['tier'];
  const atMs = ledgerAtMs(row);
  if (!ident(job) || !ident(repo) || !ident(resource) || !ident(model) || !ident(jobType)
    || atMs === null || !Number.isFinite(atMs)) return null;
  return { kind: 'assign', job, repo, resource, model, jobType, atMs };
}

function parseJobsLedgerEvents(
  text: string,
  revertedPrKeys?: ReadonlySet<string> | null,
  mergeQueue?: ReadonlyMap<string, MergeQueueEvidence> | null,
): { events: ParsedEvent[]; malformed: number } {
  const events: ParsedEvent[] = [];
  let malformed = 0;
  const usageByJob = new Map<string, number>();
  const launchAtByJob = new Map<string, number>();
  const launchLineByJob = new Map<string, number>();
  const resolvedJobs = new Set<string>();
  const openJobs = new Set<string>();
  // Batch members claimed but not yet launched: member job -> its claim,
  // and session id -> member jobs, so a dead session can close them all.
  const batchClaims = new Map<string, { bid: string; assign: AssignEvent }>();
  const batchMembers = new Map<string, Set<string>>();
  const lines = text.split(/\r?\n/);
  // PR URL → job claims for the standing-revert and merge-queue joins,
  // built only when the caller supplied either evidence source; null keeps
  // the fold on its in-ledger evidence alone.
  const urlToJob = (revertedPrKeys !== undefined && revertedPrKeys !== null && revertedPrKeys.size > 0)
    || (mergeQueue !== undefined && mergeQueue !== null && mergeQueue.size > 0)
    ? prUrlClaims(lines)
    : null;
  // Newest ledger line carrying positive revert evidence per job id. Every
  // spelling hasRevertEvidence accepts contains 'revert', so the regex
  // keeps this pass from parsing rows that cannot carry the evidence.
  const maxRevertLine = new Map<string, number>();
  for (const [i, line] of lines.entries()) {
    if (!line.trim() || !/revert/i.test(line)) continue;
    let row: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      row = value as Record<string, unknown>;
    } catch { continue; }
    const job = ledgerJobId(row);
    if (job === null || !ident(job) || !hasRevertEvidence(row)) continue;
    maxRevertLine.set(job, i);
  }
  const closeAttempt = (job: string, state: 'closed' | 'reverted' = 'closed'): void => {
    openJobs.delete(job);
    events.push({ kind: 'outcome', job, state, usage: usageByJob.get(job) ?? null, usageUnit: 'tokens', minutes: null, breakage: 0 });
  };
  for (const [lineNo, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let row: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (!value || typeof value !== 'object' || Array.isArray(value)) { malformed += 1; continue; }
      row = value as Record<string, unknown>;
    } catch { malformed += 1; continue; }
    // Node-pool machinery rows are a different producer dialect — see the
    // function doc. Skipping before the event dispatch keeps a
    // session-pool `launch` from counting malformed and a runner `finish`
    // from keying usage on its per-claim id.
    if (isNodePoolLedgerRow(row)) continue;
    const eventName = ledgerEventName(row);
    if (eventName === 'batch_claim') {
      const assign = ledgerAssign(row);
      const bid = row['batch'];
      if (assign !== null && typeof bid === 'string' && bid.length > 0 && bid.length <= 128) {
        batchClaims.set(assign.job, { bid, assign });
        let members = batchMembers.get(bid);
        if (members === undefined) { members = new Set<string>(); batchMembers.set(bid, members); }
        members.add(assign.job);
      }
      continue;
    }
    if (eventName === 'launch') {
      const jobId = ledgerJobId(row);
      const batchSize = row['batch_size'];
      const isBatchSession = jobId !== null && (jobId.startsWith(BATCH_SESSION_PREFIX)
        || batchMembers.has(jobId)
        || (typeof batchSize === 'number' && Number.isFinite(batchSize) && batchSize > 0));
      if (isBatchSession) {
        // The session id is infrastructure: promote each recorded member
        // claim to an attempt stamped at the session's launch.
        const atMs = ledgerAtMs(row);
        if (atMs === null || !Number.isFinite(atMs)) { malformed += 1; continue; }
        const members = batchMembers.get(jobId);
        if (members !== undefined) {
          for (const member of members) {
            const claim = batchClaims.get(member);
            if (claim === undefined || claim.bid !== jobId) continue;
            batchClaims.delete(member);
            events.push({ ...claim.assign, atMs });
            launchAtByJob.set(member, atMs);
            launchLineByJob.set(member, lineNo);
            resolvedJobs.delete(member);
            openJobs.add(member);
          }
        }
        continue;
      }
      const assign = ledgerAssign(row);
      if (assign === null) { malformed += 1; continue; }
      events.push(assign);
      launchAtByJob.set(assign.job, assign.atMs);
      launchLineByJob.set(assign.job, lineNo);
      resolvedJobs.delete(assign.job);
      openJobs.add(assign.job);
      continue;
    }
    if (eventName === 'finish') {
      const job = ledgerJobId(row);
      const usage = finiteNumber(row['tokens_total']);
      if (job !== null && ident(job)) {
        if (usage !== null) usageByJob.set(job, usage);
        // A finish whose diff check recorded empty:true is the attempt's own
        // death certificate: nothing publishable means no PR can ever carry a
        // reconciler verdict, so the open assign resolves as a closed
        // non-merge now instead of waiting out the censor horizon. The row's
        // tokens_total is the attempt's recorded spend — an empty run still
        // burned allowance, so the outcome carries it rather than null. Only
        // the explicit boolean closes: an absent or false `empty` is
        // unmeasured or non-empty, and pool_error/failure_class can ride a
        // finish whose diff still publishes.
        if (row['empty'] === true && openJobs.has(job)) {
          openJobs.delete(job);
          events.push({ kind: 'outcome', job, state: 'closed', usage, usageUnit: 'tokens', minutes: null, breakage: 0 });
        }
      }
      continue;
    }
    if (eventName === 'task_outcome') {
      // A reaped member on a requeue word never publishes: its attempt is
      // dead. done/skipped members still publish — leave them for the
      // reconciler verdict.
      const outcome = row['outcome'];
      const job = ledgerJobId(row);
      if (typeof outcome === 'string' && BATCH_RETRY_OUTCOMES.has(outcome)
        && job !== null && ident(job) && openJobs.has(job)) closeAttempt(job);
      continue;
    }
    if (eventName === 'launch_failed' || eventName === 'launch_terminal') {
      const job = ledgerJobId(row);
      if (job !== null) {
        if (ident(job) && openJobs.has(job)) closeAttempt(job);
        // A dead session id closes every member attempt it launched.
        const members = batchMembers.get(job);
        if (members !== undefined) {
          for (const member of members) if (openJobs.has(member)) closeAttempt(member);
        }
      }
      continue;
    }
    const phase = ledgerPhase(row);
    const lifecycle = ledgerLifecycleEvent(row, phase);
    const state = ledgerOutcomeState(row, lifecycle, phase);
    if (state !== 'MERGED' && state !== 'CLOSED') continue;
    const job = ledgerJobId(row);
    if (job === null || !ident(job) || resolvedJobs.has(job)) continue;
    resolvedJobs.add(job);
    openJobs.delete(job);
    const atMs = ledgerEventTs(row, phase);
    const launchAt = launchAtByJob.get(job);
    const minutes = atMs !== null && launchAt !== undefined && atMs > launchAt ? (atMs - launchAt) / 60_000 : null;
    // A recorded revert at or after this verdict line means the merge did
    // not hold: the attempt resolves as reverted — a failed attempt that
    // still spent its recorded usage — never as a held merge. Revert
    // evidence older than the verdict belongs to an earlier merge era and
    // leaves this one standing.
    // The standing revert-outcomes join marks only through this verdict
    // row's own unambiguous PR claim: urlToJob.get(u) === job means the
    // job is the URL's single claimant, so a reverted pull can never mark
    // a foreign or contested merge — and because the claim names this
    // verdict's own PR, a relaunch's merge of a different PR stays held
    // exactly like the in-ledger era rule.
    let prReverted = false;
    let mergeDirty = false;
    let mergeFixup = false;
    if (urlToJob !== null) {
      const verdictUrl = rowPrUrl(row);
      if (verdictUrl !== null && urlToJob.get(verdictUrl) === job) {
        const key = pullRequestKey(verdictUrl);
        if (key !== null) {
          prReverted = revertedPrKeys?.has(key) === true;
          const queue = mergeQueue?.get(key);
          if (queue !== undefined) {
            // Only unambiguous merge friction counts: recorded conflicts,
            // recuts or a conflict block are dirty evidence; required-check
            // failures and failed retries are fix-up evidence. Flakes,
            // unrelated checks and pending states stay out.
            mergeDirty = queue.conflicts > 0 || queue.recuts > 0 || queue.blocked_reasons.includes('conflict');
            mergeFixup = queue.required_check_failures > 0 || queue.retry_failures > 0;
          }
        }
      }
    }
    const heldMerge = state === 'MERGED' && !prReverted && (maxRevertLine.get(job) ?? -1) < lineNo;
    events.push({
      kind: 'outcome', job,
      state: state === 'MERGED' ? (heldMerge ? 'merged' : 'reverted') : 'closed',
      usage: usageByJob.get(job) ?? null,
      usageUnit: 'tokens',
      minutes, breakage: 0,
      mergeDirty, mergeFixup,
    });
  }
  // An attempt still open whose job carries revert evidence recorded after
  // its own launch produced a merge that did not hold — close it as
  // reverted rather than leaving it for the censor horizon. Evidence from
  // before the launch belongs to an earlier attempt era and does not
  // close this one.
  for (const job of openJobs) {
    const launchLine = launchLineByJob.get(job);
    const revertLine = maxRevertLine.get(job);
    if (launchLine === undefined || revertLine === undefined || revertLine < launchLine) continue;
    closeAttempt(job, 'reverted');
  }
  return { events, malformed };
}

/**
 * Learn from the two evidence sources the fleet actually writes: the dispatch
 * event log's ASSIGN/OUTCOME dialect and the jobs ledger's launch/finish/
 * reconciler rows. Either text may be null when its file was unreadable; a
 * null source contributes nothing. Events fold in the order given.
 *
 * `revertedPrKeys` is the optional standing revert set (`owner/repo#n`)
 * resolved from `improve/revert-outcomes.jsonl` — the detections
 * `phm fleet reverts --record` appends for merges only git history proves.
 * When supplied, a MERGED verdict whose own PR URL is unambiguously claimed
 * by its job and whose key stands reverted resolves `reverted`, the same
 * discount in-ledger revert evidence applies; absent, empty or unmatched
 * keys change nothing, so git-only reverts the jobs ledger never wrote
 * still count against the cell instead of reading as held merges.
 *
 * `mergeQueue` is the optional per-PR merge-queue evidence map
 * (`owner/repo#n` → MergeQueueEvidence) `foldMergeEvents` produces from
 * `metrics/merge-events.jsonl`. When supplied, each verdict's own
 * unambiguously claimed PR contributes its recorded friction to the
 * attempt's `mergeDirty`/`mergeFixup` flags, which the fold adds to the
 * cell's `dirty`/`fixups` counts — the evidence the dirty and fixup
 * improvement patterns read. Absent, empty or unmatched evidence changes
 * nothing.
 */
export function learnFleetOutcomes(
  dispatchLog: string | null,
  jobsLedger: string | null,
  censor?: CensorOptions,
  revertedPrKeys?: ReadonlySet<string> | null,
  mergeQueue?: ReadonlyMap<string, MergeQueueEvidence> | null,
): OutcomeLearning {
  const dispatch = dispatchLog === null
    ? { events: [] as ParsedEvent[], malformed: 0 }
    : parseEvents(dispatchLog);
  const ledger = jobsLedger === null
    ? { events: [] as ParsedEvent[], malformed: 0 }
    : parseJobsLedgerEvents(jobsLedger, revertedPrKeys, mergeQueue);
  return fold([...dispatch.events, ...ledger.events], dispatch.malformed + ledger.malformed, censor);
}

function stableId(parts: readonly string[]): string {
  let hash = 0x811c9dc5;
  const text = parts.join('|');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function patternRate(cell: OutcomeCellView, pattern: ImprovementPattern): number {
  switch (pattern) {
    case 'breakage': return cell.breakageRate;
    case 'dirty': return cell.dirtyRate;
    case 'fixup': return cell.fixupRate;
    case 'low-merge': return 1 - cell.goodMergeRate;
    default: {
      const neverPattern: never = pattern;
      return neverPattern;
    }
  }
}

function patternCopy(cell: OutcomeCellView, pattern: ImprovementPattern): { title: string; task: string } {
  const who = `${resourceWords(cell.resource)} (${modelWords(cell.model)})`;
  const where = `${cell.repo} ${cell.jobType} jobs`;
  switch (pattern) {
    case 'breakage':
      return {
        title: `Stop main breakage from ${who} on ${where}`,
        task: `${who} broke main on ${cell.breakages} of ${cell.attempts} ${where}. Find what those jobs changed and add a regression check that fails before merge.`,
      };
    case 'dirty':
      return {
        title: `Clear the dirty pull requests from ${who} on ${where}`,
        task: `${who} recorded ${cell.dirty} dirty or merge-conflicted pull requests across ${cell.attempts} ${where}. Find the repeated conflict and make the next attempt land cleanly.`,
      };
    case 'fixup':
      return {
        title: `Catch the fix-ups ${who} needs on ${where}`,
        task: `${who} needed a fix-up on ${cell.fixups} of ${cell.attempts} ${where}. Add the check that should have caught that before the pull request opened.`,
      };
    case 'low-merge':
      return {
        title: `Raise the merge rate of ${who} on ${where}`,
        task: `${who} merged without breaking main on ${cell.goodMerges} of ${cell.attempts} ${where}. Find the repeated miss and add a check that makes the next attempt ship.`,
      };
    default: {
      const neverPattern: never = pattern;
      return neverPattern;
    }
  }
}

function recurringPatterns(cell: OutcomeCellView): ImprovementPattern[] {
  const failures = cell.attempts - cell.goodMerges;
  const patterns: ImprovementPattern[] = [];
  if (cell.breakages >= RECURRING_FAILURES) patterns.push('breakage');
  if (cell.dirty >= RECURRING_FAILURES) patterns.push('dirty');
  if (cell.fixups >= RECURRING_FAILURES) patterns.push('fixup');
  if (failures >= RECURRING_FAILURES && cell.goodMerges * 2 < cell.attempts) patterns.push('low-merge');
  return patterns;
}

export function improvementJobs(learning: OutcomeLearning): ImprovementJob[] {
  const jobs: ImprovementJob[] = [];
  for (const cell of learning.cells) {
    for (const pattern of recurringPatterns(cell)) {
      const copy = patternCopy(cell, pattern);
      jobs.push({
        id: `improve-${stableId([pattern, cell.resource, cell.model, cell.jobType, cell.repo])}`,
        repo: cell.repo,
        jobType: cell.jobType,
        pattern,
        resource: cell.resource,
        model: cell.model,
        title: copy.title,
        task: copy.task,
        attempts: cell.attempts,
        rate: patternRate(cell, pattern),
      });
    }
  }
  return jobs.sort((a, b) => PATTERN_ORDER[a.pattern] - PATTERN_ORDER[b.pattern]
    || a.resource.localeCompare(b.resource) || a.model.localeCompare(b.model) || a.repo.localeCompare(b.repo));
}

export function outcomeLearningView(learning: OutcomeLearning): OutcomeLearningView {
  return {
    schema: OUTCOME_LEARNING_SCHEMA,
    finished: learning.finished,
    malformed: learning.malformed,
    cells: [...learning.cells],
    improvementJobs: improvementJobs(learning),
  };
}

function evidenceFor(learning: OutcomeLearning, resource: string, model: string, jobType: string, repo: string): OutcomeCellView {
  const exact = learning.cells.find((cell) =>
    cell.resource === resource && cell.model === model && cell.jobType === jobType && cell.repo === repo);
  if (exact && exact.attempts > 0) return exact;
  const pooled = learning.cells.filter((cell) => cell.resource === resource && cell.model === model && cell.jobType === jobType);
  if (pooled.length === 0) return publish(blankCell(resource, model, jobType, repo));
  const sum = blankCell(resource, model, jobType, repo);
  for (const cell of pooled) {
    sum.attempts += cell.attempts;
    sum.censored += cell.censored;
    sum.reverted += cell.reverted;
    sum.merges += cell.merges;
    sum.goodMerges += cell.goodMerges;
    sum.breakages += cell.breakages;
    sum.dirty += cell.dirty;
    sum.fixups += cell.fixups;
    sum.usage += cell.usage;
    sum.usageAllowance += cell.usageAllowance;
    sum.usageAllowanceKnown += cell.usageAllowanceKnown;
    if (cell.meanMinutesToMerge !== null) {
      sum.mergeMinutes += cell.meanMinutesToMerge * cell.merges;
      sum.timedMerges += cell.merges;
    }
  }
  return publish(sum);
}

function meanSuccess(cell: Pick<OutcomeCellView, 'attempts' | 'goodMerges'>): number {
  return (1 + cell.goodMerges) / (2 + cell.attempts);
}

function meanCheapness(cell: Pick<OutcomeCellView, 'attempts' | 'usage'>): number {
  return (1 + cell.attempts) / (1 + cell.usage);
}

function minutesUntil(resetAt: string | null, nowMs: number): number | null {
  if (resetAt === null) return null;
  const ms = Date.parse(resetAt) - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms / 60_000;
}

type Block = 'ok' | 'exhausted' | 'reset';

function blockReason(offer: ResourceOffer, cell: OutcomeCellView, nowMs: number): Block {
  if (offer.exhausted === true || offer.slots <= 0 || offer.usageLeftPercent === 0) return 'exhausted';
  const left = minutesUntil(offer.resetAt, nowMs);
  if (left !== null && cell.meanMinutesToMerge !== null && cell.meanMinutesToMerge > left) return 'reset';
  return 'ok';
}

function burnBonus(offer: ResourceOffer, cell: OutcomeCellView, nowMs: number, block: Block): number {
  if (block !== 'ok') return 0;
  const left = minutesUntil(offer.resetAt, nowMs);
  const duration = cell.meanMinutesToMerge;
  if (left === null || duration === null || duration <= 0) return 0;
  return 1 / (1 + left / duration);
}

function meanReward(cell: OutcomeCellView, burn: number): number {
  return meanSuccess(cell) * meanCheapness(cell) * (1 + burn);
}

function sampledReward(cell: OutcomeCellView, burn: number, rng: BanditRng): number {
  const success = betaSample(1 + cell.goodMerges, 1 + Math.max(0, cell.attempts - cell.goodMerges), rng);
  const cheap = gammaSample(1 + cell.attempts, 1 + cell.usage, rng);
  return success * cheap * (1 + burn);
}

interface ScoredOffer {
  offer: ResourceOffer;
  cell: OutcomeCellView;
  block: Block;
  burn: number;
  mean: number;
  sampled: number;
}

function validOffer(offer: ResourceOffer): boolean {
  return ident(offer.resource) && ident(offer.model)
    && Number.isInteger(offer.slots) && offer.slots >= 0 && offer.slots <= 10_000
    && (offer.usageLeftPercent === null || (typeof offer.usageLeftPercent === 'number'
      && Number.isFinite(offer.usageLeftPercent) && offer.usageLeftPercent >= 0 && offer.usageLeftPercent <= 100))
    && (offer.resetAt === null || Number.isFinite(Date.parse(offer.resetAt)))
    && (offer.exhausted === undefined || typeof offer.exhausted === 'boolean');
}

function scoreOffers(learning: OutcomeLearning, job: LearnedJob, offers: readonly ResourceOffer[], nowMs: number, explore: boolean): ScoredOffer[] {
  const unique = new Map<string, ResourceOffer>();
  for (const offer of offers) {
    if (!validOffer(offer)) continue;
    const key = `${offer.resource}\0${offer.model}`;
    if (!unique.has(key)) unique.set(key, offer);
  }
  const ordered = [...unique.values()].sort((a, b) => a.resource.localeCompare(b.resource) || a.model.localeCompare(b.model));
  const rng = createSeededRng(`${job.id}:${job.repo}:${job.jobType}`);
  return ordered.map((offer) => {
    const cell = evidenceFor(learning, offer.resource, offer.model, job.jobType, job.repo);
    const block = blockReason(offer, cell, nowMs);
    const burn = burnBonus(offer, cell, nowMs, block);
    const mean = meanReward(cell, burn);
    const sampled = explore && block === 'ok' ? sampledReward(cell, burn, rng) : mean;
    return { offer, cell, block, burn, mean, sampled };
  });
}

function better(rows: readonly ScoredOffer[], field: 'mean' | 'sampled'): ScoredOffer | null {
  let best: ScoredOffer | null = null;
  for (const row of rows) {
    if (best === null || row[field] > best[field]) best = row;
  }
  return best;
}

function formatMinutes(minutes: number): string {
  const rounded = Math.max(1, Math.round(minutes));
  if (rounded < 90) return `${rounded} min`;
  const hours = Math.max(1, Math.round(rounded / 60));
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

function offerLabel(offer: ResourceOffer, offers: readonly ResourceOffer[], withModel: boolean): string {
  const name = resourceWords(offer.resource);
  const shared = offers.filter((other) => resourceWords(other.resource) === name).length > 1;
  if (withModel || shared) return `${name} (${modelWords(offer.model)})`;
  return name;
}

function resetPhrase(offer: ResourceOffer, nowMs: number): string | null {
  const left = minutesUntil(offer.resetAt, nowMs);
  if (left === null || offer.usageLeftPercent === null) return null;
  return `resets in ${formatMinutes(left)} with ${Math.round(offer.usageLeftPercent)}% left`;
}

function formatUsage(usage: number): string {
  return String(Math.round(usage * 100) / 100);
}

function learnedSentence(winner: ScoredOffer, runner: ScoredOffer | null, job: LearnedJob, rows: readonly ScoredOffer[]): string {
  const offers = rows.map((row) => row.offer);
  const who = offerLabel(winner.offer, offers, true);
  if (winner.cell.attempts < 1) {
    if (rows.every((row) => row.cell.attempts < 1)) {
      return `Sent to ${offerLabel(winner.offer, offers, false)} to see whether it ships; no finished ${job.repo} ${job.jobType} jobs are on record yet.`;
    }
    return `Sent to ${offerLabel(winner.offer, offers, false)} to check a resource that has not finished this ${job.repo} ${job.jobType} job yet.`;
  }
  const rate = Math.round(winner.cell.goodMergeRate * 100);
  const usage = formatUsage(winner.cell.meanUsage);
  if (!runner || runner.cell.attempts < 1) {
    return `Sent to ${who} because ${rate}% of its ${job.repo} ${job.jobType} jobs merge without breaking main, at usage ${usage}.`;
  }
  const other = offerLabel(runner.offer, offers, true);
  const cheaper = winner.cell.meanUsage < runner.cell.meanUsage;
  const breakRate = Math.round(runner.cell.breakageRate * 100);
  const cost = cheaper ? ` at lower usage than ${other}` : '';
  const broke = breakRate > 0 ? `${cost ? ',' : ''} and ${other} breaks main on ${breakRate}% of them` : '';
  return `Sent to ${who} because ${rate}% of its ${job.repo} ${job.jobType} jobs merge without breaking main${cost}${broke}.`;
}

function dispatchExplanation(winner: ScoredOffer, feasible: readonly ScoredOffer[], blocked: readonly ScoredOffer[], job: LearnedJob, nowMs: number): string {
  const offers = [...feasible, ...blocked].map((row) => row.offer);
  const skipped = blocked
    .map((row) => ({ row, phrase: resetPhrase(row.offer, nowMs) }))
    .filter((item): item is { row: ScoredOffer; phrase: string } => item.phrase !== null)
    .sort((a, b) => (a.row.offer.usageLeftPercent ?? 100) - (b.row.offer.usageLeftPercent ?? 100));
  const notable = skipped[0];
  if (notable) {
    return `Sent to ${offerLabel(winner.offer, offers, false)} because ${offerLabel(notable.row.offer, offers, false)} ${notable.phrase}.`;
  }
  const runner = better(feasible.filter((row) => row !== winner), 'mean');
  const phrase = resetPhrase(winner.offer, nowMs);
  const bestWithoutBurn = better(feasible.map((row) => ({ ...row, mean: meanReward(row.cell, 0) })), 'mean');
  if (phrase && winner.burn > 0 && bestWithoutBurn !== null
    && (bestWithoutBurn.offer.resource !== winner.offer.resource || bestWithoutBurn.offer.model !== winner.offer.model)) {
    return `Sent to ${offerLabel(winner.offer, offers, false)} because it ${phrase} and still ships this work.`;
  }
  return learnedSentence(winner, runner, job, [...feasible, ...blocked]);
}

/**
 * Choose a resource for one job. Critical work dispatches to whatever can
 * take it now, or nowhere; it does not wait on a reset. Other work may wait
 * only when every offered resource is exhausted or cannot finish before reset.
 */
export function routeLearnedJob(
  learning: OutcomeLearning,
  job: LearnedJob,
  offers: readonly ResourceOffer[],
  options: RouteLearningOptions,
): LearnedRoute {
  if (!ident(job.id) || !ident(job.repo) || !ident(job.jobType) || !Number.isFinite(options.nowMs)) {
    return { action: 'nowhere', resource: null, model: null, explanation: 'This job has no usable id, repo, or type, so it was not routed.', explored: false, score: null };
  }
  const scored = scoreOffers(learning, job, offers, options.nowMs, options.explore !== false);
  const feasible = scored.filter((row) => row.block === 'ok');
  const blocked = scored.filter((row) => row.block !== 'ok');
  const field = options.explore === false ? 'mean' : 'sampled';
  const winner = better(feasible, field);
  if (winner) {
    const meanWinner = better(feasible, 'mean');
    const explored = options.explore !== false && (meanWinner?.offer.resource !== winner.offer.resource || meanWinner?.offer.model !== winner.offer.model);
    return {
      action: 'dispatch',
      resource: winner.offer.resource,
      model: winner.offer.model,
      explanation: dispatchExplanation(winner, feasible, blocked, job, options.nowMs),
      explored,
      score: winner[field],
    };
  }
  if (job.priority === 'critical') {
    return {
      action: 'nowhere',
      resource: null,
      model: null,
      explanation: 'No resource can take this critical job right now, so it is not waiting on a reset.',
      explored: false,
      score: null,
    };
  }
  const waiting = blocked
    .filter((row) => minutesUntil(row.offer.resetAt, options.nowMs) !== null)
    .sort((a, b) => b.mean - a.mean);
  const hold = waiting[0];
  const phrase = hold ? resetPhrase(hold.offer, options.nowMs) : null;
  if (hold && phrase) {
    const offers = scored.map((row) => row.offer);
    return {
      action: 'wait',
      resource: hold.offer.resource,
      model: hold.offer.model,
      explanation: `Waiting until ${offerLabel(hold.offer, offers, false)} ${phrase}, because nothing else can take this job.`,
      explored: false,
      score: null,
    };
  }
  return {
    action: 'nowhere',
    resource: null,
    model: null,
    explanation: 'No offered resource can take this job.',
    explored: false,
    score: null,
  };
}

/** Posterior mean penalties for the seat router. Lower is better. The best resource stays at 0. */
export function learnedSeatPenalty(learning: OutcomeLearning, jobType: string, repo: string): Record<string, number> {
  const scores = new Map<string, number>();
  for (const cell of learning.cells) {
    if (cell.jobType !== jobType || cell.repo !== repo || cell.attempts < 1) continue;
    const score = meanReward(cell, 0);
    const previous = scores.get(cell.resource);
    if (previous === undefined || score > previous) scores.set(cell.resource, score);
  }
  return normalizedPenalties(scores);
}

/**
 * The same posterior means pooled across every recorded cell: a seat-router
 * request carries no fleet job type or repo, so the honest prior is the
 * resource's whole dispatch record — attempts, good merges and usage summed
 * per resource over all models, job types and repos, then the same
 * meanSuccess x meanCheapness reward and normalization learnedSeatPenalty
 * applies. Lower is better; the best resource stays at 0 and every other
 * resource's penalty stays inside [0, 1]. An empty or all-unmeasured log
 * yields {} — the router's ranking is then byte-identical.
 */
export function learnedFleetSeatPenalty(learning: OutcomeLearning): Record<string, number> {
  const pooled = new Map<string, { attempts: number; goodMerges: number; usage: number }>();
  for (const cell of learning.cells) {
    if (cell.attempts < 1) continue;
    const acc = pooled.get(cell.resource) ?? { attempts: 0, goodMerges: 0, usage: 0 };
    acc.attempts += cell.attempts;
    acc.goodMerges += cell.goodMerges;
    acc.usage += cell.usage;
    pooled.set(cell.resource, acc);
  }
  const scores = new Map<string, number>();
  for (const [resource, cell] of pooled) {
    scores.set(resource, meanSuccess(cell) * meanCheapness(cell));
  }
  return normalizedPenalties(scores);
}

function normalizedPenalties(scores: ReadonlyMap<string, number>): Record<string, number> {
  let best = 0;
  for (const score of scores.values()) if (score > best) best = score;
  const penalty: Record<string, number> = {};
  if (!(best > 0)) return penalty;
  for (const [resource, score] of scores) penalty[resource] = Math.min(10, Math.max(0, (best - score) / best));
  return penalty;
}

/** Route the same probe after every finished outcome, using only earlier evidence. */
export function replayLearnedRoutes(
  text: string,
  job: LearnedJob,
  offers: readonly ResourceOffer[],
  options: RouteLearningOptions,
): LearnedRoute[] {
  const parsed = parseEvents(text);
  const routes: LearnedRoute[] = [];
  const partial: ParsedEvent[] = [];
  for (const event of parsed.events) {
    partial.push(event);
    if (event.kind !== 'outcome') continue;
    routes.push(routeLearnedJob(fold(partial, 0), job, offers, options));
  }
  return routes;
}

export function offersFromLearning(learning: OutcomeLearning): ResourceOffer[] {
  const seen = new Set<string>();
  const offers: ResourceOffer[] = [];
  for (const cell of learning.cells) {
    const key = `${cell.resource}\0${cell.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    offers.push({ resource: cell.resource, model: cell.model, usageLeftPercent: null, resetAt: null, slots: 1 });
  }
  return offers;
}

function cellSentence(cell: OutcomeCellView): string {
  const time = cell.meanMinutesToMerge === null ? 'time to merge unknown' : `${Math.round(cell.meanMinutesToMerge)} min to merge`;
  const tail = [
    ...(cell.reverted > 0 ? [`${cell.reverted} reverted`] : []),
    ...(cell.censored > 0 ? [`${cell.censored} unmerged past the horizon`] : []),
  ];
  return `${resourceWords(cell.resource)} (${modelWords(cell.model)}) on ${cell.repo} ${cell.jobType} jobs: `
    + `${Math.round(cell.mergeRate * 100)}% merge, ${time}, usage ${formatUsage(cell.meanUsage)}, `
    + `${Math.round(cell.breakageRate * 100)}% breakage`
    + (tail.length > 0 ? `, ${tail.join(', ')}.` : '.');
}

/** Plain sentences for the desktop panel and the CLI. */
export function formatOutcomeLearning(view: OutcomeLearningView, route?: LearnedRoute | null): string {
  const lines = [
    ...(route ? [route.explanation] : []),
    `${view.finished} finished jobs${view.malformed > 0 ? `, ${view.malformed} unreadable lines` : ''}.`,
    ...view.cells.map(cellSentence),
  ];
  if (view.improvementJobs.length > 0) {
    lines.push('Improvement jobs:');
    for (const job of view.improvementJobs) {
      lines.push(`- ${job.title} (${job.attempts} jobs, ${Math.round(job.rate * 100)}%).`);
    }
  }
  return lines.join('\n');
}
