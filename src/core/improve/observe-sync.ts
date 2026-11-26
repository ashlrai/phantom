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
 *   - the fleet merge-state landing record for a superseded task's intake
 *     proposal — the merge machinery's own merge SHA, which covers fleet
 *     landings whose tracker outcome read failed or predates it;
 *   - the newest record per PR in improve/revert-outcomes.jsonl — the
 *     git-verified scan `phm fleet reverts --record` writes. A record whose
 *     `relandedBy` is set is positive re-land evidence and supplies the
 *     commit; `relandedBy: null` is a standing revert.
 *
 * Both delivery lanes feed this pass: Devin tasks (devin/types.ts
 * DevinTaskV1) claim the same backlog items and share the PR/intake shapes,
 * but carry no `outcome` block — the Devin tracker records no merge or
 * revert SHAs — so a Devin task contributes evidence only through the fleet
 * merge-state record and the revert journal, the same fallback sources a
 * superseded cloud task uses.
 *
 * When both sources cover a PR the revert journal wins: it is the dedicated,
 * append-only, scan-verified store, while `outcome.revertedBy` is a mutable
 * single field last written by a manual observe pass.
 *
 * The PR that actually lands is the carrier, not always `task.pr`: once
 * cloud intake supersedes the cloud PR, the fleet App PR (`supersededBy`)
 * is what merges or reverts on the default branch, and the task's outcome
 * evidence describes it. Evidence is therefore keyed by the carrier PR, and
 * a proposal whose ledger `pr` event still names the closed cloud PR gets a
 * fresh `pr` event re-pointed at the fleet PR — so measurement, promotion
 * checks, revert matching and the reverted-PR sets all follow the PR that
 * carries the work.
 *
 * Honesty rules:
 *   - A proposal is observed only through its own ledger events: it needs a
 *     `registered` hypothesis and a `pr` event, and the PR key must match
 *     evidence. Nothing is inferred for proposals the ledger does not tie
 *     to a PR.
 *   - A `pr` re-key happens only when the task store itself records the
 *     supersede (`supersededBy`); the ledger never guesses a different PR,
 *     and fleet merge-state evidence is accepted only when the record's own
 *     repo and PR number are the task's carrier.
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
import type { CloudIntakeMemo, CloudSupersededBy, CloudTaskPr, CloudTaskState, CloudTaskV1 } from '../cloud/types.js';
import { listDevinTasks } from '../devin/store.js';
import type { DevinTaskV1 } from '../devin/types.js';
import { proposalStateKey, readFleetMergeState, type FleetMergeStateRead } from '../fleet/fleet-merge-state.js';

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
 * The slice of a delivery-lane task the observation fold reads — a cloud
 * CloudTaskV1 or a devin DevinTaskV1. Devin tasks have no `outcome` block
 * (the tracker records no merge/revert SHAs), so their merge evidence comes
 * only from the fleet merge-state record and the revert journal.
 */
export interface OutcomeObservationTask {
  repo: string;
  state: CloudTaskState | 'blocked';
  pr: CloudTaskPr | null;
  supersededBy?: CloudSupersededBy | null;
  intake?: CloudIntakeMemo | null;
  outcome?: { mergeSha?: unknown; revertedBy?: unknown } | null;
}

/**
 * Fold task outcomes and the revert journal into per-PR evidence. The
 * journal's newest record per PR is authoritative for revert state: a
 * `relandedBy` clears the revert and names the re-land commit. Task
 * `outcome.revertedBy` is the fallback for PRs the journal never scanned.
 */
