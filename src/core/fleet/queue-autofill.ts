/**
 * `phm queue autofill --lane <lane> [--min <n>] [--apply] [--json]`: keep a lane's ready queue from running dry.
 * Pure core. Reads the lane's running, target and queued counts, and when the lane has fewer than `min` ready jobs
 * it takes candidates in order: open Ideas items, follow-ups from recent EMPTY jobs, then `bets propose`; it drops any that already exist in the checkout
 * (the bets check) or are already in the queue, and returns the rest as the gap to fill.
 * Unknown counts stay null: a lane whose queue cannot be read is never filled blind.
 */
import { titleHash } from './supply.js';
import type { BetsProposal, BetsProposeReport } from './bets-propose.js';
import { stepZeroPrompt, stripStepZero, type AutofillCandidate, type AutofillSource } from './autofill-sources.js';
import { jobFamily } from './slot-yield.js';
import { inferRequiredCapabilities, laneLacks, type LaneCapabilityOverrides } from './lane-capabilities.js';
import type { GenerationDecision } from '../queue/generator-yield.js';

export const QUEUE_AUTOFILL_SCHEMA = 'queue.autofill.v1' as const;

/** `goal` is the plain task; `prompt` is what the queue gets: the Step-0 line, the ship-partial rule, then the goal. */
export interface AutofillDraft { id: string; repo: string; tier: string; goal: string; prompt: string; acceptance: string; why: string; source: AutofillSource }
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
  trace?: GenerationDecision[];
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
  /** Open Ideas items, then recent EMPTY-job follow-ups, in the order they are tried; before the bets. */
  first?: readonly AutofillCandidate[];
  /** Ideas that were already queued, running or shipped. */
  shippedIdeas?: readonly string[];
  /** Job families `phm jobs empty --by-family` marks `stop`; their candidates are skipped. */
  stoppedFamilies?: ReadonlySet<string>;
  /** Declared lane capabilities that replace the built-in list (tests, live config). */
  capabilities?: LaneCapabilityOverrides;
}

const clip = (s: string, n = 100): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const why = (p: BetsProposal): string =>
  `From ${p.evidence.path}${p.evidence.line ? `:${p.evidence.line}` : ''} (${p.source}); the bets check says ${p.verdict}.`;
const betCandidate = (p: BetsProposal): AutofillCandidate => ({ id: p.id, repo: p.repo, goal: p.goal, acceptance: p.acceptance, why: why(p), source: 'bet', family: jobFamily(p.id) });

export function planAutofill(input: AutofillInput): QueueAutofillReport {
  const { lane, min, running, target, queued } = input;
  const trace: GenerationDecision[] = [];
  const base = { schema: QUEUE_AUTOFILL_SCHEMA, lane, min, running, target, queued, applied: false, drafted: [] as AutofillDraft[], skipped: [] as AutofillSkip[], trace };
  if (queued === null) return { ...base, summary: 'Queue depth is unknown, so nothing was drafted.' };
  const gap = min - queued;
  if (gap <= 0) return { ...base, summary: 'Lane is full.' };

  const ids = new Set(input.existing.map(job => job.id));
  const hashes = new Map(input.existing.map(job => [titleHash(stripStepZero(job.scope)), job.id]));
  const skipped: AutofillSkip[] = [
    ...(input.shippedIdeas ?? []).map(goal => ({ goal: clip(goal), reason: 'Already queued or shipped: the Ideas list says so.' })),
    ...(input.proposed.droppedGoals ?? []).map(goal => ({ goal: clip(goal), reason: 'Already shipped: the bets check found it in this checkout.' })),
  ];
  const drafted: AutofillDraft[] = [];
  for (const goal of input.shippedIdeas ?? []) trace.push({ job: `idea-${titleHash(goal)}`, src: 'autofill:idea', event: 'rejected', reason: 'already_queued_or_completed' });
  for (const goal of input.proposed.droppedGoals ?? []) trace.push({ job: `bet-${titleHash(goal)}`, src: 'autofill:bet', event: 'rejected', reason: 'already_completed' });
  for (const c of [...(input.first ?? []), ...input.proposed.proposals.map(betCandidate)]) {
    const reject = (reason: GenerationDecision['reason']) => trace.push({ job: c.id, src: `autofill:${c.source}`, event: 'rejected', reason });
    const queuedAs = ids.has(c.id) ? c.id : hashes.get(titleHash(c.goal));
    if (queuedAs) { reject('duplicate'); skipped.push({ goal: clip(c.goal), reason: `Already queued as ${queuedAs}.` }); continue; }
    if (input.stoppedFamilies?.has(c.family)) { reject('stopped_family'); skipped.push({ goal: clip(c.goal), reason: `Family ${c.family} is stopped: most of its jobs end empty.` }); continue; }
    // A lane declared to lack a capability (claude has no gh) is never handed a job that needs it; unknown is not a refusal.
    const lacks = laneLacks(lane, inferRequiredCapabilities(`${c.goal}\n${c.acceptance}`), false, input.capabilities);
    if (lacks) { reject('missing_capability'); skipped.push({ goal: clip(c.goal), reason: `Lane ${lane} cannot use ${lacks}, and this job needs it.` }); continue; }
    if (drafted.length >= gap) break;
    drafted.push({ id: c.id, repo: c.repo, tier: 'work', goal: c.goal, prompt: stepZeroPrompt(c.goal), acceptance: c.acceptance, why: c.why, source: c.source });
    trace.push({ job: c.id, src: `autofill:${c.source}`, event: 'drafted' });
    ids.add(c.id); hashes.set(titleHash(c.goal), c.id);
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
  for (const d of r.drafted) lines.push(`${r.applied ? 'Queued' : 'Draft'} ${d.id} (${d.source}): ${clip(d.goal, 140)}`);
  for (const s of r.skipped) lines.push(`Skipped "${s.goal}": ${s.reason}`);
  if (r.drafted.length && !r.applied) lines.push('Add --apply to write these to the queue.');
  return lines;
}
