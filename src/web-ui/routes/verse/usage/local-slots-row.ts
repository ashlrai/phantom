/**
 * routes/verse/usage/local-slots-row.ts — the "Local" cell of the Every
 * resource grid (RQ-PHX-LOCALSLOTSROW50). Local models have no quota, so the
 * cell never shows a meter: it says so, then reports live slot use from the
 * fleet lane rows the desktop already polls. Unknown stays unknown.
 */
export interface LocalLaneRow {
  running: number | null;
  target: number | null;
  queued: number | null;
  held: boolean;
  heldReason: string | null;
}

export interface LocalSlotsView {
  quotaText: 'No quota · runs on this Mac';
  slotsText: string | null;
  heldText: string | null;
  stale: boolean;
}

export const LOCAL_LANES = ['codex-local', 'omlx-local'] as const;
export const SLOTS_UNKNOWN_TEXT = 'Slot use unknown';
const REASON_MAX = 120;
/** A lanes read older than this is shown as stale, not as current. */
const STALE_AFTER_MS = 5 * 60_000;

const count = (n: number | null): n is number => n !== null && Number.isFinite(n) && n >= 0;

/** Sum only known values; null when none is known (never a fake 0). */
function sumKnown(values: Array<number | null>): number | null {
  const known = values.filter(count);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
}

export function localSlotsView(
  lanes: readonly LocalLaneRow[] | null,
  nowMs: number,
  generatedAt: string | null = null,
): LocalSlotsView {
  const quotaText = 'No quota · runs on this Mac' as const;
  if (!lanes || lanes.length === 0) return { quotaText, slotsText: null, heldText: null, stale: false };

  const generatedMs = generatedAt === null ? Number.NaN : Date.parse(generatedAt);
  const stale = Number.isFinite(generatedMs) && nowMs - generatedMs > STALE_AFTER_MS;

  const running = sumKnown(lanes.map((l) => l.running));
  const target = sumKnown(lanes.map((l) => l.target));
  const queued = sumKnown(lanes.map((l) => l.queued));
  let slotsText: string | null = null;
  if (running !== null) {
    slotsText = target !== null ? `${running} of ${target} slots busy` : `${running} slots busy`;
    if (queued !== null && queued > 0) slotsText += ` · ${queued} queued`;
  }

  const held = lanes.filter((l) => l.held);
  let heldText: string | null = null;
  if (held.length > 0) {
    const reason = [...new Set(held.map((l) => l.heldReason?.trim()).filter((r): r is string => !!r))].join('; ');
    heldText = reason ? `Held: ${reason.slice(0, REASON_MAX)}` : 'Held';
  }
  return { quotaText, slotsText, heldText, stale };
}
