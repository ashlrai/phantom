/** Detection only; never places a hold or grants dispatch authority. */
import { readDispatchEventsLog } from '../core/fleet/dispatch-events-read.js';
import {
  laneEmptyStreaks,
  LANE_STREAKS_DEFAULT_MINUTES,
  LANE_STREAKS_MAX_MINUTES,
  LANE_STREAKS_MIN_MINUTES,
  type LaneEmptyStreaksV1,
  type LaneStreak,
} from '../core/fleet/lane-empty-streak.js';

const usage = `ashlr fleet lane-streaks [--minutes N] [--json]
Read-only; names lanes whose recent launches all end empty.
Exit 2 when any lane is burning; detection only, never holds a lane.`;
export { readDispatchEventsLog };

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
    out(usage);
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
