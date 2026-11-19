/**
 * `phm queue autofill --lane <lane> [--min <n>] [--apply] [--json]`: keep a lane's ready queue from running dry.
 * Pure core. Reads the lane's running, target and queued counts, and when the lane has fewer than `min` ready jobs
 * it takes bets from `bets propose` (the existing proposal source), drops any that already exist in the checkout
 * (the bets check) or are already in the queue, and returns the rest as the gap to fill.
 * Unknown counts stay null: a lane whose queue cannot be read is never filled blind.
 */
import { titleHash } from './supply.js';
import type { BetsProposal, BetsProposeReport } from './bets-propose.js';

export const QUEUE_AUTOFILL_SCHEMA = 'queue.autofill.v1' as const;

export interface AutofillDraft { id: string; repo: string; tier: string; goal: string; acceptance: string; why: string }
export interface AutofillSkip { goal: string; reason: string }
export interface QueueAutofillReport {
  schema: typeof QUEUE_AUTOFILL_SCHEMA;
  lane: string;
  min: number;
  running: number | null;
  target: number | null;
  queued: number | null;
  /** True once the drafts were written to the queue. */
  applied: boolean;
  /** One plain sentence: what happened and why. */
  summary: string;
  drafted: AutofillDraft[];
  skipped: AutofillSkip[];
}
export interface AutofillQueued { id: string; scope: string }
export interface AutofillInput {
  lane: string;
  min: number;
  running: number | null;
  target: number | null;
  queued: number | null;
  /** Jobs already in the queue file, any status, so a bet is never written twice. */
  existing: readonly AutofillQueued[];
  proposed: Pick<BetsProposeReport, 'proposals' | 'droppedGoals'>;
}

const clip = (s: string, n = 100): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const why = (p: BetsProposal): string =>
  `From ${p.evidence.path}${p.evidence.line ? `:${p.evidence.line}` : ''} (${p.source}); the bets check says ${p.verdict}.`;

export function planAutofill(input: AutofillInput): QueueAutofillReport {
  const { lane, min, running, target, queued } = input;
  const base = { schema: QUEUE_AUTOFILL_SCHEMA, lane, min, running, target, queued, applied: false, drafted: [] as AutofillDraft[], skipped: [] as AutofillSkip[] };
  if (queued === null) return { ...base, summary: 'Queue depth is unknown, so nothing was drafted.' };
  const gap = min - queued;
  if (gap <= 0) return { ...base, summary: 'Lane is full.' };

  const ids = new Set(input.existing.map(job => job.id));
  const hashes = new Map(input.existing.map(job => [titleHash(job.scope), job.id]));
  const skipped: AutofillSkip[] = (input.proposed.droppedGoals ?? []).map(goal => ({ goal: clip(goal), reason: 'Already shipped: the bets check found it in this checkout.' }));
  const drafted: AutofillDraft[] = [];
  for (const p of input.proposed.proposals) {
    const queuedAs = ids.has(p.id) ? p.id : hashes.get(titleHash(p.goal));
    if (queuedAs) { skipped.push({ goal: clip(p.goal), reason: `Already queued as ${queuedAs}.` }); continue; }
    if (drafted.length >= gap) break;
    drafted.push({ id: p.id, repo: p.repo, tier: 'work', goal: p.goal, acceptance: p.acceptance, why: why(p) });
  }
  const short = gap - drafted.length;
  const summary = drafted.length === 0
    ? `Lane needs ${gap} more but no new bets were found.`
    : `Lane has ${queued} of ${min} ready; drafted ${drafted.length}${short > 0 ? `, ${short} short (no more new bets found)` : ''}.`;
  return { ...base, drafted, skipped, summary };
}

export function autofillLines(r: QueueAutofillReport): string[] {
  const state = (n: number | null): string => (n === null ? 'unknown' : String(n));
  const lines = [`Lane ${r.lane}: ${state(r.running)} running, target ${state(r.target)}, ${state(r.queued)} queued, want ${r.min}.`, r.summary];
  for (const d of r.drafted) lines.push(`${r.applied ? 'Queued' : 'Draft'} ${d.id}: ${clip(d.goal, 140)}`);
  for (const s of r.skipped) lines.push(`Skipped "${s.goal}": ${s.reason}`);
  if (r.drafted.length && !r.applied) lines.push('Add --apply to write these to the queue.');
  return lines;
}
