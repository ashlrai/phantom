/**
 * Post-merge credit release funnel recurring failures → backlog items.
 *
 * Every resident daemon producer-maintenance pass runs
 * sweepPostMergeCreditReleases (src/core/fleet/post-merge-credit.ts): it
 * re-scans applied proposals, evaluates each one's release eligibility —
 * authenticated merge witness, elapsed observation window, clean adverse
 * ledger, manifested stability witness, signing — and records the outcome
 * on the tick as producerMaintenance.postMergeCredit{Scanned,Released,
 * Skipped,SourceComplete,SkippedByReason}, persisted on each entry of the
 * `ticks` history daemon.json keeps (capped at 100). Released credit is
 * the labelBasis attestPostMergeCreditSkillCard signs onto learned-skill
 * cards, so a funnel that keeps failing closed starves the learned-skills
 * minting lane this machinery exists to feed. Until now the only reader
 * was `phm daemon status`, which prints the LAST tick's summary: a ledger
 * that stays degraded, a witness timestamp that never parses, an
 * eligibility path that keeps throwing, or a sweep whose sources keep
 * reporting incomplete was invisible as a pattern — each bad pass looked
 * like a one-off. creditReleaseBacklogItems carries the retained history
 * into discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the daemon tick-health source beside
 * it (same state file, same bounded read, same fleet-repo gate).
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. daemon.json is read through readSource's bounded no-follow
 *    whole-file read; nothing is written and no network is touched. Only
 *    the `ticks[].ts` and `ticks[].producerMaintenance.postMergeCredit*`
 *    fields are consumed — the state file's spend, dispatch and backlog
 *    fields never reach a prompt.
 *  - Healthy-only evidence. A missing state file yields no items (a fresh
 *    install has no daemon — that is normal, not a finding); an
 *    unreadable, oversized or unparseable file, or a `ticks` value that
 *    is not an array, yields no items — unknown stays unknown, never a
 *    guessed tally.
 *  - Recency-windowed. Only ticks whose `ts` parses inside
 *    CREDIT_RELEASE_WINDOW_MS of the clock count, so a daemon that
 *    stopped sweeping weeks ago never queues work for stale failures; a
 *    tick with no parseable timestamp cannot be placed in the window and
 *    is ignored.
 *  - Recurring means recorded across passes. A skip reason emits only
 *    after CREDIT_RELEASE_RECURRING distinct in-window sweep ticks carried
 *    it — the fleet's RECURRING_FAILURES convention applied to passes, not
 *    rows: one degraded pass that skips two hundred proposals counts once,
 *    because the pass-level record is what proves the machinery stayed
 *    broken. skippedByReason tallies rows within ONE pass, so row sums
 *    are quoted as context, never as the recurrence count.
 *  - Designed holds never emit. The funnel's vocabulary mixes machinery
 *    failures with deliberate waits, and only the waits are safe to
 *    ignore: 'observation-window-not-elapsed' (merge still inside the
 *    14-day window), 'no-authenticated-merge-witness' (no realized-merge
 *    evidence yet), 'no-positive-stability-witness' (waiting on the
 *    manifested-witness lane), 'adverse-outcome-observed' (a recorded
 *    adverse outcome — already folded by postmerge-backlog), and
 *    'report-only-operational-release-disabled' (the
 *    POST_MERGE_CREDIT_OPERATIONAL_RELEASE ops gate — a policy state like
 *    tick-health's 'budget-exhausted', an owner decision, not a bug).
 *    'clean-window-elapsed' is the success reason and never appears in
 *    skippedByReason at all. A reason outside both lists is unclassified:
 *    it emits with the verify-it-is-machinery framing rather than being
 *    silently dropped.
 *  - Incomplete sources emit too. postMergeCreditSourceComplete === false
 *    means the applied-proposal list read degraded, a per-proposal
 *    decisions read degraded, or the 200-candidate cap truncated the
 *    pass — proposals can starve unevaluated while it lasts. The tick
 *    record cannot say which of the three fired, so the item quotes the
 *    possibilities honestly. And when a pass reports skipped rows beyond
 *    the sum of its recorded eligibility reasons with a complete source,
 *    the excess are skips the per-proposal catch logged without a reason
 *    (a throw around readDecisions/recordDecision/causalMetadata) —
 *    emitted as its own cell since no reason vocabulary can name it.
 *  - Known blind spot, stated: sweepPostMergeCreditReleases never throws,
 *    but if it did the tick would carry no postMergeCredit* fields at
 *    all — those ticks read as "sweep did not run" and are context, not
 *    evidence. The fold cannot invent a tally the state file does not
 *    record.
 *  - The daemon's machinery is this repository's: the sweep, its ledgers
 *    and the state file are Phantom's own code. Items therefore emit only
 *    when the backlog target's repository name is 'phantom', the same
 *    last-segment rule the sibling fleet-evidence sources apply;
 *    self-improvement pointed at another repository never inherits this
 *    install's credit-funnel evidence it cannot attribute.
 *  - Dedup is downstream. The item id embeds a stable hash of the skip
 *    reason or cell kind (never the counts or timestamps), so a refresh
 *    re-derives the same id and appendUserBacklogItems adds only what is
 *    new; a funnel that recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: reason names are
 *    scrubbed, flattened to one line and capped before they reach the
 *    prompt, counts are quoted only as recorded, and the brief carries
 *    the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readSource } from '../fleet/runs-parked-queue.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the reason vocabulary is bounded in practice. */
