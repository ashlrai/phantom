import type { ExecutionFeedbackOutcome } from '../../../../core/fleet/execution-feedback-types.js';
import { safeHref } from '../cloud/cloud-model.js';
import { JOB_ID_RE } from '../fleet-job-log/worker-log-model.js';

export type FeedbackReadState = 'warming' | 'current' | 'stale' | 'unavailable';

export interface OutcomeMixRow {
  outcome: ExecutionFeedbackOutcome;
  label: string;
  /** Lower bound; always a real number. */
  observed: number;
  /** Exact count; only sent when the detailed source read completely. */
  total: number | null;
}

export interface OutcomeCaseRow {
  caseId: string;
  endedAt: string | null;
  outcome: ExecutionFeedbackOutcome;
  lane?: string;
  producer?: string;
  label: string;
  failureKind: string | null;
  proposalRecorded: boolean;
  jobId: string | null;
  prLink: { url: string; label: string } | null;
}

export interface OutcomesView {
  state: FeedbackReadState;
  refreshedAt: string | null;
  /** null when the read carried no feedback object at all. */
  sourceState: 'missing' | 'healthy' | 'degraded' | null;
  complete: boolean | null;
  since: string | null;
  through: string | null;
  mix: OutcomeMixRow[];
  cases: OutcomeCaseRow[];
  notes: string[];
}

export interface CaseStep {
  stage: string;
  stageLabel: string;
  at: string | null;
  result: string;
  basis: string | null;
  href: string | null;
  ci: string | null;
  suite: string | null;
}

export interface CaseView {
  state: FeedbackReadState;
  /** null when the read carried no detail object for the case. */
  caseId: string | null;
  outcome: ExecutionFeedbackOutcome | null;
  label: string | null;
  endedAt: string | null;
  steps: CaseStep[];
}

