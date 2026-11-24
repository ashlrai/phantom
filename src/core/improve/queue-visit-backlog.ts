/**
 * ~/.ashlr/queue/visits.jsonl queue-visit journal → self-improvement backlog
 * items.
 *
 * The daemon's visit-sync off-tick job (src/core/queue/visit-sync.ts) folds
 * metrics/jobs.jsonl and the live `- READY` rows of queue/router-queue.md
 * into QueueVisit snapshots — one job attempt's (<job>:a<attempt>) dwell
 * through each pipeline station: READY queue wait, claimed worker service,
 * publish slot, pr-ci CI wait, merge-queue dwell and the zero-dwell merged
 * marker — and appends each new or progressed snapshot to this one
 * append-only journal under the Ashlr home (queueJournalPath,
 * $ASHLR_HOME/queue/visits.jsonl). Every reader folds to the latest
 * appended snapshot per (station, pool, id); the journal self-compacts
 * past VISIT_JOURNAL_MAX_BYTES keeping exactly that live evidence window.
 *
 * Until now its only readers were point-in-time surfaces:
 * `phm queue stats` and GET /api/queue/stats (the Fleet Dashboard's
 * station graph, which rates each station/pool window idle, green, amber,
 * red or unknown from the same estimateQueueStats fold and names a
 * bottleneck) — reports someone had to run and read, showing only the
 * windows asked for. A station that kept rating red week after week, or
 * visits that kept parking open with no completedAt, looked like ordinary
 * current-state numbers and never became work.
 * queueVisitBacklogItems carries the same rows into discoverBacklog.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's bounded
 *    no-follow tail at twice the writer's own compaction bound; nothing is
 *    written and no network is touched. A missing or unreadable file
 *    yields no items; a malformed line is skipped, never guessed.
 *  - Rows count only under the writer's contract: isQueueVisit accepts a
 *    snapshot — non-empty id/station/pool strings, finite arrivedAt,
 *    startedAt >= arrivedAt when present, completedAt >= startedAt when
 *    present — and the last appended snapshot per queueVisitKey wins, the
 *    same dedup estimateQueueStats and the journal's own compaction apply.
 *  - Saturation is the dashboard's own verdict, not an invented bar: for
 *    each UTC day inside the window the fold runs estimateQueueStats on
 *    exactly that day's half-open bounds — the same call `phm queue
 *    stats --window 86400` makes — and a (scope, name) cell records the
 *    day as adverse when its rho reaches 0.9, the documented red band
 *    (offered load at or above the measured service rate; stations whose
 *    service is structurally instantaneous — READY, publish,
 *    merge-queue, merged — never measure a rate and never saturate).
 *    A cell emits only at QUEUE_VISIT_MIN_ADVERSE_DAYS distinct adverse
 *    days AND QUEUE_VISIT_MIN_ARRIVALS in-window arrivals, so one busy
 *    afternoon or a two-visit cell never queues a session.
 *  - Stuck is recorded evidence, not a guess: a latest snapshot with no
 *    completedAt whose arrivedAt is at least QUEUE_VISIT_STUCK_AGE_MS old
 *    at the clock is a visit parked at its station — publish waiting on a
 *    publisher slot, pr-ci never completing, merge-queue never merging,
 *    READY never launching, claimed never finishing. A cell emits only at
 *    QUEUE_VISIT_MIN_STUCK distinct visits whose in-window open days span
 *    QUEUE_VISIT_MIN_DAYS distinct UTC days.
 *  - Truncation is stated, never hidden: when the bounded tail cut older
 *    bytes, every prompt says the counts are a lower bound.
 *  - Fleet machinery only: the journal is this install's dispatch record
 *    and carries no repository column, so items emit only when the
 *    backlog target's repository name is 'phantom', the same
 *    last-segment rule the sibling fleet-evidence feeds apply.
 *  - Dedup is downstream: the item id hashes the cell identity — never
 *    the counts or timestamps — so a refresh re-derives the same id and
 *    appendUserBacklogItems adds only what is new; a station that
 *    recovers simply stops re-adding as its days roll out of the window.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { queueJournalPath } from '../queue/journal.js';
import { estimateQueueStats, isQueueVisit, queueVisitKey, type QueueVisit } from '../queue/stats.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';
import { STRAY_ID_PATTERN } from '../fleet/stray-slots.js';

/** Items one call may emit; the cell space is stations × pools × two kinds. */
export const QUEUE_VISIT_BACKLOG_MAX_ITEMS = 8;
const QUEUE_VISIT_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention. */
export const QUEUE_VISIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** An open visit this old at the clock is parked evidence, not in-flight work. */
export const QUEUE_VISIT_STUCK_AGE_MS = 24 * 60 * 60 * 1000;
/** A saturated cell emits only at this many distinct adverse UTC days... */
export const QUEUE_VISIT_MIN_ADVERSE_DAYS = 2;
/** ...and this many in-window arrivals, so a two-visit cell never emits. */
export const QUEUE_VISIT_MIN_ARRIVALS = 3;
/** A stuck cell emits only at this many distinct parked visits... */
export const QUEUE_VISIT_MIN_STUCK = 2;
/** ...whose open days span this many distinct UTC days inside the window. */
export const QUEUE_VISIT_MIN_DAYS = 2;
/** Bounded tail: twice the writer's own 4 MiB compaction bound covers the overshoot between sync passes. */
const QUEUE_VISIT_TAIL_BYTES = 8 * 1024 * 1024;
/** The fleet's own repository label: visit evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** The dashboard's documented red band: offered load at or above measured service capacity. */
const RHO_RED = 0.9;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded names are unbounded text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 80;
/** UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;
/** Example job ids quoted inside one stuck prompt. */
const MAX_EXAMPLES = 3;
/** Station/pool labels are dispatcher vocabulary; the shape check is defense in depth after scrub. */
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
/** What each station's dwell means, quoted inside prompts so the reader knows which pipeline stage is dragging. */
const STATION_HINT: Record<string, string> = {
  READY: 'queue dwell — arrival to launch, dispatch service instantaneous',
  claimed: 'worker service — launch to the first finish/publish/terminal boundary',
  publish: 'publisher slot — finish to publish',
  'pr-ci': 'CI dwell — publish to ci_complete or a matched terminal',
  'merge-queue': 'merge dwell — ci_complete to merged/closed',
  merged: 'zero-dwell throughput marker',
};