export const CREDIT_RELEASE_MAX_ITEMS = 8;
const CREDIT_RELEASE_ITEM_HARD_MAX = 25;
/**
 * Sweep passes inside the retained window a reason or cell needs before it
 * counts as recurring — the same absolute-evidence bar
 * TICK_HEALTH_RECURRING and LOCAL_GATE_RECURRING_FAILURES apply.
 */
export const CREDIT_RELEASE_RECURRING = 3;
/** Evidence window: the daemon sweeps far more often than this, so it covers the whole retained history of a live install. */
export const CREDIT_RELEASE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** daemon.json is metadata-only state; 4 MiB is many times the realistic size (100 ticks × bounded ledgers). */
const CREDIT_RELEASE_MAX_STATE_BYTES = 4 * 1024 * 1024;
/** The writer caps ticks at 100; the fold re-caps defensively. */
const CREDIT_RELEASE_MAX_TICKS = 200;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded reason keys are unbounded text; flatten, scrub and cap before use. */
const MAX_REASON_CHARS = 120;
/** Future-skew allowance on tick timestamps, same convention the friction fold applies. */
const CREDIT_RELEASE_FUTURE_SKEW_MS = 60_000;
/** The fleet's own repository label: credit-funnel evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** State-file path named inside item prompts, relative to the ASHLR root. */
const DAEMON_STATE_RELATIVE = 'daemon.json';
/** The sweep's own candidate bound (MAX_SWEEP_CANDIDATES upstream) — named so prompts can quote it. */
const SWEEP_CANDIDATE_CAP = 200;

/**
 * Skip reasons the fold knows are machinery failures — each gets its own
 * diagnostic framing. Everything not in this set and not in
 * DESIGNED_HOLD_REASONS emits with the unclassified framing.
 */
const ADVERSE_REASONS: ReadonlyMap<string, string> = new Map([
  ['error',
    'evaluatePostMergeCreditRelease\'s catch-all fired — the throw is inside the eligibility path (authenticatedRealizedMergeOf, readPostMergeObservations, readPostMergeStability, postMergeObservationEventId or computeCreditMac) or a callee; reproduce against the recorded applied-proposal set or add targeted logging to find which'],
  ['observation-ledger-degraded',
    'readPostMergeObservations({requireComplete:true}) returned degraded or incomplete — the adverse-outcome ledger cannot prove clean, so every evaluated proposal fails closed; find which ledger file or partition is unreadable, oversized or chain-broken (src/core/fleet/post-merge-observations.ts)'],
  ['stability-ledger-degraded',
    'readPostMergeStability({requireComplete:true}) returned degraded or incomplete — the manifested-witness store cannot prove stability, so every evaluated proposal fails closed; find which store file or partition is unreadable, oversized or chain-broken (src/core/fleet/post-merge-stability.ts)'],
  ['invalid-merge-timestamp',
    'a realized-merge witness\'s observedAt (or its github-host reconciliation.observedAt) fails Date.parse — a witness producer is writing an unparseable timestamp; find which inbox/reconciliation path emits it'],
  ['signing-unavailable',
    'computeCreditMac returned null — the credit signing key path failed; unreachable while POST_MERGE_CREDIT_OPERATIONAL_RELEASE stays false, so if this reason is recorded the ops gate has opened and signing itself is broken (foundry provenance loadOrCreateKey)'],
]);

