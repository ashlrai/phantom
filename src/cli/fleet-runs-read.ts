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

/** Row collections bounded by `--sample`; scalar fields, `sources` and `switches` are not rows. */
const SAMPLE_MAX = 200;
const SAMPLE_ROW_KEYS: Record<Verb, readonly string[]> = {
  runs: ['lanes', 'claimed', 'publishesLastHour', 'events'],
  journal: ['notes', 'passes', 'ingest', 'ingested'],
  parked: ['byLane', 'nextUp', 'groups', 'skips'],
};
const ISO_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Timestamped streams emit newest first; other row lists keep the projection's order. */
function newestFirst(rows: readonly unknown[]): unknown[] {
  const stamp = (row: unknown): number => {
    const at = typeof row === 'object' && row !== null ? (row as { at?: unknown }).at : undefined;
    return typeof at === 'string' && ISO_AT.test(at) ? Date.parse(at) : Number.NaN;
  };
  return rows.length > 1 && rows.every(row => Number.isFinite(stamp(row)))
    ? [...rows].sort((a, b) => stamp(b) - stamp(a))
    : [...rows];
}

/** Cap each emitted row collection to its newest `n` rows; `truncated` reports rows cut by the bound. */
function boundSample<T extends object>(state: T, verb: Verb, n: number): T & { sampled: number; truncated: boolean } {
  let truncated = false;
  const capped = { ...(state as Record<string, unknown>) };
  const take = (key: string, rows: unknown[]): void => {
    if (rows.length > n) truncated = true;
    capped[key] = newestFirst(rows).slice(0, n);
  };
  for (const key of SAMPLE_ROW_KEYS[verb]) {
    const rows = capped[key];
    if (Array.isArray(rows)) take(key, rows);
  }
  const drop = capped.drop;
  if (drop !== null && typeof drop === 'object' && !Array.isArray(drop)) {
    const pending = (drop as { pending?: unknown }).pending;
    if (Array.isArray(pending)) {
      if (pending.length > n) truncated = true;
      capped.drop = { ...(drop as Record<string, unknown>), pending: pending.slice(0, n) };
    }
  }
  return { ...(capped as T), sampled: n, truncated } as T & { sampled: number; truncated: boolean };
}

