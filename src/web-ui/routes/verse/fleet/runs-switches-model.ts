import type { RunsSwitch } from './runs-switches-queries.js';

const LABELS: Record<string, string> = {
  ORCH_OFF: 'Leader passes', OPUS_LEADER_OFF: 'Opus leader', PAUSE: 'Launches',
  PUBLISH_HOLD: 'Publishing', HOLD: 'Dispatcher', QUEUE_DISABLE: 'Queue',
};

export function switchLabel(id: string): string { return Object.hasOwn(LABELS, id) ? LABELS[id]! : id; }

export function switchSummary(rows: RunsSwitch[]): string {
  const off = rows.filter(row => row.on).map(row => switchLabel(row.id));
  return off.length ? `${off.length} ${off.length === 1 ? 'switch' : 'switches'} off: ${off.join(', ')}` : 'All on';
}

export function sinceText(since: string | null, now: number): string | null {
  if (!since) return null;
  const time = Date.parse(since);
  if (!Number.isFinite(time) || time > now) return null;
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return 'off since <1 m';
  if (minutes < 60) return `off since ${minutes} m`;
  if (minutes < 1440) return `off since ${Math.floor(minutes / 60)} h`;
  return `off since ${Math.floor(minutes / 1440)} d`;
}
