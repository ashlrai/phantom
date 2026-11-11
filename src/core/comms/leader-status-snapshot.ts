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
const MAX_STATUS_BYTES = 1024 * 1024;
const MAX_LANES = 16;

export interface LeaderStatusLane { lane: string; merged: number; medianTtmS: number | null }
export interface LeaderStatusSnapshot {
  schema: typeof LEADER_STATUS_SNAPSHOT_SCHEMA;
  /** Null when queue/status.json has no rollup_24h, so "zero" is never invented. */
  merged24h: number | null;
  medianTtmS: number | null;
  lanes: LeaderStatusLane[];
  mains: { known: boolean; green: number; red: number; total: number; redRepos: string[]; stale: boolean };
  ceo: string[];
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
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const laneName = (raw: string): string => raw.replace(/[^\w.-]/g, '').slice(0, 40);

/** Pure: the numbers a status answer needs from a parsed queue/status.json. */
export function summarizeQueueRollup(status: unknown): Pick<LeaderStatusSnapshot, 'merged24h' | 'medianTtmS' | 'lanes'> {
  const rollup = object(object(status).rollup_24h);
  const byLane = object(rollup.by_lane);
  const lanes: LeaderStatusLane[] = [];
  for (const [name, row] of Object.entries(byLane)) {
    const merged = count(object(row).merged);
    const lane = laneName(name);
    if (merged !== null && lane) lanes.push({ lane, merged, medianTtmS: count(object(row).median_ttm_s) });
  }
  lanes.sort((a, b) => b.merged - a.merged || a.lane.localeCompare(b.lane));
  const hasRollup = Object.keys(byLane).length > 0 || count(rollup.merged) !== null;
  return {
    merged24h: hasRollup ? count(rollup.merged) ?? lanes.reduce((sum, lane) => sum + lane.merged, 0) : null,
    medianTtmS: count(rollup.median_ttm_s),
    lanes: lanes.slice(0, MAX_LANES),
  };
}

export async function readLeaderStatusSnapshot(opts: { runsDir?: string; now?: () => number } = {}): Promise<LeaderStatusSnapshot> {
  const runsDir = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const [queue, mains, journal] = await Promise.all([
    readSource(join(runsDir, 'queue', 'status.json'), MAX_STATUS_BYTES, false).then(source => {
      if (source.state !== 'healthy') return summarizeQueueRollup(null);
      try { return summarizeQueueRollup(JSON.parse(source.text)); } catch { return summarizeQueueRollup(null); }
    }),
    readFleetMainHealth({ runsDir, now: opts.now }).catch(() => null),
    readLeaderJournal({ runsDir, now: opts.now }).catch(() => null),
  ]);
  const repos = mains?.source === 'ok' ? mains.repos : [];
  const ceo = (journal?.passes[0]?.sections ?? []).filter(section => /\bCEO\b/i.test(section.title)).flatMap(section => section.bullets).slice(0, 6);
  return {
    schema: LEADER_STATUS_SNAPSHOT_SCHEMA, ...queue,
    mains: {
      known: repos.length > 0, total: repos.length, stale: mains?.stale ?? true,
      green: repos.filter(repo => repo.state === 'green').length,
      red: repos.filter(repo => repo.state === 'red').length,
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
  if (snapshot.merged24h === null) lines.push('Merged PRs in the last 24h: unknown (no rollup recorded).');
  else {
    const median = snapshot.medianTtmS === null ? '' : `, median time to merge ${duration(snapshot.medianTtmS)}`;
    lines.push(`Merged PRs in the last 24h: ${snapshot.merged24h}${median}.`);
    const perLane = snapshot.lanes.filter(lane => lane.merged > 0)
      .map(lane => `${lane.lane} ${lane.merged}${lane.medianTtmS === null ? '' : ` (median ${duration(lane.medianTtmS)})`}`);
    if (perLane.length) lines.push(`By lane: ${perLane.join(', ')}.`);
  }
  const { mains } = snapshot;
  if (!mains.known) lines.push('Mains: unknown (no guardian table).');
  else {
    const red = mains.red ? ` Red: ${mains.redRepos.join(', ')}.` : '';
    lines.push(`Mains green: ${mains.green} of ${mains.total}.${red}${mains.stale ? ' The table is stale.' : ''}`);
  }
  if (snapshot.ceo.length) lines.push(`CEO summary: ${snapshot.ceo.slice(0, 3).join(' ')}`);
  return lines.join('\n');
}
