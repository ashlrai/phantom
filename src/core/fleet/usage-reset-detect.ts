import { homedir } from 'node:os';
import { join } from 'node:path';
import { readLaneTargets, type LaneTargetRow } from './runs-lane-targets.js';
import { readResourceLedger, type ResourceLaneRow } from './runs-resource-ledger.js';

export interface UsageResetRow {
  lane: string; held: boolean; heldReason: string | null; heldUntil: string | null;
  holdSince: string | null; heldBy: 'autobackoff' | 'manual' | null;
  usedPct: number | null; readingAsOf: string | null; resetAt: string | null;
  state: 'reset-detected' | 'hold-expired' | 'consistent' | 'stale-reading' | 'no-reading' | 'manual-hold' | 'open';
  releasable: boolean; tell: string;
}
export interface UsageResetsV1 {
  v: 1; generatedAt: string; sourceState: 'healthy' | 'degraded' | 'missing'; rows: UsageResetRow[];
}
export const RESET_DETECT_USED_PCT_MAX = 25;

export function detectUsageResets(input: { lanes: LaneTargetRow[]; ledger: ResourceLaneRow[]; ledgerAsOf: string | null; nowMs: number }): UsageResetRow[] {
  const ledger = new Map(input.ledger.map(row => [row.lane, row]));
  return input.lanes.map(lane => {
    const reading = ledger.get(lane.lane);
    const asOf = reading?.observation?.asOf ?? input.ledgerAsOf;
    const readingMs = Date.parse(asOf ?? '');
    const valid = Number.isFinite(readingMs) && readingMs <= input.nowMs;
    const usedPct = valid && typeof reading?.usedPct === 'number' && Number.isFinite(reading.usedPct) ? Math.max(0, reading.usedPct) : null;
    const heldBy = lane.held ? (/^autobackoff\b/i.test(lane.heldReason ?? '') ? 'autobackoff' : 'manual') : null;
    const row: UsageResetRow = {
      lane: lane.lane, held: lane.held, heldReason: lane.heldReason, heldUntil: lane.heldUntil,
      holdSince: lane.lastChange, heldBy, usedPct, readingAsOf: reading && valid ? asOf : null,
      resetAt: reading && valid ? reading.resetAt : null, state: 'open', releasable: false, tell: '',
    };
    if (!lane.held) row.tell = `${lane.lane} is open for dispatch.`;
    else if (!/autobackoff|usage|limit|exhaust/i.test(lane.heldReason ?? '') || heldBy === 'manual') {
      row.state = 'manual-hold';
      row.tell = `${lane.lane} has a manual hold requiring operator release.`;
    } else if (Date.parse(lane.heldUntil ?? '') <= input.nowMs) {
      row.state = 'hold-expired'; row.releasable = true;
      row.tell = `${lane.lane} has an expired autobackoff hold that can be released.`;
    } else if (usedPct === null || !valid) {
      row.state = 'no-reading';
      row.tell = `${lane.lane} has no usable usage reading to evaluate its hold.`;
    } else if (!Number.isFinite(Date.parse(lane.lastChange ?? '')) || readingMs <= Date.parse(lane.lastChange!)) {
      row.state = 'stale-reading';
      row.tell = `${lane.lane} has no usage reading proven newer than its hold.`;
    } else if (usedPct <= RESET_DETECT_USED_PCT_MAX) {
      row.state = 'reset-detected'; row.releasable = true;
      row.tell = `${lane.lane} reads ${usedPct}% at ${asOf} while held by autobackoff: the window reset, release the hold.`;
    } else {
      row.state = 'consistent';
      row.tell = `${lane.lane} reads ${usedPct}%, consistent with its usage hold.`;
    }
    return row;
  });
}

export async function readUsageResets(opts: { runsDir?: string; now?: () => number } = {}): Promise<UsageResetsV1> {
  const result: UsageResetsV1 = { v: 1, generatedAt: new Date(0).toISOString(), sourceState: 'degraded', rows: [] };
  try {
    const nowMs = (opts.now ?? Date.now)();
    result.generatedAt = new Date(nowMs).toISOString();
    const runsDir = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
    const [targets, ledger] = await Promise.all([
      readLaneTargets({ runsDir, now: () => new Date(nowMs) }),
      readResourceLedger({ runsDir, now: () => nowMs }),
    ]);
    result.sourceState = targets.sourceState === 'missing' ? 'missing' :
      targets.sourceState === 'degraded' || Object.values(ledger.sources).some(state => state === 'degraded') ? 'degraded' : 'healthy';
    result.rows = detectUsageResets({ lanes: targets.lanes, ledger: ledger.lanes, ledgerAsOf: ledger.asOf, nowMs });
  } catch { result.sourceState = 'degraded'; result.rows = []; }
  return result;
}
