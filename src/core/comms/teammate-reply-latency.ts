/**
 * RQ-PHX-TEAMMATELATENCY20: how fast teammate (Dot) texts get answered.
 * Pairs each text row in teammates.jsonl with its answered marker by rowid.
 * Output carries only rowids, counts, minutes and intent: never text or senders.
 */
import { classifyTeammateIntent, readRows, type TeammateRow, type TeammateSourceState } from './imessage-teammate-inbox.js';

export interface TeammateLatencySummary {
  v: 1;
  windowHours: number;
  targetMinutes: number;
  texts: number;
  answered: number;
  unanswered: number;
  ignorable: number;
  medianMinutes: number | null;
  p90Minutes: number | null;
  maxMinutes: number | null;
  withinTarget: number;
  oldestUnanswered: { rowid: number; ageMinutes: number; intent: 'reply' | 'leader' } | null;
  /** Newest inbound text time in the readable tail (ISO). Not window-limited: it is a contact fact, not a latency stat. Null when no text rows parse. */
  latestTextAt: string | null;
  sourceState: TeammateSourceState;
}

const HOUR_MS = 3_600_000;
const validRowid = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Nearest-rank percentile over an ascending list. */
const percentile = (sorted: number[], p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;

export function summarizeTeammateLatency(
  rows: readonly TeammateRow[],
  opts: { now: number; windowMs?: number; targetMinutes?: number; sourceState?: TeammateSourceState },
): TeammateLatencySummary {
  const windowMs = opts.windowMs ?? 24 * HOUR_MS;
  const targetMinutes = opts.targetMinutes ?? 5;
  // First marker wins: that is when the text was first answered.
  const answeredAt = new Map<number, number>();
  for (const r of rows) {
    if (!validRowid(r.answered) || typeof r.at !== 'string') continue;
    const t = Date.parse(r.at);
    if (Number.isFinite(t) && !answeredAt.has(r.answered)) answeredAt.set(r.answered, t);
  }
  const latencies: number[] = [];
  let texts = 0, unanswered = 0, ignorable = 0;
  let oldest: TeammateLatencySummary['oldestUnanswered'] = null;
  let oldestAt = Infinity;
  let latestTextAt: string | null = null;
  let latestTextMs = -Infinity;
  const seen = new Set<number>();
  for (const r of rows) {
    if (!validRowid(r.rowid) || typeof r.at !== 'string' || typeof r.text !== 'string' || seen.has(r.rowid)) continue;
    const at = Date.parse(r.at);
    if (!Number.isFinite(at)) continue;
    if (at > latestTextMs) { latestTextMs = at; latestTextAt = r.at; }
    if (opts.now - at > windowMs) continue;
    seen.add(r.rowid);
    texts++;
    const intent = classifyTeammateIntent(r.text);
    if (intent === 'ignore') { ignorable++; continue; }
    const answerAt = answeredAt.get(r.rowid);
    if (answerAt !== undefined) {
      latencies.push(Math.max(0, answerAt - at) / 60_000);
    } else {
      unanswered++;
      if (at < oldestAt) {
        oldestAt = at;
        oldest = { rowid: r.rowid, ageMinutes: Math.max(0, Math.floor((opts.now - at) / 60_000)), intent };
      }
    }
  }
  latencies.sort((a, b) => a - b);
  const n = latencies.length;
  const mid = n >> 1;
  return {
    v: 1,
    windowHours: round1(windowMs / HOUR_MS),
    targetMinutes,
    texts,
    answered: n,
    unanswered,
    ignorable,
    medianMinutes: n === 0 ? null : round1(n % 2 ? latencies[mid]! : (latencies[mid - 1]! + latencies[mid]!) / 2),
    p90Minutes: n === 0 ? null : round1(percentile(latencies, 0.9)),
    maxMinutes: n === 0 ? null : round1(latencies[n - 1]!),
    withinTarget: latencies.filter((m) => m <= targetMinutes).length,
    oldestUnanswered: oldest,
    latestTextAt,
    sourceState: opts.sourceState ?? 'healthy',
  };
}

/** Read teammates.jsonl (capped tail) and summarize. Never throws. */
export function readTeammateLatency(opts: {
  runsDir?: string; now?: () => number; windowMs?: number; targetMinutes?: number;
} = {}): TeammateLatencySummary {
  const now = (opts.now ?? Date.now)();
  try {
    const { rows, state } = readRows(opts.runsDir);
    return summarizeTeammateLatency(rows, { now, windowMs: opts.windowMs, targetMinutes: opts.targetMinutes, sourceState: state });
  } catch {
    return summarizeTeammateLatency([], { now, windowMs: opts.windowMs, targetMinutes: opts.targetMinutes, sourceState: 'degraded' });
  }
}
