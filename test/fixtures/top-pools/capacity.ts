import type { SeatCapacity } from '../../../src/core/routing/headroom.js';

export const nowMs = Date.parse('2026-10-26T16:00:00.000Z');
const base: SeatCapacity = {
  seatId: 'codex-personal', engine: 'codex', label: 'Personal', free: false,
  signedOut: false, reachable: true, contextWindow: null, observedAt: new Date(nowMs).toISOString(),
  windows: [{ id: 'codex_codex_secondary', usedPercent: 25, limitReached: false,
    resetsAt: '2026-10-27T16:00:00.000Z', resetDescription: null,
    resetProvenance: { kind: 'weekly-deadline', at: '2026-10-27T16:00:00.000Z', description: null,
      source: 'codex-native-rate-limits', plan: 'plus', windowDurationMins: 10080 } }],
};
export const seats: SeatCapacity[] = [
  { ...base, seatId: 'codex-work', windows: base.windows.map(window => ({ ...window, usedPercent: 99 })) },
  base,
  { ...base, seatId: 'claude', engine: 'claude', windows: [{ id: 'seven_day', usedPercent: null,
    resetsAt: null, resetDescription: 'Tomorrow', limitReached: false }] },
];
