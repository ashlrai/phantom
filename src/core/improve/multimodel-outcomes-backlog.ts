/**
 * ~/.ashlr/verse/multimodel/outcomes.jsonl outcome-signal journal →
 * self-improvement backlog items.
 *
 * Every recorded Multi-model chat outcome — a thumbs up/down, a retry, a
 * seat switch, an Auto follow or override, a Compare pick, an escalation,
 * a cheap-first draft verdict — is appended by the Verse sidecar's
 * POST /api/verse/multimodel/outcome handler as one SeatOutcome row
 * {at, seatId, engine, kind, signal, sessionId?, model?} to this
 * append-only file under the private multimodel store (mode 0600; the
 * store reads back only the newest OUTCOMES_READ_MAX_BYTES). Prompt
 * text is never stored: only seat ids, engines, the closed PROMPT_KINDS
 * vocabulary, the closed OUTCOME_SIGNALS vocabulary and timestamps.
 *
 * Until now the journal's only reader was the Auto seat advisor itself:
 * aggregateOutcomes folds the bounded tail into the LearnedTable that
 * learnedTilt turns into a bounded ±LEARNING_MAX_TILT-position ranking
 * tilt for interactive chat (src/core/verse/multimodel/learning.ts —
 * 14-day half-life, LEARNING_MIN_SIGNALS decayed signals, score shrunk
 * toward zero). The fleet's dispatch journals — jobs.jsonl,
 * work-market.jsonl, route.explain.jsonl — never see these signals, so
 * a seat or engine the operator keeps rejecting for a prompt kind, or
 * an Auto picker that keeps getting overridden, was invisible to the
 * self-improvement loop: interactive outcome evidence that never
 * became work. multimodelOutcomesBacklogItems carries the same rows
 * into discoverBacklog.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail — OUTCOMES_READ_MAX_BYTES, the store's own
 *    read bound; nothing is written and no network is touched. A
 *    missing or unreadable file yields no items; a malformed line is
 *    skipped, never guessed.
 *  - Rows count only under the store's own contract: a parseable `at`,
 *    a seatId inside the writer's seatIdOk bounds, a non-empty engine,
 *    kind inside PROMPT_KINDS and signal inside OUTCOME_SIGNALS
 *    (src/core/verse/multimodel/types.ts). sessionId and model are
 *    accepted by the contract but never folded — session ids identify
 *    chats and model adds nothing the seat does not.
 *  - Recurring means recorded across days: a preference cell emits only
 *    when the SAME aggregateOutcomes table the advisor reads gives the
 *    (kind, seat) or (kind, engine) stat n >= LEARNING_MIN_SIGNALS
 *    decayed signals AND the learnedTilt adverse gate (|tilt| >= 0.15
 *    with the seat passed over, i.e. positive tilt) holds AND the
 *    contributing rows span MULTIMODEL_OUTCOMES_MIN_DAYS distinct UTC
 *    days inside the 7-day window. An advisor cell emits per
 *    (kind, seat) only when 'auto-overridden' rows reach
 *    ADVISOR_MIN_OVERRIDES across the same day bar AND overrides are at
 *    least half of that cell's recorded suggestion outcomes
 *    (overridden >= followed) — a seat Auto suggests and the operator
 *    mostly rejects.
 *  - Fleet machinery only: items emit only for the fleet's own
 *    repository — the same last-segment rule the sibling
 *    fleet-evidence sources apply — since the journal describes this
 *    install's interactive seats and carries no repository column.
 *    Dedup is downstream: the item id hashes the cell identity, never
 *    counts or timestamps, so a refresh re-derives the same id and a
 *    recovered seat simply stops re-adding.
 *  - Truncation is stated, never hidden: when the bounded tail cut
 *    older bytes, every prompt says the counts are a lower bound.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';
import {
  aggregateOutcomes,
  engineKey,
  LEARNING_MAX_TILT,
  LEARNING_MIN_SIGNALS,
  SIGNAL_WEIGHT,
  seatKey,
} from '../verse/multimodel/learning.js';
import { OUTCOMES_READ_MAX_BYTES, defaultMultimodelRoot } from '../verse/multimodel/store.js';
import {
  OUTCOME_SIGNALS,
  PROMPT_KINDS,
  type LearnedStat,
  type OutcomeSignal,
  type PromptKind,
  type SeatOutcome,
} from '../verse/multimodel/types.js';

/** Items one call may emit; the cell space is kinds × seats/engines plus advisor cells. */
export const MULTIMODEL_OUTCOMES_BACKLOG_MAX_ITEMS = 12;
const MULTIMODEL_OUTCOMES_BACKLOG_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention. */
export const MULTIMODEL_OUTCOMES_WINDOW_HOURS = 168;
/** A cell emits only at this many distinct UTC days of contributing rows. */
export const MULTIMODEL_OUTCOMES_MIN_DAYS = 2;
/** An advisor cell emits only at this many 'auto-overridden' rows... */
export const MULTIMODEL_OUTCOMES_MIN_OVERRIDES = 3;
/** Bounded no-follow tail; the store itself reads back only OUTCOMES_READ_MAX_BYTES. */
export const MULTIMODEL_OUTCOMES_TAIL_BYTES = OUTCOMES_READ_MAX_BYTES;
/** The fleet's own repository label: multimodel outcome evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** ±5-minute future skew, the sibling folds' tolerance for clock drift on journal timestamps. */
const SKEW_MS = 300_000;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded seat/engine names are unbounded text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 80;
/** Distinct seat ids quoted inside one engine-cell prompt. */
const MAX_ENGINE_SEATS = 6;
/** Signal tallies and UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_TALLIES = 4;
const MAX_PROMPT_DAYS = 4;
/** The writer's seatIdOk bound (multimodel-api.ts SEAT_ID_MAX). */
const SEAT_ID_MAX = 256;
/** learning.ts's module-private shrinkage pseudo-count, mirrored for the adverse gate. */
const LEARNED_PRIOR = 2;
/** learning.ts's phrase gate inside learnedTilt: |tilt| below this reads as no preference. */
const LEARNED_PHRASE_MIN = 0.15;

