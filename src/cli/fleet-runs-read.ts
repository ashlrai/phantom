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
interface WatchOptions {
  signal?: AbortSignal;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
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

function readiness(state: FleetRunsDirState) {
  // A failed root stat also produces runsDirPresent=false; only ENOENT is known absent.
  const directoryPresent = state.runsDirPresent ? true : state.sourceState === 'missing' ? false : null;
  const eligibleLaneIds = state.sources.status === 'healthy'
    ? state.lanes.filter(lane => lane.held === false && lane.running < lane.target).map(lane => lane.lane)
    : null;
  const reasons: string[] = [];
  if (directoryPresent === false) reasons.push('runs_directory_absent');
  if (directoryPresent === null) reasons.push('runs_directory_unknown');
  if (state.sourceState !== 'healthy') reasons.push(`sources_${state.sourceState}`);
  if (state.paused === true) reasons.push('host_paused');
  if (state.paused === null) reasons.push('pause_unknown');
  if (eligibleLaneIds === null) reasons.push('lane_capacity_unknown');
  else if (eligibleLaneIds.length === 0) reasons.push('no_eligible_lanes');
  return { ready: reasons.length === 0, reasons, eligibleLaneIds, directoryPresent,
    sourceState: state.sourceState, sources: state.sources, paused: state.paused };
}

// lastTick is the status producer's observation time, not the reader's generatedAt.
const STATUS_MAX_AGE_MS = 60_000;
function laneReadiness(state: FleetRunsDirState, lane: string, now: number) {
  const base = readiness(state);
  const observedMs = state.lastTick === null ? NaN : Date.parse(state.lastTick);
  const age = now - observedMs;
  const ageMs = Number.isFinite(age) && age >= 0 ? age : null;
  const freshness = state.sources.status !== 'healthy' || ageMs === null ? 'unknown'
    : ageMs <= STATUS_MAX_AGE_MS ? 'fresh' : 'stale';
  const reasons = base.reasons.filter(reason => reason !== 'no_eligible_lanes');
  if (Object.values(state.sources).some(source => source !== 'healthy') && state.sourceState === 'healthy') reasons.push('sources_degraded');
  if (state.sources.status === 'healthy') {
    const selected = state.lanes.find(row => row.lane === lane);
    if (!selected) reasons.push('lane_unknown');
    else if (selected.held !== false) reasons.push('lane_held');
    else if (!(selected.running < selected.target)) reasons.push('lane_full');
  }
  if (freshness !== 'fresh') reasons.push(`status_freshness_${freshness}`);
  return { ...base, ready: reasons.length === 0, reasons, freshness, lastTick: state.lastTick, ageMs };
}

const unavailableReadiness = () => ({ ready: false, reasons: ['source_unavailable'], eligibleLaneIds: null,
  directoryPresent: null, sourceState: null, sources: null, paused: null,
  freshness: 'unknown', lastTick: null, ageMs: null });

async function waitReady(lane: string, timeout: number, interval: number, deps: Readers, options: WatchOptions): Promise<number> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  const now = options.now ?? Date.now;
  const deadline = now() + timeout;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  let result: ReturnType<typeof laneReadiness> | ReturnType<typeof unavailableReadiness> = unavailableReadiness();
  // An in-flight read is not cancellable, but must not delay cancellation or the deadline.
  const aborted = new Promise<null>(resolve => {
    if (controller.signal.aborted) resolve(null);
    else controller.signal.addEventListener('abort', () => resolve(null), { once: true });
  });
  try {
    while (!controller.signal.aborted && now() < deadline) {
      const sample = await Promise.race([Promise.resolve().then(() => deps.runs()).then(state => ({ state }), () => ({ state: null })), aborted]);
      if (sample === null || controller.signal.aborted) break;
      const sampledAt = now();
      if (sampledAt >= deadline) break;
      result = sample.state ? laneReadiness(sample.state, lane, sampledAt) : unavailableReadiness();
      if (result.ready) {
        console.log(JSON.stringify({ v: 1, lane: sanitizePublicJson(lane), outcome: 'ready', ...result }));
        return 0;
      }
      await Promise.race([(options.wait ?? waitForTick)(Math.min(interval, Math.max(0, deadline - now())), controller.signal), aborted]);
    }
    const outcome = timedOut || (!controller.signal.aborted && now() >= deadline) ? 'timed_out' : 'cancelled';
    console.log(JSON.stringify({ v: 1, lane: sanitizePublicJson(lane), outcome, ...result, ready: false }));
    return 1;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    options.signal?.removeEventListener('abort', stop);
  }
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

function waitForTick(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** Read only the host's standard runs directory; callers cannot supply paths. */
export async function cmdFleetRunsRead(verb: Verb, args: string[], deps: Readers = readers, watchOptions: WatchOptions = {}): Promise<number> {
  const usage = `Usage: phm fleet ${verb} [--json] [--help]${verb === 'journal' ? ' [--rejections-only]' : ' [--lane <lane>]'} [--watch] [--interval-ms <1000..60000>]${verb === 'runs' ? ' [--check-ready | --wait-ready --lane <lane> --timeout-ms <1..3600000>]' : ''}`;
  const seen = new Set<string>();
  let lane: string | undefined;
  let interval = 5000;
  let timeout: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const flag = arg === '-h' ? '--help' : arg;
    if (flag === '--lane' && verb !== 'journal' && !seen.has(flag) && /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/.test(args[i + 1] ?? '')) {
      lane = args[++i];
    } else if (flag === '--rejections-only' && verb === 'journal' && !seen.has(flag)) {
      // Applied to each journal snapshot after it is read.
    } else if (flag === '--watch' && !seen.has(flag)) {
      // The watch loop is entered after all arguments have been validated.
    } else if (flag === '--check-ready' && verb === 'runs' && !seen.has(flag)) {
      // Readiness is evaluated once after argument validation.
    } else if (flag === '--wait-ready' && verb === 'runs' && !seen.has(flag)) {
      // The bounded readiness wait starts after argument validation.
    } else if (flag === '--timeout-ms' && verb === 'runs' && !seen.has(flag) && /^\d+$/.test(args[i + 1] ?? '') && Number(args[i + 1]) >= 1 && Number(args[i + 1]) <= 3600000) {
      timeout = Number(args[++i]);
    } else if (flag === '--interval-ms' && !seen.has(flag) && /^\d+$/.test(args[i + 1] ?? '') && Number(args[i + 1]) >= 1000 && Number(args[i + 1]) <= 60000) {
      interval = Number(args[++i]);
    } else if (!['--json', '--help'].includes(flag) || seen.has(flag)) {
      process.stderr.write(`error: invalid fleet ${verb} arguments\n${usage}\n`);
      return 2;
    }
    seen.add(flag);
  }
  if ((seen.has('--interval-ms') && !seen.has('--watch') && !seen.has('--wait-ready')) ||
      (seen.has('--timeout-ms') && !seen.has('--wait-ready')) ||
      (seen.has('--check-ready') && (!seen.has('--json') || seen.has('--watch') || seen.has('--lane') || seen.has('--wait-ready'))) ||
      (seen.has('--wait-ready') && (!seen.has('--json') || seen.has('--watch') || lane === undefined || timeout === undefined))) {
    process.stderr.write(`error: invalid fleet ${verb} arguments\n${usage}\n`);
    return 2;
  }
  if (seen.has('--help')) {
    console.log(`${usage}${verb === 'journal' ? '\n--rejections-only shows reject and rejected ingest rows; source health and rejectedLastHour remain global. Passes and ingested rows are omitted.' : '\n--lane filters lane-attributed rows; totals and source health remain global. Rows without lane attribution are omitted.'}\n--watch samples immediately, then every 5000ms by default; --json emits JSONL. Read errors are reported and retried.${verb === 'runs' ? '\n--check-ready requires --json and cannot be combined with --watch or --lane. It reports one snapshot of directory presence, source health, pause state, reasons and observed unheld lane IDs below target; unknown values remain null. Exit 0 requires healthy sources, an unpaused host and eligible capacity; otherwise exit 1. This is evidence for the leader, not dispatch or authority.\n--wait-ready requires --json, --lane and --timeout-ms; it samples immediately and at the interval until ready, timeout or cancellation. Status lastTick must be no more than 60000ms old and not in the future. It emits one versioned result; timeout or cancellation exits 1. Capacity observation is not a reservation.' : ''}`);
    return 0;
  }
  if (seen.has('--wait-ready')) return waitReady(lane!, timeout!, interval, deps, watchOptions);
  if (seen.has('--check-ready')) {
    try {
      const result = readiness(await deps.runs());
      console.log(JSON.stringify(result));
      return result.ready ? 0 : 1;
    } catch {
      console.log(JSON.stringify({ ready: false, reasons: ['source_unavailable'], eligibleLaneIds: null,
        directoryPresent: null, sourceState: null, sources: null, paused: null }));
      return 1;
    }
  }
  const readOnce = async (signal?: AbortSignal): Promise<void> => {
    // Each reader returns its existing bounded, scrubbed and versioned projection.
    if (verb === 'runs') {
      const state = await deps.runs();
      if (signal?.aborted) return;
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
      if (signal?.aborted) return;
      if (!seen.has('--rejections-only')) console.log(seen.has('--json') ? JSON.stringify(state) : formatJournal(state));
      else {
        const filtered = { ...state, passes: [], ingest: state.ingest.filter(row => /^reject(?:ed)?$/i.test(row.verb)), ingested: [],
          rejectionsFilter: { global: ['sources', 'rejectedLastHour'], omitted: ['passes', 'ingested'] } };
        console.log(seen.has('--json') ? JSON.stringify(filtered) : `Rejections only; source health and rejected last hour are global; passes and ingested rows omitted\n${formatJournal(filtered)}`);
      }
    } else {
      // Match the desktop queue endpoint's additional public-output scrub.
      const state = sanitizePublicJson(await deps.parked()) as FleetQueueV1;
      if (signal?.aborted) return;
      if (lane === undefined) console.log(seen.has('--json') ? JSON.stringify(state) : formatParked(state));
      else {
        const filtered = { ...state, byLane: state.byLane.filter(row => row.lane === lane),
          groups: state.groups.filter(row => row.lane === lane), skips: [],
          laneFilter: { lane: sanitizePublicJson(lane), global: ['sources', 'total', 'ready', 'parked', 'malformed', 'skipsLast24h'], omitted: ['skips'] } };
        console.log(seen.has('--json') ? JSON.stringify(filtered) : `Lane filter: ${filtered.laneFilter.lane}; totals and source health are global; unattributed skips omitted\n${formatParked(filtered)}`);
      }
    }
  };
  if (seen.has('--watch')) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    watchOptions.signal?.addEventListener('abort', stop, { once: true });
    if (watchOptions.signal?.aborted) stop();
    try {
      while (!controller.signal.aborted) {
        try {
          await readOnce(controller.signal);
        } catch {
          if (controller.signal.aborted) break;
          if (seen.has('--json')) console.log(JSON.stringify({ error: `fleet ${verb} unavailable` }));
          else process.stderr.write(`error: fleet ${verb} unavailable\n`);
        }
        if (!controller.signal.aborted) await (watchOptions.wait ?? waitForTick)(interval, controller.signal);
      }
      return 0;
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      watchOptions.signal?.removeEventListener('abort', stop);
    }
  }
  try {
    await readOnce();
    return 0;
  } catch {
    process.stderr.write(`error: fleet ${verb} unavailable\n`);
    return 1;
  }
}
