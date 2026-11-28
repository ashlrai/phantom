import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { readFleetQueue, type FleetQueueV1 } from '../core/fleet/runs-parked-queue.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: phm fleet queue-parked [--root <absolute>] [--json]\n'
  + 'Read-only view of parked jobs: parked reasons, BLOCKED jobs with unmet dependency gates, and EVIDENCE-ONLY jobs whose gates are all MERGED. '
  + 'Reads <root>/queue/ready.tsv, queue/precheck-skips.tsv and metrics/jobs.jsonl (default ASHLR_RUNS_DIR or ~/.ashlr-runs). '
  + 'Exit 1 when ready.tsv is absent or degraded. All-met rows are never permission to launch, unpark or dispatch.';

// Mutation options are named explicitly so a mistyped action fails before any read.
const MUTATION_FLAGS = new Set(['--unpark', '--dispatch', '--apply', '--launch', '--write', '--force', '--yes', '--lock', '--fix']);

type Snapshot = 'absent' | 'degraded' | 'empty' | 'populated';

/** Distinguish a missing or malformed snapshot from a healthy queue with no jobs. */
function snapshotOf(state: FleetQueueV1): Snapshot {
  if (state.sources.ready === 'missing') return 'absent';
  if (state.sources.ready !== 'healthy') return 'degraded';
  return state.total === 0 ? 'empty' : 'populated';
}

function formatText(state: FleetQueueV1, snapshot: Snapshot): string {
  const value = (lane: string | null): string => lane ?? 'unknown';
  const notice = {
    absent: 'No queue snapshot: queue/ready.tsv is absent. This is not an empty queue.',
    degraded: 'Queue snapshot is degraded: unreadable or malformed rows; counts may be incomplete.',
    empty: 'Queue is empty: healthy snapshot with no jobs.',
    populated: '',
  }[snapshot];
  return [
    `Fleet queue parked: snapshot ${snapshot}; sources ready=${state.sources.ready} skips=${state.sources.skips}`,
    `Total ${state.total}; ready ${state.ready}; parked ${state.parked}; malformed ${state.malformed}`,
    ...(notice ? [notice] : []),
    ...state.groups.map(group => `parked ${group.reason} (${value(group.lane)}): ${group.count} [${group.jobs.join(', ')}]`),
    ...(state.unmetDeps ?? []).map(row => `BLOCKED ${row.job} (${value(row.lane)}): unmet ${row.unmet.join(', ')}`),
    ...(state.metDeps ?? []).map(row => `EVIDENCE-ONLY ${row.job} (${value(row.lane)}): all gates MERGED ${row.gates.join(', ')}; not permission to launch or unpark`),
    'Read-only; no queue state changed.',
  ].join('\n');
}

/** Read-only parked-queue inspection; exit 0 for a readable snapshot, 1 when absent or degraded. */
export async function cmdFleetQueueParked(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const reject = (message: string): number => {
    console.error(`error: ${message}`);
    console.error(usage);
    return 2;
  };
  let root = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  let json = false;
  let rootSeen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (MUTATION_FLAGS.has(arg)) return reject(`fleet queue-parked is read-only; ${arg} is not accepted`);
    if (arg === '--json' && !json) json = true;
    else if (arg === '--root' && !rootSeen) {
      const value = args[i + 1];
      if (value === undefined || !isAbsolute(value)) return reject('--root requires an absolute path');
      root = value;
      rootSeen = true;
      i++;
    } else return reject(`unknown argument: ${arg}`);
  }

  let state: FleetQueueV1;
  try {
    state = sanitizePublicJson(await readFleetQueue({ runsDir: root, depDetail: true })) as FleetQueueV1;
  } catch {
    console.error('error: fleet queue-parked unavailable');
    return 1;
  }
  const snapshot = snapshotOf(state);
  console.log(json ? JSON.stringify({ ...state, snapshot }) : formatText(state, snapshot));
  return snapshot === 'absent' || snapshot === 'degraded' ? 1 : 0;
}
