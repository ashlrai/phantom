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
  merges: number;
  /** Merges that did not break main. This is what routing treats as success. */
  goodMerges: number;
  breakages: number;
  dirty: number;
  fixups: number;
  usage: number;
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
}

interface AssignEvent {
  kind: 'assign';
  job: string;
  resource: string;
  model: string;
  jobType: string;
  repo: string;
}

interface OutcomeEvent {
  kind: 'outcome';
  job: string;
  state: 'merged' | 'closed' | 'dirty' | 'fixup';
  usage: number;
  minutes: number | null;
  breakage: number;
}

type ParsedEvent = AssignEvent | OutcomeEvent;

const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
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

function assignFrom(fields: { positional: string[]; kv: Record<string, string> }): AssignEvent | null {
  const job = pickIdent(fields.kv, fields.positional, 0, 'job');
  const repo = pickIdent(fields.kv, fields.positional, 1, 'repo');
  const resource = pickIdent(fields.kv, fields.positional, 2, 'resource');
  const model = pickIdent(fields.kv, fields.positional, 3, 'model');
  const jobType = pickIdent(fields.kv, fields.positional, 4, 'jobType', 'type');
  if (!job || !repo || !resource || !model || !jobType) return null;
  return { kind: 'assign', job, repo, resource, model, jobType };
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
    return assignFrom({ positional: [], kv });
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
    const event = kind === 'OUTCOME' ? outcomeFrom(fields) : assignFrom(fields);
    if (!event) malformed += 1;
    else events.push(event);
  }
  return { events, malformed };
}

function blankCell(resource: string, model: string, jobType: string, repo: string): Cell {
  return {
    resource, model, jobType, repo,
    attempts: 0, merges: 0, goodMerges: 0, breakages: 0, dirty: 0, fixups: 0,
    usage: 0, mergeMinutes: 0, timedMerges: 0,
    mergeRate: 0, goodMergeRate: 0, breakageRate: 0, dirtyRate: 0, fixupRate: 0,
    meanUsage: 0, meanMinutesToMerge: null,
  };
}

function cellKey(resource: string, model: string, jobType: string, repo: string): string {
  return `${resource}\0${model}\0${jobType}\0${repo}`;
}

function publish(cell: Cell): OutcomeCellView {
  const attempts = cell.attempts;
  const { mergeMinutes, timedMerges, ...view } = cell;
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

function fold(events: readonly ParsedEvent[], malformed: number): OutcomeLearning {
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
    cell.usage += event.usage;
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
    if (!Number.isSafeInteger(cell.attempts) || !Number.isFinite(cell.usage)) {
      malformed += 1;
      continue;
    }
    cells.set(key, cell);
    finished += 1;
  }
  return {
    finished,
    malformed,
    cells: [...cells.values()].map(publish).sort((a, b) =>
      b.attempts - a.attempts || a.resource.localeCompare(b.resource) || a.model.localeCompare(b.model)
      || a.jobType.localeCompare(b.jobType) || a.repo.localeCompare(b.repo)),
  };
}

/** Learn from a dispatch event log. Malformed lines are counted and skipped. */
export function learnOutcomes(text: string): OutcomeLearning {
  const parsed = parseEvents(text);
  return fold(parsed.events, parsed.malformed);
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
        task: `${who} left ${cell.dirty} of ${cell.attempts} ${where} DIRTY. Find the repeated conflict and make the next attempt land cleanly.`,
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
    sum.merges += cell.merges;
    sum.goodMerges += cell.goodMerges;
    sum.breakages += cell.breakages;
    sum.dirty += cell.dirty;
    sum.fixups += cell.fixups;
    sum.usage += cell.usage;
    if (cell.meanMinutesToMerge !== null) {
      sum.mergeMinutes += cell.meanMinutesToMerge * cell.merges;
      sum.timedMerges += cell.merges;
    }
  }
  return publish(sum);
}

function meanSuccess(cell: OutcomeCellView): number {
  return (1 + cell.goodMerges) / (2 + cell.attempts);
}

function meanCheapness(cell: OutcomeCellView): number {
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
  return `${resourceWords(cell.resource)} (${modelWords(cell.model)}) on ${cell.repo} ${cell.jobType} jobs: `
    + `${Math.round(cell.mergeRate * 100)}% merge, ${time}, usage ${formatUsage(cell.meanUsage)}, `
    + `${Math.round(cell.breakageRate * 100)}% breakage.`;
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