export interface MultimodelOutcomesItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Journal override (default: <home>/.ashlr/verse/multimodel/outcomes.jsonl). */
  journalPath?: string;
  /** Home for the journal default; default homedir(). */
  homeDir?: string;
  /** Evidence window in hours (default MULTIMODEL_OUTCOMES_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default MULTIMODEL_OUTCOMES_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Journal-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const dayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);
const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Row contract — one SeatOutcome exactly as the API appends it
// ---------------------------------------------------------------------------

/**
 * Structural validation of one persisted row against the store's isOutcome
 * contract and the writer's seatIdOk bound, field by field: parseable `at`,
 * seatId a non-empty string within the writer's length and control-byte
 * bounds, engine a non-empty bounded string, kind inside PROMPT_KINDS and
 * signal inside OUTCOME_SIGNALS. sessionId and model pass through the
 * contract but are deliberately not folded. Returns the cleaned outcome or
 * null — a malformed or foreign row is skipped, never guessed.
 */
function projectOutcome(row: Record<string, unknown>): { outcome: SeatOutcome; atMs: number } | null {
  const at = row['at'];
  if (typeof at !== 'string') return null;
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return null;
  const seatId = row['seatId'];
  if (typeof seatId !== 'string' || seatId === '' || seatId.length > SEAT_ID_MAX || /[\0\n\r]/.test(seatId)) return null;
  const engine = row['engine'];
  if (typeof engine !== 'string' || engine.trim() === '') return null;
  const kind = row['kind'];
  if (typeof kind !== 'string' || !(PROMPT_KINDS as readonly unknown[]).includes(kind)) return null;
  const signal = row['signal'];
  if (typeof signal !== 'string' || !(OUTCOME_SIGNALS as readonly unknown[]).includes(signal)) return null;
  const cleanSeat = fieldText(seatId, MAX_NAME_CHARS);
  const cleanEngine = fieldText(engine, MAX_NAME_CHARS);
  if (cleanSeat === '' || cleanEngine === '') return null;
  return {
    outcome: {
      at,
      seatId: cleanSeat,
      engine: cleanEngine,
      kind: kind as PromptKind,
      signal: signal as OutcomeSignal,
    },
    atMs,
  };
}

