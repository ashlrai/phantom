/**
 * usage-motion-audit.ts — RQ-PHX-ZEROWASTEAUDIT31: did each lane's usage
 * meter actually move over the last hour? `fleet lanes` retains only the
 * newest reading per pool, so a queued job or remaining quota can masquerade
 * as progress; this audit rereads the queue's usage-readings.log journal and
 * requires two distinct valid observations spanning the window — the latest
 * fresh — before asserting motion, stagnation (incident) or idleness.
 *
 * READ-ONLY GUARDRAILS: bounded fs reads only (8 MiB / 50,000 rows). Never
 * writes, spawns a process, touches credential/session directories, provider
 * endpoints or the network, and never clears holds or launches work. A proven
 * `incident` is evidence for an operator — never a repair claim. Used-percent
 * is never compared against credit balances, and readings from different
 * reset windows are never subtracted. Ambiguity is preserved, never guessed:
 * stale, single, conflicting or malformed evidence is `insufficient-evidence`,
 * never healthy.
 */

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getFleetLaneSnapshot, type FleetLaneSourceState } from './lane-console.js';

const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const MAX_JOURNAL_ROWS = 50_000;
const WINDOW_MINUTES = 60;
const FRESH_MINUTES = 15;
const LANE_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

export type UsageMotionClassification =
  'incident' | 'moving' | 'idle' | 'reset-observed' | 'insufficient-evidence';

export interface UsageMotionLaneView {
  lane: string;
  /** READY jobs queued / in-flight jobs (null when no queue source read them). */
  queued: number | null;
  live: number | null;
  /** Distinct eligible readings; malformed rows naming this lane; same-timestamp conflicts; probe rows with no reading. */
  readings: number;
  droppedReadings: number;
  conflicts: number;
  probeMisses: number;
  firstReadingAt: string | null;
  lastReadingAt: string | null;
  observedMinutes: number | null;
  /** Oldest/newest eligible used-percent; delta null across a reset or <2 readings. */
  pctUsedFirst: number | null;
  pctUsedLast: number | null;
  pctUsedDelta: number | null;
  /** resetAt carried by the newest eligible reading. */
  resetBoundary: string | null;
  classification: UsageMotionClassification;
  reason: string;
  nextAction: string;
}

export interface UsageMotionAuditView {
  schema: 'fleet.usage-motion.v1';
  generatedAt: string;
  windowMinutes: number;
  freshnessMinutes: number;
  sources: {
    queue: FleetLaneSourceState;
    queueState: FleetLaneSourceState;
    usageJournal: {
      state: 'healthy' | 'missing' | 'degraded';
      file: string;
      rows: number;
      dropped: number;
      truncated: boolean;
    };
  };
  incidents: number;
  lanes: UsageMotionLaneView[];
}

export interface UsageMotionAuditOptions {
  /** Router queue directory. Default `~/.ashlr-runs/queue`. */
  queueDir?: string;
  /** Usage journal path. Default `<queueDir>/usage-readings.log`. */
  usageLogPath?: string;
  /** Clock seam for deterministic tests. */
  now?: () => Date;
}

interface MotionReading { ms: number; observedAt: string; pctUsed: number; resetAt: string | null }

interface JournalRead {
  state: 'healthy' | 'missing' | 'degraded';
  rows: number;
  dropped: number;
  truncated: boolean;
  readings: Map<string, MotionReading[]>;
  laneDropped: Map<string, number>;
  conflicts: Map<string, number>;
  probeMisses: Map<string, number>;
}

function emptyJournal(): Omit<JournalRead, 'state' | 'truncated'> {
  return { rows: 0, dropped: 0, readings: new Map(), laneDropped: new Map(), conflicts: new Map(), probeMisses: new Map() };
}

/**
 * Read the whole journal, not just the newest row per pool (lane-console
 * already projects that). Same row schema: pool, pctUsed 0–100, resetAt,
 * observed at writtenAt ?? fetchedAt ?? observedAt. A row naming a lane but
 * carrying a bad timestamp or invalid pctUsed is a defect for that lane;
 * unparsable lines are unattributable drops.
 */
