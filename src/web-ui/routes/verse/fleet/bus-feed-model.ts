import type { Tone } from '../../../components/primitives/StatusBadge.js';
import type { BusFeedData, BusHop, BusKind } from './bus-feed-queries.js';

export function describeHop(hop: BusHop): string {
  const n = (value: number | null) => value === null ? '?' : value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : String(value);
  return `${hop.from} → ${hop.to} · ${n(hop.inputTokens)} in / ${n(hop.outputTokens)} out`;
}
export function eventTone(kind: BusKind): Tone {
  const tones: Partial<Record<BusKind, Tone>> = { incident: 'danger', 'lane-hold': 'warning', inbox: 'info', orch: 'running' };
  return tones[kind] ?? 'neutral';
}
export function relativeAt(at: string | null, now: number): string {
  if (at === null || !Number.isFinite(Date.parse(at))) return 'unknown';
  const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  return seconds < 60 ? `${seconds} s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)} m ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)} h ago` : `${Math.floor(seconds / 86400)} d ago`;
}
export function busTimeline(data: BusFeedData) {
  // Hops only carry sequence order. Anchor the group at the last observed hop;
  // do not invent individual timestamps or display that anchor as a row time.
  const hops = data.hops.map((hop, i) => ({ key: `hop:${i}:${hop.id}`, at: data.lastHopAt, kind: 'hop' as const, text: describeHop(hop) }));
  const events = data.events.map((event, i) => ({ ...event, key: `event:${i}` }));
  return [...hops, ...events].reverse().sort((a, b) => (b.at ? Date.parse(b.at) : -Infinity) - (a.at ? Date.parse(a.at) : -Infinity)).slice(0, 40);
}
