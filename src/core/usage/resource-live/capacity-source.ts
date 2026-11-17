import { readCapacitySnapshot, type CapacitySnapshot } from '../../routing/budget-store.js';
import { readingIsFresh } from '../sensor-reading.js';
import type { ResourceLiveSource } from './source-types.js';
import type { LiveSourcesConfig } from './config.js';

export function capacitySource(lane: 'claude-weekly' | 'codex-personal' | 'codex-cmp',
  seatMap: LiveSourcesConfig['codexSeatMap'] = {}, read: () => CapacitySnapshot | null = readCapacitySnapshot): ResourceLiveSource {
  return { tier: 'official', read: nowMs => {
    const seats = read()?.seats.filter(s => lane === 'claude-weekly'
      ? s.engine === 'claude' : s.engine === 'codex' && seatMap[s.seatId] === lane) ?? [];
    if (seats.length !== 1) return null;
    const seat = seats[0]!;
    if (seat.signedOut || !readingIsFresh({ observedAt: seat.observedAt, nowMs }) ||
      !readingIsFresh({ observedAt: seat.observedAt, staleAfter: seat.staleAfter, nowMs })) return null;
    const windows = seat.windows.filter(w => w.usedPercent !== null &&
      (lane === 'claude-weekly' ? w.id === 'seven_day' : /^codex_.*_(primary|secondary)$/.test(w.id)));
    if (!windows.length) return null;
    const window = windows.reduce((a, b) => a.usedPercent! >= b.usedPercent! ? a : b);
    if (window.resetsAt !== null && Date.parse(window.resetsAt) <= nowMs) return null;
    return { used: window.usedPercent, limit: 100, unit: 'percent', reset_at: window.resetsAt,
      source: lane === 'claude-weekly' ? 'claude-usage' : 'codex-app-server', observed_at: seat.observedAt!,
      stale_after: seat.staleAfter ?? undefined };
  } };
}
