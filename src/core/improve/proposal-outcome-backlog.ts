/**
 * Improve outcome-ledger recurring adverse evidence → self-improvement backlog items.
 *
 * Phantom's self-improvement loop keeps its own scorecard in
 * `$ASHLR_HOME/improve/outcomes.jsonl`, an append-only digest-chained ledger
 * (`src/core/improve/outcomes.ts`): `phm improve register`/`sync-backlog`
 * record a proposal's declared metric, `phm improve measure` records base and
 * head measurements, `phm improve promote` records gate decisions, and
 * `phm improve observe` records merges and reverts. Until now the ledger only
 * ever reached `phm improve outcomes` (a report someone had to run), the
 * north-star vision read and the backlog's own area-leverage ranking — so the
 * loop's measured verdicts never became work. Four recurring evidence shapes
 * become items here:
 *
 *   - measurement stalls: registered proposals with a recorded PR but zero
 *     `measured` events past a grace period. Registration IS automated — the
 *     cloud scheduler's syncCloudBacklogOutcomes registers every unclosed
 *     backlog PR whose item declares a metric — but measure, promote and
 *     observe are manual verbs no scheduled pass runs, so the ledger can
 *     accumulate hypotheses it can never score and area-leverage ranking
 *     starves for evidence;
 *   - unknown measurements: in-window `measured` events that returned no
 *     value. measureAt yields null with a recorded reason when the checkout
 *     misses the commit, the metric script is absent, confinement refuses
 *     the run or the runner exits without the contract line — recurring
 *     unknowns mean the declared metrics cannot be measured at all;
 *   - measured regressions: proposals whose declared metric scored worse at
 *     the PR head than at the merge base inside the window. Backlog-registered
 *     PRs merge through the fleet's normal merge machinery — the promote gate
 *     only covers `phm improve propose` PRs — so a regressed verdict is
 *     fleet-merged work that failed its own success criterion, or a metric
 *     declaration that never measured what the item claimed;
 *   - reverted observations: proposals whose last recorded observation is a
 *     revert inside the window — self-improvement work that merged and then
 *     did not hold (the same reverts post-merge-observations.jsonl folds at
 *     fleet level, here tied to registered proposals and their metrics).
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The ledger is read through readLedger's bounded 8 MiB
 *    digest-chain-verified read and folded by scoreOutcomes — the same fold
 *    `phm improve outcomes` prints; nothing is written and no network is
 *    touched.
 *  - Degraded evidence yields no items. A missing ledger reads as empty; a
 *    broken chain or unreadable file marks the read not intact and the whole
 *    source stays quiet — unknown stays unknown, never a guessed tally.
 *  - Recurring means recorded. Each signal emits only at
 *    PROPOSAL_OUTCOME_RECURRING distinct proposals (the fleet's
 *    RECURRING_FAILURES convention), so one bad proposal never queues a
 *    session; the unknown-measurement signal additionally needs
 *    PROPOSAL_OUTCOME_UNKNOWN_MIN_EVENTS recorded events across
 *    PROPOSAL_OUTCOME_UNKNOWN_MIN_PROPOSALS proposals inside the window.
 *  - Event-recency signals window on the establishing event's own `at`
 *    timestamp inside PROPOSAL_OUTCOME_WINDOW_MS (7 days, the sibling
 *    recurrence window). The stall count is a current-state tally instead —
 *    a proposal that never got measured is stalled however old its
 *    registration — gated by PROPOSAL_OUTCOME_UNMEASURED_GRACE_MS so a
 *    freshly registered proposal is never called stalled.
 *  - Fleet machinery only. The verbs, the scheduler sync and the metric
 *    contract are this repository's machinery, so items emit only for the
 *    fleet's own repository ('phantom' last-segment match, the same rule
 *    the sibling machinery feeds apply).
 *  - Dedup is downstream. The item id embeds a stable hash of the signal
 *    kind (never the counts or titles), so a refresh re-derives the same id
 *    and appendUserBacklogItems adds only what is new; shifted tallies do
 *    not spawn twin items, and a signal that recovers simply stops
 *    re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts, ages and
 *    titles are quoted only as recorded (titles scrubbed and flattened),
 *    the ledger path and the reporting commands are named, and the brief
 *    keeps the usual no-change escape for evidence that has rolled forward.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { scrubSecrets } from '../util/scrub.js';
import {
  outcomesLedgerPath,
  readLedger,
  scoreOutcomes,
  type LedgerRead,
  type LedgerRecord,
} from './outcomes.js';

/** Items one call may emit; the signal set is four fixed umbrellas. */
export const PROPOSAL_OUTCOME_BACKLOG_MAX_ITEMS = 8;
const PROPOSAL_OUTCOME_ITEM_HARD_MAX = 25;
/**
 * Distinct proposals a signal needs before it counts as recurring — the
 * fleet's RECURRING_FAILURES convention the sibling machinery feeds apply.
 */
