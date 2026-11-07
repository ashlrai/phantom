import { liveStates, type GraphLiveData, type GraphLiveState } from './graph-live-queries.js';

const minute = 60_000;
const hour = 60 * minute;

function duration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / minute));
  if (minutes < 1) return 'less than 1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours} h${remainder ? ` ${remainder} min` : ''}`;
}

function resetText(at: number | null, nowMs: number): string {
  if (at === null) return 'reset unknown';
  if (at - nowMs <= 24 * hour) return `resets in ${duration(at - nowMs)}`;
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return 'reset unknown';
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `resets ${day} ${time}`;
}

export function liveNodeRows(data: GraphLiveData, nowMs: number) {
  return data.live.nodes.map(node => ({
    id: node.id, kind: node.kind, label: node.id, state: node.live.state,
    usedText: node.live.usedPercent === null ? 'unmeasured' : `${node.live.usedPercent}% used`,
    resetText: resetText(node.live.resetsAtMs, nowMs),
    ageText: node.live.readingAgeMs === null ? 'no dated reading' : `read ${duration(node.live.readingAgeMs)} ago`,
    reasons: node.live.reasons,
  })).sort((a, b) => liveStates.indexOf(a.state) - liveStates.indexOf(b.state) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function liveHeadline(data: GraphLiveData): string {
  const counts = new Map<GraphLiveState, number>();
  for (const node of data.live.nodes) counts.set(node.live.state, (counts.get(node.live.state) ?? 0) + 1);
  const parts = [`${data.live.nodes.length} ${data.live.nodes.length === 1 ? 'node' : 'nodes'}`];
  for (const state of ['ready', 'limited', 'exhausted', 'held', 'stale', 'unknown', 'untracked'] as const) {
    const count = counts.get(state);
    if (count) parts.push(`${count} ${state}`);
  }
  if (data.live.complete === false) parts.push('incomplete');
  return parts.join(' · ');
}

export function liveIssuesText(data: GraphLiveData): string[] | null {
  const lines = data.live.issues?.map(issue => {
    const label = issue.code === 'seat-unread' ? 'seats unread' : issue.code.replaceAll('-', ' ');
    return `${label}${issue.nodeIds.length ? `: ${issue.nodeIds.join(', ')}` : ''}`;
  });
  return lines?.length ? lines : null;
}