export interface QueueVisitItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Journal override (default: queueJournalPath(), the writer's own $ASHLR_HOME path). */
  journalPath?: string;
  /** Evidence window in ms (default QUEUE_VISIT_WINDOW_MS). */
  windowMs?: number;
  /** Most items one call emits (default QUEUE_VISIT_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window and the stuck age (default: now, ms epoch). */
  now?: number;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);
const dayOfMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

/** Journal-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// Fold — one pass over the journal tail
// ---------------------------------------------------------------------------

export interface QueueVisitJournalFold {
  /** Latest appended snapshot per (station, pool, id), the only form every reader folds to. */
  visits: QueueVisit[];
  /** Contract-valid snapshots the tail carried (superseded ones included). */
  rows: number;
  /** Non-blank lines that failed JSON parse or the writer's own visit contract. */
  invalidRows: number;
}

/**
 * Pure: fold journal text — oldest first — into the latest snapshot per
 * queueVisitKey. Lines that fail JSON parse or isQueueVisit are skipped,
 * never guessed; a later snapshot of the same key replaces the earlier one
 * exactly as estimateQueueStats and compactQueueVisits fold them.
 */
export function foldQueueVisitJournal(text: string): QueueVisitJournalFold {
  const fold: QueueVisitJournalFold = { visits: [], rows: 0, invalidRows: 0 };
  const latest = new Map<string, QueueVisit>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value: unknown;
    try { value = JSON.parse(trimmed); } catch { fold.invalidRows += 1; continue; }
    if (!isQueueVisit(value)) { fold.invalidRows += 1; continue; }
    fold.rows += 1;
    latest.set(queueVisitKey(value), value);
  }
  fold.visits = [...latest.values()];
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface QueueVisitDayStats {
  /** UTC date the half-open day window covered. */
  date: string;
  /** The day's window bounds in ms. */
  since: number;
  until: number;
  arrivals: number;
  departures: number;
  /** Offered load in worker equivalents; null when no service rate was measured. */
  rho: number | null;
  /** Mean arrival-to-start seconds for the day's departures; null with none. */
  wait: number | null;
  /** Time-average waiting occupancy in visit-seconds per second. */
  queueLength: number | null;
  /** Time-average total occupancy. */
  wip: number | null;
  /** Endpoint counts at the day's close. */
  currentQueueLength: number;
  currentWip: number;
}

