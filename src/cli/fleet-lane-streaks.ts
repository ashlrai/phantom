/** Detection only; never places a hold or grants dispatch authority. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  laneEmptyStreaks,
  LANE_STREAKS_DEFAULT_MINUTES,
  LANE_STREAKS_MAX_MINUTES,
  LANE_STREAKS_MIN_MINUTES,
  type LaneEmptyStreaksV1,
  type LaneStreak,
} from '../core/fleet/lane-empty-streak.js';

/** Descriptor-bound tail read of the runs-dir event log, like runs-dir-state. */
const DISPATCH_EVENTS_TAIL = 8 * 1024 * 1024;
async function readDispatchEventsLog(): Promise<string | null> {
  const path = join(homedir(), '.ashlr-runs', 'dispatch-events.log');
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size <= 0) return null;
      const start = Math.max(0, info.size - DISPATCH_EVENTS_TAIL);
      const bytes = Buffer.alloc(Math.min(info.size, DISPATCH_EVENTS_TAIL));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, start + offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const text = bytes.subarray(0, offset).toString('utf8');
      return start ? text.slice(text.indexOf('\n') < 0 ? text.length : text.indexOf('\n') + 1) : text;
    } finally { await file.close(); }
  } catch { return null; }
}

function line(lane: LaneStreak): string {
  const median = lane.medianMinutes === null ? 'median —' : `median ${Math.round(lane.medianMinutes)} min`;
  const running = lane.running > 0 ? `, ${lane.running} running` : '';
  const last = lane.lastEmptyJob && lane.lastEmptyAt ? `, last ${lane.lastEmptyJob} ${lane.lastEmptyAt.slice(11, 16)}` : '';
  return `${lane.lane}  ${lane.verdict}  ${lane.launches} launches, ${lane.empties} empty, ${lane.published} published, ${median}${running}${last}`;
}

export interface FleetLaneStreaksDeps {
  /** Defaults to the dispatch-events.log tail under ~/.ashlr-runs (null when absent). */
  readDispatchEvents?: () => Promise<string | null>;
  now?: () => number;
  out?: (line: string) => void;
}

export async function cmdFleetLaneStreaks(args: string[], deps: FleetLaneStreaksDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    out('ashlr fleet lane-streaks [--minutes N] [--json]\n' +
      'Read-only; names lanes whose recent launches all end empty.\n' +
      'Exit 2 when any lane is burning; detection only, never holds a lane.');
    return 0;
  }
  let minutes = LANE_STREAKS_DEFAULT_MINUTES;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--minutes' && /^\d+$/.test(args[i + 1] ?? '')
      && Number(args[i + 1]) >= LANE_STREAKS_MIN_MINUTES && Number(args[i + 1]) <= LANE_STREAKS_MAX_MINUTES) {
      minutes = Number(args[++i]);
    } else {
      console.error(`fleet lane-streaks: bad flag or value: ${arg}`);
      return 1;
    }
  }
  const readEvents = deps.readDispatchEvents ?? readDispatchEventsLog;
  const now = deps.now ?? Date.now;
  let text: string | null = null;
  try { text = await readEvents(); } catch { text = null; }
  const report: LaneEmptyStreaksV1 = text === null
    ? { v: 1, generatedAt: new Date(now()).toISOString(), source: 'unavailable', windowMinutes: minutes, lanes: [], malformedLines: 0 }
    : laneEmptyStreaks(text, now(), minutes);
  if (json) {
    out(JSON.stringify(report));
  } else if (report.source === 'unavailable') {
    out('lane-streaks: dispatch events unavailable');
  } else if (!report.lanes.length) {
    out(`no lane launches in the last ${report.windowMinutes} min`);
  } else {
    for (const lane of report.lanes) out(line(lane));
  }
  return report.lanes.some(lane => lane.verdict === 'burning') ? 2 : 0;
}
