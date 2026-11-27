/**
 * Reasoning-insight digest evidence → self-improvement backlog items.
 *
 * The reasoning store ($ASHLR_HOME/reasoning, else ~/.ashlr/reasoning)
 * holds two append-only, private, size-bounded JSONL kinds: scrubbed
 * reasoning steps and text-free TurnFeaturesV1 rows — one per finished
 * agent turn, carrying derived labels only (tool-call failure and loop
 * signatures, outcome, errorClass, uncertainty score, backtrack hits,
 * re-edit counts, verification flags). The verse, fleet, codex-rollout
 * and grok ingests (src/core/reasoning/ingest-*.ts) write them; text is
 * kept 30 days, features 180.
 *
 * DigestBuilder (src/core/reasoning/insights.ts) folds the features into
 * per-(kind, repo, engine, signature) insight clusters — the projection
 * computeReasoningDigest serves the Leader's prompt context, the Verse
 * UI and `phm`'s reasoning surfaces. Until now the only consumer that
 * turned an insight into work was enqueueInsightTasks
 * (src/core/fleet/task-source.ts), which files fleet "add tests" tasks
 * for 'verification-gap' insights alone. Every other kind — 'struggle'
 * (repeated tool failures, error outcomes, give-ups), 'loop' (the same
 * call repeated without an edit), 'uncertainty' and 'backtrack' —
 * reached the Leader and the UI but never the deterministic backlog, so
 * a failure signature, stuck-loop pattern or give-up streak that kept
 * recurring across days looked like per-run noise, never work.
 *
 * reasoningInsightBacklogItems carries the recurring adverse insights
 * into discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue them exactly like the sibling feeds beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The store is scanned through scanFeatures — the same
 *    bounded, day-partitioned, deduplicated reader the digest uses;
 *    nothing is written and no network is touched. The store's own
 *    day-file, row-size and directory-entry caps apply.
 *  - Recorded rows only. A feature row counts only after the store's
 *    own validation (isFeatureRow/normalizeFeature); the digest's
 *    clustering thresholds decide which signals form an insight at all.
 *    Malformed lines are skipped by the reader, never guessed.
 *  - Recurring means recorded across days, proven per insight. An
 *    insight emits only at REASONING_INSIGHT_MIN_COUNT folded
 *    occurrences/turns AND REASONING_INSIGHT_MIN_DAYS distinct UTC
 *    days, where the days are tracked per insight id while the same
 *    feature scan feeds the DigestBuilder — one turn contributes the
 *    UTC day of its endedAt (its `at` start when no end was recorded),
 *    so a single long turn spanning midnight can never fake a second
 *    day. The insight's own count/firstAt/lastAt are quoted as
 *    recorded; days and turn counts come from the same rows.
 *  - 'verification-gap' and 'win' never emit: the first already becomes
 *    fleet tasks through enqueueInsightTasks, the second is a positive
 *    signal, not work.
 *  - Truncation is stated by the store, not hidden: the digest itself
 *    caps insights at 50 and evidence at 5 refs, and this feed emits at
 *    most REASONING_INSIGHT_BACKLOG_MAX_ITEMS in the digest's own
 *    severity-first order.
 *  - Items emit only for the fleet's own repository — the insights
 *    describe this install's agent behavior and the fix surface
 *    (extractors, engine adapters, prompts, harness) lives in this
 *    repository; the insight's repo label is quoted inside the prompt
 *    as evidence context, never as the item's target.
 *  - Dedup is downstream. The item id embeds the insight's stable
 *    `ri-<hash>` id (the digest's cluster-key hash — kind, variant,
 *    repo, engine, signature, never counts or timestamps), so a
 *    refresh re-derives the same id and appendUserBacklogItems adds
 *    only what is new; a cluster that grows worse does not spawn a
 *    twin item.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, engine/repo/signature strings are the
 *    store's scrubbed derived labels, evidence refs are the digest's
 *    own pointers, and the brief carries the usual no-change escape.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  BACKTRACK_TURN_MIN,
  UNCERTAIN_TURN_SCORE,
  type TurnFeaturesV1,
} from '../reasoning/extractors.js';
import { DigestBuilder } from '../reasoning/insights.js';
import { DAY_MS, scanFeatures, utcDay } from '../reasoning/store.js';
import type { ReasoningInsight, ReasoningInsightKind } from '../reasoning/types.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; insights are already capped at 50 and severity-sorted. */
export const REASONING_INSIGHT_BACKLOG_MAX_ITEMS = 8;
const REASONING_INSIGHT_ITEM_HARD_MAX = 25;
/** Evidence window: a week of turns gives recurring patterns room without letting stale evidence linger. */
export const REASONING_INSIGHT_WINDOW_DAYS = 7;
/** Folded occurrences (failure/loop) or turns (the rest) one insight needs inside the window. */
export const REASONING_INSIGHT_MIN_COUNT = 3;
/** Distinct UTC days those occurrences must span — recurring means recorded across days. */
export const REASONING_INSIGHT_MIN_DAYS = 2;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: insight evidence is this install's agent behavior, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Insight kinds that become work. 'verification-gap' already becomes fleet tasks; 'win' is not a problem. */
const EMITTED_KINDS: ReadonlySet<ReasoningInsightKind> = new Set(['struggle', 'loop', 'uncertainty', 'backtrack']);

