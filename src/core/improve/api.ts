/**
 * The one import for other loops that feed or read the outcome ledger: the PR
 * autopilot, the task-to-PR pipeline, the cloud backlog. They record what they
 * proposed and which PR carries it; `phm improve measure` adds the paired
 * base/head measurements; they read realized leverage back to rank their own
 * work. Unknown stays unknown: nothing here turns a missing measurement into 0.
 *
 *   import { recordProposal, rankWork } from '../improve/api.js';
 *   const { proposalId } = recordProposal({ key: `autopilot:${repo}#${pr}`, title, kind: 'ci-fix',
 *     source: { kind: 'model', engine: 'claude', model }, metric, pr: { repository: repo, number: pr } });
 *   const next = rankWork(candidates, (c) => c.kind);
 */
import { createHash } from 'node:crypto';
import {
  appendLedger, kindLeverage, kindOf, rankByKindLeverage, readLedger, scoreOutcomes,
  type LedgerEvent, type MetricSpec, type ProposalOutcome, type ProposerSource,
} from './outcomes.js';

export type { MetricSpec, ProposalOutcome, ProposerSource } from './outcomes.js';
export { kindOf } from './outcomes.js';

/** Stable 10-hex proposal id for a caller-chosen key, e.g. `autopilot:ashlrai/phantom#747`. */
export const proposalIdFor = (key: string) => createHash('sha256').update(`proposal:${key}`).digest('hex').slice(0, 10);

export interface RecordProposalInput {
  /** Caller-unique key; the same key always maps to the same proposal. */
  key: string;
  title: string;
  /** Free-form label, normalized with kindOf(); ranking groups by it. */
  kind: string;
  source: ProposerSource;
  metric: MetricSpec;
  pr?: { repository: string; number: number };
  predictedDelta?: number | null;
}

/**
 * Register a proposal (once per key) and attach its PR (once per PR). Safe to
 * call repeatedly: returns which events it actually appended. Throws when the
 * ledger is broken or an input is invalid, so callers never record into a
 * chain that would be ignored.
 */
export function recordProposal(input: RecordProposalInput, opts: { path?: string } = {}): { proposalId: string; appended: LedgerEvent['type'][] } {
  const proposalId = proposalIdFor(input.key);
  const read = readLedger(opts.path);
  if (!read.intact) throw new Error(`Outcome ledger is not intact (${read.reasons.join(', ')}).`);
  const mine = read.records.filter((r) => r.proposalId === proposalId);
  const appended: LedgerEvent['type'][] = [];
  if (!mine.some((r) => r.type === 'registered')) {
    appendLedger({ type: 'registered', proposalId, title: input.title.slice(0, 200), proposalKind: kindOf(input.kind), source: input.source,
      metric: input.metric, predictedDelta: input.predictedDelta ?? null }, opts);
    appended.push('registered');
  }
  if (input.pr && !mine.some((r) => r.type === 'pr' && r.repository === input.pr!.repository && r.number === input.pr!.number)) {
    appendLedger({ type: 'pr', proposalId, repository: input.pr.repository, number: input.pr.number }, opts);
    appended.push('pr');
  }
  return { proposalId, appended };
}

/** Scored outcomes; an unreadable or broken ledger yields its verified prefix plus `intact: false`. */
export function outcomes(opts: { path?: string } = {}): { intact: boolean; outcomes: ProposalOutcome[] } {
  const read = readLedger(opts.path);
  return { intact: read.intact, outcomes: scoreOutcomes(read.records) };
}

/** Realized leverage per normalized kind; null = no measured outcome yet. Empty on a broken ledger. */
export function leverageByKind(opts: { path?: string } = {}): Map<string, number | null> {
  const read = readLedger(opts.path);
  return read.intact ? kindLeverage(scoreOutcomes(read.records)) : new Map();
}

/**
 * Order any work list by the realized leverage of each item's kind: proven
 * positive first (best first), then unmeasured (explore, original order), then
 * zero or negative. Stable; a broken ledger leaves the order unchanged.
 */
export function rankWork<T>(items: readonly T[], kind: (item: T) => string | undefined, opts: { path?: string } = {}): T[] {
  return rankByKindLeverage(items, (item) => { const k = kind(item); return k ? kindOf(k) : undefined; }, leverageByKind(opts));
}