/**
 * Skip reasons that are designed holds, never machinery: the funnel's
 * normal waiting states plus the deliberate ops gate. They count toward
 * funnel context only — an item never emits for them.
 */
const DESIGNED_HOLD_REASONS: ReadonlySet<string> = new Set([
  'no-authenticated-merge-witness',
  'observation-window-not-elapsed',
  'adverse-outcome-observed',
  'no-positive-stability-witness',
  'report-only-operational-release-disabled',
  'clean-window-elapsed',
]);

export interface CreditReleaseItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** ASHLR root override for the state file (default: ~/.ashlr, daemonStatePath()'s own resolution — ASHLR_HOME does not relocate daemon.json). */
  rootDir?: string;
  /** Most items one call emits (default CREDIT_RELEASE_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the evidence window (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** ASHLR root the daemon state file lives under: explicit override, else ~/.ashlr — daemonStatePath()'s own resolution (ASHLR_HOME is NOT consulted for daemon.json). */
function ashlrRoot(rootDir: string | undefined): string {
  if (rootDir !== undefined && rootDir.trim() !== '') return rootDir;
  return join(homedir(), '.ashlr');
}

/** Ledger-recorded reason keys are unbounded text; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// Tolerant fold of daemon.json's ticks[] producerMaintenance.postMergeCredit*
// ---------------------------------------------------------------------------

/** The credit-sweep fields one tick's producerMaintenance record may carry. */
interface CreditSweepRow {
  /** Finite postMergeCreditScanned — its presence marks the pass as having run. */
  scanned: number;
  released: number | null;
  skipped: number | null;
  sourceComplete: boolean | null;
  /** Sanitized reason → summed in-pass skip rows (context; recurrence counts ticks). */
  reasonRows: Map<string, number>;
}

interface TickRow {
  tsMs: number;
  ts: string;
  credit: CreditSweepRow | null;
}

/** A finite recorded count, or null when the field is absent or not a usable number. */
function finiteCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Parse one persisted tick; null when it cannot be placed inside the evidence window. */
function tickRow(value: unknown, windowStartMs: number, windowEndMs: number): TickRow | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row['ts'] !== 'string') return null;
  const tsMs = Date.parse(row['ts']);
  if (!Number.isFinite(tsMs) || tsMs < windowStartMs || tsMs > windowEndMs) return null;
  const pm = typeof row['producerMaintenance'] === 'object' && row['producerMaintenance'] !== null && !Array.isArray(row['producerMaintenance'])
    ? row['producerMaintenance'] as Record<string, unknown>
    : null;
  const scanned = pm === null ? null : finiteCount(pm['postMergeCreditScanned']);
  let credit: CreditSweepRow | null = null;
  if (pm !== null && scanned !== null) {
    const rawReasons = typeof pm['postMergeCreditSkippedByReason'] === 'object' && pm['postMergeCreditSkippedByReason'] !== null && !Array.isArray(pm['postMergeCreditSkippedByReason'])
      ? pm['postMergeCreditSkippedByReason'] as Record<string, unknown>
      : {};
    const reasonRows = new Map<string, number>();
    for (const [rawKey, rawValue] of Object.entries(rawReasons).slice(0, 64)) {
      const key = fieldText(rawKey, MAX_REASON_CHARS);
      const count = finiteCount(rawValue);
      if (key === '' || count === null || count <= 0) continue;
      reasonRows.set(key, (reasonRows.get(key) ?? 0) + count);
    }
    const sourceComplete = pm['postMergeCreditSourceComplete'];
    credit = {
      scanned,
      released: finiteCount(pm['postMergeCreditReleased']),
      skipped: finiteCount(pm['postMergeCreditSkipped']),
      sourceComplete: typeof sourceComplete === 'boolean' ? sourceComplete : null,
      reasonRows,
    };
  }
  return { tsMs, ts: row['ts'], credit };
}