/** Per-(scope, name) cell before the recurring bars apply. */
interface CellFold {
  scope: 'station' | 'pool';
  name: string;
  days: Map<string, QueueVisitDayStats>;
  arrivals: number;
  departures: number;
  maxRho: number;
  firstMs: number | null;
  lastMs: number | null;
}

export interface QueueVisitSaturatedCell {
  kind: 'saturated';
  scope: 'station' | 'pool';
  name: string;
  /** Distinct UTC dates whose window rated rho >= RHO_RED, sorted. */
  days: string[];
  /** In-window arrivals across every day window (each arrival lands in exactly one). */
  arrivals: number;
  /** In-window departures across every day window. */
  departures: number;
  /** Highest rho any adverse day recorded. */
  maxRho: number;
  /** The most recent day's stats — current pressure, not just history. */
  latest: QueueVisitDayStats;
  firstSeen: string | null;
  lastSeen: string | null;
  lowerBound: boolean;
}

export interface QueueVisitStuckVisit {
  /** The job id the visit id embeds (<job>:a<attempt>), when it matches the fleet id shape. */
  job: string;
  arrivedAt: string;
  /** Whole days the visit has been open at the clock. */
  ageDays: number;
}

export interface QueueVisitStuckCell {
  kind: 'stuck';
  scope: 'station' | 'pool';
  name: string;
  /** Distinct parked visits (latest snapshots with no completedAt, aged past the bar). */
  visits: number;
  /** Union of the in-window UTC days the parked visits have been open, sorted. */
  days: string[];
  /** Up to MAX_EXAMPLES fleet-shaped job ids among the parked visits. */
  examples: QueueVisitStuckVisit[];
  /** Oldest parked arrival in ms; null when none parse (they always do — isQueueVisit requires finite arrivedAt). */
  oldestArrivedAt: number | null;
  /** Newest parked arrival in ms. */
  newestArrivedAt: number | null;
  lowerBound: boolean;
}

export type QueueVisitCell = QueueVisitSaturatedCell | QueueVisitStuckCell;

/**
 * Pure: the UTC dates whose half-open day windows partition
 * [nowMs - windowMs, nowMs). The first date clips to the window start, the
 * last ends at the clock — today is a partial day and still counts.
 */
export function queueVisitWindowDays(nowMs: number, windowMs: number): Array<{ date: string; since: number; until: number }> {
  const windowStart = nowMs - windowMs;
  const days: Array<{ date: string; since: number; until: number }> = [];
  const first = new Date(windowStart);
  let cursor = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate());
  while (cursor < nowMs) {
    const since = Math.max(cursor, windowStart);
    const until = Math.min(cursor + DAY_MS, nowMs);
    if (until > since) days.push({ date: dayOfMs(cursor), since, until });
    cursor += DAY_MS;
  }
  return days;
}

const dayStatsOf = (date: string, since: number, until: number, w: { arrivals: number; departures: number; rho: number | null; wait: number | null; queueLength: number; wip: number; currentQueueLength: number; currentWip: number }): QueueVisitDayStats => ({
  date,
  since,
  until,
  arrivals: w.arrivals,
  departures: w.departures,
  rho: w.rho,
  wait: w.wait,
  queueLength: w.queueLength,
  wip: w.wip,
  currentQueueLength: w.currentQueueLength,
  currentWip: w.currentWip,
});

/**
 * Pure: recurring cells over the folded visits. For every UTC day in the
 * window, estimateQueueStats — the exact fold `phm queue stats` and the
 * dashboard station graph run — rates each station and pool; a cell's day
 * is adverse when rho reaches the documented red band. Stuck cells fold
 * the open snapshots aged past QUEUE_VISIT_STUCK_AGE_MS. Both emit only at
 * their recurring bars; sorted stuck-first (parked work is the sharper
 * signal), then by severity, then name for determinism.
 */