export interface ReasoningInsightItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /**
   * Reasoning store root override (default reasoningRoot() —
   * $ASHLR_HOME/reasoning when set, else ~/.ashlr/reasoning). Tests pass
   * a temp dir.
   */
  root?: string;
  /** Evidence window in days (default REASONING_INSIGHT_WINDOW_DAYS). */
  days?: number;
  /** Most items one call emits (default REASONING_INSIGHT_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/**
 * One cluster contribution a feature row makes to the digest — the same
 * (kind, variant, signature) triple DigestBuilder.addFeature's cluster()
 * calls use. Mirrored here so the per-insight day tracker keys exactly
 * the clusters the builder folds; a drift makes an insight look
 * single-day and simply never emit (the conservative direction).
 */
interface ClusterKey {
  kind: ReasoningInsightKind;
  variant: string;
  signature: string | null;
}

/**
 * Pure: every insight cluster one feature row feeds, mirroring
 * DigestBuilder.addFeature's cluster() calls in order. Exported for
 * tests; the digest remains the authority on which clusters become
 * insights.
 */
export function featureClusterKeys(feature: TurnFeaturesV1): ClusterKey[] {
  const keys: ClusterKey[] = [];
  for (const failure of feature.failures ?? []) {
    keys.push({ kind: 'struggle', variant: 'failure', signature: failure.signature });
  }
  if (feature.outcome === 'error') {
    keys.push({ kind: 'struggle', variant: 'error', signature: feature.errorClass ?? 'error' });
  }
  if (feature.gaveUp) keys.push({ kind: 'struggle', variant: 'gave-up', signature: null });
  for (const loop of feature.loops ?? []) {
    keys.push({ kind: 'loop', variant: 'loop', signature: loop.signature });
  }
  if (feature.uncertaintyScore >= UNCERTAIN_TURN_SCORE) {
    keys.push({ kind: 'uncertainty', variant: 'uncertainty', signature: null });
  }
  if (feature.backtrackHits >= BACKTRACK_TURN_MIN || feature.reEditedFiles > 0) {
    keys.push({ kind: 'backtrack', variant: 'backtrack', signature: null });
  }
  if (feature.claimUnverified) {
    keys.push({ kind: 'verification-gap', variant: 'claim', signature: null });
  }
  if (feature.verificationGap) {
    keys.push({ kind: 'verification-gap', variant: 'untested', signature: null });
  }
  if (feature.win) keys.push({ kind: 'win', variant: 'win', signature: null });
  return keys;
}

/**
 * Pure: the insight id DigestBuilder.toInsight assigns a cluster —
 * 'ri-' + sha256(kind, variant, repo, engine, signature). Replicated so
 * the day tracker can join feature rows back to published insights; if
 * the digest's formula ever changes the join simply finds no days and
 * the insight never emits.
 */
export function reasoningInsightId(key: ClusterKey, repo: string | null, engine: string): string {
  return 'ri-' + createHash('sha256')
    .update([key.kind, key.variant, repo ?? '', engine ?? '', key.signature ?? ''].join(' '))
    .digest('hex')
    .slice(0, 16);
}

