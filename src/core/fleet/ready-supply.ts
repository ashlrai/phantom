import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseReadyTsv, type FleetLaneQueueRow } from './lane-console.js';
import { readSource } from './runs-parked-queue.js';

export interface ReadySupplyLane {
  lane: string;
  phxReady: number;
  phxParked: number;
  fillerReady: number;
  fillerParked: number;
  oldestPhxId: string | null;
}

export interface ReadySupplyV1 {
  v: 1;
  generatedAt: string;
  sourceState: 'healthy' | 'missing' | 'degraded';
  rows: number;
  dropped: number;
  lanes: ReadySupplyLane[];
  totals: { phxReady: number; phxParked: number; fillerReady: number; fillerParked: number };
}

export function summarizeReadySupply(
  rows: FleetLaneQueueRow[],
  meta: { dropped: number; sourceState: ReadySupplyV1['sourceState']; now: () => Date },
): ReadySupplyV1 {
  const lanes = new Map<string, ReadySupplyLane>();
  const totals = { phxReady: 0, phxParked: 0, fillerReady: 0, fillerParked: 0 };
  for (const row of rows) {
    const dotted = /^([A-Z-]+)\.(.+)$/.exec(row.pool);
    const lane = dotted?.[2] ?? row.pool;
    const status = dotted?.[1] ?? row.status;
    let counts = lanes.get(lane);
    if (!counts) {
      counts = { lane, phxReady: 0, phxParked: 0, fillerReady: 0, fillerParked: 0, oldestPhxId: null };
      lanes.set(lane, counts);
    }
    const phx = typeof row.id === 'string' && row.id.startsWith('RQ-PHX-');
    const parked = status.startsWith('PARKED');
    const key = phx ? (parked ? 'phxParked' : 'phxReady') : (parked ? 'fillerParked' : 'fillerReady');
    counts[key]++;
    totals[key]++;
    if (phx && !parked && counts.oldestPhxId === null) counts.oldestPhxId = row.id;
  }
  return {
    v: 1, generatedAt: meta.now().toISOString(), sourceState: meta.sourceState,
    rows: rows.length, dropped: meta.dropped,
    lanes: [...lanes.values()].sort((a, b) => a.lane.localeCompare(b.lane)), totals,
  };
}

/** Recognize the router's five-column id/repo/lane/work/path form. */
function normalizeLegacyRows(text: string): string {
  return text.replace(/^([A-Za-z0-9][A-Za-z0-9_.:/@-]{0,127}|)\t([^\t\r\n]+)\t([^\t\r\n]+)\twork\t\/[^\t\r\n]*(\r?)$/gm,
    '$1\t$3\t$2\twork\t$4');
}

export async function readReadySupply(opts: { runsDir?: string; now?: () => Date } = {}): Promise<ReadySupplyV1> {
  const now = opts.now ?? (() => new Date());
  try {
    const root = opts.runsDir ?? (process.env['ASHLR_RUNS_DIR'] || join(homedir(), '.ashlr-runs'));
    const source = await readSource(join(root, 'queue', 'ready.tsv'), 2 * 1024 * 1024, false);
    const parsed = parseReadyTsv(normalizeLegacyRows(source.text));
    return summarizeReadySupply(parsed.rows, { ...parsed, sourceState: source.state, now });
  } catch {
    // Even a faulty injected clock or invalid path cannot make the reader throw.
    return summarizeReadySupply([], { dropped: 0, sourceState: 'degraded', now: () => new Date(0) });
  }
}