export const PROPOSAL_OUTCOME_RECURRING = 3;
/** Event-recency window for the verdict and unknown-measurement signals (7 days). */
export const PROPOSAL_OUTCOME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * A registered proposal must be this old before 'never measured' counts as a
 * stall — measurement is a manual verb and a fresh registration has not had
 * its chance yet.
 */
export const PROPOSAL_OUTCOME_UNMEASURED_GRACE_MS = 24 * 60 * 60 * 1000;
/** Unknown-measurement signal bars: recorded events and distinct proposals inside the window. */
export const PROPOSAL_OUTCOME_UNKNOWN_MIN_EVENTS = 3;
export const PROPOSAL_OUTCOME_UNKNOWN_MIN_PROPOSALS = 2;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: the outcome machinery is this repo's. */
const FLEET_REPO_NAME = 'phantom';
/** Ledger-recorded text is unbounded; flatten, scrub and cap before use. */
const MAX_FIELD_CHARS = 160;
const MAX_REASONS_QUOTED = 3;
const MAX_TITLES_QUOTED = 5;

export interface ProposalOutcomeItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Outcome ledger path override (default: outcomesLedgerPath() under the Ashlr home). */
  ledgerPath?: string;
  /** Injected ledger read (tests); skips the file read when set. An explicit not-intact read yields no items. */
  ledger?: LedgerRead;
  /** Most items one call emits (default PROPOSAL_OUTCOME_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock for the window, grace and stall-age reads (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

/** Ledger-recorded text is unbounded; flatten, scrub and cap before use. */
function fieldText(value: string, max: number = MAX_FIELD_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

interface MeasuredEvent { atMs: number; value: number | null; reason: string | null }
interface ProposalFold {
  registeredAtMs: number | null;
  hasPr: boolean;
  measured: MeasuredEvent[];
  lastObservedAtMs: number | null;
  lastObservedKind: 'merged' | 'reverted' | null;
}

const emptyFold = (): ProposalFold => ({ registeredAtMs: null, hasPr: false, measured: [], lastObservedAtMs: null, lastObservedKind: null });

/** Per-proposal event fold: registration time, PR presence, measurements and the last observation. */
function foldProposalEvents(records: readonly LedgerRecord[]): Map<string, ProposalFold> {
  const folds = new Map<string, ProposalFold>();
  for (const r of records) {
    const atMs = Date.parse(r.at);
    if (Number.isNaN(atMs)) continue;
    let f = folds.get(r.proposalId);
    if (f === undefined) { f = emptyFold(); folds.set(r.proposalId, f); }
    switch (r.type) {
      case 'registered': f.registeredAtMs = atMs; break;
      case 'pr': f.hasPr = true; break;
      case 'measured': f.measured.push({ atMs, value: r.value, reason: r.reason }); break;
      case 'observed': f.lastObservedAtMs = atMs; f.lastObservedKind = r.observation; break;
      default: break;
    }
  }
  return folds;
}

const inWindow = (atMs: number, nowMs: number): boolean => atMs >= nowMs - PROPOSAL_OUTCOME_WINDOW_MS;

interface StallTally { stalled: number; withPr: number; oldestRegisteredAtMs: number | null }

function tallyStalls(folds: ReadonlyMap<string, ProposalFold>, nowMs: number): StallTally {
  let stalled = 0;
  let withPr = 0;
  let oldest: number | null = null;
  for (const f of folds.values()) {
    if (f.registeredAtMs === null) continue;
    if (f.hasPr) withPr += 1;
    if (!f.hasPr || f.measured.length > 0) continue;
    // A proposal whose last observation is a revert is dead evidence — it can
    // never be measured meaningfully, so it is not a measurement stall.
    if (f.lastObservedKind === 'reverted') continue;
    if (nowMs - f.registeredAtMs < PROPOSAL_OUTCOME_UNMEASURED_GRACE_MS) continue;
    stalled += 1;
    if (oldest === null || f.registeredAtMs < oldest) oldest = f.registeredAtMs;
  }
  return { stalled, withPr, oldestRegisteredAtMs: oldest };
}

interface UnknownTally { events: number; proposals: Set<string>; reasons: Map<string, number> }

function tallyUnknownMeasurements(records: readonly LedgerRecord[], nowMs: number): UnknownTally {
  const out: UnknownTally = { events: 0, proposals: new Set(), reasons: new Map() };
  for (const r of records) {
    if (r.type !== 'measured' || r.value !== null) continue;
    const atMs = Date.parse(r.at);
    if (Number.isNaN(atMs) || !inWindow(atMs, nowMs)) continue;
    out.events += 1;
    out.proposals.add(r.proposalId);
    if (r.reason !== null) {
      const reason = fieldText(r.reason, MAX_FIELD_CHARS);
      if (reason !== '') out.reasons.set(reason, (out.reasons.get(reason) ?? 0) + 1);
    }
  }
  return out;
}

function topReasons(reasons: ReadonlyMap<string, number>): string[] {
  return [...reasons.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_REASONS_QUOTED)
    .map(([reason]) => `'${reason}'`);
}

const dayCount = (ms: number): string => `${Math.round((ms / 86_400_000) * 10) / 10}`;

function unmeasuredPrompt(t: StallTally, nowMs: number): string {
  const age = t.oldestRegisteredAtMs === null ? 'unknown' : `${dayCount(nowMs - t.oldestRegisteredAtMs)} day(s)`;
  return [
    `Phantom's self-improvement outcome ledger shows ${t.stalled} registered proposal(s) with a recorded PR but no 'measured' event — the oldest has waited ${age} since registration.`,
    '',
    `The ledger is improve/outcomes.jsonl under the Ashlr home (~/.ashlr or $ASHLR_HOME); \`phm improve outcomes --json\` prints the same scorecard. Registration is automated — the cloud scheduler's syncCloudBacklogOutcomes registers every unclosed backlog PR whose item declares a metric — but measurement, promotion evaluation and post-merge observation are the manual verbs \`phm improve measure\`, \`promote\` and \`observe\`, which no scheduled pass runs. The ledger therefore accumulates hypotheses it can never score: every stalled proposal's area-leverage ranking stays unknown and the backlog's measured-leverage ordering starves for evidence. Of ${t.withPr} registered proposal(s) with a PR, ${t.stalled} have waited past the ${Math.round(PROPOSAL_OUTCOME_UNMEASURED_GRACE_MS / 3_600_000)}h grace with no measurement.`,
    '',
    'What is in scope is the pipeline around the verbs: whether measurement should run on a schedule (a cloud-scheduler tick, a daemon pass or a queue job driving measureAt and appending measured events), whether measure/promote/observe should collapse into one automated pass, or whether proposals that can never be measured — closed PRs, withdrawn items — should be recorded as terminal instead of stalling. Check src/core/improve/outcomes.ts, measure.ts, backlog-sync.ts and the scheduler tick in src/core/cloud/cloud-api.ts, fix the cause in this repository, and run the affected suite. If an operator pass has measured these proposals since this evidence — report no-change and name the evidence.',
  ].join('\n');
}

function unknownPrompt(t: UnknownTally): string {
  const reasons = topReasons(t.reasons);
  return [
    `Phantom's improve outcome ledger recorded ${t.events} 'measured' event(s) across ${t.proposals.size} distinct proposal(s) inside the ${Math.round(PROPOSAL_OUTCOME_WINDOW_MS / 86_400_000)}-day window that returned no value — the declared metrics are failing to measure.`,
    '',
    reasons.length > 0 ? `Recorded reasons, most frequent first: ${reasons.join(', ')}.` : 'No reason text was recorded on the null measurements.',
    '',
    `The ledger is improve/outcomes.jsonl under the Ashlr home; \`phm improve outcomes --json\` prints per-proposal reasons. measureAt (src/core/improve/measure.ts) returns null with a reason when the checkout misses the requested commit, the metric script is absent at that commit, standing confinement refuses the run, or the runner exits without printing the {"metric","value"} contract line. Recurring unknowns mean the scorecard stays blind exactly where evidence was promised. What is in scope: the metric declarations backlog items carry (validateMetricSpec in src/core/improve/outcomes.ts, the metric field in src/core/cloud/backlog.ts and discover.ts item prompts), the runner confinement and npm-script/node-path resolution in measure.ts, or proposals whose metrics were never runnable. If the failures were a transient checkout or runner outage that no longer reproduces — report no-change and name the evidence.`,
  ].join('\n');
}

function titlesPrompt(outcomes: readonly { title: string }[]): string {
  const titles = outcomes
    .map((o) => fieldText(o.title, 80))
    .filter((t) => t !== '')
    .slice(0, MAX_TITLES_QUOTED);
  return titles.length === 0 ? '' : `Newest affected: ${titles.map((t) => `'${t}'`).join('; ')}.`;
}

function regressedPrompt(count: number, outcomes: readonly { title: string }[]): string {
  return [
    `Phantom's improve outcome ledger shows ${count} registered proposal(s) whose declared metric measured worse at the PR head than at the merge base inside the ${Math.round(PROPOSAL_OUTCOME_WINDOW_MS / 86_400_000)}-day window — self-improvement work failing its own success criterion.`,
    '',
    titlesPrompt(outcomes),
    '',
    `The ledger is improve/outcomes.jsonl under the Ashlr home; \`phm improve outcomes --json\` prints effects, statuses and reasons. Note the merge path: proposals registered from cloud backlog items have their PRs merged by the fleet's normal merge machinery — the promote gate (evaluatePromotion in src/core/improve/promote.ts) only covers \`phm improve propose\` PRs — so a regressed verdict means fleet-merged work landed while its declared metric got worse, or the metric declaration never measured what the item claimed. What is in scope: whether backlog items' metric declarations are meaningful and runnable (the metric field in src/core/cloud/backlog.ts and the item prompts discover.ts emits), whether the fleet merge path should consult measured outcomes before landing registered work, or whether the base/head measurement itself is biased (src/core/improve/measure.ts, outcomes.ts phaseValue). If the window has rolled forward to improved or unknown verdicts — report no-change and name the evidence.`,
  ].filter((line) => line !== '').join('\n');
}

function revertedPrompt(count: number, outcomes: readonly { title: string }[]): string {
  return [
    `Phantom's improve outcome ledger shows ${count} registered proposal(s) whose PRs merged and were then reverted inside the ${Math.round(PROPOSAL_OUTCOME_WINDOW_MS / 86_400_000)}-day window — self-improvement work that did not hold.`,
    '',
    titlesPrompt(outcomes),
    '',
    `The ledger is improve/outcomes.jsonl under the Ashlr home; \`phm improve observe\` records the merged/reverted observations and \`phm improve outcomes --json\` prints them. fleet/post-merge-observations.jsonl folds the same reverts at fleet level; this ledger ties them to registered proposals and their declared metrics, grouped by proposalKind. Recurring reverts mean the changes being championed do not hold — check whether the evidence bar for queueing these proposal kinds is too weak, whether revert detection (revertedPrKeys in src/core/improve/reverted.ts, observeOutcomes in observe.ts) misfires on re-lands, or whether specific proposal kinds keep producing unstable work. If the reverts were already handled by follow-up fixes — report no-change and name the evidence.`,
  ].filter((line) => line !== '').join('\n');
}

type Signal = 'unmeasured' | 'unknown' | 'regressed' | 'reverted';

const AREAS: Record<Signal, string> = {
  unmeasured: 'outcome-stall',
  unknown: 'outcome-unknown',
  regressed: 'outcome-regressed',
  reverted: 'outcome-reverted',
};

const TITLES: Record<Signal, string> = {
  unmeasured: 'Improve outcome ledger: registered proposals never get measured',
  unknown: 'Improve metric runners keep returning unknown',
  regressed: 'Registered improvement proposals keep regressing on their metric',
  reverted: 'Registered improvement proposals keep merging then reverting',
};

function outcomeItem(signal: Signal, prompt: string, repo: string): CloudBacklogItem {
  return {
    id: `improve-outcome-${sha(`improve-outcome:${signal}`)}`,
    title: TITLES[signal].slice(0, MAX_TITLE_CHARS),
    prompt,
    area: AREAS[signal],
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the improve outcome ledger's recurring adverse evidence.
 * Total: a missing or not-intact ledger, another repository, or any
 * unexpected failure yields fewer/no items rather than throwing into
 * discovery.
 */
export async function proposalOutcomeBacklogItems(opts: ProposalOutcomeItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const read: LedgerRead = opts.ledger ?? readLedger(opts.ledgerPath ?? outcomesLedgerPath());
    // Healthy-only evidence bar: a missing ledger reads as empty, but a
    // broken chain or unreadable file is unknown — never a guessed tally.
    if (!read.intact) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const folds = foldProposalEvents(read.records);
    if (folds.size === 0) return [];
    const windowStartMs = nowMs - PROPOSAL_OUTCOME_WINDOW_MS;

    const candidates: { signal: Signal; prompt: string }[] = [];

    // Measurement stalls: registered proposals with a PR and zero measured
    // events past the grace — a current-state tally, not windowed.
    const stalls = tallyStalls(folds, nowMs);
    if (stalls.stalled >= PROPOSAL_OUTCOME_RECURRING) {
      candidates.push({ signal: 'unmeasured', prompt: unmeasuredPrompt(stalls, nowMs) });
    }

    // Unknown measurements: in-window measured events that returned no value.
    const unknown = tallyUnknownMeasurements(read.records, nowMs);
    if (unknown.events >= PROPOSAL_OUTCOME_UNKNOWN_MIN_EVENTS && unknown.proposals.size >= PROPOSAL_OUTCOME_UNKNOWN_MIN_PROPOSALS) {
      candidates.push({ signal: 'unknown', prompt: unknownPrompt(unknown) });
    }

    // Measured regressions and reverted observations: scoreOutcomes supplies
    // the verdict classification (including the re-land rule for reverts);
    // the event fold supplies the establishing timestamps for windowing and
    // recency ordering.
    const outcomes = scoreOutcomes(read.records);
    const measuredAt = (proposalId: string): number => {
      const f = folds.get(proposalId);
      return f === undefined ? Number.NEGATIVE_INFINITY : Math.max(...f.measured.map((m) => m.atMs), Number.NEGATIVE_INFINITY);
    };
    const observedAt = (proposalId: string): number => folds.get(proposalId)?.lastObservedAtMs ?? Number.NEGATIVE_INFINITY;
    const newestFirst = (a: { proposalId: string }, b: { proposalId: string }, at: (id: string) => number) => at(b.proposalId) - at(a.proposalId) || a.proposalId.localeCompare(b.proposalId);
    const regressed = outcomes
      .filter((o) => o.status === 'regressed' && o.reverted === null && measuredAt(o.proposalId) >= windowStartMs)
      .sort((a, b) => newestFirst(a, b, measuredAt));
    if (regressed.length >= PROPOSAL_OUTCOME_RECURRING) {
      candidates.push({ signal: 'regressed', prompt: regressedPrompt(regressed.length, regressed) });
    }
    const reverted = outcomes
      .filter((o) => o.reverted !== null && observedAt(o.proposalId) >= windowStartMs)
      .sort((a, b) => newestFirst(a, b, observedAt));
    if (reverted.length >= PROPOSAL_OUTCOME_RECURRING) {
      candidates.push({ signal: 'reverted', prompt: revertedPrompt(reverted.length, reverted) });
    }

    const limit = Math.max(1, Math.min(opts.limit ?? PROPOSAL_OUTCOME_BACKLOG_MAX_ITEMS, PROPOSAL_OUTCOME_ITEM_HARD_MAX));
    return candidates.slice(0, limit).map((c) => outcomeItem(c.signal, c.prompt, repo));
  } catch {
    return [];
  }
}