export interface CreditReleaseReasonTally {
  /** Sanitized skip reason as recorded. */
  reason: string;
  /** Distinct in-window sweep ticks that recorded this reason with rows > 0. */
  ticks: number;
  /** Summed in-pass skip rows across those ticks — context, never the recurrence count. */
  rows: number;
  /** ISO timestamps bounding the reason's in-window observations. */
  firstSeen: string;
  lastSeen: string;
}

export interface CreditReleaseFold {
  /** In-window ticks the fold consumed. */
  ticks: number;
  /** Ticks dropped for a missing/unparseable/out-of-window timestamp. */
  skippedTicks: number;
  /** In-window ticks where the credit sweep ran (postMergeCreditScanned recorded). */
  sweeps: number;
  /** Summed scanned/released/skipped rows across sweep ticks — funnel context. */
  scanned: number;
  released: number;
  skipped: number;
  /** Sweep ticks reporting postMergeCreditSourceComplete === false. */
  sourceIncompleteTicks: number;
  firstSourceIncompleteAt: string | null;
  lastSourceIncompleteAt: string | null;
  /**
   * Sweep ticks where skipped rows exceeded the summed recorded eligibility
   * reasons while the source reported complete — skips the per-proposal
   * catch logged without a reason (throws around the decisions write-back).
   */
  unattributedSkipTicks: number;
  firstUnattributedSkipAt: string | null;
  lastUnattributedSkipAt: string | null;
  reasons: CreditReleaseReasonTally[];
}

/**
 * Fold persisted daemon ticks into the credit-release funnel's tallies.
 * Pure: `rows` is the already-parsed `ticks` array (or any equivalent row
 * list); rows that cannot be placed inside [now-window, now+skew] are
 * counted under skippedTicks, never guessed into the window. Ticks whose
 * producerMaintenance carries no postMergeCreditScanned are passes where
 * the sweep did not run — context, never evidence.
 */
export function foldCreditRelease(rows: readonly unknown[], now: Date = new Date(), windowMs: number = CREDIT_RELEASE_WINDOW_MS): CreditReleaseFold {
  const nowMs = now.getTime();
  const windowStartMs = nowMs - windowMs;
  const windowEndMs = nowMs + CREDIT_RELEASE_FUTURE_SKEW_MS;
  const fold: CreditReleaseFold = {
    ticks: 0, skippedTicks: 0, sweeps: 0,
    scanned: 0, released: 0, skipped: 0,
    sourceIncompleteTicks: 0, firstSourceIncompleteAt: null, lastSourceIncompleteAt: null,
    unattributedSkipTicks: 0, firstUnattributedSkipAt: null, lastUnattributedSkipAt: null,
    reasons: [],
  };
  const byReason = new Map<string, CreditReleaseReasonTally>();

  for (const raw of rows.slice(-CREDIT_RELEASE_MAX_TICKS)) {
    const tick = tickRow(raw, windowStartMs, windowEndMs);
    if (tick === null) { fold.skippedTicks += 1; continue; }
    fold.ticks += 1;
    const credit = tick.credit;
    if (credit === null) continue;
    fold.sweeps += 1;
    fold.scanned += credit.scanned;
    if (credit.released !== null) fold.released += credit.released;
    if (credit.skipped !== null) fold.skipped += credit.skipped;

    if (credit.sourceComplete === false) {
      fold.sourceIncompleteTicks += 1;
      fold.firstSourceIncompleteAt ??= tick.ts;
      fold.lastSourceIncompleteAt = tick.ts;
    }

    // Every recorded reason row is attributed; the residual skipped rows
    // are skips no reason names. Only a pass that reported a COMPLETE
    // source makes the residual pure per-proposal-catch evidence — an
    // incomplete pass explains its own unattributed source-quality skips.
    if (
      credit.sourceComplete === true &&
      credit.skipped !== null &&
      credit.skipped > [...credit.reasonRows.values()].reduce((a, b) => a + b, 0)
    ) {
      fold.unattributedSkipTicks += 1;
      fold.firstUnattributedSkipAt ??= tick.ts;
      fold.lastUnattributedSkipAt = tick.ts;
    }

    for (const [reason, rows_] of credit.reasonRows) {
      if (!(rows_ > 0)) continue;
      let tally = byReason.get(reason);
      if (tally === undefined) {
        tally = { reason, ticks: 0, rows: 0, firstSeen: tick.ts, lastSeen: tick.ts };
        byReason.set(reason, tally);
      }
      tally.ticks += 1;
      tally.rows += rows_;
      tally.lastSeen = tick.ts;
    }
  }

  fold.reasons = [...byReason.values()]
    .sort((a, b) => b.ticks - a.ticks || b.rows - a.rows || a.reason.localeCompare(b.reason));
  return fold;
}