function parseMotionJournal(text: string): JournalRead {
  const out: JournalRead = { state: 'healthy', truncated: false, ...emptyJournal() };
  const seen = new Map<string, Map<number, number>>(); // lane → observed ms → pctUsed
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (out.rows >= MAX_JOURNAL_ROWS) { out.truncated = true; break; }
    out.rows++;
    let value: unknown;
    try { value = JSON.parse(line); } catch { out.dropped++; continue; }
    const row = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
    const pool = row && typeof row.pool === 'string' && LANE_ID.test(row.pool) ? row.pool : null;
    if (!row || !pool) { out.dropped++; continue; }
    const observed = row.writtenAt ?? row.fetchedAt ?? row.observedAt;
    const ms = typeof observed === 'string' ? Date.parse(observed) : NaN;
    const pctRaw = row.pctUsed;
    const pct = typeof pctRaw === 'number' && Number.isFinite(pctRaw) && pctRaw >= 0 && pctRaw <= 100
      ? pctRaw : null;
    if (!Number.isFinite(ms) || (pctRaw !== undefined && pctRaw !== null && pct === null)) {
      out.laneDropped.set(pool, (out.laneDropped.get(pool) ?? 0) + 1);
      continue;
    }
    if (pct === null) { // probe ran, meter unread — legitimate status row
      out.probeMisses.set(pool, (out.probeMisses.get(pool) ?? 0) + 1);
      continue;
    }
    const byMs = seen.get(pool) ?? new Map<number, number>();
    seen.set(pool, byMs);
    const prior = byMs.get(ms);
    if (prior !== undefined && prior !== pct) {
      out.conflicts.set(pool, (out.conflicts.get(pool) ?? 0) + 1);
      continue; // same timestamp, different meter — preserve the ambiguity
    }
    if (prior === pct) continue; // identical re-observation, one timestamp
    byMs.set(ms, pct);
    const resetAt = typeof row.resetAt === 'string' && Number.isFinite(Date.parse(row.resetAt))
      ? row.resetAt : null;
    const list = out.readings.get(pool) ?? [];
    list.push({ ms, observedAt: observed as string, pctUsed: pct, resetAt });
    out.readings.set(pool, list);
  }
  if (out.dropped > 0 || out.laneDropped.size > 0 || out.truncated) out.state = 'degraded';
  return out;
}

async function readUsageJournal(path: string): Promise<JournalRead> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_JOURNAL_BYTES) {
      return { state: 'degraded', truncated: info.size > MAX_JOURNAL_BYTES, ...emptyJournal() };
    }
    return parseMotionJournal(await readFile(path, 'utf8'));
  } catch (error) {
    const state = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'degraded';
    return { state, truncated: false, ...emptyJournal() };
  }
}

const NEXT_ACTION: Record<UsageMotionClassification, string> = {
  'incident': "check the lane's held reason and dispatch evidence: 'ashlr fleet lanes' and 'ashlr fleet doctor'",
  'moving': 'none — the usage meter advanced inside the observed window',
  'idle': 'none — no queued or live work observed for this lane',
  'reset-observed': 'rerun once the new reset window has an hour of fresh readings',
  'insufficient-evidence': "refresh the existing usage probe so the journal holds fresh readings, then rerun 'ashlr fleet usage-audit'",
};