export function outcomeObservationEvidence(
  tasks: readonly OutcomeObservationTask[],
  revertRecords: readonly RevertOutcomeRecord[],
  fleetState: (key: string) => FleetMergeStateRead = readFleetMergeState,
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
    // The carrier PR is the one that lands: a superseded task's fleet App PR
    // (its outcome evidence describes that PR), else the task's own PR. The
    // revert journal keys its records the same way — fleet merges and reverts
    // are recorded under the fleet PR's number.
    const carrier = task.supersededBy ?? null;
    const e = entry(prKey(task.repo, carrier?.number ?? pr.number));
    e.mergeSha ??= sha(task.outcome?.mergeSha);
    e.taskRevertSha ??= sha(task.outcome?.revertedBy);
  }
  // Fleet merge-state records are the merge machinery's own landing evidence.
  // For a superseded task they supply the merge SHA even when the tracker's
  // outcome read failed or predates it — correlated through intake.proposalId
  // and accepted only when the record's own PR and repo are this task's
  // carrier, so a stale or foreign record contributes nothing.
  for (const task of tasks) {
    const by = task.supersededBy;
    const proposalId = task.intake?.proposalId;
    if (!by || !proposalId || task.state !== 'merged') continue;
    const key = proposalStateKey(proposalId);
    if (!key) continue;
    let read: FleetMergeStateRead;
    try {
      read = fleetState(key);
    } catch {
      continue;
    }
    if (read.state !== 'ok') continue;
    const rec = read.record;
    if (rec.kind !== 'change' || rec.proposalId !== proposalId || rec.outcome !== 'merged') continue;
    if (rec.repo.toLowerCase() !== task.repo.toLowerCase() || rec.pr?.number !== by.number) continue;
    const mergeSha = rec.landing?.kind === 'merge' ? rec.landing.mergeSha : rec.merge?.phase === 'merged' ? rec.merge.mergeSha : null;
    const verified = sha(mergeSha);
    if (verified === null) continue;
    entry(prKey(task.repo, by.number)).mergeSha ??= verified;
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
  /**
   * Devin-lane task store read; defaults to every stored Devin task. Devin
   * sessions claim the same backlog items, so their merges and reverts are
   * the same proposal evidence — via the fleet merge-state record and the
   * revert journal, since Devin tasks carry no outcome block. Unreadable ⇒
   * none, matching the claim fold.
   */
  devinTasks?: () => readonly DevinTaskV1[];
  /** Outcome ledger read; defaults to readLedger. */
  ledger?: () => LedgerRead;
  /** Revert-outcomes journal read; defaults to readRevertOutcomeRecords. */
  reverts?: () => RevertLedgerRead;
  /** Fleet merge-state read by state key; defaults to readFleetMergeState. */
  fleetState?: (key: string) => FleetMergeStateRead;
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
  /** Proposals whose ledger `pr` event was re-pointed at a superseding fleet PR. */
  rekeyed: number;
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
    intact: true, reasons: [], proposals: 0, matched: 0, appended: 0, merged: 0, reverted: 0, revertLedger: 'missing', rekeyed: 0,
  };
  let records: LedgerRecord[];
  let tasks: readonly OutcomeObservationTask[];
  let revertRead: RevertLedgerRead;
  try {
    const led = (deps.ledger ?? readLedger)();
    if (!led.intact) return { ...out, intact: false, reasons: led.reasons };
    records = led.records;
    const cloud = (deps.tasks ?? (() => listCloudTasks(Number.MAX_SAFE_INTEGER)))();
    // Devin sessions claim the same backlog items, so their PRs carry the
    // same merge/revert evidence — but an unreadable Devin store must not
    // starve the cloud lane's observations (same rule as the claim fold).
    let devin: readonly DevinTaskV1[] = [];
    try {
      devin = (deps.devinTasks ?? (() => listDevinTasks(Number.MAX_SAFE_INTEGER)))();
    } catch { /* unreadable ⇒ none */ }
    tasks = [...cloud, ...devin];
    revertRead = (deps.reverts ?? readRevertOutcomeRecords)();
  } catch {
    return { ...out, reason: 'source-unavailable' };
  }
  out.revertLedger = revertRead.state;
  const fleetState = deps.fleetState ?? readFleetMergeState;
  const evidence = outcomeObservationEvidence(tasks, revertRead.state === 'read' ? revertRead.records : [], fleetState);

  const byProposal = new Map<string, LedgerRecord[]>();
  for (const r of records) byProposal.set(r.proposalId, [...(byProposal.get(r.proposalId) ?? []), r]);

  // Carrier re-key map: a task's own (closed) cloud PR → the fleet App PR
  // that superseded it. Evidence is keyed by the carrier (see
  // outcomeObservationEvidence), so a proposal still recording the cloud PR
  // is matched through this map — and its ledger `pr` event is re-pointed at
  // the fleet PR, the same event backlogRegistrations emits for tasks first
  // registered after the supersede.
  const carriers = new Map<string, { repository: string; number: number }>();
  for (const t of tasks) {
    if (t.supersededBy && t.pr) carriers.set(prKey(t.repo, t.pr.number), { repository: t.repo, number: t.supersededBy.number });
  }

  const jobs: { proposalId: string; events: LedgerEvent[] }[] = [];
  for (const [proposalId, rs] of byProposal) {
    if (!rs.some((r) => r.type === 'registered')) continue;
    const prEvent = [...rs].reverse().find((r): r is LedgerRecord & { type: 'pr' } => r.type === 'pr');
    if (!prEvent) continue;
    out.proposals += 1;
    const carrier = carriers.get(prKey(prEvent.repository, prEvent.number));
    const events: LedgerEvent[] = [];
    if (carrier && (carrier.number !== prEvent.number || carrier.repository.toLowerCase() !== prEvent.repository.toLowerCase())) {
      events.push({ type: 'pr', proposalId, repository: carrier.repository, number: carrier.number });
      out.rekeyed += 1;
    }
    const ev = evidence.get(prKey(carrier?.repository ?? prEvent.repository, carrier?.number ?? prEvent.number));
    if (ev && (ev.mergeSha !== null || ev.revertSha !== null || ev.relandSha !== null)) {
      out.matched += 1;
      events.push(...observationEvents(proposalId, rs, ev));
    }
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