// ---------------------------------------------------------------------------
// Fold — one pass over the journal tail
// ---------------------------------------------------------------------------

/** Per-(kind, subject) in-window metadata the learned table does not carry. */
interface SubjectMeta {
  kind: PromptKind;
  /** seatId on the seat axis, engine on the engine axis. */
  subject: string;
  /** Contributing outcome rows. */
  rows: number;
  /** Distinct UTC days the contributing rows landed on. */
  days: Set<string>;
  firstMs: number | null;
  lastMs: number | null;
  /** Raw per-signal tallies for prompt context. */
  signals: Map<string, number>;
  /** Engine axis only: the distinct seat ids the engine's rows named. */
  seatIds: Set<string>;
}

/** Per-(kind, seat) Auto-suggestion outcome counts for the advisor axis. */
interface AdvisorMeta {
  kind: PromptKind;
  seatId: string;
  /** 'auto-overridden' rows: Auto suggested this seat, the operator chose another. */
  overridden: number;
  /** 'auto-followed' rows: the operator sent where Auto suggested this seat. */
  followed: number;
  /** Distinct UTC days carrying an override row. */
  overrideDays: Set<string>;
  overrideFirstMs: number | null;
  overrideLastMs: number | null;
}

export interface MultimodelOutcomesFold {
  /** Contract-valid rows seen inside the window — the share denominator. */
  rows: number;
  /** The production LearnedTable aggregateOutcomes computes over the in-window rows. */
  learned: Record<string, LearnedStat>;
  seatMeta: Map<string, SubjectMeta>;
  engineMeta: Map<string, SubjectMeta>;
  advisorMeta: Map<string, AdvisorMeta>;
  /** Non-blank lines that were not contract-valid outcome rows. */
  malformed: number;
  /** Parsed rows outside the window or beyond the future-skew tolerance. */
  outsideWindow: number;
}

const touch = (cell: { firstMs: number | null; lastMs: number | null }, atMs: number): void => {
  cell.firstMs = cell.firstMs === null ? atMs : Math.min(cell.firstMs, atMs);
  cell.lastMs = cell.lastMs === null ? atMs : Math.max(cell.lastMs, atMs);
};

const bump = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

function subjectMeta(
  map: Map<string, SubjectMeta>,
  kind: PromptKind,
  subject: string,
  outcome: SeatOutcome,
  atMs: number,
): SubjectMeta {
  const key = `${kind} ${subject}`;
  let cell = map.get(key);
  if (cell === undefined) {
    cell = { kind, subject, rows: 0, days: new Set(), firstMs: null, lastMs: null, signals: new Map(), seatIds: new Set() };
    map.set(key, cell);
  }
  cell.rows += 1;
  cell.days.add(dayOf(atMs));
  bump(cell.signals, outcome.signal);
  touch(cell, atMs);
  return cell;
}

/**
 * Pure: fold journal text(s) — oldest first — into the production learned
 * table plus per-cell recurrence metadata. Lines outside the window,
 * undated, malformed or foreign-shaped are skipped or counted, never
 * guessed. The learned table is aggregateOutcomes' own output over the
 * in-window rows, so the emit gate reads exactly what the advisor reads.
 */
