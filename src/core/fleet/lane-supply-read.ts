/**
 * lane-supply-read.ts — the file reads behind the lane supply report. The CLI and the
 * /api/verse/fleet/lane-supply route both call readLaneSupply, so they cannot disagree.
 * Read-only: nothing under the runs dir is written.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getFleetLaneSnapshot, type FleetLaneSnapshot } from './lane-console.js';
import { defaultRunsDir } from './host-top.js';
import { SELF_TICK_LAST } from './self-tick-last.js';
import { buildLaneSupply, type LaneSupplyReport } from './lane-supply.js';

export interface ReadLaneSupplyDeps {
  runsDir?: string;
  now?: () => number;
  snapshot?: (queueDir: string) => Promise<FleetLaneSnapshot>;
  /** The self-tick record text, or null when absent. */
  readRecord?: (path: string) => Promise<string | null>;
}

const readOrNull = async (path: string): Promise<string | null> => {
  try { return await readFile(path, 'utf8'); } catch { return null; }
};

export async function readLaneSupply(deps: ReadLaneSupplyDeps = {}): Promise<LaneSupplyReport> {
  const runsDir = deps.runsDir ?? defaultRunsDir();
  const nowMs = (deps.now ?? Date.now)();
  const [snapshot, record] = await Promise.all([
    (deps.snapshot ?? ((queueDir: string) => getFleetLaneSnapshot({ queueDir, now: () => new Date(nowMs) })))(join(runsDir, 'queue')),
    (deps.readRecord ?? readOrNull)(join(runsDir, SELF_TICK_LAST)),
  ]);
  return buildLaneSupply(snapshot, record, nowMs);
}
