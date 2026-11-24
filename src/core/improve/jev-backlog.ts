/**
 * Jev decision ledger recurring fallback dominance → self-improvement
 * backlog items.
 *
 * Every wired decide() call — engine-error classification, task-class,
 * judge/taste/red-team verdicts, completion-claim, retro-root-cause,
 * needs-you-priority, interrupt-worthiness, lane-choice, resource-choice,
 * trigger-triage, action-class, operator-intent — ends in record()
 * (src/core/decide/decide.ts), which appends one DecisionRecord to
 * `jev/decisions/YYYY-MM-DD.jsonl` under the Ashlr home: the kind, the
 * path ('jev' when the model cleared the kind's confidence gate,
 * 'fallback' when the deterministic rule won), the fallback reason,
 * confidence, cached/called, token counts and estimated cost — never
 * the classified text. Deliberate-off fallbacks (no-key, disabled,
 * killed, kind-disabled, no-input) are filtered by UNRECORDED_REASONS
 * before the write, so every fallback row the ledger holds is a decision
 * Jev was eligible for and lost: a provider failure, a spent budget, an
 * answer that missed the gate, or an escalate-only refusal.
 *
 * Until now the ledger's only readers were `phm jev status [--day]` —
 * one local day at a time — and the Verse Jev card's today rollup, both
 * reports someone had to run and read. A kind whose Jev path keeps
 * losing across a week looks identical to a healthy one on any single
 * day, and a provider-side reason recurring across kinds never surfaced
 * anywhere. jevBacklogItems carries the same records into
 * discoverBacklog: a decision kind whose recorded fallbacks keep
 * dominating inside the window is self-diagnosed improvement work that
 * never became a backlog item.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The per-day files are read once each through
 *    readLedgerTail's bounded no-follow tail; nothing is written and no
 *    network is touched. A missing day file means no decisions were
 *    recorded that day; an unreadable or non-file day degrades the
 *    whole read to no items rather than folding partial evidence.
 *  - Rows count only under the writer's contract: a parseable
 *    DecisionRecord whose kind is a registry kind (isDecisionKind),
 *    whose path is 'jev'/'fallback', whose fallback reason is inside
 *    the recordable vocabulary (the TypeSafe unavailable reasons minus
 *    the never-recorded 'no-key'/'disabled', plus the decide-layer
 *    reasons minus the never-recorded 'killed'/'kind-disabled'/
 *    'no-input' — 'admission-refused', 'timeout', 'network',
 *    'rate-limited', 'http-error', 'malformed-response',
 *    'oversized-response', 'budget-exhausted', 'below-threshold',
 *    'no-answer', 'escalate-only'), and whose confidence/cached/called/
 *    durationMs fields are the recorded shapes. Malformed lines,
 *    foreign schemas and out-of-contract rows are skipped, never
 *    guessed.
 *  - Recurring means recorded across days at a rate that cannot be a
 *    transient burst: a kind cell emits only when its in-window
 *    decisions reach JEV_KIND_MIN_DECISIONS, its fallback rows reach
 *    JEV_KIND_MIN_FALLBACK across JEV_KIND_MIN_DAYS distinct UTC days,
 *    and fallbacks are at least JEV_KIND_MIN_FALLBACK_SHARE of the
 *    kind's decisions — a kind Jev still wins most of the time stays
 *    quiet, and deliberate-off states cannot appear because the writer
 *    never records them.
 *  - The window is anchored on each record's own timestamp, not the
 *    file name: day files are named by the writer's localDay() but a
 *    record near a timezone boundary still counts by its ts, and
 *    out-of-window or future-dated records contribute nothing.
 *  - Unknown stays unknown: estimated cost is summed only over
 *    fallback rows that were called and carried a recorded
 *    estCostUsd — a kind whose calls were never priced reports no
 *    cost figure rather than a zero.
 *  - Truncation is stated, never hidden: when a day file's bounded tail
 *    cut older rows, every prompt says the counts are a lower bound.
 *  - Fleet machinery only: the ledger carries no per-record repository
 *    dimension — every decide() call site is this install's own code —
 *    so items emit only when the backlog target's repository name is
 *    'phantom', the same last-segment rule the sibling fleet-evidence
 *    sources apply. Dedup is downstream: the item id hashes the kind
 *    identity, never the counts or timestamps, so a refresh re-derives
 *    the same id and appendUserBacklogItems adds only what is new; a
 *    kind that recovers simply stops re-adding.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { isDecisionKind } from '../decide/registry.js';
import { jevLedgerDir, localDay } from '../decide/ledger.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; there are only fourteen decision kinds. */
export const JEV_BACKLOG_MAX_ITEMS = 10;
const JEV_BACKLOG_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const JEV_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, same convention the sibling folds tolerate. */
const JEV_FUTURE_SKEW_MS = 60_000;
/** In-window decisions a kind needs before its fallback share means anything. */
export const JEV_KIND_MIN_DECISIONS = 6;
/** Recorded fallback rows a kind cell needs before it counts as recurring. */
export const JEV_KIND_MIN_FALLBACK = 4;
/** Distinct UTC days the fallback rows must span — recurring means recorded across days. */
export const JEV_KIND_MIN_DAYS = 2;
/** Fallbacks must be at least this share of the kind's in-window decisions. */
export const JEV_KIND_MIN_FALLBACK_SHARE = 0.5;
/**
 * Bounded tail per day file. A record is a few hundred bytes, so 512 KiB
 * retains well over a thousand decisions per day; a busier day reads as
 * a truncated tail and prompts say the counts are a lower bound.
 */