// ---------------------------------------------------------------------------
// Backlog items
// ---------------------------------------------------------------------------

interface BacklogCandidate {
  item: CloudBacklogItem;
  /** Recorded pass count — the sort key, never part of the item. */
  passes: number;
}

/** The funnel context every prompt quotes: what the sweep is and what the window recorded. */
function funnelContext(fold: CreditReleaseFold): string {
  const designed = fold.reasons
    .filter((r) => DESIGNED_HOLD_REASONS.has(r.reason))
    .map((r) => `${r.reason} ${r.rows}`)
    .join(', ');
  return [
    `Funnel context: ${fold.sweeps} in-window sweep pass(es) scanned ${fold.scanned} applied proposal(s), released ${fold.released}, skipped ${fold.skipped}.`,
    designed === ''
      ? 'Designed holds (never emit items): none recorded in-window.'
      : `Designed holds recorded (context only, never items): ${designed}.`,
  ].join('\n');
}

function evidenceFooter(): string {
  return [
    `The ledger is ${DAEMON_STATE_RELATIVE} under ~/.ashlr (daemonStatePath()'s resolution; ASHLR_HOME does not relocate it): each ticks[].producerMaintenance.postMergeCredit* field records one producer-maintenance pass — postMergeCreditScanned/Released/Skipped/SourceComplete plus postMergeCreditSkippedByReason's per-reason in-pass tallies. \`phm daemon status --json\` shows only the LAST tick's summary, so recurrence is invisible there, and src/core/fleet/post-merge-credit.ts documents the release protocol's fail-closed checks. Ticks without postMergeCreditScanned are passes where the sweep did not run.`,
    'Designed holds that never become items: observation-window-not-elapsed, no-authenticated-merge-witness, no-positive-stability-witness, adverse-outcome-observed (already folded by the post-merge observation source), report-only-operational-release-disabled (the POST_MERGE_CREDIT_OPERATIONAL_RELEASE ops gate — a policy state, not a bug) and clean-window-elapsed (the success reason). If investigation shows the recurring signal is one of those designed states or a transient window that no longer reproduces, report no-change and name the evidence.',
  ].join('\n');
}

function reasonItem(t: CreditReleaseReasonTally, fold: CreditReleaseFold, repo: string): BacklogCandidate {
  const id = `credit-release-${createHash('sha256').update(`reason:${t.reason}`).digest('hex').slice(0, 16)}`;
  const guidance = ADVERSE_REASONS.get(t.reason);
  const title = (guidance !== undefined
    ? `Post-merge credit sweep keeps recording '${t.reason}'`
    : `Post-merge credit sweep keeps recording unclassified '${t.reason}'`).slice(0, MAX_TITLE_CHARS);
  const lead = guidance !== undefined
    ? `Phantom's daemon state recorded the post-merge credit release sweep skipping proposals for '${t.reason}' on ${t.ticks} of ${fold.sweeps} in-window sweep pass(es) — ${t.rows} recorded skip row(s) total. ${guidance}. The self-improvement machinery's own release funnel failing closed, recurring across the retained history.`
    : `Phantom's daemon state recorded the post-merge credit release sweep skipping proposals for '${t.reason}' on ${t.ticks} of ${fold.sweeps} in-window sweep pass(es) — ${t.rows} recorded skip row(s) total. This fold does not classify the reason: determine whether it is a machinery failure or a designed hold the vocabulary gained since this fold shipped; if designed, report no-change and name the evidence.`;
  const prompt = [
    lead,
    '',
    `Window: ${t.firstSeen} → ${t.lastSeen}.`,
    '',
    funnelContext(fold),
    '',
    evidenceFooter(),
  ].join('\n');
  return {
    item: {
      id,
      title,
      prompt,
      area: 'credit-release',
      priority: 3,
      ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
    },
    passes: t.ticks,
  };
}

