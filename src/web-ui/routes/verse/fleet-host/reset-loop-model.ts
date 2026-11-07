import type { UsageResets } from '../shell/usage-resets-query.js';
import type { ResetReleases } from './reset-loop-query.js';

type Tone = 'ok' | 'warn' | 'bad';
const TEN_MINUTES = 10 * 60_000;
const timestamp = (value: string | null): number => value === null ? NaN : Date.parse(value);
function age(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 3_600)} hr`;
}

export function resetLoopLine(data: ResetReleases, nowMs: number, hasMutationToken = true): { text: string; tone: Tone } {
  const { loop } = data;
  if (!loop.started) return { text: 'Reset loop not armed', tone: loop.lastError || hasMutationToken ? 'bad' : 'warn' };
  const lastRun = timestamp(loop.lastRunAt);
  const runText = Number.isFinite(lastRun) ? `${age(nowMs - lastRun)} ago` : 'unknown';
  const count = loop.lastResult?.released.length;
  return {
    text: `Reset loop armed · last run ${runText} · ${count === undefined ? 'unknown' : count} released`,
    tone: loop.lastError ? 'bad' : !Number.isFinite(lastRun) || nowMs - lastRun > TEN_MINUTES ? 'warn' : 'ok',
  };
}

export function releaseRows(data: ResetReleases, _nowMs: number): string[] {
  return [...data.releases].sort((a, b) => timestamp(b.at) - timestamp(a.at)).slice(0, 5).map((record) => {
    const at = timestamp(record.at);
    const time = Number.isFinite(at) ? new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : 'at unknown time';
    return `${record.lane} released ${time} (${record.state === 'reset-detected' ? 'reset detected' : 'hold expired'}, ${record.usedPct === null ? 'unknown' : `${record.usedPct}%`} used)`;
  });
}

export function unreleasedResets(resets: UsageResets | null, data: ResetReleases | null, nowMs: number): { lane: string; sinceText: string }[] {
  if (!resets || !data) return [];
  const newest = new Map<string, (typeof resets.rows)[number]>();
  for (const row of resets.rows) {
    const reading = timestamp(row.readingAsOf);
    const previous = newest.get(row.lane);
    if (Number.isFinite(reading) && (!previous || reading > timestamp(previous.readingAsOf))) newest.set(row.lane, row);
  }
  return [...newest.values()].filter((row) => {
    const reading = timestamp(row.readingAsOf);
    return row.state === 'reset-detected' && nowMs - reading > TEN_MINUTES &&
      !data.releases.some((record) => record.lane === row.lane && timestamp(record.at) > reading);
  }).map((row) => ({ lane: row.lane, sinceText: `${age(nowMs - timestamp(row.readingAsOf))} ago` }));
}