export function foldMultimodelOutcomes(
  texts: readonly string[],
  nowMs: number,
  windowHours: number,
): MultimodelOutcomesFold {
  const fold: MultimodelOutcomesFold = {
    rows: 0,
    learned: {},
    seatMeta: new Map(),
    engineMeta: new Map(),
    advisorMeta: new Map(),
    malformed: 0,
    outsideWindow: 0,
  };
  const since = nowMs - windowHours * 3_600_000;
  const until = nowMs + SKEW_MS;
  const outcomes: SeatOutcome[] = [];

  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fold.malformed++;
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        fold.malformed++;
        continue;
      }
      const projected = projectOutcome(parsed as Record<string, unknown>);
      if (projected === null) {
        fold.malformed++;
        continue;
      }
      if (projected.atMs < since || projected.atMs > until) {
        fold.outsideWindow++;
        continue;
      }
      fold.rows++;
      outcomes.push(projected.outcome);
      subjectMeta(fold.seatMeta, projected.outcome.kind, projected.outcome.seatId, projected.outcome, projected.atMs);
      subjectMeta(fold.engineMeta, projected.outcome.kind, projected.outcome.engine, projected.outcome, projected.atMs)
        .seatIds.add(projected.outcome.seatId);
      if (projected.outcome.signal === 'auto-overridden' || projected.outcome.signal === 'auto-followed') {
        const key = `${projected.outcome.kind} ${projected.outcome.seatId}`;
        let cell = fold.advisorMeta.get(key);
        if (cell === undefined) {
          cell = { kind: projected.outcome.kind, seatId: projected.outcome.seatId, overridden: 0, followed: 0, overrideDays: new Set(), overrideFirstMs: null, overrideLastMs: null };
          fold.advisorMeta.set(key, cell);
        }
        if (projected.outcome.signal === 'auto-overridden') {
          cell.overridden += 1;
          cell.overrideDays.add(dayOf(projected.atMs));
          cell.overrideFirstMs = cell.overrideFirstMs === null ? projected.atMs : Math.min(cell.overrideFirstMs, projected.atMs);
          cell.overrideLastMs = cell.overrideLastMs === null ? projected.atMs : Math.max(cell.overrideLastMs, projected.atMs);
        } else {
          cell.followed += 1;
        }
      }
    }
  }
  fold.learned = aggregateOutcomes(outcomes, nowMs);
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface MultimodelOutcomeCell {
  kind: 'multimodel-outcomes';
  /** 'advisor' (Auto picks overridden), 'seat' or 'engine' (learned preference gone adverse). */
  axis: 'advisor' | 'engine' | 'seat';
  promptKind: PromptKind;
  /** seatId on seat/advisor axes, engine on the engine axis. */
  subject: string;
  /** Contributing in-window outcome rows (advisor axis: overridden rows). */
  rows: number;
  /** Distinct UTC days the contributing rows landed on. */
  days: string[];
  /** Contract-valid in-window rows — the share denominator. */
  totalRows: number;
  firstSeen: string | null;
  lastSeen: string | null;
  /** Preference axes only: the production learned stat and its adverse tilt. */
  score: number | null;
  signals: number | null;
  up: number | null;
  down: number | null;
  tilt: number | null;
  /** Up to MAX_PROMPT_TALLIES "signal×count" pairs, adverse-weighted first. */
  topSignals: string[];
  /** Engine axis only: distinct seat ids the engine's rows named (bounded). */
  seats: string[];
  /** Advisor axis only: 'auto-followed' rows for the same (kind, seat). */
  followed: number | null;
  /** True when the bounded tail cut older bytes: counts are a lower bound. */
  lowerBound: boolean;
}

function cellBase(fold: MultimodelOutcomesFold): Omit<MultimodelOutcomeCell, 'kind' | 'axis' | 'promptKind' | 'subject'> {
  return {
    rows: 0, days: [], totalRows: fold.rows, firstSeen: null, lastSeen: null,
    score: null, signals: null, up: null, down: null, tilt: null, topSignals: [],
    seats: [], followed: null, lowerBound: false,
  };
}

/**
 * The adverse gate, mirroring learnedTilt exactly: the score shrinks toward
 * zero by the module-private PRIOR and the tilt clamps at ±LEARNING_MAX_TILT;
 * the advisor only phrases a preference at |tilt| >= 0.15, and a POSITIVE
 * tilt is the "you've passed over" direction — the seat is being ranked
 * down. Returns the tilt when adverse, else 0.
 */