/** Read-only audit: snapshot queue/live evidence, reread journal history, classify. Never throws on bad input. */
export async function auditUsageMotion(options: UsageMotionAuditOptions = {}): Promise<UsageMotionAuditView> {
  const now = options.now?.() ?? new Date();
  const queueDir = options.queueDir ?? join(homedir(), '.ashlr-runs', 'queue');
  const journalPath = options.usageLogPath ?? join(queueDir, 'usage-readings.log');
  const [snapshot, journal] = await Promise.all([
    // Lane universe = the queue directory's own evidence (ready.tsv,
    // queue.v1.json, jobs.jsonl, the queue usage journal, canonical pools).
    // Ambient $ASHLR_HOME ledgers must not invent evidence this audit
    // cannot observe.
    getFleetLaneSnapshot({
      queueDir, budgetsDir: join(queueDir, 'budgets'),
      usageLogPaths: [journalPath], now: () => now,
    }),
    readUsageJournal(journalPath),
  ]);

  const laneIds = new Set<string>([
    ...snapshot.lanes.map(l => l.lane),
    ...journal.readings.keys(), ...journal.laneDropped.keys(),
    ...journal.conflicts.keys(), ...journal.probeMisses.keys(),
  ]);
  const queueDegraded =
    snapshot.sources.queue.state === 'degraded' || snapshot.sources.queueState.state === 'degraded';
  const byLane = new Map(snapshot.lanes.map(l => [l.lane, l]));

  const lanes: UsageMotionLaneView[] = [...laneIds].map(lane => {
    const view = byLane.get(lane);
    const queued = view?.queueDepth ?? null;
    const live = view?.liveJobs ?? null;
    const obs = [...(journal.readings.get(lane) ?? [])].sort((a, b) => a.ms - b.ms);
    const droppedReadings = journal.laneDropped.get(lane) ?? 0;
    const conflicts = journal.conflicts.get(lane) ?? 0;
    const probeMisses = journal.probeMisses.get(lane) ?? 0;
    const first = obs[0] ?? null;
    const last = obs.at(-1) ?? null;
    const span = first && last ? last.ms - first.ms : null;
    const discontinuous = obs.slice(1).some((b, i) => {
      const a = obs[i]!;
      return b.pctUsed < a.pctUsed || (a.resetAt !== null && b.resetAt !== null && a.resetAt !== b.resetAt);
    });

    // Visible rows prove work even under a degraded source (dropped rows can
    // only hide more). A computed double-zero needs clean sources before it
    // may claim the lane is empty.
    const work: 'positive' | 'empty' | 'unknown' =
      (queued ?? 0) + (live ?? 0) > 0 ? 'positive'
        : queued === null || live === null || queueDegraded ? 'unknown' : 'empty';

    let classification: UsageMotionClassification;
    let reason: string;
    const staleMin = last ? Math.round((now.getTime() - last.ms) / 60_000) : 0;
    if (droppedReadings > 0) {
      classification = 'insufficient-evidence';
      reason = `${droppedReadings} malformed reading(s) name this lane`;
    } else if (conflicts > 0) {
      classification = 'insufficient-evidence';
      reason = 'conflicting readings share a timestamp';
    } else if (obs.length < 2) {
      classification = 'insufficient-evidence';
      reason = journal.state === 'missing' ? 'usage journal is missing'
        : journal.state === 'degraded' && obs.length === 0 ? 'usage journal is unreadable or over the read bound'
        : obs.length === 0 ? (probeMisses > 0 ? `${probeMisses} probe row(s), none carried a meter reading` : 'no eligible readings in journal')
        : 'only one eligible reading in journal';
    } else if (staleMin > FRESH_MINUTES) {
      classification = 'insufficient-evidence';
      reason = `latest reading is ${staleMin}m old (> ${FRESH_MINUTES}m freshness bound)`;
    } else if (discontinuous) {
      classification = 'reset-observed';
      reason = 'meter evidence is discontinuous — a reset boundary or falling used-percent lies inside the observed interval';
    } else if (span! < WINDOW_MINUTES * 60_000) {
      classification = 'insufficient-evidence';
      reason = `eligible readings span ${Math.round(span! / 60_000)}m (< ${WINDOW_MINUTES}m window)`;
    } else if (last!.pctUsed > first!.pctUsed) {
      classification = 'moving';
      reason = `used-percent rose ${first!.pctUsed}% → ${last!.pctUsed}% over ${Math.round(span! / 60_000)}m`;
    } else if (work === 'unknown') {
      classification = 'insufficient-evidence';
      reason = 'meter unchanged but queue evidence cannot prove work present or absent';
    } else if (work === 'positive') {
      classification = 'incident';
      reason = `used-percent unchanged at ${first!.pctUsed}% for ${Math.round(span! / 60_000)}m with queued/live work`;
    } else {
      classification = 'idle';
      reason = 'meter unchanged and no queued or live work observed';
    }

    return {
      lane, queued, live,
      readings: obs.length, droppedReadings, conflicts, probeMisses,
      firstReadingAt: first?.observedAt ?? null,
      lastReadingAt: last?.observedAt ?? null,
      observedMinutes: span === null ? null : Math.round(span / 60_000),
      pctUsedFirst: first?.pctUsed ?? null,
      pctUsedLast: last?.pctUsed ?? null,
      pctUsedDelta: obs.length >= 2 && !discontinuous ? last!.pctUsed - first!.pctUsed : null,
      resetBoundary: last?.resetAt ?? null,
      classification, reason, nextAction: NEXT_ACTION[classification],
    };
  });

  // Incidents first, then unresolved evidence, then observed classes; name ties.
  const rank: Record<UsageMotionClassification, number> = {
    'incident': 0, 'insufficient-evidence': 1, 'reset-observed': 2, 'moving': 3, 'idle': 4,
  };
  lanes.sort((a, b) => rank[a.classification] - rank[b.classification] || a.lane.localeCompare(b.lane));

  return {
    schema: 'fleet.usage-motion.v1',
    generatedAt: now.toISOString(),
    windowMinutes: WINDOW_MINUTES,
    freshnessMinutes: FRESH_MINUTES,
    sources: {
      queue: snapshot.sources.queue.state,
      queueState: snapshot.sources.queueState.state,
      usageJournal: {
        state: journal.state, file: 'usage-readings.log',
        rows: journal.rows, dropped: journal.dropped, truncated: journal.truncated,
      },
    },
    incidents: lanes.filter(l => l.classification === 'incident').length,
    lanes,
  };
}
