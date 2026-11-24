/**
 * Read-only status snapshot for the leader-network reply path, plus the text
 * cleanup that keeps CLI chrome out of replies. The replier has no tools, so it
 * is handed real numbers (queue/status.json rollup_24h, the main-guardian table,
 * the latest PLAN-LOG CEO summary) instead of an empty workspace. Nothing here
 * writes, and every source degrades to "unknown" rather than throwing.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFleetMainHealth } from '../fleet/main-health.js';
import { readLeaderJournal } from '../fleet/leader-journal.js';
import { readSource } from '../fleet/runs-parked-queue.js';
import { scrubSecrets } from '../util/scrub.js';

export const LEADER_STATUS_SNAPSHOT_SCHEMA = 'leader.status-snapshot.v1';
// Match fleet/status-api: dispatcher observations expire after 60 seconds.
const MAX_QUEUE_AGE_MS = 60_000;
const MAX_STATUS_BYTES = 1024 * 1024;
const MAX_LANES = 16;

export interface LeaderStatusLane { lane: string; merged: number; medianTtmS: number | null }
export interface LeaderStatusCollectionError {
  source: 'queue' | 'guardian' | 'journal';
  code: 'missing' | 'unavailable' | 'empty' | 'invalid' | 'stale' | 'failed';
}
export interface LeaderStatusSnapshot {
  schema: typeof LEADER_STATUS_SNAPSHOT_SCHEMA;
  collectedAt: string;
  /** Source tick, retained even when stale; null without a parseable timestamp. */
  queueObservedAt: string | null;
  /** Fixed codes only: paths and raw collector exceptions never leave the reader. */
  collectionErrors: LeaderStatusCollectionError[];
  /** Null when the queue rollup is missing or its dispatcher tick is not fresh. */
  merged24h: number | null;
  medianTtmS: number | null;
  lanes: LeaderStatusLane[];
  queueState: 'fresh' | 'stale' | 'empty' | 'unavailable';
  /** Fleet totals require complete fresh lane evidence, before the display cap. */
  running: number | null;
  queued: number | null;
  laneActivityTruncated: boolean;
  laneActivity: Array<{ lane: string; running: number | null; queued: number | null }>;
  mains: { guardianState: 'fresh' | 'stale' | 'empty' | 'off' | 'unavailable'; known: boolean; green: number | null; red: number | null; total: number | null; unknown: number | null; redRepos: string[]; stale: boolean; observedAt: string | null };
  ceo: string[];
}

function summarizeQueueActivity(status: unknown): Pick<LeaderStatusSnapshot, 'laneActivity' | 'running' | 'queued' | 'laneActivityTruncated'> {
  const lanes = object(object(status).lanes);
  const names = new Set([...Object.keys(lanes), ...Object.keys(object(object(object(status).rollup_24h).by_lane))]);
  const activity = [...names].sort().map(lane => ({
    lane, running: mergedCount(object(lanes[lane]).running), queued: mergedCount(object(lanes[lane]).queued),
  }));
  const total = (key: 'running' | 'queued') => activity.length && activity.every(row => row.lane && laneName(row.lane) === row.lane && row[key] !== null)
    ? mergedCount(activity.reduce((sum, row) => sum + row[key]!, 0)) : null;
  const visible = activity.filter(row => row.lane && laneName(row.lane) === row.lane);
  return { running: total('running'), queued: total('queued'), laneActivity: visible.slice(0, MAX_LANES), laneActivityTruncated: visible.length > MAX_LANES };
}

// ESC sequences: CSI, OSC (BEL or ST terminated), then any other two-byte escape.
// eslint-disable-next-line no-control-regex -- stripping terminal escapes is the point.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex -- remaining control bytes other than \n and \t.
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;
const BOX_EDGES = /^[\s─-╿]+|[\s─-╿]+$/gu;
const BOX_ONLY = /^[\s─-╿▀-▟|+\-_=*~.]*$/u;
const BANNER = /^\s*(?:welcome to (?:the )?(?:devin|claude code|codex|gemini|grok)\b|(?:devin|claude code|codex|gemini|grok)(?: cli)? v?\d[\w.+-]*\s*$|openai codex\b|type \/help\b|tip:)/i;