export function queueVisitCells(fold: QueueVisitJournalFold, nowMs: number, windowMs: number, lowerBound = false): QueueVisitCell[] {
  const cells = new Map<string, CellFold>();
  const cellFor = (scope: 'station' | 'pool', name: string): CellFold => {
    const key = `${scope}|${name}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = { scope, name, days: new Map(), arrivals: 0, departures: 0, maxRho: 0, firstMs: null, lastMs: null };
      cells.set(key, cell);
    }
    return cell;
  };
  const windowStart = nowMs - windowMs;
  const windowDates = new Set<string>();
  for (const day of queueVisitWindowDays(nowMs, windowMs)) {
    windowDates.add(day.date);
    const stats = estimateQueueStats(fold.visits, day.until, [day.until - day.since]);
    for (const [scope, rows] of [['station', stats.stations], ['pool', stats.pools]] as const) {
      for (const row of rows) {
        // estimateQueueStats keys each group by a computed property, so the
        // row's name and windows infer as the union of every property type;
        // narrow both before use.
        const name = row[scope];
        const w = Array.isArray(row.windows) ? row.windows[0] : undefined;
        if (typeof name !== 'string' || w === undefined) continue;
        const cell = cellFor(scope, name);
        cell.days.set(day.date, dayStatsOf(day.date, day.since, day.until, w));
        cell.arrivals += w.arrivals;
        cell.departures += w.departures;
        if (w.rho !== null) cell.maxRho = Math.max(cell.maxRho, w.rho);
      }
    }
  }

  // One pass for each cell's activity span: a visit overlaps the evidence
  // window when it arrived before the clock and was not completed before
  // the window opened (open visits count through the clock).
  for (const visit of fold.visits) {
    if (visit.arrivedAt >= nowMs) continue;
    const end = Math.min(visit.completedAt ?? nowMs, nowMs);
    if (end <= windowStart) continue;
    for (const scope of ['station', 'pool'] as const) {
      const name = scope === 'station' ? visit.station : visit.pool;
      const cell = cells.get(`${scope}|${name}`);
      if (cell === undefined) continue;
      cell.firstMs = cell.firstMs === null ? visit.arrivedAt : Math.min(cell.firstMs, visit.arrivedAt);
      cell.lastMs = cell.lastMs === null ? end : Math.max(cell.lastMs, end);
    }
  }

  const out: QueueVisitCell[] = [];
  for (const cell of cells.values()) {
    if (!SAFE_LABEL.test(cell.name)) continue;
    const adverse = [...cell.days.values()].filter((d) => d.rho !== null && d.rho >= RHO_RED);
    if (adverse.length >= QUEUE_VISIT_MIN_ADVERSE_DAYS && cell.arrivals >= QUEUE_VISIT_MIN_ARRIVALS) {
      const latest = [...cell.days.values()].sort((a, b) => a.until - b.until).at(-1)!;
      out.push({
        kind: 'saturated',
        scope: cell.scope,
        name: cell.name,
        days: adverse.map((d) => d.date).sort(),
        arrivals: cell.arrivals,
        departures: cell.departures,
        maxRho: cell.maxRho,
        latest,
        firstSeen: isoOrNull(cell.firstMs),
        lastSeen: isoOrNull(cell.lastMs),
        lowerBound,
      });
    }
  }

  // Stuck: latest snapshots still open (no completedAt) aged past the bar.
  // A parked visit's open days are every window UTC date from its arrival
  // (clipped to the window start) through the clock — it demonstrably held
  // the station across them.
  const stuckByCell = new Map<string, { scope: 'station' | 'pool'; name: string; visits: number; days: Set<string>; examples: QueueVisitStuckVisit[]; oldest: number | null; newest: number | null }>();
  for (const visit of fold.visits) {
    if (visit.completedAt !== undefined) continue;
    if (nowMs - visit.arrivedAt < QUEUE_VISIT_STUCK_AGE_MS) continue;
    if (!SAFE_LABEL.test(visit.station) || !SAFE_LABEL.test(visit.pool)) continue;
    const openFrom = Math.max(visit.arrivedAt, windowStart);
    const openDays = queueVisitWindowDays(nowMs, nowMs - openFrom).map((d) => d.date);
    for (const scope of ['station', 'pool'] as const) {
      const name = scope === 'station' ? visit.station : visit.pool;
      const key = `${scope}|${name}`;
      let agg = stuckByCell.get(key);
      if (agg === undefined) {
        agg = { scope, name, visits: 0, days: new Set(), examples: [], oldest: null, newest: null };
        stuckByCell.set(key, agg);
      }
      agg.visits += 1;
      for (const d of openDays) if (windowDates.has(d)) agg.days.add(d);
      agg.oldest = agg.oldest === null ? visit.arrivedAt : Math.min(agg.oldest, visit.arrivedAt);
      agg.newest = agg.newest === null ? visit.arrivedAt : Math.max(agg.newest, visit.arrivedAt);
      if (agg.examples.length < MAX_EXAMPLES) {
        const job = visit.id.replace(/:a\d+$/, '');
        if (STRAY_ID_PATTERN.test(job)) {
          agg.examples.push({
            job,
            arrivedAt: new Date(visit.arrivedAt).toISOString(),
            ageDays: Math.floor((nowMs - visit.arrivedAt) / DAY_MS),
          });
        }
      }
    }
  }
  for (const agg of stuckByCell.values()) {
    if (agg.visits < QUEUE_VISIT_MIN_STUCK || agg.days.size < QUEUE_VISIT_MIN_DAYS) continue;
    out.push({
      kind: 'stuck',
      scope: agg.scope,
      name: agg.name,
      visits: agg.visits,
      days: [...agg.days].sort(),
      examples: agg.examples,
      oldestArrivedAt: agg.oldest,
      newestArrivedAt: agg.newest,
      lowerBound,
    });
  }

  const rank = (c: QueueVisitCell): number => (c.kind === 'stuck' ? 0 : 1);
  const metric = (c: QueueVisitCell): number => (c.kind === 'stuck' ? c.visits : c.maxRho);
  return out.sort((a, b) => rank(a) - rank(b) || metric(b) - metric(a) || a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is queue/visits.jsonl under the Ashlr home (~/.ashlr or $ASHLR_HOME) — queueJournalPath() in src/core/queue/journal.ts resolves it — one append-only file the daemon\'s visit-sync off-tick job (src/core/queue/visit-sync.ts, syncQueueVisits) appends to on every self-improvement pass: it folds metrics/jobs.jsonl and the live `- READY` rows of queue/router-queue.md into QueueVisit snapshots, one per job attempt (<job>:a<attempt>) per pipeline station — READY queue dwell, claimed worker service, publish slot, pr-ci CI dwell, merge-queue dwell and the zero-dwell merged marker — recording arrivedAt/startedAt/completedAt epoch-ms boundaries derived only from ledger stamps, never invented. The file self-compacts past VISIT_JOURNAL_MAX_BYTES keeping the latest snapshot per (station, pool, id) — the only form every reader folds to. Its only readers until this feed were `phm queue stats` and GET /api/queue/stats — the Fleet Dashboard\'s station graph, which rates each window idle/green/amber/red/unknown from the same estimateQueueStats fold and names a bottleneck — point-in-time reports someone had to run and read, so a station that kept rating red or visits that kept parking open never became work.';

const REPRO = 'Reproduce the fold by reading queue/visits.jsonl directly, keeping the latest snapshot per (station, pool, id), then running estimateQueueStats (src/core/queue/stats.ts — the same fold `phm queue stats` and the dashboard station graph use) on each UTC day\'s half-open bounds inside the window: a (station|pool, name) cell\'s day is adverse when rho >= 0.9, the documented red band, and open snapshots with no completedAt aged >= 24h at the clock are the stuck evidence. The writer and sync are src/core/queue/visit-sync.ts (queueVisitsFromJobs, queueReadyVisits, syncQueueVisits) and src/core/queue/journal.ts (recordQueueVisit, appendQueueVisits, compactQueueVisits, VISIT_JOURNAL_MAX_BYTES).';

const NO_CHANGE = 'If the window has rolled forward, the red days trace to a planned capacity push or a one-off migration the later days recovered from, the parked visits belong to jobs the queue deliberately holds (KILL, park, foreign-owner rows) rather than dropped work, the saturation is a single lane\'s intentional concentration the router already prefers for the work\'s shape, or the journal\'s producer (visit-sync) stopped feeding and the evidence is stale residue — report no-change and name the evidence.';

const fmtSeconds = (s: number | null): string => (s === null ? 'unknown' : `${Math.round(s)}s`);

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const boundText = (cell: { lowerBound: boolean }): string =>
  cell.lowerBound ? ' The journal tail was truncated at the bounded read, so these counts cover only the retained rows — a lower bound, not the full window.' : '';

const scopeNoun = (scope: 'station' | 'pool'): string => (scope === 'station' ? 'station' : 'pool (lane)');

function saturatedPrompt(cell: QueueVisitSaturatedCell): string {
  const latest = cell.latest;
  const hint = STATION_HINT[cell.name] ?? (cell.scope === 'pool' ? 'the lane\'s offered load across every station' : 'a pipeline station');
  return [
    `Phantom's queue-visit journal keeps rating ${scopeNoun(cell.scope)} '${fieldText(cell.name, MAX_NAME_CHARS)}' saturated — estimateQueueStats, the same fold \`phm queue stats\` and the Fleet Dashboard station graph run, put its offered load rho at or above ${RHO_RED} — the documented red band, wait growing steeply as offered load nears and passes measured service capacity — on ${cell.days.length} distinct UTC day(s) inside the 7-day window (${daysText(cell.days)}) — the self-improvement work this backlog exists for.`,
    '',
    `Each visit is one job attempt's (<job>:a<attempt>) recorded dwell through a pipeline station — ${hint}. Across the window the cell saw ${cell.arrivals} arrival(s) and ${cell.departures} departure(s); peak rho ${cell.maxRho.toFixed(2)}. The most recent day (${latest.date}) closed with wait ${fmtSeconds(latest.wait)}, queue occupancy ${latest.queueLength === null ? 'unknown' : latest.queueLength.toFixed(2)}, wip ${latest.wip === null ? 'unknown' : latest.wip.toFixed(2)} and ${latest.currentQueueLength} visit(s) still waiting / ${latest.currentWip} in service at close.${cell.firstSeen !== null && cell.lastSeen !== null ? ` Activity recorded ${cell.firstSeen} through ${cell.lastSeen}.` : ''}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    cell.scope === 'station'
      ? `Find why station '${fieldText(cell.name, MAX_NAME_CHARS)}' keeps saturating: read the newest visit rows for the station, then check whether its service rate is genuinely the binding constraint — too few workers for the arrival rate (claimed concurrency, CI runner capacity for pr-ci, publisher slots for publish, merge throughput for merge-queue), a station whose exits depend on machinery that keeps failing (the sibling ci-rerun, merge-queue and autopilot feeds carry those recurrences), or arrival bursts the scheduler should smooth. If the red days trace to deliberate over-provisioning for a planned push, report no-change.`
      : `Find why pool '${fieldText(cell.name, MAX_NAME_CHARS)}' keeps saturating: read the newest visit rows carrying that pool, then check whether the lane's worker-equivalent capacity is genuinely below its offered load — seat count, per-seat concurrency, quota-throttled lanes the router keeps preferring anyway (the sibling rate-limit, routine and unfed feeds carry the provider-side evidence) — or whether the lane is absorbing work shaped for other lanes. If the concentration is deliberate for the work's shape, report no-change.`,
    '',
    `Fix what lives here — the station's service capacity in this repo's dispatch, scheduler or merge machinery, the lane's seat/concurrency configuration the router reads, or the visit-sync fold itself if the recorded boundaries are wrong. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function stuckPrompt(cell: QueueVisitStuckCell): string {
  const hint = cell.scope === 'station'
    ? (STATION_HINT[cell.name] ?? 'a pipeline station')
    : 'the lane\'s visits across every station';
  const examples = cell.examples.length === 0
    ? ''
    : ` Example job ids still parked: ${cell.examples.map((e) => `'${e.job}'`).join(', ')}.`;
  return [
    `Phantom's queue-visit journal keeps recording visits that never complete — ${cell.visits} distinct visit(s) at ${scopeNoun(cell.scope)} '${fieldText(cell.name, MAX_NAME_CHARS)}' have no completedAt in their latest snapshot and are at least ${Math.floor(QUEUE_VISIT_STUCK_AGE_MS / DAY_MS)} day(s) old at the clock, parked across ${cell.days.length} UTC day(s) inside the 7-day window (${daysText(cell.days)}) — the self-improvement work this backlog exists for.`,
    '',
    `Each visit is one job attempt's (<job>:a<attempt>) recorded dwell through a pipeline station — ${hint}. A snapshot with no completedAt means the station never recorded the boundary that ends the dwell: the job is parked, not merely slow. Oldest parked arrival ${cell.oldestArrivedAt === null ? 'unknown' : new Date(cell.oldestArrivedAt).toISOString()}, newest ${cell.newestArrivedAt === null ? 'unknown' : new Date(cell.newestArrivedAt).toISOString()}.${examples}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    cell.scope === 'station'
      ? `Find why visits keep parking at station '${fieldText(cell.name, MAX_NAME_CHARS)}': read the newest open snapshots for the station and their jobs in metrics/jobs.jsonl, then check whether the boundary that should close the dwell is never recorded — a publisher that stopped publishing (publish), CI runs that never conclude or never emit ci_complete (pr-ci), merges that never land (merge-queue), launches the dispatcher stopped firing (READY), or finishes the worker never writes (claimed). The visit-sync fold derives boundaries only from ledger stamps, so a missing boundary is upstream evidence, not a fold bug — unless the ledger carries the stamp and the fold drops it.`
      : `Find why pool '${fieldText(cell.name, MAX_NAME_CHARS)}'s visits keep parking: read the newest open snapshots carrying that pool and their jobs in metrics/jobs.jsonl, then check whether the lane stopped producing the closing boundary — seats that went unreachable or signed-out mid-run, quota or rate-limit walls the provider never recovered from (the sibling rate-limit and routine feeds carry that evidence), or jobs the lane claimed and abandoned.`,
    '',
    `Fix what lives here — the pass that should record the missing boundary, the lane's executor health, or the job lifecycle that leaves attempts open. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function queueVisitItem(cell: QueueVisitCell, repo: string): CloudBacklogItem {
  const name = fieldText(cell.name, MAX_NAME_CHARS);
  const title = cell.kind === 'saturated'
    ? `Queue ${cell.scope} '${name}' keeps rating saturated`
    : `Jobs keep parking at queue ${cell.scope} '${name}'`;
  return {
    id: `queue-visit-${sha(`${cell.kind}|${cell.scope}|${cell.name}`)}`,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: cell.kind === 'saturated' ? saturatedPrompt(cell) : stuckPrompt(cell),
    area: `queue-${cell.kind}`,
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the queue-visit journal's recurring saturation and
 * parked-visit evidence. Total: a missing journal, another repository or
 * any read or fold failure yields no items rather than throwing into
 * discovery.
 */
export async function queueVisitBacklogItems(opts: QueueVisitItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = opts.now ?? Date.now();
    const windowMs = opts.windowMs !== undefined && Number.isFinite(opts.windowMs) && opts.windowMs > 0
      ? opts.windowMs
      : QUEUE_VISIT_WINDOW_MS;
    if (!Number.isFinite(nowMs)) return [];
    const path = opts.journalPath ?? queueJournalPath();
    const tail = await readLedgerTail(path, QUEUE_VISIT_TAIL_BYTES);
    if (tail.state !== 'read') return [];
    const fold = foldQueueVisitJournal(tail.text);
    if (fold.visits.length === 0) return [];
    const cells = queueVisitCells(fold, nowMs, windowMs, tail.truncated);
    const limit = Math.max(1, Math.min(opts.limit ?? QUEUE_VISIT_BACKLOG_MAX_ITEMS, QUEUE_VISIT_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => queueVisitItem(cell, repo));
  } catch {
    return [];
  }
}
