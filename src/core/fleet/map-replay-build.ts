/** Reads and folds the history into frames for `phm map replay` and the map-replay API. Node only; the pane uses map-replay.ts. */
import { buildMapEdges } from './map-edges.js';
import { BUS_INBOX_MAX_MESSAGES, scanBusInbox, type BusInboxOptions, type BusInboxScan } from './bus-inbox.js';
import { parseSince } from './agent-messages.js';
import { readWorklog, type WorklogEntry } from './worklog.js';
import { MAP_REPLAY_DEFAULT_SINCE, MAP_REPLAY_DEFAULT_STEP, MAP_REPLAY_LOOKBACK_HOURS, MAP_REPLAY_MAX_FRAMES, MAP_REPLAY_SCHEMA, parseStep,
  type MapReplay, type MapReplayFrame, type ReplayJob, type ReplayPr } from './map-replay.js';

const job = (entry: Pick<WorklogEntry, 'job' | 'lane' | 'repo'>): ReplayJob | null => entry.job ? { job: entry.job, lane: entry.lane, repo: entry.repo } : null;
const pr = (entry: WorklogEntry): ReplayPr => ({ job: entry.job ?? 'unknown', lane: entry.lane, repo: entry.repo, url: entry.url });
const byJob = (a: ReplayJob, b: ReplayJob) => (a.job < b.job ? -1 : a.job > b.job ? 1 : 0);
/** A launch starts running; the first of these after it ends it. */
const ENDS = new Set<WorklogEntry['kind']>(['finished', 'pr', 'empty', 'failed', 'merged', 'closed']);

export interface ReplayInputs {
  /** Work log entries, any order. Null when the jobs ledger could not be read (unknown, not zero). */
  entries: readonly WorklogEntry[] | null;
  bus: Pick<BusInboxScan, 'source' | 'rows' | 'skipped'>;
  since: number;
  now: number;
  stepMs: number;
}

/** Pure: ledger entries and bus rows in, frames out. The same inputs always give the same JSON. */
export function buildMapReplay({ entries, bus, since, now, stepMs }: ReplayInputs): MapReplay {
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
    });
  }
  return { schema: MAP_REPLAY_SCHEMA, version: 1, generatedAt: new Date(now).toISOString(), since: new Date(since).toISOString(), until: new Date(now).toISOString(),
    stepSeconds: stepMs / 1000, sources: { jobs: entries === null ? 'unknown' : 'available', messages: bus.source }, frames, gaps };
}

export interface ReadReplayOptions extends BusInboxOptions { runsDir?: string }
/** The one read behind the CLI and the API. Null when `since` or `step` is not valid; `error` says which. */
export async function readMapReplay(since: string = MAP_REPLAY_DEFAULT_SINCE, step: string = MAP_REPLAY_DEFAULT_STEP, options: ReadReplayOptions = {}):
  Promise<{ ok: true; replay: MapReplay } | { ok: false; error: string }> {
  const now = (options.now ?? Date.now)(), from = parseSince(since, now), stepMs = parseStep(step);
  if (from === null || from >= now) return { ok: false, error: '--since takes a time in the past: 6h, 90m, 1d, epoch ms or an ISO time.' };
  if (stepMs === null) return { ok: false, error: '--step takes 1m or more, for example 5m or 1h.' };
  if (Math.ceil((now - from) / stepMs) > MAP_REPLAY_MAX_FRAMES) return { ok: false, error: `That is more than ${MAP_REPLAY_MAX_FRAMES} frames: use a bigger --step or a shorter --since.` };
  const hours = (now - from) / 3_600_000 + MAP_REPLAY_LOOKBACK_HOURS;
  let entries: WorklogEntry[] | null = null;
  try {
    const log = await readWorklog(hours, { now, ...(options.runsDir ? { runsDir: options.runsDir } : {}) });
    if (log.sources.jobs.state === 'ok') entries = log.entries;
  } catch { /* unknown, listed in gaps */ }
  return { ok: true, replay: buildMapReplay({ entries, bus: scanBusInbox(options), since: from, now, stepMs }) };
}

