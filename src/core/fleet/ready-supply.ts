import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseReadyTsv, type FleetLaneQueueRow } from './lane-console.js';
import { readSource } from './runs-parked-queue.js';

/** router-queue.md is append-mostly Markdown history; same 32 MiB bound the other market readers use. */
const ROUTER_QUEUE_MAX_BYTES = 32 * 1024 * 1024;

export interface ReadySupplyLane {
  lane: string;
  phxReady: number;
  phxParked: number;
  fillerReady: number;
  fillerParked: number;
  oldestPhxId: string | null;
}

/** Lane-open supply: ready rows carrying no honest lane hint, which the market may place on any lane. */
export interface ReadySupplyUnhinted {
  total: number;
  /** Of those, rows whose id marks Phantom work — the same RQ-PHX- rule `totals` uses. */
  phantom: number;
  filler: number;
}

export interface ReadySupplyV1 {
  v: 1;
  generatedAt: string;
  sourceState: 'healthy' | 'missing' | 'degraded';
  rows: number;
  /** Lane-open supply; null when the caller cannot count it. */
  unhinted: ReadySupplyUnhinted | null;
  dropped: number;
  lanes: ReadySupplyLane[];
  totals: { phxReady: number; phxParked: number; fillerReady: number; fillerParked: number };
}

export function summarizeReadySupply(
  rows: FleetLaneQueueRow[],
  meta: { dropped: number; unhinted?: ReadySupplyUnhinted | null; sourceState: ReadySupplyV1['sourceState']; now: () => Date },
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
    rows: rows.length, unhinted: meta.unhinted ?? null, dropped: meta.dropped,
    lanes: [...lanes.values()].sort((a, b) => a.lane.localeCompare(b.lane)), totals,
  };
}

export async function readReadySupply(opts: { runsDir?: string; now?: () => Date } = {}): Promise<ReadySupplyV1> {
  const now = opts.now ?? (() => new Date());
  try {
    const root = opts.runsDir ?? (process.env['ASHLR_RUNS_DIR'] || join(homedir(), '.ashlr-runs'));
    const [source, router] = await Promise.all([
      readSource(join(root, 'queue', 'ready.tsv'), 2 * 1024 * 1024, false),
      readSource(join(root, 'queue', 'router-queue.md'), ROUTER_QUEUE_MAX_BYTES, false),
    ]);
    // parseReadyTsv recognizes the dispatcher's job/repo/lane/tier/prompt
    // dialect natively, including its PARKED-<reason>[.<lane>] encodings, and
    // resolves a spec-less row's lane through its router-queue.md envelope.
    const parsed = parseReadyTsv(source.text, router.state === 'healthy' ? router.text : null);
    // Lane-open rows are real supply the market can place anywhere; the fleet
    // queue already counts them in `ready`. Classify them by the same RQ-PHX-
    // id rule the lane totals use — they have no lane to attribute.
    const unhintedPhantom = parsed.unhintedRows.filter(row => row.id.startsWith('RQ-PHX-')).length;
    return summarizeReadySupply(parsed.rows, {
      dropped: parsed.dropped,
      unhinted: { total: parsed.unhinted, phantom: unhintedPhantom, filler: parsed.unhinted - unhintedPhantom },
      sourceState: source.state, now,
    });
  } catch {
    // Even a faulty injected clock or invalid path cannot make the reader throw.
    return summarizeReadySupply([], { dropped: 0, sourceState: 'degraded', now: () => new Date(0) });
  }
}
