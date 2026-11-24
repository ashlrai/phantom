/** Reads and folds the history into frames for `phm map replay` and the map-replay API. Node only; the pane uses map-replay.ts. */
import { buildMapEdges } from './map-edges.js';
import { BUS_INBOX_MAX_MESSAGES, scanBusInbox, type BusInboxOptions, type BusInboxScan } from './bus-inbox.js';
import { parseSince } from './agent-messages.js';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { worklog, type WorklogEntry } from './worklog.js';
import { readUsageSamples, type UsageReading } from './usage-history.js';
import { MAP_REPLAY_DEFAULT_SINCE, MAP_REPLAY_DEFAULT_STEP, MAP_REPLAY_LOOKBACK_HOURS, MAP_REPLAY_MAX_FRAMES, MAP_REPLAY_SCHEMA, MAP_REPLAY_SNAPSHOT_MAX_AGE_MS, parseStep,
  type MapReplay, type MapReplayFrame, type ReplayJob, type ReplayLane, type ReplayPool, type ReplayPr } from './map-replay.js';

/** The jobs ledger is read from its end, at most this many bytes: a bounded scan, never the whole file. */
export const MAP_REPLAY_LEDGER_MAX_BYTES = 32 * 1024 * 1024;

const job = (entry: Pick<WorklogEntry, 'job' | 'lane' | 'repo'>): ReplayJob | null => entry.job ? { job: entry.job, lane: entry.lane, repo: entry.repo } : null;
const pr = (entry: WorklogEntry): ReplayPr => ({ job: entry.job ?? 'unknown', lane: entry.lane, repo: entry.repo, url: entry.url });
const byJob = (a: ReplayJob, b: ReplayJob) => (a.job < b.job ? -1 : a.job > b.job ? 1 : 0);
/** A launch starts running; the first of these after it ends it. */
const ENDS = new Set<WorklogEntry['kind']>(['finished', 'pr', 'empty', 'failed', 'merged', 'closed']);

export interface ReplayInputs {
  /** Work log entries, any order. Null when the jobs ledger could not be read (unknown, not zero). */
  entries: readonly WorklogEntry[] | null;
  bus: Pick<BusInboxScan, 'source' | 'rows' | 'skipped'>;
  /** Recorded pool readings (usage history), any order. Null or absent when there is no pool history. */
  usage?: readonly UsageReading[] | null;
  /** Set when the ledger read stopped early: nothing before this time is proven. */
  ledgerFrom?: number;
  since: number;
  now: number;
  stepMs: number;
}

/** Pure: ledger entries and bus rows in, frames out. The same inputs always give the same JSON. */
export function buildMapReplay({ entries, bus, usage = null, ledgerFrom = -Infinity, since, now, stepMs }: ReplayInputs): MapReplay {
  const gaps: string[] = [];
  const times = (entries ?? []).map(entry => ({ entry, at: Date.parse(entry.at) })).filter(row => Number.isFinite(row.at)).sort((a, b) => a.at - b.at);
  // Per job, [launch, end) spans; an unended launch runs until now.
  const spans: { who: ReplayJob; start: number; end: number }[] = [];
  const open = new Map<string, { who: ReplayJob; start: number }>();
  for (const { entry, at } of times) {
    const who = job(entry);
    if (!who) continue;
    if (entry.kind === 'launch') {
      const prior = open.get(who.job);
      if (prior) spans.push({ ...prior, end: at });
      open.set(who.job, { who, start: at });
    } else if (ENDS.has(entry.kind) && open.has(who.job)) {
      spans.push({ ...open.get(who.job)!, end: at });
      open.delete(who.job);
    }
  }
  for (const rest of open.values()) spans.push({ ...rest, end: Infinity });
  // The bus keeps a bounded inbox: when it is full, nothing older than its oldest row is proven.
  const busKnown = bus.source !== 'unavailable';
  const busFrom = busKnown && bus.rows.length >= BUS_INBOX_MAX_MESSAGES ? Math.min(...bus.rows.map(row => row.receivedAt)) : -Infinity;
  if (entries === null) gaps.push('Jobs unknown: the jobs ledger could not be read, so launches, PRs and merges are not shown.');
  if (!busKnown) gaps.push('Messages unknown: the agent bus could not be read.');
  else if (busFrom > since) gaps.push(`Messages before ${new Date(busFrom).toISOString().slice(0, 16).replace('T', ' ')} UTC are unknown: the bus keeps only its newest ${BUS_INBOX_MAX_MESSAGES}.`);

  if (entries !== null && ledgerFrom > since - MAP_REPLAY_LOOKBACK_HOURS * 3_600_000) gaps.push(`Jobs before ${new Date(ledgerFrom).toISOString().slice(0, 16).replace('T', ' ')} UTC are unknown: only the newest part of the jobs ledger was read.`);
  const readings = (usage ?? []).map(row => ({ pool: row.pool, at: Date.parse(row.observed_at), pct: row.used_pct })).filter(row => Number.isFinite(row.at)).sort((a, b) => a.at - b.at);
  const poolNames = [...new Set(readings.map(row => row.pool))].sort();
  // Nearest recorded reading at or before the frame end; none within 30 minutes is unknown (null), never today's number.
  const poolsAt = (end: number): ReplayPool[] | null => poolNames.length === 0 ? null : poolNames.map(pool => {
    const near = readings.filter(row => row.pool === pool && row.at <= end).at(-1);
    return { pool, usedPct: near && end - near.at <= MAP_REPLAY_SNAPSHOT_MAX_AGE_MS ? Math.round(near.pct) : null };
  });
  if (poolNames.length === 0) gaps.push('Pools unknown: no pool usage history has been recorded.');
  else if (readings.every(row => row.at > since + MAP_REPLAY_SNAPSHOT_MAX_AGE_MS)) gaps.push('Pools are unknown at the start of this window: no pool reading is recorded that early.');
  const lanesOf = (rows: ReplayJob[] | null): ReplayLane[] | null => {
    if (rows === null) return null;
    const counts = new Map<string, number>();
    for (const row of rows) if (row.lane) counts.set(row.lane, (counts.get(row.lane) ?? 0) + 1);
    return [...counts].map(([lane, running]) => ({ lane, running })).sort((a, b) => (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0));
  };
  const frames: MapReplayFrame[] = [];
  for (let from = since; from < now; from += stepMs) {
    const end = Math.min(from + stepMs, now), last = end === now;
    const inFrame = (at: number) => at >= from && (at < end || (last && at === end));
    const jobsKnown = entries !== null, messagesKnown = busKnown && from >= busFrom;
    const hits = (kind: WorklogEntry['kind']) => times.filter(row => row.entry.kind === kind && inFrame(row.at)).map(row => row.entry);
    const running = jobsKnown ? spans.filter(span => span.start <= end && end < span.end).map(span => span.who).sort(byJob) : null;
    const messages = messagesKnown ? buildMapEdges(bus, from, last ? end : end - 1).edges : null;
    frames.push({
      from: new Date(from).toISOString(), at: new Date(end).toISOString(),
      state: jobsKnown && messagesKnown ? 'known' : jobsKnown || messagesKnown ? 'partly-unknown' : 'unknown',
      running,
      launched: jobsKnown ? hits('launch').flatMap(entry => job(entry) ?? []).sort(byJob) : null,
      prsOpened: jobsKnown ? hits('pr').map(pr).sort(byJob) : null,
      merged: jobsKnown ? hits('merged').map(pr).sort(byJob) : null,
      messages,
      lanes: lanesOf(running),
      pools: poolsAt(end),
    });
  }
  return { schema: MAP_REPLAY_SCHEMA, version: 1, generatedAt: new Date(now).toISOString(), since: new Date(since).toISOString(), until: new Date(now).toISOString(),
    stepSeconds: stepMs / 1000, sources: { jobs: entries === null ? 'unknown' : 'available', messages: bus.source, pools: poolNames.length ? 'available' : 'unknown' }, frames, gaps };
}

