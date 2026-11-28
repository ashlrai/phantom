/**
 * Claude reset rule. This module only drafts. It never clicks, buys or resets
 * anything: the output is a decision for Mason, who performs the reset himself.
 *
 * Fable reset: Fable is at or above 95% of its share with more than 24 h
 * before the weekly reset.
 * Weekly reset: the weekly allowance is at or above 95% with more than 24 h left.
 * Never both inside one week unless both are exhausted.
 *
 * When both cross 95% in the same pass and they are not both exhausted, only
 * the weekly reset is drafted: the weekly allowance is the one that stops all
 * Claude work, Fable included.
 */
import { round1 } from '../runway.js';
import type { ResetDraft, ResetDraftKind, ResetRuleState, ResourceLiveReading } from './types.js';
import { RESOURCE_LIVE_STALE_MS } from './types.js';

const RESET_THRESHOLD_PCT = 95;
const RESET_MIN_HOURS_LEFT = 24;
const RESET_WEEK_MS = 7 * 24 * 3_600_000;
const RESET_DECISION_SCHEMA = 'resource-live.reset-decision.v1' as const;

export const EMPTY_RESET_STATE: ResetRuleState = { fable: null, weekly: null, last_decision_file: null };

function fresh(reading: ResourceLiveReading | undefined, nowMs: number): reading is ResourceLiveReading & { used_pct: number; observed_at: string; source: string } {
  if (!reading || !reading.verified || reading.used_pct === null || reading.observed_at === null || reading.source === null) return false;
  const observed = Date.parse(reading.observed_at);
  return Number.isFinite(observed) && observed <= nowMs && nowMs - observed < RESOURCE_LIVE_STALE_MS;
}

/** One identity per weekly window. Reset times re-derived each pass drift by minutes. */
function windowKey(resetAt: string): string {
  return new Date(Math.round(Date.parse(resetAt) / 3_600_000) * 3_600_000).toISOString();
}

function withinWeek(entry: ResetRuleState[ResetDraftKind], nowMs: number): boolean {
  if (!entry) return false;
  const at = Date.parse(entry.drafted_at);
  return Number.isFinite(at) && at <= nowMs && nowMs - at < RESET_WEEK_MS;
}

export interface ResetRuleResult {
  drafts: ResetDraft[];
  state: ResetRuleState;
}

export function evaluateResetRule(
  weekly: ResourceLiveReading | undefined,
  fable: ResourceLiveReading | undefined,
  state: ResetRuleState,
  nowMs: number,
): ResetRuleResult {
  const none: ResetRuleResult = { drafts: [], state };
  // The weekly reading supplies the reset time. Without a fresh one nothing is drafted.
  if (!fresh(weekly, nowMs) || weekly.reset_at === null) return none;
  const resetMs = Date.parse(weekly.reset_at);
  const hours = (resetMs - nowMs) / 3_600_000;
  if (!Number.isFinite(hours) || !(hours > RESET_MIN_HOURS_LEFT)) return none;
  const window = windowKey(weekly.reset_at);
  const fableFresh = fresh(fable, nowMs) ? fable : null;
  const hit: Record<ResetDraftKind, boolean> = {
    weekly: weekly.used_pct >= RESET_THRESHOLD_PCT,
    fable: fableFresh !== null && fableFresh.used_pct >= RESET_THRESHOLD_PCT,
  };
  const bothExhausted = weekly.used_pct >= 100 && fableFresh !== null && fableFresh.used_pct >= 100;
  // One draft per kind per window, and never a repeat inside a week.
  let kinds = (['weekly', 'fable'] as const).filter(kind =>
    hit[kind] && state[kind]?.window !== window && !withinWeek(state[kind], nowMs));
  if (!bothExhausted) {
    const otherDrafted = (kind: ResetDraftKind): boolean => withinWeek(state[kind === 'weekly' ? 'fable' : 'weekly'], nowMs);
    kinds = kinds.filter(kind => !otherDrafted(kind));
    if (kinds.length === 2) kinds = ['weekly'];
  }
  if (kinds.length === 0) return none;
  const draftedAt = new Date(nowMs).toISOString();
  const next: ResetRuleState = { ...state };
  const drafts = kinds.map((kind): ResetDraft => {
    const reading = kind === 'weekly' ? weekly : fableFresh!;
    next[kind] = { drafted_at: draftedAt, window };
    return { kind, used_pct: reading.used_pct, weekly_reset_at: weekly.reset_at!, hours_to_weekly_reset: round1(hours),
      source: reading.source, observed_at: reading.observed_at };
  });
  return { drafts, state: next };
}

export interface ResetDecision {
  schema: typeof RESET_DECISION_SCHEMA;
  id: string;
  created_at: string;
  audience: 'mason-only';
  status: 'draft';
  /** Agents never perform a reset. */
  agent_may_act: false;
  title: string;
  question: string;
  drafts: ResetDraft[];
}

/** One decision for every draft that fired in this pass. */
export function renderResetDecision(drafts: readonly ResetDraft[], nowMs: number): ResetDecision {
  const createdAt = new Date(nowMs).toISOString();
  const lines = drafts.map(draft => {
    const name = draft.kind === 'fable' ? 'Fable reset' : 'Weekly reset';
    const what = draft.kind === 'fable' ? 'Fable is at' : 'The Claude weekly allowance is at';
    const of = draft.kind === 'fable' ? ' of its share' : '';
    return `${name}: ${what} ${draft.used_pct}%${of} with ${draft.hours_to_weekly_reset} h before the weekly reset (${draft.weekly_reset_at}). Source ${draft.source}, observed ${draft.observed_at}.`;
  });
  return {
    schema: RESET_DECISION_SCHEMA,
    // Named by window and kinds, so a pass that is retried rewrites one file.
    id: `resource-live-reset-${windowKey(drafts[0]!.weekly_reset_at).replace(/[-:.]/g, '')}-${drafts.map(draft => draft.kind).join('-')}`,
    created_at: createdAt,
    audience: 'mason-only',
    status: 'draft',
    agent_may_act: false,
    title: drafts.length === 1 ? `Claude ${drafts[0]!.kind} reset: your call` : 'Claude resets: your call',
    question: `${lines.join(' ')} Use the reset? Only you can click it. No agent will.`,
    drafts: [...drafts],
  };
}