const JEV_DAY_FILE_BYTES = 512 * 1024;
/**
 * Day-file candidates around the window: localDay() names each file by
 * the writer's local calendar, so the rolling 7-day window plus skew
 * margin touches at most eleven local dates — two days of margin on
 * each side covers month boundaries and clock drift without a
 * directory listing.
 */
const JEV_DAY_OFFSETS = [-9, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2] as const;
/** The fleet's own repository label: decision-ledger evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded strings are unbounded text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 60;
/** Distinct fallback reasons quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_REASONS = 3;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;
const DAY_FILE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The fallback reasons recordDecision can actually write: every
 * DecisionFallbackReason minus UNRECORDED_REASONS (no-key, disabled,
 * killed, kind-disabled, no-input — deliberate-off states the writer
 * filters before the ledger ever sees them). A row carrying any other
 * reason is outside the producer's contract.
 */
const RECORDED_REASONS: ReadonlySet<string> = new Set([
  'admission-refused',
  'timeout',
  'network',
  'rate-limited',
  'http-error',
  'malformed-response',
  'oversized-response',
  'budget-exhausted',
  'below-threshold',
  'no-answer',
  'escalate-only',
]);

export interface JevItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Ledger directory override (default: jevLedgerDir(), $ASHLR_HOME/jev/decisions). */
  ledgerDir?: string;
  /** Evidence window in ms (default JEV_WINDOW_MS). */
  windowMs?: number;
  /** Most items one call emits (default JEV_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now, ms epoch). */
  now?: number;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded names are unbounded text; flatten, scrub and cap before use. */
