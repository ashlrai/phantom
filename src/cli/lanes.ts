import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseSince } from '../core/fleet/agent-messages.js';
import { formatLaneAdaptText, raiseLaneAdaptAsks, readLaneAdapt } from '../core/fleet/lane-adapt.js';
import { computeLaneFit } from '../core/fleet/lane-fit.js';
import { computeLaneYield, NEUTRAL_WEIGHT, type LaneYieldRow } from '../core/fleet/lane-yield-weight.js';
import { readFleetRunsDirState } from '../core/fleet/runs-dir-state.js';
import { buildFleetLiveSnapshot } from '../core/verse/fleet-live-api.js';
import { computeLaneHealth, laneHealthLine, stuckBadge } from '../core/fleet/lane-health.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const USAGE = `Usage: phm lanes --json | phm lanes health [--json] | phm lanes fit --lane <lane> [--json]
       phm lanes yield [--json] | phm lanes adapt [--since 6h] [--json]
Calls, error rate, p50 latency and deployed commit per lane over the last 12 h,
plus a "stuck" badge with phase age for any run past its phase timeout.
"phm lanes yield" shows merged PRs per launch over each lane's last 50 jobs, the empty rate and the
weight the router uses (1 = neutral; unknown below 10 jobs).
"phm lanes adapt" shows, per lane, why it sits below its target and for how long: the last cut in plain words, minutes below
target, and whether the cause (memory, the PAUSE file) is still there. A lane still cut after its cause cleared over
10 minutes ago is flagged backed_off_while_healthy. JSON schema id: lanes.adapt.v1.
Figures that cannot be measured print "unknown".`;

const pct = (n: number | null): string => n === null ? 'unknown' : `${Math.round(n * 100)}%`;
function yieldLine(row: LaneYieldRow, min: number): string {
  const head = `${row.lane} / ${row.size === 'all' ? 'all sizes' : row.size}`;
  if (!row.known) return `${head}: unknown (${row.launches} of ${min} launches needed); router weight ${NEUTRAL_WEIGHT.toFixed(2)} (neutral)`;
  return `${head}: yield ${pct(row.yield)} (${row.merged} merged of ${row.launches} launches), empty ${pct(row.emptyRate)}; router weight ${row.weight.toFixed(2)}`;
}

export async function cmdLanes(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--json') {
    const state = await readFleetRunsDirState();
    console.log(JSON.stringify(sanitizePublicJson({ schema: 'lanes.dispatchd.v1', lastTick: state.lastTick,
      sourceState: state.sources.status, lanes: state.lanes })));
    return 0;
  }
  if (args.length === 0 || ['--help', '-h'].includes(args[0]!)) {
    console.log(USAGE);
    return args.length === 0 ? 2 : 0;
  }
  if (args[0] === 'yield') {
    const flags = args.slice(1);
    if (flags.some(x => x !== '--json') || flags.length > 1) { console.error(USAGE); return 2; }
    let ledger: string | null;
    try { ledger = await readFile(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl'), 'utf8'); } catch { ledger = null; }
    const report = computeLaneYield(ledger);
    if (flags.length) console.log(JSON.stringify(sanitizePublicJson(report)));
    else if (!report.known) console.log('Job history is unavailable. Yield is unknown.');
    else if (!report.rows.length) console.log('No launches recorded yet. Every lane is neutral (weight 1).');
    else for (const row of report.rows) console.log(yieldLine(row, report.minJobs));
    return 0;
  }
  if (args[0] === 'adapt') {
    const flags = args.slice(1);
    const json = flags.includes('--json');
    const sinceAt = flags.indexOf('--since');
    const sinceText = sinceAt >= 0 ? flags[sinceAt + 1] : '6h';
    const sinceMs = sinceText === undefined ? null : parseSince(sinceText);
    const extra = flags.filter((x, i) => x !== '--json' && x !== '--since' && !(sinceAt >= 0 && i === sinceAt + 1));
    if (extra.length || flags.filter(x => x === '--json').length > 1 || flags.filter(x => x === '--since').length > 1 || sinceMs === null) {
      console.error(USAGE); return 2;
    }
    const report = await readLaneAdapt({ sinceMs });
    // Raise the Asks card here too, so the one command both shows and surfaces the flag. Best effort.
    if (report.flagged.length) await raiseLaneAdaptAsks(report).catch(() => []);
    console.log(json ? JSON.stringify(sanitizePublicJson(report)) : formatLaneAdaptText(report));
    return 0;
  }
  if (args[0] === 'fit') {
    const flags = args.slice(1);
    const laneIndex = flags.indexOf('--lane');
    const lane = laneIndex >= 0 ? flags[laneIndex + 1] : undefined;
    if (!lane || lane.startsWith('-') || flags.filter(x => x === '--lane').length !== 1 || flags.filter(x => x === '--json').length > 1 || flags.some((x, i) => i !== laneIndex && i !== laneIndex + 1 && x !== '--json')) {
      console.error(USAGE); return 2;
    }
    let text: string | null;
    try { text = await readFile(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl'), 'utf8'); } catch { text = null; }
    const report = computeLaneFit(text, lane);
    if (flags.includes('--json')) console.log(JSON.stringify(sanitizePublicJson(report)));
    else if (!report.known) console.log('Job history is unavailable. Fit is unknown.');
    else if (!report.kinds.length) console.log('No job history for this lane. Fit is unknown.');
    else for (const kind of report.kinds) console.log(`${kind.repo ?? 'unknown repo'} / ${kind.tier ?? 'unknown tier'} / ${kind.verb ?? 'unknown verb'}: ${kind.recommendation}; ${kind.prs}/${kind.jobs - kind.unknownOutcomes} produced a PR, ${kind.unknownOutcomes} unknown`);
    return 0;
  }
  if (args[0] !== 'health' || args.slice(1).some((a) => a !== '--json')) {
    console.error(USAGE);
    return 2;
  }
  const { snapshot } = await buildFleetLiveSnapshot();
  const health = computeLaneHealth(snapshot);
  if (args.includes('--json')) {
    console.log(JSON.stringify(sanitizePublicJson(health)));
    return 0;
  }
  console.log(`Lane health, last ${health.window.hours} h (to ${health.window.until})`);
  for (const lane of health.lanes) {
    const badge = stuckBadge(lane);
    console.log(`${lane.lane}: ${laneHealthLine(lane)}${badge ? `  [${badge}]` : ''}`);
  }
  return 0;
}
