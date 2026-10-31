import { readFleetRunsDirState, type FleetRunsDirState } from '../core/fleet/runs-dir-state.js';
import { readLeaderJournal, type LeaderJournalV1 } from '../core/fleet/leader-journal.js';
import { readFleetQueue, type FleetQueueV1 } from '../core/fleet/runs-parked-queue.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

type Verb = 'runs' | 'journal' | 'parked';
interface Readers {
  runs: () => Promise<FleetRunsDirState>;
  journal: () => Promise<LeaderJournalV1>;
  parked: () => Promise<FleetQueueV1>;
}
const readers: Readers = { runs: readFleetRunsDirState, journal: readLeaderJournal, parked: readFleetQueue };
const health = (sources: Record<string, string>): string =>
  Object.entries(sources).map(([name, state]) => `${name}=${state}`).join(' ');
const value = (v: string | number | boolean | null): string => v === null ? 'unknown' : String(v);

function formatRuns(state: FleetRunsDirState): string {
  return [
    `Fleet runs: ${state.sourceState}; directory ${state.runsDirPresent ? 'present' : 'absent'}`,
    `Sources: ${health(state.sources)}`,
    `Last tick: ${value(state.lastTick)}; paused: ${value(state.paused)}`,
    ...state.lanes.map(lane => `${lane.lane}: ${lane.running}/${lane.target} running, ${lane.queued} queued; held: ${lane.held}${lane.heldReason === null ? '' : ` (${lane.heldReason})`}`),
  ].join('\n');
}

function formatJournal(state: LeaderJournalV1): string {
  return [
    `Fleet journal: ${health(state.sources)}`,
    `Rejected last hour: ${value(state.rejectedLastHour)}`,
    ...state.passes.flatMap(pass => [pass.at, ...pass.sections.flatMap(section => [`  ${section.title}`, ...section.bullets.map(bullet => `    - ${bullet}`)])]),
    ...state.ingest.map(row => `${row.verb} ${row.file}${row.reason === null ? '' : `: ${row.reason}`}`),
    ...state.ingested.map(row => `ingested ${row.id} (${row.lane}): ${row.title}`),
  ].join('\n');
}

function formatParked(state: FleetQueueV1): string {
  return [
    `Fleet parked: ${health(state.sources)}`,
    `Total: ${state.total}; ready: ${state.ready}; parked: ${state.parked}; malformed: ${state.malformed}`,
    ...state.byLane.map(lane => `${lane.lane}: ${lane.ready} ready, ${lane.parked} parked`),
    ...state.groups.map(group => `${group.reason} (${value(group.lane)}): ${group.count} [${group.jobs.join(', ')}]`),
    `Precheck skips last 24h: ${value(state.skipsLast24h)}`,
    ...state.skips.map(skip => `${skip.at} ${skip.job} ${skip.code}: ${skip.reason}`),
  ].join('\n');
}

/** Read only the host's standard runs directory; callers cannot supply paths. */
export async function cmdFleetRunsRead(verb: Verb, args: string[], deps: Readers = readers): Promise<number> {
  const usage = `Usage: phm fleet ${verb} [--json]${verb === 'journal' ? '' : ' [--lane <lane>]'} [--help]`;
  const seen = new Set<string>();
  let lane: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const flag = arg === '-h' ? '--help' : arg;
    if (flag === '--lane' && verb !== 'journal' && !seen.has(flag) && /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/.test(args[i + 1] ?? '')) {
      lane = args[++i];
    } else if (!['--json', '--help'].includes(flag) || seen.has(flag)) {
      process.stderr.write(`error: invalid fleet ${verb} arguments\n${usage}\n`);
      return 2;
    }
    seen.add(flag);
  }
  if (seen.has('--help')) {
    console.log(verb === 'journal' ? usage : `${usage}\n--lane filters lane-attributed rows; totals and source health remain global. Rows without lane attribution are omitted.`);
    return 0;
  }
  try {
    // Each reader returns its existing bounded, scrubbed and versioned projection.
    if (verb === 'runs') {
      const state = await deps.runs();
      if (lane === undefined) console.log(seen.has('--json') ? JSON.stringify(state) : formatRuns(state));
      else {
        const filtered = { ...state, lanes: state.lanes.filter(row => row.lane === lane),
          claimed: state.claimed.filter(row => row.lane === lane),
          publishesLastHour: state.publishesLastHour.filter(row => row.lane === lane),
          events: [], drop: { ...state.drop, pending: state.drop.pending.filter(row => row.lane === lane) },
          laneFilter: { lane: sanitizePublicJson(lane), global: ['sources', 'sourceState', 'drop.done', 'other non-row fields', 'switches'], omitted: ['events'] } };
        console.log(seen.has('--json') ? JSON.stringify(filtered) : `Lane filter: ${filtered.laneFilter.lane}; source health and other non-row values are global; unattributed events omitted\n${formatRuns(filtered)}`);
      }
    } else if (verb === 'journal') {
      const state = await deps.journal();
      console.log(seen.has('--json') ? JSON.stringify(state) : formatJournal(state));
    } else {
      // Match the desktop queue endpoint's additional public-output scrub.
      const state = sanitizePublicJson(await deps.parked()) as FleetQueueV1;
      if (lane === undefined) console.log(seen.has('--json') ? JSON.stringify(state) : formatParked(state));
      else {
        const filtered = { ...state, byLane: state.byLane.filter(row => row.lane === lane),
          groups: state.groups.filter(row => row.lane === lane), skips: [],
          laneFilter: { lane: sanitizePublicJson(lane), global: ['sources', 'total', 'ready', 'parked', 'malformed', 'skipsLast24h'], omitted: ['skips'] } };
        console.log(seen.has('--json') ? JSON.stringify(filtered) : `Lane filter: ${filtered.laneFilter.lane}; totals and source health are global; unattributed skips omitted\n${formatParked(filtered)}`);
      }
    }
    return 0;
  } catch {
    process.stderr.write(`error: fleet ${verb} unavailable\n`);
    return 1;
  }
}