function cellItem(kind: 'source-incomplete' | 'unattributed-skip', fold: CreditReleaseFold, repo: string): BacklogCandidate {
  const hashKey = kind === 'source-incomplete' ? 'source:incomplete' : 'skip:unattributed';
  const id = `credit-release-${createHash('sha256').update(hashKey).digest('hex').slice(0, 16)}`;
  const title = (kind === 'source-incomplete'
    ? 'Post-merge credit sweep keeps reporting incomplete sources'
    : 'Post-merge credit sweep keeps logging unattributed skips').slice(0, MAX_TITLE_CHARS);
  const firstSeen = kind === 'source-incomplete' ? fold.firstSourceIncompleteAt : fold.firstUnattributedSkipAt;
  const lastSeen = kind === 'source-incomplete' ? fold.lastSourceIncompleteAt : fold.lastUnattributedSkipAt;
  const ticks = kind === 'source-incomplete' ? fold.sourceIncompleteTicks : fold.unattributedSkipTicks;
  const lead = kind === 'source-incomplete'
    ? `Phantom's daemon state recorded the post-merge credit release sweep reporting sourceComplete:false on ${ticks} of ${fold.sweeps} in-window sweep pass(es). The pass could not see everything: the applied-proposal list read degraded (listProposalsDetailed), a per-proposal decisions read degraded, or the ${SWEEP_CANDIDATE_CAP}-candidate cap truncated the pass — proposals can starve unevaluated while it lasts. The tick record cannot say which of the three fired.`
    : `Phantom's daemon state recorded the post-merge credit release sweep logging skipped proposals beyond the sum of its recorded eligibility reasons on ${ticks} of ${fold.sweeps} in-window sweep pass(es) while reporting a complete source. Those excess skips are the per-proposal catch firing without a reason — a throw around readDecisions, recordDecision or causalMetadataFromProposal that no eligibility reason can name.`;
  const prompt = [
    `${lead} The self-improvement machinery's own release funnel degrading, recurring across the retained history.`,
    '',
    `Window: ${firstSeen ?? 'unknown'} → ${lastSeen ?? 'unknown'}.`,
    '',
    funnelContext(fold),
    '',
    evidenceFooter(),
  ].join('\n');
  return {
    item: {
      id,
      title,
      prompt,
      area: 'credit-release',
      priority: 3,
      ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
    },
    passes: ticks,
  };
}

/**
 * Backlog items for the post-merge credit release funnel's recurring
 * machinery failures — adverse or unclassified skip reasons, incomplete
 * source passes and unattributed skips — worst-recorded first. Total: any
 * read or fold failure yields no items rather than throwing into
 * discovery.
 */
export async function creditReleaseBacklogItems(opts: CreditReleaseItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const statePath = join(ashlrRoot(opts.rootDir), DAEMON_STATE_RELATIVE);
    const read = await readSource(statePath, CREDIT_RELEASE_MAX_STATE_BYTES, false);
    if (read.state !== 'healthy') return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      return [];
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
    const ticks = (parsed as Record<string, unknown>)['ticks'];
    if (!Array.isArray(ticks)) return [];
    const fold = foldCreditRelease(ticks, opts.now ?? new Date());

    const candidates: BacklogCandidate[] = [];
    for (const tally of fold.reasons) {
      if (tally.ticks < CREDIT_RELEASE_RECURRING || DESIGNED_HOLD_REASONS.has(tally.reason)) continue;
      candidates.push(reasonItem(tally, fold, repo));
    }
    if (fold.sourceIncompleteTicks >= CREDIT_RELEASE_RECURRING && fold.firstSourceIncompleteAt !== null) {
      candidates.push(cellItem('source-incomplete', fold, repo));
    }
    if (fold.unattributedSkipTicks >= CREDIT_RELEASE_RECURRING && fold.firstUnattributedSkipAt !== null) {
      candidates.push(cellItem('unattributed-skip', fold, repo));
    }
    candidates.sort((a, b) => b.passes - a.passes || a.item.id.localeCompare(b.item.id));
    const limit = Math.max(1, Math.min(opts.limit ?? CREDIT_RELEASE_MAX_ITEMS, CREDIT_RELEASE_ITEM_HARD_MAX));
    return candidates.slice(0, limit).map((c) => c.item);
  } catch {
    return [];
  }
}