/** The last `maxBytes` of the jobs ledger, from a whole line. `truncated` says the start was cut off. */
async function readLedgerTail(file: string, maxBytes: number): Promise<{ text: string; truncated: boolean } | null> {
  let handle;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes), buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    return size > length ? { text: text.slice(text.indexOf('\n') + 1), truncated: true } : { text, truncated: false };
  } catch { return null; } finally { await handle?.close().catch(() => undefined); }
}

export interface ReadReplayOptions extends BusInboxOptions { runsDir?: string; ledgerMaxBytes?: number }
/** The one read behind the CLI and the API. Null when `since` or `step` is not valid; `error` says which. */
export async function readMapReplay(since: string = MAP_REPLAY_DEFAULT_SINCE, step: string = MAP_REPLAY_DEFAULT_STEP, options: ReadReplayOptions = {}):
  Promise<{ ok: true; replay: MapReplay } | { ok: false; error: string }> {
  const now = (options.now ?? Date.now)(), from = parseSince(since, now), stepMs = parseStep(step);
  if (from === null || from >= now) return { ok: false, error: '--since takes a time in the past: 6h, 90m, 1d, epoch ms or an ISO time.' };
  if (stepMs === null) return { ok: false, error: '--step takes 1m or more, for example 5m or 1h.' };
  if (Math.ceil((now - from) / stepMs) > MAP_REPLAY_MAX_FRAMES) return { ok: false, error: `That is more than ${MAP_REPLAY_MAX_FRAMES} frames: use a bigger --step or a shorter --since.` };
  const runsDir = options.runsDir ?? (process.env.ASHLR_RUNS_DIR?.trim() || join(homedir(), '.ashlr-runs'));
  // Launches from before the window are read too, so a job still running at the start shows as running.
  const tail = await readLedgerTail(join(runsDir, 'metrics', 'jobs.jsonl'), options.ledgerMaxBytes ?? MAP_REPLAY_LEDGER_MAX_BYTES);
  let entries: WorklogEntry[] | null = null, ledgerFrom = -Infinity;
  if (tail) {
    const report = worklog(tail.text, from - MAP_REPLAY_LOOKBACK_HOURS * 3_600_000, now);
    entries = report.entries;
    if (tail.truncated) {
      const stamps = tail.text.split('\n').flatMap(line => { const at = /"(?:ts|at|timestamp)"\s*:\s*"([^"]+)"/.exec(line)?.[1]; return at && Number.isFinite(Date.parse(at)) ? [Date.parse(at)] : []; });
      ledgerFrom = stamps.length ? Math.min(...stamps) : now;
    }
  }
  const usage = await readUsageSamples({ runsDir, nowMs: now }).catch(() => null);
  return { ok: true, replay: buildMapReplay({ entries, bus: scanBusInbox(options), usage, ledgerFrom, since: from, now, stepMs }) };
}
