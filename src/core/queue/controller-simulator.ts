/**
 * Offline queue.v1 counterfactuals. No clock, filesystem, network or live scheduler.
 * The RQ-QUEUE event fields (jobId/kind/atMs) are retained, with station added.
 * A job may visit each station once, sequentially. Complete traces are required:
 * silently dropping censored jobs would bias W. Recorded service durations are
 * fixed workload demands, not predictions of how real workers will perform.
 */
export interface ControllerQueueEvent {
  jobId: string;
  station: string;
  kind: 'arrival' | 'start' | 'complete';
  atMs: number;
}

export interface QueueStation {
  station: string;
  slots: number;
  minSlots?: number;
}

export interface StationPressure extends QueueStation {
  running: number;
  waiting: number;
  /** Arrivals/second and completions/busy second, observed so far. */
  lambda: number;
  mu: number | null;
}

export interface CapacityDecision {
  slots: Record<string, number>;
  rho: Record<string, number | null>;
  planningThrottled: boolean;
  transfer: { from: string; to: string } | null;
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const count = (n: number) => Number.isSafeInteger(n) && n >= 0;
const finite = (n: number) => Number.isFinite(n) && n >= 0;

function validateStations(stations: readonly QueueStation[]): void {
  const names = new Set<string>();
  if (!stations.length) throw new Error('At least one queue station is required');
  for (const s of stations) {
    if (typeof s.station !== 'string' || !s.station.trim() || names.has(s.station) ||
      !count(s.slots) || s.slots < 1 || !count(s.minSlots ?? 1) ||
      (s.minSlots ?? 1) < 1 || (s.minSlots ?? 1) > s.slots) {
      throw new Error('Invalid queue station capacity');
    }
    names.add(s.station);
  }
  if (!Number.isSafeInteger(stations.reduce((sum, s) => sum + s.slots, 0))) {
    throw new Error('Invalid total queue capacity');
  }
}

/**
 * Move at most one idle slot to the highest-rho station with waiting work.
 * rho = lambda / (slots * mu); unknown service rates never imply zero load.
 * A transfer must strictly lower the pair's maximum rho, preventing ping-pong.
 * Preserve at least one slot per station and never preempt active service.
 * READY means waiting work at readyStation, excluding already running jobs.
 */
export function decideQueueCapacity(
  stations: readonly StationPressure[],
  readyStation: string,
): CapacityDecision {
  validateStations(stations);
  if (!stations.some(s => s.station === readyStation)) throw new Error('Unknown READY station');
  for (const s of stations) {
    if (!count(s.running) || s.running > s.slots || !count(s.waiting) || !finite(s.lambda) ||
      (s.mu !== null && (!Number.isFinite(s.mu) || s.mu <= 0))) {
      throw new Error('Invalid queue station pressure');
    }
  }
  const ordered = [...stations].sort((a, b) => compare(a.station, b.station));
  const utilization = (s: StationPressure, slots = s.slots) => {
    if (s.mu === null) return null;
    const rho = s.lambda / s.mu / slots;
    if (!Number.isFinite(rho)) throw new Error('Queue utilization exceeded finite range');
    return rho;
  };
  const rho = Object.fromEntries(ordered.map(s => [s.station, utilization(s)]));
  const slots = Object.fromEntries(ordered.map(s => [s.station, s.slots]));
  const targets = ordered.filter(s => s.waiting > 0 && rho[s.station] !== null)
    .sort((a, b) => rho[b.station]! - rho[a.station]! || compare(a.station, b.station));
  const target = targets[0];
  let transfer: CapacityDecision['transfer'] = null;
  if (target) {
    const donors = ordered.filter(s => s.station !== target.station &&
      s.slots > Math.max(s.minSlots ?? 1, s.running) && rho[s.station] !== null &&
      Math.max(utilization(s, s.slots - 1)!, utilization(target, target.slots + 1)!) < rho[target.station]!)
      .sort((a, b) => rho[a.station]! - rho[b.station]! || compare(a.station, b.station));
    const donor = donors[0];
    if (donor) {
      slots[donor.station]--;
      slots[target.station]++;
      transfer = { from: donor.station, to: target.station };
    }
  }
  const ready = ordered.find(s => s.station === readyStation)!;
  return { slots, rho, transfer, planningThrottled: ready.waiting > 2 * slots[readyStation] };
}

interface Visit {
  jobId: string;
  station: string;
  arrivedAt: number;
  startedAt: number;
  completedAt: number;
}

/** Validate an initially empty, complete recording; equal-time events keep log order. */
function visitsFromEvents(events: readonly ControllerQueueEvent[], stations: readonly QueueStation[]): Visit[][] {
  const known = new Set(stations.map(s => s.station));
  const paths = new Map<string, Visit[]>();
  const active = new Map<string, { station: string; arrivedAt: number; startedAt?: number }>();
  let previous = -Infinity;
  for (const event of events) {
    if (!event || !finite(event.atMs) || event.atMs < previous ||
      typeof event.jobId !== 'string' || !event.jobId.trim() || !known.has(event.station)) {
      throw new Error('Invalid or nonchronological queue event');
    }
    previous = event.atMs;
    const visit = active.get(event.jobId);
    switch (event.kind) {
      case 'arrival': {
        const path = paths.get(event.jobId) ?? [];
        if (visit || path.some(v => v.station === event.station)) throw new Error('Duplicate queue visit');
        paths.set(event.jobId, path);
        active.set(event.jobId, { station: event.station, arrivedAt: event.atMs });
        break;
      }
      case 'start':
        if (!visit || visit.station !== event.station || visit.startedAt !== undefined) {
          throw new Error('Invalid queue start');
        }
        visit.startedAt = event.atMs;
        break;
      case 'complete':
        if (!visit || visit.station !== event.station || visit.startedAt === undefined) {
          throw new Error('Invalid queue completion');
        }
        paths.get(event.jobId)!.push({ jobId: event.jobId, station: visit.station,
          arrivedAt: visit.arrivedAt, startedAt: visit.startedAt, completedAt: event.atMs });
        active.delete(event.jobId);
        break;
      default: throw new Error('Unknown queue event kind');
    }
  }
  if (active.size) throw new Error('Incomplete queue recording: every arrival needs a start and completion');
  return [...paths.values()].sort((a, b) => a[0].arrivedAt - b[0].arrivedAt || compare(a[0].jobId, b[0].jobId));
}

export interface QueueSimulationOptions {
  stations: readonly QueueStation[];
  planningStation: string;
  readyStation: string;
  controller?: boolean;
}

export interface QueueSimulationResult {
  schema: 'queue.controller-simulation.v1';
  jobs: number;
  completed: number;
  /** Mean first-arrival to final-completion seconds, including all throttle time. */
  W: number | null;
  /** Mean sum of station queue waits per job, in seconds; excludes service and handoffs. */
  wait: number | null;
  WIP: number;
  makespanMs: number;
  stations: { station: string; slots: number; completed: number; W: number | null }[];
  events: ControllerQueueEvent[];
  decisions: (CapacityDecision & { atMs: number })[];
}

/**
 * FCFS discrete-event replay, draining the SAME complete cohort in both modes.
 * Preserve external arrivals, station routes, service times and handoff delays;
 * replace recorded queue waits with simulated waits. Each event batch processes
 * completions/arrivals before control and dispatch (lexical job-ID ties).
 * Zero-duration service creates another batch at the same timestamp.
 * rho uses only arrivals and completed service observed in this simulation;
 * until a station has a positive service sample its capacity stays unchanged.
 * Different pools must be simulated separately: slots here are interchangeable.
 */
export function simulateQueueController(
  events: readonly ControllerQueueEvent[],
  options: QueueSimulationOptions,
): QueueSimulationResult {
  validateStations(options.stations);
  if (options.planningStation === options.readyStation ||
    !options.stations.some(s => s.station === options.planningStation) ||
    !options.stations.some(s => s.station === options.readyStation)) {
    throw new Error('Planning and READY must name distinct configured stations');
  }
  const paths = visitsFromEvents(events, options.stations);
  type Pending = { path: Visit[]; index: number; atMs: number };
  type Running = Pending & { startedAt: number; endMs: number };
  const pending: Pending[] = paths.map(path => ({ path, index: 0, atMs: path[0].arrivedAt }));
  const states = [...options.stations].sort((a, b) => compare(a.station, b.station)).map(s => ({
    ...s, waiting: [] as Pending[], running: [] as Running[], arrivals: 0, completed: 0,
    busyMs: 0, residenceMs: 0,
  }));
  const byStation = new Map(states.map(s => [s.station, s]));
  const resultEvents: ControllerQueueEvent[] = [];
  const decisions: QueueSimulationResult['decisions'] = [];
  const startMs = pending[0]?.atMs ?? 0;
  let now = startMs;
  let completed = 0;
  let residenceMs = 0;
  let waitMs = 0;
  const emit = (p: Pending, kind: ControllerQueueEvent['kind']) => {
    resultEvents.push({ jobId: p.path[p.index].jobId, station: p.path[p.index].station, kind, atMs: now });
  };
  while (pending.length || states.some(s => s.waiting.length || s.running.length)) {
    // Avoid Math.min(...events): recorded traces can exceed JS argument limits.
    let next = Infinity;
    for (const p of pending) next = Math.min(next, p.atMs);
    for (const s of states) for (const r of s.running) next = Math.min(next, r.endMs);
    if (!Number.isFinite(next)) throw new Error('Queue simulation stalled or exceeded finite time');
    now = next;
    for (const s of states) {
      const done = s.running.filter(r => r.endMs === now);
      s.running = s.running.filter(r => r.endMs !== now);
      for (const r of done) {
        emit(r, 'complete');
        s.completed++;
        s.busyMs += now - r.startedAt;
        s.residenceMs += now - r.atMs;
        const nextVisit = r.path[r.index + 1];
        if (nextVisit) {
          const handoffMs = nextVisit.arrivedAt - r.path[r.index].completedAt;
          pending.push({ path: r.path, index: r.index + 1, atMs: now + handoffMs });
        } else {
          completed++;
          residenceMs += now - r.path[0].arrivedAt;
        }
      }
    }
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      if (p.atMs !== now) continue;
      const s = byStation.get(p.path[p.index].station)!;
      s.arrivals++;
      s.waiting.push(p);
      emit(p, 'arrival');
      pending.splice(i, 1);
    }
    const elapsedMs = now - startMs;
    const pressure: StationPressure[] = states.map(s => ({
      station: s.station, slots: s.slots, minSlots: s.minSlots,
      running: s.running.length, waiting: s.waiting.length,
      lambda: elapsedMs > 0 ? s.arrivals * 1000 / elapsedMs : 0,
      mu: s.busyMs > 0 ? s.completed * 1000 / s.busyMs : null,
    }));
    const decision = decideQueueCapacity(pressure, options.readyStation);
    if (options.controller !== false) {
      for (const s of states) s.slots = decision.slots[s.station];
      decisions.push({ atMs: now, ...decision });
    }
    for (const s of states) {
      if (options.controller !== false && decision.planningThrottled && s.station === options.planningStation) continue;
      s.waiting.sort((a, b) => a.atMs - b.atMs || compare(a.path[0].jobId, b.path[0].jobId));
      while (s.waiting.length && s.running.length < s.slots) {
        const p = s.waiting.shift()!;
        const visit = p.path[p.index];
        const endMs = now + (visit.completedAt - visit.startedAt);
        if (!Number.isFinite(endMs) || endMs < now) throw new Error('Queue simulation exceeded finite time');
        s.running.push({ ...p, startedAt: now, endMs });
        waitMs += now - p.atMs;
        emit(p, 'start');
      }
    }
  }
  if (![residenceMs, waitMs, ...states.flatMap(s => [s.busyMs, s.residenceMs])].every(Number.isFinite)) {
    throw new Error('Queue measurements exceeded finite range');
  }
  return {
    schema: 'queue.controller-simulation.v1', jobs: paths.length, completed, WIP: paths.length - completed,
    W: completed ? residenceMs / completed / 1000 : null,
    wait: completed ? waitMs / completed / 1000 : null, makespanMs: now - startMs,
    stations: states.map(s => ({ station: s.station, slots: s.slots, completed: s.completed,
      W: s.completed ? s.residenceMs / s.completed / 1000 : null })),
    events: resultEvents, decisions,
  };
}

/** A positive reduction is evidence for this workload only, not a universal guarantee. */
export function evaluateQueueController(events: readonly ControllerQueueEvent[], options: QueueSimulationOptions) {
  const baseline = simulateQueueController(events, { ...options, controller: false });
  const controlled = simulateQueueController(events, { ...options, controller: true });
  return { baseline, controlled, reductionSeconds: baseline.W === null || controlled.W === null
    ? null : baseline.W - controlled.W };
}