/** Per-insight recurrence evidence gathered while the feature scan feeds the builder. */
interface InsightDays {
  /** Distinct UTC days the contributing turns ended on (endedAt, else at). */
  days: Set<string>;
  /** Distinct contributing turn/feature ids — mirrors the cluster's turns set. */
  turns: Set<string>;
  /** The cluster's sub-kind (failure/error/gave-up/loop/…) — fixed per insight id. */
  variant: string;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Journal-derived text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const NO_CHANGE = 'If the window has rolled forward, the cluster was a bounded incident the fleet recovered from, the recorded labels reflect provider-side outages or owner-side repo/tooling state no repository change can fix — report no-change and name the evidence.';

/**
 * The evidence pointers every prompt shares; the reasoning-store-only
 * gap is named so the session can reproduce the fold.
 */
const EVIDENCE = 'The evidence is the reasoning store under the Phantom state home ($ASHLR_HOME/reasoning, else ~/.ashlr/reasoning) — append-only day-partitioned JSONL the reasoning ingests write (src/core/reasoning/ingest-verse.ts, ingest-fleet.ts, ingest-codex.ts): scrubbed reasoning steps kept 30 days and text-free TurnFeaturesV1 rows kept 180 days, one per finished turn carrying derived labels only — tool-call failure and loop signatures, outcome, errorClass, uncertainty score, backtrack hits, re-edit counts and verification flags. DigestBuilder (src/core/reasoning/insights.ts) folds the feature rows into the per-(kind, repo, engine, signature) insight clusters computeReasoningDigest serves the Leader and the Verse UI; until this feed only \'verification-gap\' insights became work (enqueueInsightTasks in src/core/fleet/task-source.ts files fleet add-tests tasks), so recurring struggle, loop, uncertainty and backtrack patterns never reached the deterministic backlog.';

/** Where the recorded signal came from, per insight kind — what one cluster row represents. */
const KIND_TEXT: Record<string, string> = {
  'struggle': 'one recorded struggle signal — a repeated failing tool signature, an error outcome, or a give-up without an edit',
  'loop': 'one recorded loop — the same tool signature repeated without an edit in between',
  'uncertainty': 'one turn whose derived uncertainty score crossed the digest threshold',
  'backtrack': 'one turn that backtracked or re-edited the same file past the digest threshold',
};

function seenText(firstAt: string, lastAt: string): string {
  return firstAt === lastAt
    ? ` First recorded ${firstAt}.`
    : ` First recorded ${firstAt}, last ${lastAt}.`;
}

function daysText(days: ReadonlySet<string>): string {
  const sorted = [...days].sort();
  return sorted.length <= 7 ? sorted.join(', ') : `${sorted.slice(0, 6).join(', ')} and ${sorted.length - 6} more`;
}

function evidenceText(insight: ReasoningInsight): string {
  const refs = insight.evidence.slice(0, 5);
  if (refs.length === 0) return '';
  return ` Newest evidence refs: ${refs.map((e) => `${e.ref} (${e.at})`).join('; ')}.`;
}

function scopeText(insight: ReasoningInsight): string {
  const repo = insight.repo === null ? 'repo unattributed' : `repo '${fieldText(insight.repo, 120)}'`;
  const engine = insight.engine === null ? 'engine unattributed' : `engine '${fieldText(insight.engine, 64)}'`;
  return `${repo}, ${engine}`;
}

function promptFor(insight: ReasoningInsight, tracked: InsightDays | undefined, windowDays: number): string {
  const variant = tracked?.variant ?? 'unknown';
  const turns = tracked?.turns.size ?? null;
  const days = tracked?.days.size ?? 0;
  // failure/loop counts are raw occurrences (turns tracked separately);
  // every other emitted variant's count already IS the turn count.
  const occurrenceVariant = variant === 'failure' || variant === 'loop';
  const countText = occurrenceVariant
    ? `${insight.count} recorded occurrence(s)`
    : `${insight.count} turn(s)`;
  const turnText = occurrenceVariant && turns !== null ? ` across ${turns} distinct turn(s)` : '';
  const kindLine = ({
    'struggle': variant === 'failure'
      ? `Phantom's agents keep failing the same tool calls — ${insight.title}.`
      : variant === 'error'
        ? `Phantom's agent turns keep ending in the same error — ${insight.title}.`
        : variant === 'gave-up'
          ? `Phantom's agents keep giving up without making a change — ${insight.title}.`
          : `Phantom's agents keep hitting recurring struggle signals — ${insight.title}.`,
    'loop': `Phantom's agents keep repeating the same tool call without an edit in between — ${insight.title}.`,
    'uncertainty': `Phantom's agents keep reasoning through uncertainty — ${insight.title}.`,
    'backtrack': `Phantom's agents keep backtracking or re-editing the same files — ${insight.title}.`,
  } as Partial<Record<ReasoningInsightKind, string>>)[insight.kind]
    ?? `Phantom's agents keep showing a recurring ${insight.kind} pattern — ${insight.title}.`;
  return [
    `${kindLine} The cluster folded ${countText}${turnText} on ${days} distinct UTC day(s) (${daysText(tracked?.days ?? new Set<string>())}) inside the ${windowDays}-day window — scoped to ${scopeText(insight)}, severity '${insight.severity}' — the self-improvement work this backlog exists for.`,
    '',
    `Each cluster row is ${KIND_TEXT[insight.kind] ?? 'one recorded adverse signal'}; the digest groups them by (kind, repo, engine, signature) so the same pattern recurring is one insight, not per-run noise.${seenText(insight.firstAt, insight.lastAt)}${evidenceText(insight)}`,
    '',
    EVIDENCE,
    '',
    `The reasoning store, the turn extractors and the digest are this repository's — src/core/reasoning/extractors.ts owns the per-turn feature rules (tool signatures, LOOP_MIN/REEDIT_MIN/UNCERTAIN_TURN_SCORE/BACKTRACK_TURN_MIN thresholds), src/core/reasoning/ingest-*.ts own what each source reports, and src/core/reasoning/insights.ts owns the clustering. What this repository owns is everything between raw agent behavior and the recorded feature: extractor coverage and thresholds, engine adapters' error and loop reporting, and the prompts and harness that produce the behavior. Provider outages, model capability, quotas and the target repos' own state are owner-side.`,
    '',
    `Find why this pattern keeps recurring: for a failure or loop signature, check whether the signature names a real recurring cause (a missing tool or dependency in fleet repos, a stale path or command, an adapter that reports the wrong signature) or extractor noise; for error outcomes and give-ups, join the engine adapter and errorClass producers in the sandboxed engine path; for uncertainty and backtrack, check whether the thresholds match the task mix or the harness keeps handing agents ambiguous or thrashing work. ${NO_CHANGE}`,
  ].join('\n');
}

function reasoningInsightItem(
  insight: ReasoningInsight,
  tracked: InsightDays | undefined,
  repo: string,
  windowDays: number,
): CloudBacklogItem {
  const id = `fleet-reasoning-${insight.id}`;
  const title = insight.title.slice(0, MAX_TITLE_CHARS);
  return {
    id,
    title,
    prompt: promptFor(insight, tracked, windowDays),
    area: 'reasoning-insights',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the reasoning digest's recurring adverse insights.
 * Total: any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function reasoningInsightBacklogItems(opts: ReasoningInsightItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowDays = Math.max(1, Math.floor(opts.days ?? REASONING_INSIGHT_WINDOW_DAYS));
    const window = { fromMs: nowMs - windowDays * DAY_MS, toMs: nowMs };
    const root = typeof opts.root === 'string' && opts.root !== '' ? opts.root : undefined;

    // One feature scan feeds both folds: the DigestBuilder produces the
    // authoritative insights (same projection the Leader reads) while the
    // tracker proves each candidate's recurrence across distinct UTC
    // days — the bar a bare firstAt/lastAt span cannot honestly claim.
    const builder = new DigestBuilder(window);
    const tracked = new Map<string, InsightDays>();
    await scanFeatures(window, (feature) => {
      builder.addFeature(feature);
      const endMs = Date.parse(feature.endedAt ?? '');
      const atMs = Date.parse(feature.at);
      if (!Number.isFinite(atMs)) return;
      const day = utcDay(Number.isFinite(endMs) ? endMs : atMs);
      for (const key of featureClusterKeys(feature)) {
        const id = reasoningInsightId(key, feature.repo, feature.engine);
        let entry = tracked.get(id);
        if (entry === undefined) {
          entry = { days: new Set(), turns: new Set(), variant: key.variant };
          tracked.set(id, entry);
        }
        entry.days.add(day);
        entry.turns.add(feature.id);
      }
    }, root ? { root } : {});

    const digest = builder.build(nowMs);
    const recurring = digest.insights.filter((insight) =>
      EMITTED_KINDS.has(insight.kind)
      && insight.count >= REASONING_INSIGHT_MIN_COUNT
      && (tracked.get(insight.id)?.days.size ?? 0) >= REASONING_INSIGHT_MIN_DAYS);
    if (recurring.length === 0) return [];

    const limit = Math.max(1, Math.min(opts.limit ?? REASONING_INSIGHT_BACKLOG_MAX_ITEMS, REASONING_INSIGHT_ITEM_HARD_MAX));
    return recurring.slice(0, limit).map((insight) => reasoningInsightItem(insight, tracked.get(insight.id), repo, windowDays));
  } catch {
    return [];
  }
}
