/**
 * Scheduled post-merge observation for the self-improvement outcome ledger.
 *
 * `phm improve observe --repo <dir>` is the deep pass: it asks GitHub and a
 * local checkout's default-branch history whether each registered proposal's
 * PR merged, and whether a later commit reverted it. Nothing ran it on a
 * timer, so `observed` events only reached improve/outcomes.jsonl when an
 * operator remembered the verb — merges stayed invisible and standing
 * reverts never discounted the proposals that caused them, leaving
 * area-leverage ranking and proposer comparison blind (the stall
 * proposal-outcome-backlog.ts reports).
 *
 * This sync closes the checkout-free half of that gap on the same scheduler
 * tick that registers proposals (backlog-sync.ts). It appends `observed`
 * events built only from evidence that already exists off-repo:
 *
 *   - a merged cloud task's recorded outcome (`outcome.mergeSha`, and
 *     `outcome.revertedBy` when no revert-ledger verdict exists for the PR);
 *   - the newest record per PR in improve/revert-outcomes.jsonl — the
 *     git-verified scan `phm fleet reverts --record` writes. A record whose
 *     `relandedBy` is set is positive re-land evidence and supplies the
 *     commit; `relandedBy: null` is a standing revert.
 *
 * When both sources cover a PR the revert journal wins: it is the dedicated,
 * append-only, scan-verified store, while `outcome.revertedBy` is a mutable
 * single field last written by a manual observe pass.
 *
 * Honesty rules:
 *   - A proposal is observed only through its own ledger events: it needs a
 *     `registered` hypothesis and a `pr` event, and the PR key must match
 *     evidence. Nothing is inferred for proposals the ledger does not tie
 *     to a PR.
 *   - A standing `reverted` observation clears only on re-land evidence
 *     (a revert record's `relandedBy`, or a fresh merge observation for a
 *     proposal with none). Merge evidence alone never resurrects a reverted
 *     proposal — same rule scoreOutcomes applies.
 *   - An unreadable revert ledger contributes no journal evidence (its
 *     verified prefix can be staler than the task fields it would override);
 *     task outcome fields still apply and `revertLedger` reports 'unreadable'.
 *   - The pass is total and idempotent: a corrupt outcome ledger or an
 *     unavailable store appends nothing and says why; a second run on
 *     unchanged evidence appends nothing.
 */
import { appendLedger, readLedger, type LedgerEvent, type LedgerRead, type LedgerRecord } from './outcomes.js';
import { prKey } from './lesson-trial.js';
import { readRevertOutcomeRecords, type RevertLedgerRead } from './revert-ledger.js';
import type { RevertOutcomeRecord } from './reverted.js';
import { listCloudTasks } from '../cloud/store.js';
import type { CloudTaskV1 } from '../cloud/types.js';

const SHA40 = /^[0-9a-f]{40}$/;
const sha = (v: unknown): string | null => (typeof v === 'string' && SHA40.test(v) ? v : null);

/** Post-merge evidence for one PR, keyed by `prKey(repository, number)`. */
interface PrEvidence {
  /** Exact merge commit on the default branch; null when no source recorded one. */
  mergeSha: string | null;
  /** Standing revert commit; null when the change stands or no source saw a revert. */
  revertSha: string | null;
  /** Commit that re-landed the change after a revert (revert record's relandedBy). */
  relandSha: string | null;
  /** Task-field revert candidate, used only when the revert journal has no verdict for the PR. */
  taskRevertSha: string | null;
  /** True when the newest revert-ledger record supplied the revert verdict. */
  ledgerVerdict: boolean;
}

const emptyEvidence = (): PrEvidence => ({ mergeSha: null, revertSha: null, relandSha: null, taskRevertSha: null, ledgerVerdict: false });

/**
 * Fold task outcomes and the revert journal into per-PR evidence. The
 * journal's newest record per PR is authoritative for revert state: a
 * `relandedBy` clears the revert and names the re-land commit. Task
 * `outcome.revertedBy` is the fallback for PRs the journal never scanned.
 */
export function outcomeObservationEvidence(
  tasks: readonly CloudTaskV1[],
  revertRecords: readonly RevertOutcomeRecord[],
): Map<string, PrEvidence> {
  const byPr = new Map<string, PrEvidence>();
  const entry = (key: string): PrEvidence => {
    let e = byPr.get(key);
    if (!e) { e = emptyEvidence(); byPr.set(key, e); }
    return e;
  };
  for (const task of tasks) {
    const pr = task.pr;
    if (!pr || (pr.state !== 'merged' && task.state !== 'merged')) continue;
    const e = entry(prKey(task.repo, pr.number));
    e.mergeSha ??= sha(task.outcome?.mergeSha);
    e.taskRevertSha ??= sha(task.outcome?.revertedBy);
  }
  const newest = new Map<string, RevertOutcomeRecord>();
  for (const rec of revertRecords) newest.set(rec.pr, rec);
  for (const [key, rec] of newest) {
    const e = entry(key);
    e.mergeSha ??= rec.mergeSha;
    e.ledgerVerdict = true;
    if (rec.relandedBy === null) { e.revertSha = rec.revertedBy; e.relandSha = null; }
    else { e.revertSha = null; e.relandSha = rec.relandedBy; }
  }
  for (const e of byPr.values()) if (!e.ledgerVerdict) e.revertSha = e.taskRevertSha;
  return byPr;
}

type ObservedRecord = LedgerRecord & { type: 'observed' };