const OUTCOME_ORDER: readonly ExecutionFeedbackOutcome[] = [
  'producer-succeeded', 'failed', 'empty-diff', 'cancelled', 'refused', 'disabled', 'unknown',
];
const OUTCOMES = new Set<string>(OUTCOME_ORDER);
const MAX_CASES = 100;
const WASTE_OUTCOMES = ['empty-diff', 'refused', 'failed', 'cancelled'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface WasteSummary {
  /** Hours in the window, or zero when no case has an end time. */
  window: number;
  finished: number;
  wasted: number;
  byOutcome: Record<string, number>;
  byLane: Array<{ lane: string; wasted: number }>;
}

export function isWasteCase(row: OutcomeCaseRow): boolean {
  return WASTE_OUTCOMES.some(outcome => outcome === row.outcome);
}

export function recutPrefill(row: OutcomeCaseRow): string | null {
  if (!isWasteCase(row) || !row.jobId) return null;
  const prNumber = row.prLink?.url.match(/\/pull\/(\d+)/)?.[1];
  const order = `Recut ${row.jobId} (${row.lane || 'lane unknown'}): ${row.failureKind || outcomeLabel(row.outcome)} — ${row.label}. PR ${row.prLink?.label || 'none'}.`;
  return prNumber ? `${order} Inherit with git fetch origin pull/${prNumber}/head.` : order;
}

export function wasteSummary(cases: OutcomeCaseRow[], nowMs: number): WasteSummary {
  const hasEndTime = cases.some(item => item.endedAt !== null);
  const finishedCases = hasEndTime ? cases.filter(item => {
    const ended = Date.parse(item.endedAt ?? '');
    return ended >= nowMs - DAY_MS && ended <= nowMs;
  }) : cases;
  const byOutcome: Record<string, number> = {};
  const lanes = new Map<string, number>();
  for (const item of finishedCases) {
    if (!isWasteCase(item)) continue;
    byOutcome[item.outcome] = (byOutcome[item.outcome] ?? 0) + 1;
    const lane = item.lane || (item.producer ? `producer ${item.producer}` : 'unrecorded');
    lanes.set(lane, (lanes.get(lane) ?? 0) + 1);
  }
  return {
    window: hasEndTime ? 24 : 0,
    finished: finishedCases.length,
    wasted: Object.values(byOutcome).reduce((sum, count) => sum + count, 0),
    byOutcome,
    byLane: [...lanes].map(([lane, wasted]) => ({ lane, wasted }))
      .sort((a, b) => b.wasted - a.wasted || a.lane.localeCompare(b.lane)),
  };
}

export function wasteLine(summary: WasteSummary): string | null {
  if (summary.finished === 0) return null;
  const reasons = WASTE_OUTCOMES.filter(outcome => summary.byOutcome[outcome])
    .map(outcome => `${summary.byOutcome[outcome]} ${outcome.replace('-', ' ')}`);
  const top = summary.byLane.find(item => item.lane !== 'unrecorded');
  const unrecorded = summary.byLane.find(item => item.lane === 'unrecorded');
  const location = [top ? `Most ${unrecorded ? 'recorded ' : ''}on ${top.lane} (${top.wasted}).` : '',
    unrecorded ? `Lane or producer not recorded (${unrecorded.wasted}).` : ''].filter(Boolean).join(' ');
  return `Waste, ${summary.window ? `last ${summary.window} h` : 'all available cases'}: ${summary.wasted} of ${summary.finished} finished cases produced nothing${reasons.length ? ` (${reasons.join(', ')})` : ''}.${location ? ` ${location}` : ''}`;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === 'string' && value ? value : null;
const nonneg = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const readState = (value: unknown): FeedbackReadState =>
  value === 'current' || value === 'stale' || value === 'warming' || value === 'unavailable' ? value : 'unavailable';
const readOutcome = (value: unknown): ExecutionFeedbackOutcome =>
  OUTCOMES.has(value as string) ? value as ExecutionFeedbackOutcome : 'unknown';
const byNewest = (left: string | null, right: string | null): number => {
  const a = Date.parse(left ?? ''), b = Date.parse(right ?? '');
  return (Number.isFinite(b) ? b : -Infinity) - (Number.isFinite(a) ? a : -Infinity);
};

function pullRequestLink(item: Record<string, unknown>): OutcomeCaseRow['prLink'] {
  const steps = Array.isArray(item.timeline) ? item.timeline.map(record) : [];
  const step = steps.find(row => row.stage === 'pr-opened' && text(row.href));
  const href = text(item.href) ?? text(item.prUrl) ?? text(step?.href);
  const number = nonneg(item.prNumber);
  const url = safeHref(href ?? (number && number > 0 ? `https://github.com/ashlrai/phantom/pull/${number}` : null), 'github.com');
  if (!url) return null;
  const match = new URL(url).pathname.match(/^\/[^/]+\/[^/]+\/pull\/([1-9]\d*)\/?$/);
  return match ? { url, label: `#${match[1]}` } : null;
}

export function outcomeLabel(outcome: string): string {
  if (outcome === 'producer-succeeded') return 'Produced';
  if (outcome === 'empty-diff') return 'Empty diff';
  return outcome ? outcome[0]!.toUpperCase() + outcome.slice(1) : 'Unknown';
}

export function filterCases(view: OutcomesView, outcome: ExecutionFeedbackOutcome | 'all'): OutcomeCaseRow[] {
  return outcome === 'all' ? view.cases : view.cases.filter(item => item.outcome === outcome);
}

export function outcomeChips(view: OutcomesView): Array<{ outcome: ExecutionFeedbackOutcome | 'all'; label: string; count: number }> {
  const chips: Array<{ outcome: ExecutionFeedbackOutcome | 'all'; label: string; count: number }> =
    [{ outcome: 'all', label: 'All', count: view.cases.length }];
  for (const row of view.mix) {
    const count = row.total ?? row.observed;
    if (count > 0) chips.push({ outcome: row.outcome, label: row.label, count });
  }
  return chips;
}

export function stageLabel(stage: string): string {
  if (stage === 'pr-opened') return 'PR opened';
  if (stage === 'post-merge') return 'Post-merge CI';
  return stage ? stage[0]!.toUpperCase() + stage.slice(1) : 'Unknown';
}

export function readOutcomes(value: unknown): OutcomesView | null {
  const data = record(value);
  if (data.v !== 1) return null;
  const state = readState(data.state);
  const refreshedAt = text(data.refreshedAt);
  const rawFeedback = data.feedback;
  if (!rawFeedback || typeof rawFeedback !== 'object' || Array.isArray(rawFeedback)) {
    return { state, refreshedAt, sourceState: null, complete: null, since: null, through: null, mix: [], cases: [], notes: [] };
  }
  const feedback = rawFeedback as Record<string, unknown>;
  const sourceState = feedback.sourceState === 'healthy' || feedback.sourceState === 'degraded' ? feedback.sourceState : 'missing';
  const complete = typeof feedback.complete === 'boolean' ? feedback.complete : null;
  const window = record(feedback.window);
  const counts = feedback.counts && typeof feedback.counts === 'object' && !Array.isArray(feedback.counts)
    ? feedback.counts as Record<string, unknown> : null;
  const observed = record(feedback.observedCounts);
  const mix: OutcomeMixRow[] = OUTCOME_ORDER.flatMap(outcome => {
    const row: OutcomeMixRow = {
      outcome, label: outcomeLabel(outcome),
      observed: nonneg(observed[outcome]) ?? 0,
      total: counts ? nonneg(counts[outcome]) : null,
    };
    return row.observed === 0 && (row.total === null || row.total === 0) ? [] : [row];
  });
  const cases: OutcomeCaseRow[] = (Array.isArray(feedback.cases) ? feedback.cases : []).flatMap(raw => {
    const item = record(raw);
    const caseId = text(item.caseId);
    if (!caseId) return [];
    const outcome = readOutcome(item.outcome);
    return [{ caseId, endedAt: text(item.endedAt), outcome, label: outcomeLabel(outcome),
      ...(text(item.lane) ? { lane: text(item.lane)! } : {}),
      ...(text(item.producer) ? { producer: text(item.producer)! } : {}),
      failureKind: text(item.failureKind), proposalRecorded: item.proposalRecorded === true,
      jobId: JOB_ID_RE.test(caseId) ? caseId : null, prLink: pullRequestLink(item) }];
  }).sort((a, b) => byNewest(a.endedAt, b.endedAt)).slice(0, MAX_CASES);
  const notes: string[] = [];
  if (sourceState !== 'healthy') notes.push('Outcome data may be incomplete.');
  if (complete === false) notes.push('The window is still being read.');
  const coverage = record(feedback.coverage);
  const invalid = nonneg(coverage.invalidAttempts) ?? 0, conflicting = nonneg(coverage.conflictingAttempts) ?? 0;
  if (invalid > 0 || conflicting > 0) notes.push(`${invalid} invalid and ${conflicting} conflicting attempts were skipped.`);
  return { state, refreshedAt, sourceState, complete, since: text(window.since), through: text(window.through), mix, cases, notes };
}

export function readCase(value: unknown): CaseView | null {
  const data = record(value);
  if (data.v !== 1) return null;
  const state = readState(data.state);
  const rawDetail = data.detail;
  const empty: CaseView = { state, caseId: null, outcome: null, label: null, endedAt: null, steps: [] };
  if (!rawDetail || typeof rawDetail !== 'object' || Array.isArray(rawDetail)) return empty;
  const detail = rawDetail as Record<string, unknown>;
  const caseId = text(detail.caseId);
  if (!caseId) return empty;
  const outcome = readOutcome(detail.outcome);
  const steps: CaseStep[] = (Array.isArray(detail.timeline) ? detail.timeline : []).flatMap(raw => {
    const item = record(raw);
    const stage = text(item.stage), result = text(item.result);
    if (!stage || !result) return [];
    return [{ stage, stageLabel: stageLabel(stage), at: text(item.at), result, basis: text(item.basis),
      href: safeHref(text(item.href), 'github.com'), ci: text(item.ci), suite: text(item.suite) }];
  });
  return { state, caseId, outcome, label: outcomeLabel(outcome), endedAt: text(detail.endedAt), steps };
}