/** Read only the host's standard runs directory; callers cannot supply paths. */
export async function cmdFleetRunsRead(verb: Verb, args: string[], deps: Readers = readers, watchOptions: WatchOptions = {}): Promise<number> {
  const usage = `Usage: phm fleet ${verb} [--json] [--help]${verb === 'journal' ? ' [--rejections-only]' : ' [--lane <lane>]'} [--sample <1..${SAMPLE_MAX}>] [--watch] [--interval-ms <1000..60000>]${verb === 'runs' ? ' [--check-ready]' : ''}`;
  const seen = new Set<string>();
  let lane: string | undefined;
  let interval = 5000;
  let sample: number | undefined;
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
    } else if (flag === '--interval-ms' && !seen.has(flag) && /^\d+$/.test(args[i + 1] ?? '') && Number(args[i + 1]) >= 1000 && Number(args[i + 1]) <= 60000) {
      interval = Number(args[++i]);
    } else if (flag === '--sample' && !seen.has(flag)) {
      const raw = args[++i] ?? '';
      if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > SAMPLE_MAX) {
        process.stderr.write(`error: --sample requires an integer in 1..${SAMPLE_MAX}\n${usage}\n`);
        return 2;
      }
      sample = Number(raw);
    } else if (!['--json', '--help'].includes(flag) || seen.has(flag)) {
      process.stderr.write(`error: invalid fleet ${verb} arguments\n${usage}\n`);
      return 2;
    }
    seen.add(flag);
  }
  if ((seen.has('--interval-ms') && !seen.has('--watch')) ||
      (seen.has('--check-ready') && (!seen.has('--json') || seen.has('--watch') || seen.has('--lane') || seen.has('--sample')))) {
    process.stderr.write(`error: invalid fleet ${verb} arguments\n${usage}\n`);
    return 2;
  }
  if (seen.has('--help')) {
    console.log(`${usage}${verb === 'journal' ? '\n--rejections-only shows reject and rejected ingest rows; source health and rejectedLastHour remain global. Passes and ingested rows are omitted.' : '\n--lane filters lane-attributed rows; totals and source health remain global. Rows without lane attribution are omitted.'}\n--watch samples immediately, then every 5000ms by default; --json emits JSONL. Read errors are reported and retried.\n--sample caps each emitted row collection to the newest n rows (newest first) and reports sampled and truncated.${verb === 'runs' ? '\n--check-ready requires --json and cannot be combined with --watch, --lane or --sample. It reports one snapshot of directory presence, source health, pause state, reasons and observed unheld lane IDs below target; unknown values remain null. Exit 0 requires healthy sources, an unpaused host and eligible capacity; otherwise exit 1. This is evidence for the leader, not dispatch or authority.' : ''}`);
    return 0;
  }
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
  const emit = <T extends object>(value: T, format: (state: T) => string, notice = ''): void => {
    const emitted: T & { sampled?: number; truncated?: boolean } = sample === undefined ? value : boundSample(value, verb, sample);
    const bound = emitted.sampled === undefined ? ''
      : `Sample: newest ${emitted.sampled} rows per collection${emitted.truncated ? ' (truncated)' : ''}\n`;
    console.log(seen.has('--json') ? JSON.stringify(emitted) : `${notice}${bound}${format(emitted)}`);
  };
  const readOnce = async (signal?: AbortSignal): Promise<void> => {
    // Each reader returns its existing bounded, scrubbed and versioned projection.
    if (verb === 'runs') {
      const state = await deps.runs();
      if (signal?.aborted) return;
      if (lane === undefined) emit(state, formatRuns);
      else {
        const filtered = { ...state, lanes: state.lanes.filter(row => row.lane === lane),
          claimed: state.claimed.filter(row => row.lane === lane),
          publishesLastHour: state.publishesLastHour.filter(row => row.lane === lane),
          events: [], drop: { ...state.drop, pending: state.drop.pending.filter(row => row.lane === lane) },
          laneFilter: { lane: sanitizePublicJson(lane), global: ['sources', 'sourceState', 'drop.done', 'other non-row fields', 'switches'], omitted: ['events'] } };
        emit(filtered, formatRuns, `Lane filter: ${filtered.laneFilter.lane}; source health and other non-row values are global; unattributed events omitted\n`);
      }
    } else if (verb === 'journal') {
      const state = await deps.journal();
      if (signal?.aborted) return;
      if (!seen.has('--rejections-only')) emit(state, formatJournal);
      else {
        const filtered = { ...state, passes: [], ingest: state.ingest.filter(row => /^reject(?:ed)?$/i.test(row.verb)), ingested: [],
          rejectionsFilter: { global: ['sources', 'rejectedLastHour'], omitted: ['passes', 'ingested'] } };
        emit(filtered, formatJournal, 'Rejections only; source health and rejected last hour are global; passes and ingested rows omitted\n');
      }
    } else {
      // Match the desktop queue endpoint's additional public-output scrub.
      const state = sanitizePublicJson(await deps.parked()) as FleetQueueV1;
      if (signal?.aborted) return;
      if (lane === undefined) emit(state, formatParked);
      else {
        const filtered = { ...state, byLane: state.byLane.filter(row => row.lane === lane),
          groups: state.groups.filter(row => row.lane === lane), skips: [],
          laneFilter: { lane: sanitizePublicJson(lane), global: ['sources', 'total', 'ready', 'parked', 'malformed', 'skipsLast24h'], omitted: ['skips'] } };
        emit(filtered, formatParked, `Lane filter: ${filtered.laneFilter.lane}; totals and source health are global; unattributed skips omitted\n`);
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