function adverseTilt(stat: LearnedStat): number {
  const shrunk = stat.score / (stat.n + LEARNED_PRIOR);
  const tilt = -Math.max(-LEARNING_MAX_TILT, Math.min(LEARNING_MAX_TILT, shrunk * 2 * LEARNING_MAX_TILT));
  return tilt >= LEARNED_PHRASE_MIN ? tilt : 0;
}

/** Adverse-signal-first ordering for the prompt's signal tally: the production SIGNAL_WEIGHT, most negative first. */
function topSignals(meta: SubjectMeta): string[] {
  return [...meta.signals.entries()]
    .sort((a, b) => (SIGNAL_WEIGHT[a[0] as OutcomeSignal] ?? 0) - (SIGNAL_WEIGHT[b[0] as OutcomeSignal] ?? 0) || b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_PROMPT_TALLIES)
    .map(([signal, count]) => `${signal}×${count}`);
}

function preferenceCell(
  fold: MultimodelOutcomesFold,
  axis: 'seat' | 'engine',
  meta: SubjectMeta,
  stat: LearnedStat,
  tilt: number,
  lowerBound: boolean,
): MultimodelOutcomeCell {
  return {
    ...cellBase(fold),
    kind: 'multimodel-outcomes',
    axis,
    promptKind: meta.kind,
    subject: meta.subject,
    rows: meta.rows,
    days: [...meta.days].sort(),
    score: stat.score,
    signals: stat.n,
    up: stat.up,
    down: stat.down,
    tilt,
    topSignals: topSignals(meta),
    seats: axis === 'engine' ? [...meta.seatIds].sort().slice(0, MAX_ENGINE_SEATS) : [],
    firstSeen: isoOrNull(meta.firstMs),
    lastSeen: isoOrNull(meta.lastMs),
    lowerBound,
  };
}

/**
 * Pure: the cells one fold emits — recurring advisor-override cells first
 * (Phantom's own picker misranking), then adverse seat-preference cells,
 * then engine-preference cells, each group sorted by badness. Emission
 * order puts the self-machinery evidence ahead of the seat-quality
 * evidence.
 */