/** Plain text from raw model/CLI output: no escapes, no carriage-return redraws, no leading banner. */
export function cleanLeaderReplyText(raw: string): string {
  // A carriage return redraws the line, so only the last segment is what the reader saw.
  const lines = raw.replace(ESCAPES, '').replace(/\r\n/g, '\n').split('\n')
    .map(line => line.split('\r').pop() ?? '').map(line => line.replace(CONTROLS, ''));
  let start = 0;
  while (start < lines.length && (!lines[start]!.trim() || BOX_ONLY.test(lines[start]!) || BANNER.test(lines[start]!.replace(BOX_EDGES, '')))) start++;
  return lines.slice(start).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const mergedCount = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const laneName = (raw: string): string => raw.replace(/[^\w.-]/g, '').slice(0, 40);

/** Pure: the numbers a status answer needs from a parsed queue/status.json. */
export function summarizeQueueRollup(status: unknown): Pick<LeaderStatusSnapshot, 'merged24h' | 'medianTtmS' | 'lanes'> {
  const rollup = object(object(status).rollup_24h);
  const byLane = object(rollup.by_lane);
  const lanes: LeaderStatusLane[] = [];
  const entries = Object.entries(byLane);
  let complete = entries.length > 0 && entries.length <= MAX_LANES;
  for (const [name, row] of entries) {
    const merged = mergedCount(object(row).merged);
    const lane = laneName(name);
    if (merged === null || !lane) complete = false;
    if (merged !== null && lane) lanes.push({ lane, merged, medianTtmS: count(object(row).median_ttm_s) });
  }
  lanes.sort((a, b) => b.merged - a.merged || a.lane.localeCompare(b.lane));
  const inferred = complete ? lanes.reduce((sum, lane) => sum + lane.merged, 0) : null;
  return {
    merged24h: mergedCount(rollup.merged) ?? mergedCount(inferred),
    medianTtmS: count(rollup.median_ttm_s),
    lanes: lanes.slice(0, MAX_LANES),
  };
}

export async function readLeaderStatusSnapshot(opts: { runsDir?: string; now?: () => number } = {}): Promise<LeaderStatusSnapshot> {
  const runsDir = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const now = (opts.now ?? Date.now)();
  const unknownQueue = { ...summarizeQueueRollup(null), ...summarizeQueueActivity(null), queueState: 'unavailable' as const,
    queueObservedAt: null as string | null, queueError: 'unavailable' as LeaderStatusCollectionError['code'] | null };
  const [queue, mains, journal] = await Promise.all([
    readSource(join(runsDir, 'queue', 'status.json'), MAX_STATUS_BYTES, false).then(source => {
      if (source.state !== 'healthy') return { ...unknownQueue, queueError: source.state === 'missing' ? 'missing' as const : 'unavailable' as const };
      if (!source.text.trim()) return { ...unknownQueue, queueState: 'empty' as const, queueError: 'empty' as const };
      try {
        const status: unknown = JSON.parse(source.text);
        if (!status || typeof status !== 'object' || Array.isArray(status)) return { ...unknownQueue, queueError: 'invalid' as const };
        if (!Object.keys(status).length) return { ...unknownQueue, queueState: 'empty' as const, queueError: 'empty' as const };
        const tick = object(status).last_tick;
        const tickMs = typeof tick === 'string' ? Date.parse(tick) : NaN;
        const queueObservedAt = Number.isFinite(tickMs) ? new Date(tickMs).toISOString() : null;
        const age = now - tickMs;
        return Number.isFinite(age) && age >= 0 && age <= MAX_QUEUE_AGE_MS
          ? { ...summarizeQueueRollup(status), ...summarizeQueueActivity(status), queueState: 'fresh' as const, queueObservedAt, queueError: null }
          : { ...unknownQueue, queueState: 'stale' as const, queueObservedAt, queueError: queueObservedAt === null ? 'invalid' as const : 'stale' as const };
      } catch { return { ...unknownQueue, queueError: 'invalid' as const }; }
    }).catch(() => ({ ...unknownQueue, queueError: 'failed' as const })),
    readFleetMainHealth({ runsDir, now: () => now }).catch(() => null),
    readLeaderJournal({ runsDir, now: () => now }).catch(() => null),
  ]);
  const observedAt = mains?.statusAt ?? null;
  const stale = mains?.stale !== false || observedAt === null || Date.parse(observedAt) > now;
  const guardianState = mains?.guardianOff ? 'off' : mains?.source !== 'ok' ? 'unavailable'
    : observedAt !== null && stale ? 'stale' : mains.repos.length === 0 ? 'empty' : stale ? 'stale' : 'fresh';
  const known = mains?.source === 'ok' && !stale && mains.repos.length > 0;
  const repos = known ? mains.repos : [];
  const ceo = (journal?.passes[0]?.sections ?? []).filter(section => /\bCEO\b/i.test(section.title)).flatMap(section => section.bullets).slice(0, 6);
  const { queueError, ...queueEvidence } = queue;
  const collectionErrors: LeaderStatusCollectionError[] = queueError === null ? [] : [{ source: 'queue', code: queueError }];
  if (mains === null) collectionErrors.push({ source: 'guardian', code: 'failed' });
  else if (mains.source !== 'ok') collectionErrors.push({ source: 'guardian', code: 'unavailable' });
  else if (guardianState === 'stale' || guardianState === 'empty') collectionErrors.push({ source: 'guardian', code: guardianState });
  if (journal === null) collectionErrors.push({ source: 'journal', code: 'failed' });
  else if (journal.sources.planLog !== 'healthy') collectionErrors.push({ source: 'journal', code: journal.sources.planLog === 'missing' ? 'missing' : 'unavailable' });
  else if (!journal.passes.length) collectionErrors.push({ source: 'journal', code: 'empty' });
  return {
    schema: LEADER_STATUS_SNAPSHOT_SCHEMA, collectedAt: new Date(now).toISOString(), ...queueEvidence, collectionErrors,
    mains: {
      guardianState, known, total: known ? repos.length : null, stale, observedAt,
      green: known ? repos.filter(repo => repo.state === 'green').length : null,
      red: known ? repos.filter(repo => repo.state === 'red').length : null,
      unknown: known ? repos.filter(repo => repo.state === 'unknown').length : null,
      redRepos: repos.filter(repo => repo.state === 'red').map(repo => repo.repo).slice(0, 8),
    },
    ceo: ceo.map(line => scrubSecrets(line)),
  };
}

function duration(seconds: number): string {
  return seconds < 90 ? `${Math.round(seconds)}s` : `${Math.round(seconds / 60)} min`;
}

/** Short plain-words status, built only from the snapshot. Also the fallback when no model answers. */
export function renderLeaderStatus(snapshot: LeaderStatusSnapshot): string {
  const lines: string[] = [];
  lines.push(`Status collected: ${snapshot.collectedAt}. Queue checked: ${snapshot.queueObservedAt ?? 'unknown'}.`);
  if (snapshot.merged24h === null) lines.push(`Merged PRs in the last 24h: unknown (queue ${snapshot.queueState}; no fresh complete rollup).`);
  else {
    const median = snapshot.medianTtmS === null ? '' : `, median time to merge ${duration(snapshot.medianTtmS)}`;
    lines.push(`Merged PRs in the last 24h: ${snapshot.merged24h}${median}.`);
    const perLane = snapshot.lanes.filter(lane => lane.merged > 0)
      .map(lane => `${lane.lane} ${lane.merged}${lane.medianTtmS === null ? '' : ` (median ${duration(lane.medianTtmS)})`}`);
    if (perLane.length) lines.push(`By lane: ${perLane.join(', ')}.`);
  }
  lines.push(`Fleet activity: ${snapshot.running ?? 'unknown'} running, ${snapshot.queued ?? 'unknown'} queued.`);
  const activity = snapshot.laneActivity.map(lane => `${lane.lane}: ${lane.running ?? 'unknown'} running, ${lane.queued ?? 'unknown'} queued`);
  lines.push(activity.length ? `Lane activity: ${activity.join('; ')}.` : `Lane activity: unknown (queue ${snapshot.queueState}).`);
  if (snapshot.laneActivityTruncated) lines.push(`Showing the first ${MAX_LANES} lanes.`);
  const { mains } = snapshot;
  if (mains.guardianState === 'off') lines.push('Guardian: off.');
  if (!mains.known) lines.push(`Mains: unknown (${!mains.observedAt ? 'no dated guardian table' : mains.stale ? 'guardian table is stale' : 'guardian table has no rows'}).`);
  else {
    const red = mains.red ? ` Red: ${mains.redRepos.join(', ')}.` : '';
    lines.push(`Mains green: ${mains.green} of ${mains.total}.${red}${mains.unknown ? ` Unknown: ${mains.unknown}.` : ''} Guardian checked: ${mains.observedAt}.`);
  }
  if (snapshot.ceo.length) lines.push(`CEO summary: ${snapshot.ceo.slice(0, 3).join(' ')}`);
  if (snapshot.collectionErrors.length) lines.push(`Collection gaps: ${snapshot.collectionErrors.map(error => `${error.source} ${error.code}`).join('; ')}.`);
  return lines.join('\n');
}