function fieldText(value: string, max: number = MAX_NAME_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const dayOf = (tsMs: number): string => new Date(tsMs).toISOString().slice(0, 10);

const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Fold — one pass over the in-window day files
// ---------------------------------------------------------------------------

/** One day file's bounded tail as read. */
export interface JevDayRead {
  /** The file's YYYY-MM-DD name (the writer's localDay label; records still filter by their own ts). */
  day: string;
  text: string;
  truncated: boolean;
}

/** A fallback row's contribution to its kind's cell. */
interface ParsedDecision {
  tsMs: number;
  kind: string;
  fallback: boolean;
  reason: string | null;
  called: boolean;
  estCostUsd: number | null;
}

/** Per-kind in-window fold before the recurring bars apply. */
export interface JevKindFold {
  kind: string;
  /** Valid in-window records for the kind (jev + fallback paths). */
  decisions: number;
  /** Records whose path is 'fallback'. */
  fallback: number;
  /** Distinct UTC days the fallback rows landed on. */
  days: Set<string>;
  /** Fallback reason → recorded rows. */
  reasons: Map<string, number>;
  /** ISO bounds of the fallback rows; null when the kind never fell back. */
  firstMs: number | null;
  lastMs: number | null;
  /**
   * Sum of recorded estCostUsd over fallback rows that were called and
   * priced — null when no fallback row carried a usable estimate, so an
   * unpriced kind reports unknown rather than zero.
   */
  estCostUsd: number | null;
  /** Called fallback rows that carried a recorded estCostUsd. */
  pricedCalls: number;
}

export interface JevFold {
  /** Valid in-window DecisionRecords across all kinds. */
  records: number;
  /** Non-blank lines that failed JSON parse or the producer contract. */
  invalid: number;
  kinds: Map<string, JevKindFold>;
}

/**
 * One ledger line under the writer's contract, or null. The required
 * fields are the DecisionRecord shapes record() always emits; optional
 * telemetry fields the fold does not read are ignored rather than
 * validated, and a reason is accepted only on fallback rows inside the
 * recordable vocabulary.
 */
function parseDecisionRecord(row: unknown): ParsedDecision | null {
  if (!isRecord(row)) return null;
  const ts = row['ts'];
  if (typeof ts !== 'string') return null;
  const tsMs = Date.parse(ts);
  if (!Number.isFinite(tsMs)) return null;
  const kind = row['kind'];
  if (typeof kind !== 'string' || !isDecisionKind(kind)) return null;
  const path = row['path'];
  if (path !== 'jev' && path !== 'fallback') return null;
  const reasonRaw = row['reason'];
  if (reasonRaw !== undefined &&
      (path !== 'fallback' || typeof reasonRaw !== 'string' || !RECORDED_REASONS.has(reasonRaw))) return null;
  if (typeof row['confidence'] !== 'number' || !Number.isFinite(row['confidence'])) return null;
  const called = row['called'];
  if (typeof row['cached'] !== 'boolean' || typeof called !== 'boolean') return null;
  const durationMs = row['durationMs'];
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return null;
  const cost = row['estCostUsd'];
  return {
    tsMs,
    kind,
    fallback: path === 'fallback',
    reason: typeof reasonRaw === 'string' ? reasonRaw : null,
    called,
    estCostUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
  };
}

/**
 * Pure: fold the in-window day files into per-kind decision evidence.
 * Lines outside the window, malformed JSON, wrong kinds, off-contract
 * paths/reasons and unsafe field shapes are skipped — never guessed.
 */
export function foldJevDecisions(
  days: readonly JevDayRead[],
  nowMs: number,
  windowMs: number,
): JevFold {
  const fold: JevFold = { records: 0, invalid: 0, kinds: new Map() };
  const since = nowMs - windowMs;
  const until = nowMs + JEV_FUTURE_SKEW_MS;
  for (const day of days) {
    if (!DAY_FILE.test(day.day)) continue;
    for (const line of day.text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let row: unknown;
      try { row = JSON.parse(trimmed); } catch { fold.invalid += 1; continue; }
      const rec = parseDecisionRecord(row);
      if (rec === null) { fold.invalid += 1; continue; }
      if (rec.tsMs < since || rec.tsMs > until) continue;
      fold.records += 1;
      let cell = fold.kinds.get(rec.kind);
      if (cell === undefined) {
        cell = {
          kind: rec.kind, decisions: 0, fallback: 0, days: new Set(), reasons: new Map(),
          firstMs: null, lastMs: null, estCostUsd: null, pricedCalls: 0,
        };
        fold.kinds.set(rec.kind, cell);
      }
      cell.decisions += 1;
      if (!rec.fallback) continue;
      cell.fallback += 1;
      cell.days.add(dayOf(rec.tsMs));
      if (rec.reason !== null) cell.reasons.set(rec.reason, (cell.reasons.get(rec.reason) ?? 0) + 1);
      cell.firstMs = cell.firstMs === null ? rec.tsMs : Math.min(cell.firstMs, rec.tsMs);
      cell.lastMs = cell.lastMs === null ? rec.tsMs : Math.max(cell.lastMs, rec.tsMs);
      if (rec.called && rec.estCostUsd !== null) {
        cell.estCostUsd = (cell.estCostUsd ?? 0) + rec.estCostUsd;
        cell.pricedCalls += 1;
      }
    }
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface JevReasonTally {
  reason: string;
  count: number;
}

/** One emitted fallback-dominance cell: the kind plus the recorded detail the prompt quotes. */
export interface JevKindCell {
  kind: string;
  /** In-window records for the kind (jev + fallback). */
  decisions: number;
  /** In-window fallback rows. */
  fallback: number;
  /** fallback / decisions. */
  share: number;
  /** Sorted distinct UTC days the fallback rows landed on. */
  days: string[];
  /** Top recorded fallback reasons, most frequent first. */
  reasons: JevReasonTally[];
  /** ISO bounds of the fallback rows. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** Summed recorded estCostUsd over called+priced fallback rows; null when none carried an estimate. */
  estCostUsd: number | null;
  /** Called fallback rows that carried a recorded estCostUsd. */
  pricedCalls: number;
  /** True when any day file's bounded tail cut older rows: counts are a lower bound. */
  lowerBound: boolean;
}

/**
 * Pure: the recurring cells the fold justifies — kinds whose recorded
 * fallbacks reach the decision/fallback/day bars and hold at least
 * JEV_KIND_MIN_FALLBACK_SHARE of the kind's decisions. Sorted by
 * fallback count, worst first.
 */
export function jevCells(fold: JevFold, lowerBound = false): JevKindCell[] {
  const cells: JevKindCell[] = [];
  for (const cell of fold.kinds.values()) {
    if (cell.decisions < JEV_KIND_MIN_DECISIONS ||
        cell.fallback < JEV_KIND_MIN_FALLBACK ||
        cell.days.size < JEV_KIND_MIN_DAYS ||
        cell.fallback / cell.decisions < JEV_KIND_MIN_FALLBACK_SHARE) continue;
    cells.push({
      kind: cell.kind,
      decisions: cell.decisions,
      fallback: cell.fallback,
      share: cell.fallback / cell.decisions,
      days: [...cell.days].sort(),
      reasons: [...cell.reasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
        .slice(0, MAX_PROMPT_REASONS),
      firstSeen: isoOrNull(cell.firstMs),
      lastSeen: isoOrNull(cell.lastMs),
      estCostUsd: cell.estCostUsd,
      pricedCalls: cell.pricedCalls,
      lowerBound,
    });
  }
  return cells.sort((a, b) => b.fallback - a.fallback || a.kind.localeCompare(b.kind));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is jev/decisions/YYYY-MM-DD.jsonl under the Ashlr home (~/.ashlr or $ASHLR_HOME): decide() (src/core/decide/decide.ts) records one DecisionRecord per decision through recordDecision (src/core/decide/ledger.ts) for every wired call site — engine-error classification, task-class, judge/taste/red-team verdicts, completion-claim, retro-root-cause, needs-you-priority, interrupt-worthiness, lane-choice, resource-choice, trigger-triage, action-class and operator-intent — carrying the kind, path (jev|fallback), the fallback reason, confidence, cached/called, token counts and estimated cost, never the classified text. Fallbacks that only say Jev is not set up or switched off (no-key, disabled, killed, kind-disabled, no-input) are filtered before the write, so every recorded fallback is a decision Jev was eligible for and lost. Day files are append-only with no rotation; `phm jev status [--day YYYY-MM-DD]` (src/core/decide/status.ts) and the Verse Jev card read one local day at a time — until this feed no reader folded the window, so a kind that kept losing across days or a provider reason recurring across kinds never became work.';

const NO_CHANGE = 'If the window has rolled forward, the kind legitimately falls back most of the time by design — a hard or safety-adjacent kind where the deterministic rule should win — the fallback reasons trace to owner-side state such as the API key, quota or daily budget only Mason can change, or Jev is intentionally conservative here, report no-change and name the evidence.';

/**
 * What each recorded reason means in the producer's own vocabulary —
 * quoted from DecisionFallbackReason and TypeSafeUnavailableReason so
 * the session starts from producer semantics rather than guessing.
 */
const REASON_HINTS: Record<string, string> = {
  'below-threshold': 'Jev answered but its confidence stayed under the kind\'s gate',
  'no-answer': 'Jev answered but not the needed question, or an out-of-vocabulary label',
  'escalate-only': 'Jev\'s answer would have de-escalated and was refused',
  'budget-exhausted': 'the daily paid-call budget was already spent',
  'admission-refused': 'the caller-owned outcome was retired before provider contact',
  'timeout': 'the classifier deadline or the caller\'s signal hit',
  'network': 'DNS/connect/TLS failure — offline or unreachable',
  'rate-limited': 'HTTP 429 or 503 throttling',
  'http-error': 'a non-2xx response',
  'malformed-response': 'a 2xx body that was not a well-formed answer set',
  'oversized-response': 'the body exceeded the response cap',
};

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const seenText = (cell: JevKindCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const boundText = (cell: JevKindCell): string =>
  cell.lowerBound ? ' A day file\'s bounded tail was truncated at the read, so these counts cover only the retained rows — a lower bound, not the full window.' : '';

const costText = (cell: JevKindCell): string =>
  cell.estCostUsd === null || cell.pricedCalls === 0
    ? ''
    : ` Recorded est. cost on ${cell.pricedCalls} called fallback row(s): $${cell.estCostUsd.toFixed(6)}.`;

function reasonText(cell: JevKindCell): string {
  if (cell.reasons.length === 0) return '';
  const parts = cell.reasons.map((r) => {
    const hint = REASON_HINTS[r.reason];
    return `'${fieldText(r.reason)}' ×${r.count}${hint === undefined ? '' : ` (${hint})`}`;
  });
  return ` Top recorded fallback reasons: ${parts.join(', ')}.`;
}

function jevPrompt(cell: JevKindCell): string {
  const kind = fieldText(cell.kind);
  const pct = Math.round(cell.share * 100);
  return [
    `Phantom's Jev decision ledger keeps recording fallback-dominated kind '${kind}' — ${cell.fallback} of ${cell.decisions} in-window decisions took the deterministic path across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), ${pct}% of everything the kind recorded, the self-improvement work this backlog exists for.`,
    '',
    `Every recorded fallback is a decision Jev was eligible for and lost — the deterministic rule answered instead of the model's cleared answer.${reasonText(cell)}${costText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find which side is losing: reproduce the tallies with \`phm jev status --json\` and \`phm jev status --day <YYYY-MM-DD> --json\` for the recorded days to see the kind's per-day fallback rate, top reasons, calls and estimated cost, then check whether the kind's threshold override in jev/config.json or its registry gate in src/core/decide/registry.ts is miscalibrated for the answers Jev actually returns, whether its question map or interpret function in the call sites drifted from what the model answers, whether the TypeSafe provider path is degraded (timeout, network, rate-limited, http-error, malformed-response or oversized-response rows), whether the daily call budget is starving it (budget-exhausted), or whether callers keep retiring outcomes before provider contact (admission-refused). 'below-threshold' and 'no-answer' recurring means Jev answers but cannot clear the gate — question, vocabulary or calibration drift; 'escalate-only' recurring on a safety-adjacent kind means Jev persistently wants to de-escalate what the deterministic rule escalates.`,
    '',
    `Fix what lives here — the decide layer's registry thresholds, question maps, interpret functions and call sites in src/, or the ledger and status readers. If the kind legitimately falls back by design, the reasons trace to owner-side key/quota/budget state, or Jev is intentionally conservative for it, ${NO_CHANGE}`,
  ].join('\n');
}

function jevItem(cell: JevKindCell, repo: string): CloudBacklogItem {
  return {
    id: `jev-fallback-${sha(`jev-kind:${cell.kind}`)}`,
    title: `Jev decision kind '${fieldText(cell.kind)}' keeps falling back (${Math.round(cell.share * 100)}%)`.slice(0, MAX_TITLE_CHARS),
    prompt: jevPrompt(cell),
    area: 'jev-decisions',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the Jev decision ledger's recurring fallback-
 * dominant kinds. Total: any read or fold failure yields no items
 * rather than throwing into discovery.
 */
export async function jevBacklogItems(opts: JevItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const dir = opts.ledgerDir ?? jevLedgerDir();
    const nowMs = opts.now ?? Date.now();
    const windowMs = opts.windowMs ?? JEV_WINDOW_MS;
    const days: JevDayRead[] = [];
    let lowerBound = false;
    for (const offset of JEV_DAY_OFFSETS) {
      const day = localDay(new Date(nowMs + offset * 86_400_000));
      if (!DAY_FILE.test(day)) continue;
      const tail = await readLedgerTail(join(dir, `${day}.jsonl`), JEV_DAY_FILE_BYTES);
      if (tail.state === 'missing') continue;
      // An unreadable or non-file day means evidence exists that cannot
      // be trusted — fail closed rather than fold the readable remainder.
      if (tail.state !== 'read') return [];
      if (tail.truncated) lowerBound = true;
      days.push({ day, text: tail.text, truncated: tail.truncated });
    }
    const fold = foldJevDecisions(days, nowMs, windowMs);
    if (fold.kinds.size === 0) return [];
    const cells = jevCells(fold, lowerBound);
    const limit = Math.max(1, Math.min(opts.limit ?? JEV_BACKLOG_MAX_ITEMS, JEV_BACKLOG_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => jevItem(cell, repo));
  } catch {
    return [];
  }
}