/** The observation events that move one proposal's ledger tail to the evidence state. */
export function observationEvents(
  proposalId: string,
  records: readonly LedgerRecord[],
  evidence: PrEvidence,
): LedgerEvent[] {
  const last = [...records].reverse().find((r): r is ObservedRecord => r.type === 'observed');
  let desired: { observation: 'merged' | 'reverted'; sha: string; reland: boolean } | null = null;
  if (evidence.revertSha !== null) desired = { observation: 'reverted', sha: evidence.revertSha, reland: false };
  else if (evidence.relandSha !== null) desired = { observation: 'merged', sha: evidence.relandSha, reland: true };
  else if (evidence.mergeSha !== null) desired = { observation: 'merged', sha: evidence.mergeSha, reland: false };
  if (desired === null) return [];

  if (desired.observation === 'reverted') {
    if (last?.observation === 'reverted' && last.sha === desired.sha) return [];
    const events: LedgerEvent[] = [];
    // A fresh proposal records the merge it is being reverted from first;
    // a proposal already observed needs only the new tail event.
    if (last === undefined && evidence.mergeSha !== null) {
      events.push({ type: 'observed', proposalId, observation: 'merged', sha: evidence.mergeSha });
    }
    events.push({ type: 'observed', proposalId, observation: 'reverted', sha: desired.sha });
    return events;
  }

  if (last?.observation === 'reverted') {
    // Merge evidence alone cannot clear a standing revert; only a recorded
    // re-land (the revert journal's relandedBy) can.
    if (!desired.reland) return [];
    return [{ type: 'observed', proposalId, observation: 'merged', sha: desired.sha }];
  }
  if (last?.observation === 'merged' && last.sha === desired.sha) return [];
  return [{ type: 'observed', proposalId, observation: 'merged', sha: desired.sha }];
}

export interface OutcomeObservationSyncDeps {
  /** Cloud task store read; defaults to every stored task. */
  tasks?: () => readonly CloudTaskV1[];
  /** Outcome ledger read; defaults to readLedger. */
  ledger?: () => LedgerRead;
  /** Revert-outcomes journal read; defaults to readRevertOutcomeRecords. */
  reverts?: () => RevertLedgerRead;
  /** Ledger append; defaults to appendLedger. */
  append?: (event: LedgerEvent) => unknown;
}

export interface OutcomeObservationSync {
  /** False when the outcome ledger could not be read intact; nothing was written. */
  intact: boolean;
  /** Digest-chain break reasons when intact is false. */
  reasons: string[];
  /** Registered proposals with a PR event that were examined. */
  proposals: number;
  /** Of those, how many had post-merge evidence to record. */
  matched: number;
  /** Ledger events appended by this call. */
  appended: number;
  /** Appended events by observation kind. */
  merged: number;
  reverted: number;
  /** 'unreadable' when the revert journal could not be trusted whole; task outcome fields still applied. */
  revertLedger: 'read' | 'missing' | 'unreadable';
  /** Set when the pass stopped early; absent on a complete run. */
  reason?: 'source-unavailable' | 'append-failed';
}

/**
 * Append `observed` events for every registered proposal whose PR has
 * checkout-free post-merge evidence — merged task outcomes and the
 * revert-outcomes journal. Safe to run on the scheduler tick beside
 * syncCloudBacklogOutcomes: never throws, appends nothing on an unreadable
 * ledger, and a repeat call on unchanged evidence appends nothing.
 */
export function syncCloudOutcomeObservations(deps: OutcomeObservationSyncDeps = {}): OutcomeObservationSync {
  const out: OutcomeObservationSync = {
    intact: true, reasons: [], proposals: 0, matched: 0, appended: 0, merged: 0, reverted: 0, revertLedger: 'missing',
  };
  let records: LedgerRecord[];
  let tasks: readonly CloudTaskV1[];
  let revertRead: RevertLedgerRead;
  try {
    const led = (deps.ledger ?? readLedger)();
    if (!led.intact) return { ...out, intact: false, reasons: led.reasons };
    records = led.records;
    tasks = (deps.tasks ?? (() => listCloudTasks(Number.MAX_SAFE_INTEGER)))();
    revertRead = (deps.reverts ?? readRevertOutcomeRecords)();
  } catch {
    return { ...out, reason: 'source-unavailable' };
  }
  out.revertLedger = revertRead.state;
  const evidence = outcomeObservationEvidence(tasks, revertRead.state === 'read' ? revertRead.records : []);

  const byProposal = new Map<string, LedgerRecord[]>();
  for (const r of records) byProposal.set(r.proposalId, [...(byProposal.get(r.proposalId) ?? []), r]);

  const jobs: { proposalId: string; events: LedgerEvent[] }[] = [];
  for (const [proposalId, rs] of byProposal) {
    if (!rs.some((r) => r.type === 'registered')) continue;
    const prEvent = [...rs].reverse().find((r): r is LedgerRecord & { type: 'pr' } => r.type === 'pr');
    if (!prEvent) continue;
    out.proposals += 1;
    const ev = evidence.get(prKey(prEvent.repository, prEvent.number));
    if (!ev || (ev.mergeSha === null && ev.revertSha === null && ev.relandSha === null)) continue;
    out.matched += 1;
    const events = observationEvents(proposalId, rs, ev);
    if (events.length > 0) jobs.push({ proposalId, events });
  }

  const append = deps.append ?? ((event: LedgerEvent) => appendLedger(event));
  for (const job of jobs) {
    for (const event of job.events) {
      try {
        append(event);
      } catch {
        return { ...out, reason: 'append-failed' };
      }
      out.appended += 1;
      if (event.type === 'observed' && event.observation === 'merged') out.merged += 1;
      if (event.type === 'observed' && event.observation === 'reverted') out.reverted += 1;
    }
  }
  return out;
}
