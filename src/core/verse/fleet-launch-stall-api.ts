/**
 * Launch stall read for the desktop Lanes pane:
 *
 *   GET /api/verse/fleet/control/launch-stall → LaunchStallViewV1
 *
 * Reached through the fleet-control workbench family (fleet-control-api.ts
 * delegates this exact path here), because that family owns every path under
 * /api/verse/fleet/control; an A10 mount at this path would never be reached.
 * Non-GET methods pass the family's dispatch + mutation gate first and are
 * then refused with 405. Read-only: the tail of <runs>/dispatchd.log for
 * queued ticks without launches, plus lanes whose status.json says running 0
 * while old jobs wait, plus `why` (src/core/fleet/launch-why.ts): the one-line reason launches are blocked. Unreadable sources answer `source: 'unavailable'`,
 * never invented zeros. Every string is secret-scrubbed on the way out.
 */
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { explainLaunchBlock, readLaunchWhyInput, type LaunchWhy } from '../fleet/launch-why.js';
import { parseLaunchStall, type LaunchStallReport } from '../fleet/launch-stall-read.js';
import { fsLaneStallReader, readFleetLaneStall, type FleetLaneStallView } from '../../cli/fleet-lane-stall.js';
import { scrubSecrets } from '../util/scrub.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export const VERSE_FLEET_CONTROL_LAUNCH_STALL_PATH = '/api/verse/fleet/control/launch-stall';
/** Never read more than this much of dispatchd.log; the latest run lives at the end. */
export const LAUNCH_STALL_TAIL_BYTES = 512 * 1024;
/** Same default as `phm fleet launch-stall`. */
const STALL_MIN_MINUTES = 30;

export interface LaunchStallViewV1 {
  v: 1;
  generatedAt: string;
  /** null when dispatchd.log could not be read. */
  stall: LaunchStallReport | null;
  lanes: FleetLaneStallView['lanes'];
  /** 'unavailable' when the log or the lane queue could not be read. */
  source: 'ok' | 'unavailable';
  /**
   * Why launches are blocked (disk guard, load gate, cap, stale dispatcher), additive: older servers omit it.
   * null when it could not be read; reading it never changes `source`, `stall` or `lanes`.
   */
  why?: LaunchWhy | null;
}

/** Plain-line launch block reason, secret-scrubbed; null on any read failure. */
export async function readLaunchWhy(runsDir: string, now = Date.now()): Promise<LaunchWhy | null> {
  try {
    const why = explainLaunchBlock(await readLaunchWhyInput(runsDir, { now }));
    return { code: why.code, line: scrubSecrets(why.line), detail: why.detail.map((line) => scrubSecrets(line)) };
  } catch { return null; }
}

/** Last `maxBytes` of a file, starting at the first whole line when truncated. */
export async function readLogTail(path: string, maxBytes = LAUNCH_STALL_TAIL_BYTES): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await handle.close();
  }
}

export async function readLaunchStallView(runsDir: string, now = Date.now()): Promise<LaunchStallViewV1> {
  let stall: LaunchStallReport | null = null;
  let lanes: FleetLaneStallView['lanes'] = [];
  let source: LaunchStallViewV1['source'] = 'ok';
  try {
    const report = parseLaunchStall(await readLogTail(join(runsDir, 'dispatchd.log')), STALL_MIN_MINUTES);
    stall = { ...report, startTime: report.startTime === null ? null : scrubSecrets(report.startTime) };
  } catch { source = 'unavailable'; }
  try {
    lanes = (await readFleetLaneStall(fsLaneStallReader(runsDir), now)).lanes.map((group) => ({
      lane: scrubSecrets(group.lane),
      jobs: group.jobs.map((job) => ({ job: scrubSecrets(job.job), ageMinutes: job.ageMinutes })),
    }));
  } catch { source = 'unavailable'; }
  const why = await readLaunchWhy(runsDir, now);
  return { v: 1, generatedAt: new Date(now).toISOString(), stall, lanes, source, why };
}

export const handleFleetLaunchStallApi: ApiModule = async (_ctx, _req, res, path, method) => {
  if (path !== VERSE_FLEET_CONTROL_LAUNCH_STALL_PATH) return false;
  if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
  const runsDir = process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs');
  sendJson(res, 200, await readLaunchStallView(runsDir));
  return true;
};
