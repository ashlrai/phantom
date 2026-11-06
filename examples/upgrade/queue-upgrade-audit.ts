#!/usr/bin/env -S npx tsx
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readFleetQueue, type FleetQueueV1 } from '../../src/core/fleet/runs-parked-queue.js';
import { readFleetRunsDirState, type FleetRunsDirState } from '../../src/core/fleet/runs-dir-state.js';
import { scrubSecrets } from '../../src/core/util/scrub.js';

const HELP = `Usage: npx tsx examples/upgrade/queue-upgrade-audit.ts [--help]

Audit ready queue lanes against dispatch status without modifying work.
Exit codes: 0 verified, 1 mismatch or failure, 2 usage, 3 insufficient evidence.
`;
const MAX_LANES = 100;
const MAX_SAMPLES = 8;
const safeLane = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/.test(value) && scrubSecrets(value) === value;
const safeJob = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value) && scrubSecrets(value) === value;

type Dependencies = {
  readQueue?: () => Promise<FleetQueueV1>;
  readStatus?: () => Promise<FleetRunsDirState>;
  write?: (text: string) => void;
};

/** Compare only public projections; absent or partial sources cannot establish absence. */
export function auditQueue(queue: FleetQueueV1, status: FleetRunsDirState) {
  const queueComplete = queue.sources.ready === 'healthy';
  const statusComplete = status.sources.status === 'healthy';
  const queueLanes = new Map(queue.byLane.filter(row => safeLane(row.lane)).map(row => [row.lane, row]));
  const statusLanes = new Map(status.lanes.filter(row => safeLane(row.lane)).map(row => [row.lane, row]));
  const names = [...new Set([...queueLanes.keys(), ...statusLanes.keys()])].sort();
  const unsafeLanes = queue.byLane.filter(row => !safeLane(row.lane)).length + status.lanes.filter(row => !safeLane(row.lane)).length;
  const samples = new Map<string, string[]>();
  for (const group of queue.groups) {
    if (!group.lane || !queueLanes.has(group.lane)) continue;
    const ids = samples.get(group.lane) ?? [];
    samples.set(group.lane, [...new Set([...ids, ...group.jobs.filter(safeJob)])].sort().slice(0, MAX_SAMPLES));
  }
  let unknownReady = 0, heldReady = 0, unconfirmedReady = 0;
  const lanes = names.map(lane => {
    const queued = queueLanes.get(lane);
    const current = statusLanes.get(lane);
    const ready = queued?.ready ?? (queueComplete ? 0 : null);
    const parked = queued?.parked ?? (queueComplete ? 0 : null);
    const relation = current ? (current.held ? 'held' : 'available') : (statusComplete ? 'unknown' : 'unconfirmed');
    if (ready && relation === 'unknown') unknownReady += ready;
    if (ready && relation === 'held') heldReady += ready;
    if (ready && relation === 'unconfirmed') unconfirmedReady += ready;
    // The queue reader exposes IDs only for parked groups, never for READY rows.
    const parkedSamples = samples.get(lane) ?? [];
    return { lane, ready, parked, relation, running: current?.running ?? null, target: current?.target ?? null,
      floor: current?.floor ?? null, ceiling: current?.ceiling ?? null, parkedSamples };
  });
  const omittedLanes = Math.max(0, lanes.length - MAX_LANES);
  const mismatch = unknownReady > 0 || heldReady > 0;
  const sufficient = queueComplete && statusComplete && unsafeLanes === 0 && omittedLanes === 0;
  return {
    v: 1, verdict: mismatch ? 'mismatch' : sufficient ? 'verified' : 'insufficient',
    sources: { queue: queue.sources, status: status.sources.status, runs: status.sourceState },
    queue: { total: queue.sources.ready === 'missing' ? null : queue.total,
      ready: queue.sources.ready === 'missing' ? null : queue.ready,
      parked: queue.sources.ready === 'missing' ? null : queue.parked, malformed: queue.malformed },
    findings: { unknownReady, heldReady, unconfirmedReady },
    unsafeLanes, omittedLanes, lanes: lanes.slice(0, MAX_LANES),
  };
}

/** Run once using the installed user's runs directory, or injected readers in tests. */
export async function run(args: string[], deps: Dependencies = {}): Promise<number> {
  const write = deps.write ?? (text => { process.stdout.write(text); });
  if (args.length === 1 && args[0] === '--help') { write(HELP); return 0; }
  if (args.length !== 0) { write('{"v":1,"error":"invalid arguments; use --help"}\n'); return 2; }
  try {
    const [queue, status] = await Promise.all([(deps.readQueue ?? readFleetQueue)(), (deps.readStatus ?? readFleetRunsDirState)()]);
    const report = auditQueue(queue, status);
    write(`${JSON.stringify(report)}\n`);
    return report.verdict === 'mismatch' ? 1 : report.verdict === 'insufficient' ? 3 : 0;
  } catch {
    write('{"v":1,"error":"unable to audit queue"}\n');
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
