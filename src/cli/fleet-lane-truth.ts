/** Offline advisory only. Never changes a hold or grants dispatch authority. */
import {
  defaultLaneTruthReaders,
  readLaneTruth,
} from '../core/fleet/lane-truth.js';

export {
  defaultLaneTruthReaders,
  LANE_TRUTH_MAX_AGE_MS,
  readLaneTruth,
} from '../core/fleet/lane-truth.js';
export type {
  LaneState,
  LaneTruthReaders,
  LaneVerdict,
  MeterSample,
} from '../core/fleet/lane-truth.js';

const laneName = /^[a-z][a-z0-9-]{1,40}$/;
const checkReasons = {
  held_with_capacity: 'held despite available capacity; investigate the hold',
  idle_with_work: 'queued work with no running workers; investigate the stall',
  unknown: 'evidence is missing or stale; refresh lane and meter evidence',
  missing_lane: 'requested lane is missing; verify lane evidence',
  empty_evidence: 'no lane evidence; verify the evidence source',
  evidence_unavailable: 'lane evidence unavailable; verify the evidence source',
  too_many_lanes: 'too many lane entries to check; narrow the selection',
} as const;
type CheckReason = keyof typeof checkReasons;
type CheckEntry = { lane: string | null; reason: CheckReason };
const MAX_CHECK_ENTRIES = 256;

export async function cmdFleetLaneTruth(args: string[], readers = defaultLaneTruthReaders()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('ashlr fleet lane-truth [--lane NAME]... [--json] [--check]\n' +
      'Read-only; stale or missing evidence is unknown. reset_detected is advisory.\n' +
      'Checking never releases holds or grants dispatch authority.');
    return 0;
  }
  let json = false;
  let checking = false;
  const requested = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--check' && !checking) checking = true;
    else if (arg === '--lane' && args[i + 1] && laneName.test(args[i + 1]!)) {
      requested.add(args[++i]!);
      if (requested.size > MAX_CHECK_ENTRIES) return 2;
    }
    else return 2;
  }
  try {
    const result = await readLaneTruth(readers);
    const lanes = requested.size ? result.lanes.filter(row => requested.has(row.lane)) : result.lanes;
    if (!checking) {
      console.log(json ? JSON.stringify({ ...result, lanes }) : lanes.map(row => `${row.lane}: ${row.verdict}`).join('\n'));
      return 0;
    }
    const entries: CheckEntry[] = [];
    let total = 0;
    const add = (entry: CheckEntry) => { total++; if (entries.length < MAX_CHECK_ENTRIES) entries.push(entry); };
    const present = new Set(lanes.map(row => row.lane));
    for (const lane of requested) if (!present.has(lane)) add({ lane, reason: 'missing_lane' });
    for (const row of lanes) {
      if (row.verdict !== 'ok' && row.verdict !== 'reset_detected') add({ lane: row.lane, reason: row.verdict });
    }
    if (!lanes.length && !requested.size) add({ lane: null, reason: 'empty_evidence' });
    if (total > MAX_CHECK_ENTRIES) entries.push({ lane: null, reason: 'too_many_lanes' });
    const check = { passed: total === 0, entries };
    console.log(json ? JSON.stringify({ ...result, lanes, check }) :
      [...lanes.map(row => `${row.lane}: ${row.verdict}`), ...entries.map(entry => `${entry.lane ?? 'fleet'}: ${checkReasons[entry.reason]}`)].join('\n'));
    return check.passed ? 0 : 1;
  } catch {
    if (checking && json) console.log(JSON.stringify({ schema: 'fleet.lane-truth.v1', lanes: [], check: { passed: false, entries: requested.size ? [...requested].map(lane => ({ lane, reason: 'evidence_unavailable' })) : [{ lane: null, reason: 'evidence_unavailable' }] } }));
    else console.error('fleet lane-truth: lane evidence unavailable');
    return 1;
  }
}