export function multimodelOutcomeCells(fold: MultimodelOutcomesFold, lowerBound = false): MultimodelOutcomeCell[] {
  const cells: MultimodelOutcomeCell[] = [];

  const advisor = [...fold.advisorMeta.values()]
    .filter((meta) => meta.overridden >= MULTIMODEL_OUTCOMES_MIN_OVERRIDES
      && meta.overrideDays.size >= MULTIMODEL_OUTCOMES_MIN_DAYS
      && meta.overridden >= meta.followed)
    .sort((a, b) => b.overridden - a.overridden || a.seatId.localeCompare(b.seatId) || a.kind.localeCompare(b.kind));
  for (const meta of advisor) {
    cells.push({
      ...cellBase(fold),
      kind: 'multimodel-outcomes',
      axis: 'advisor',
      promptKind: meta.kind,
      subject: meta.seatId,
      rows: meta.overridden,
      days: [...meta.overrideDays].sort(),
      followed: meta.followed,
      firstSeen: isoOrNull(meta.overrideFirstMs),
      lastSeen: isoOrNull(meta.overrideLastMs),
      lowerBound,
    });
  }

  const seats = [...fold.seatMeta.values()]
    .map((meta) => {
      const stat = fold.learned[seatKey(meta.kind, meta.subject)];
      if (stat === undefined || stat.n < LEARNING_MIN_SIGNALS || meta.days.size < MULTIMODEL_OUTCOMES_MIN_DAYS) return null;
      const tilt = adverseTilt(stat);
      return tilt > 0 ? { meta, stat, tilt } : null;
    })
    .filter((entry): entry is { meta: SubjectMeta; stat: LearnedStat; tilt: number } => entry !== null)
    .sort((a, b) => b.tilt - a.tilt || b.meta.rows - a.meta.rows || a.meta.subject.localeCompare(b.meta.subject));
  for (const { meta, stat, tilt } of seats) {
    cells.push(preferenceCell(fold, 'seat', meta, stat, tilt, lowerBound));
  }

  const engines = [...fold.engineMeta.values()]
    .map((meta) => {
      const stat = fold.learned[engineKey(meta.kind, meta.subject)];
      if (stat === undefined || stat.n < LEARNING_MIN_SIGNALS || meta.days.size < MULTIMODEL_OUTCOMES_MIN_DAYS) return null;
      const tilt = adverseTilt(stat);
      return tilt > 0 ? { meta, stat, tilt } : null;
    })
    .filter((entry): entry is { meta: SubjectMeta; stat: LearnedStat; tilt: number } => entry !== null)
    .sort((a, b) => b.tilt - a.tilt || b.meta.rows - a.meta.rows || a.meta.subject.localeCompare(b.meta.subject));
  for (const { meta, stat, tilt } of engines) {
    cells.push(preferenceCell(fold, 'engine', meta, stat, tilt, lowerBound));
  }

  return cells;
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is ~/.ashlr/verse/multimodel/outcomes.jsonl — the Multi-model chat outcome journal the Verse sidecar appends one {at, seatId, engine, kind, signal, sessionId?, model?} SeatOutcome row per recorded operator action to (src/core/verse/multimodel/store.ts; prompt text is never stored). Its only reader until now was the Auto seat advisor: aggregateOutcomes folds the bounded tail into the LearnedTable that learnedTilt turns into a bounded ranking tilt for interactive chat (src/core/verse/multimodel/learning.ts — 14-day half-life, LEARNING_MIN_SIGNALS decayed signals, score shrunk toward zero, ±LEARNING_MAX_TILT positions). The fleet dispatch journals — jobs.jsonl, work-market.jsonl, route.explain.jsonl — never see these signals, so recurring adverse interactive outcomes never became work.';

const REPRO = 'Reproduce the fold by reading ~/.ashlr/verse/multimodel/outcomes.jsonl directly: each line must carry at (a parseable timestamp), seatId inside the writer\'s seatIdOk bounds, a non-empty engine, kind inside PROMPT_KINDS and signal inside OUTCOME_SIGNALS (src/core/verse/multimodel/types.ts); sessionId and model are contract fields that are never folded. In-window rows group by (kind, seat) and (kind, engine) through the same SIGNAL_WEIGHT/decay aggregation learning.ts applies, then emit only when the decayed stat clears the advisor\'s own bars across two UTC days; \'auto-overridden\' vs \'auto-followed\' rows group per (kind, seat) for the advisor axis. The writer, store and advisor this repository owns are src/core/verse/multimodel-api.ts, src/core/verse/multimodel/store.ts and src/core/verse/multimodel/{classify,advisor,learning,escalation}.ts; the client recording the signals is src/web-ui/routes/verse/multimodel/.';

const NO_CHANGE = 'If the operator simply prefers another seat for this kind the learned tilt already re-orders interactive picks and fleet dispatch never consumed these signals — report no-change and name the evidence; if the seat\'s engine, model or subscription changed recently the outcome mix may be measuring a transition, not a defect.';

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const seenText = (cell: MultimodelOutcomeCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const boundText = (cell: MultimodelOutcomeCell): string =>
  cell.lowerBound ? ' A bounded tail cut older bytes, so these counts cover only the retained window — a lower bound, not the full window.' : '';

const shareText = (cell: MultimodelOutcomeCell): string =>
  cell.totalRows > 0 ? ` (${Math.round((cell.rows / cell.totalRows) * 100)}% of the ${cell.totalRows} contract-valid in-window rows)` : '';

const tallyText = (cell: MultimodelOutcomeCell): string =>
  cell.topSignals.length > 0 ? ` Signal mix: ${cell.topSignals.join(', ')}.` : '';

function preferenceDetail(cell: MultimodelOutcomeCell, subjectLabel: string): string {
  const up = cell.up ?? 0;
  const down = cell.down ?? 0;
  const total = up + down;
  const tally = total > 0 ? ` — ${down} negative vs ${up} positive recorded signal(s)` : '';
  const seats = cell.seats.length > 0
    ? ` The engine's rows named ${cell.seats.length}${cell.seats.length >= MAX_ENGINE_SEATS ? '+' : ''} distinct seat(s): ${cell.seats.join(', ')}${cell.seats.length >= MAX_ENGINE_SEATS ? ', …' : ''}.`
    : '';
  const investigation = cell.axis === 'engine'
    ? `Find why engine '${cell.subject}' keeps losing '${cell.promptKind}' outcomes before blaming any one seat: check provider-side model drift or deprecation (the router catalog refresh journal and \`phm router catalog\` reports), the engine's tier mapping for '${cell.promptKind}' difficulty (src/core/routing), quota posture across ALL of its seats (\`phm fleet vitals\` usage sections, usage-readings journal), and whether '${cell.promptKind}' classification routes engine-inappropriate work to it (classify.ts kind → RoutingTask/RoutingDifficulty). Fix what lives here — the catalog entry, the tier map, or the classification boundary.`
    : `Find why seat '${cell.subject}' keeps losing '${cell.promptKind}' outcomes: check whether its engine/model degraded (the engine-level cell and \`phm lanes health\` carry the fleet view), whether '${cell.promptKind}' prompts hit a weakness the seat's tier mapping does not capture, whether its quota window is chronically spent so answers arrive late or truncated, and whether prompt-kind classification mislabels '${cell.promptKind}' traffic (the label endpoint's decidedBy 'jev' vs 'rules' path). Fix what lives here — the seat's catalog or policy entry, the classification boundary, or the evidence path that should mark the seat's '${cell.promptKind}' record stale.`;
  return [
    `Phantom's Multi-model chat keeps recording adverse outcomes for ${subjectLabel} on '${cell.promptKind}' prompts`,
    '',
    `${cell.rows} outcome row(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) for ${subjectLabel} and prompt kind '${cell.promptKind}' — decayed learned score ${cell.score} over ${cell.signals} signal(s), enough for the advisor's own phrase gate (tilt +${cell.tilt}: the "you've passed over" direction).${tally}${tallyText(cell)}${seats}${shareText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    `Every '${cell.promptKind}' answer ${subjectLabel} gives is accumulating negative evidence — thumbs-down, retries, switches-away, lost Compares, overrides and escalations all fold into the same learned stat the Auto advisor reads.`,
    '',
    EVIDENCE,
    '',
    investigation,
    '',
    NO_CHANGE,
    '',
    REPRO,
  ].join('\n');
}

function multimodelOutcomePrompt(cell: MultimodelOutcomeCell): string {
  if (cell.axis === 'advisor') {
    const followed = cell.followed ?? 0;
    const total = cell.rows + followed;
    const share = total > 0 ? Math.round((cell.rows / total) * 100) : null;
    const shareClause = share === null ? '' : ` — ${share}% of the ${total} recorded Auto-suggestion outcome(s) for this pair`;
    return [
      `Phantom's Auto seat picker keeps getting overridden on '${cell.promptKind}' prompts`,
      '',
      `${cell.rows} 'auto-overridden' outcome row(s) versus ${followed} 'auto-followed' across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) for seat '${cell.subject}' and prompt kind '${cell.promptKind}'${shareClause}.${seenText(cell)}${boundText(cell)}`,
      '',
      `Every override is the operator rejecting the seat Auto suggested for that prompt kind and sending somewhere else instead — recurring rejections mean the advisor's ranking systematically mispicks for '${cell.promptKind}' traffic aimed at '${cell.subject}'. The learned tilt already suppresses the seat interactively (bounded ±${LEARNING_MAX_TILT} positions), but nothing investigates WHY the picker keeps choosing it.`,
      '',
      EVIDENCE,
      '',
      `Find why the Auto advisor keeps suggesting '${cell.subject}' for '${cell.promptKind}' prompts the operator rejects: check advisor.ts's factor weights and how classify.ts maps '${cell.promptKind}' to RoutingTask/RoutingDifficulty (a kind whose difficulty the seat overshoots will keep attracting suggestions), whether '${cell.subject}'s SeatAdviceOption note or tier overstates it for this kind, whether the alternatives ordering buries the seat the operator actually picks, and whether engine-level learned stats are drowning the seat-level signal (learning.ts's seat-wins rule needs LEARNING_MIN_SIGNALS on the seat key before engine evidence applies). Fix what lives here — the advisor's factor weights, the kind → task/difficulty map, or the option notes that feed the ranking.`,
      '',
      NO_CHANGE,
      '',
      REPRO,
    ].join('\n');
  }
  const subjectLabel = cell.axis === 'engine' ? `engine '${cell.subject}'` : `seat '${cell.subject}'`;
  return preferenceDetail(cell, subjectLabel);
}

function multimodelOutcomeTitle(cell: MultimodelOutcomeCell): string {
  switch (cell.axis) {
    case 'advisor': return `Auto picks for '${cell.promptKind}' keep landing on '${fieldText(cell.subject, MAX_NAME_CHARS)}' and getting overridden`.slice(0, MAX_TITLE_CHARS);
    case 'engine': return `Engine '${fieldText(cell.subject, MAX_NAME_CHARS)}' keeps losing '${cell.promptKind}' chat outcomes`.slice(0, MAX_TITLE_CHARS);
    case 'seat': return `Chat seat '${fieldText(cell.subject, MAX_NAME_CHARS)}' keeps losing '${cell.promptKind}' outcomes`.slice(0, MAX_TITLE_CHARS);
    default: return `Multi-model outcome journal recurring evidence`.slice(0, MAX_TITLE_CHARS);
  }
}

function multimodelOutcomeArea(cell: MultimodelOutcomeCell): string {
  switch (cell.axis) {
    case 'advisor': return 'multimodel-advisor-override';
    case 'engine': return 'multimodel-engine-preference';
    case 'seat': return 'multimodel-seat-preference';
    default: return 'multimodel-outcomes';
  }
}

function multimodelOutcomeItem(cell: MultimodelOutcomeCell, repo: string): CloudBacklogItem {
  return {
    id: `multimodel-outcomes-${sha(`${cell.axis}|${cell.promptKind}|${cell.subject}`)}`,
    title: multimodelOutcomeTitle(cell),
    prompt: multimodelOutcomePrompt(cell),
    area: multimodelOutcomeArea(cell),
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the Multi-model outcome journal's recurring adverse
 * evidence. Total: any read or fold failure yields no items rather than
 * throwing into discovery.
 */
export async function multimodelOutcomesBacklogItems(opts: MultimodelOutcomesItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowHours = opts.windowHours ?? MULTIMODEL_OUTCOMES_WINDOW_HOURS;
    const homeDir = opts.homeDir ?? homedir();
    const journalPath = opts.journalPath ?? (opts.homeDir === undefined ? join(defaultMultimodelRoot(), 'outcomes.jsonl') : join(homeDir, '.ashlr', 'verse', 'multimodel', 'outcomes.jsonl'));
    const read = await readLedgerTail(journalPath, MULTIMODEL_OUTCOMES_TAIL_BYTES);
    if (read.state !== 'read') return [];
    // readLedgerTail has no time filter; the fold's per-row window check
    // drops everything older than the window.
    const fold = foldMultimodelOutcomes([read.text], nowMs, windowHours);
    const cells = multimodelOutcomeCells(fold, read.truncated);
    if (cells.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? MULTIMODEL_OUTCOMES_BACKLOG_MAX_ITEMS, MULTIMODEL_OUTCOMES_BACKLOG_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => multimodelOutcomeItem(cell, repo));
  } catch {
    return [];
  }
}
