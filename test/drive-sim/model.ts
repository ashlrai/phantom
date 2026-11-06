/**
 * drive-sim model: stub contracts for the queue the drive loop consumes.
 *
 * queue.v1 stub
 * -------------
 * `jobs.jsonl` is the queue.v1 stub: one JSON record per line, in the order
 * the router journal records them. Two kinds exist:
 *
 *   {"v":1,"kind":"enqueue","at":"...","id":"RQ-...","pool":"devin",...}
 *   {"v":1,"kind":"cancel","at":"...","id":"RQ-..."}
 *
 * `kind` may be omitted on enqueue lines; anything else is a cancel.
 *
 * `status.json` is the day's operating picture the driver reads once: lane
 * specs (floor, ceiling, pace target) and the memguard pause/resume timeline
 * it must respect. A real deployment reloads status; the fixture freezes one
 * day so replays are deterministic.
 *
 * Nothing here imports production code. When DRIVER-2/3/5 land, the real
 * modules can be replayed through this harness by adapting their inputs into
 * these records; until then the stub is the contract the sim tests pin down.
 */

export type LaneId = string;

export type Priority = 'P0' | 'P1' | 'P2';

/** One queued unit of work, as the router wrote it. */
export interface QueueV1Enqueue {
  v: 1;
  kind?: 'enqueue';
  /** ISO time the record was journaled. */
  at: string;
  id: string;
  repo?: string;
  /** Lane the router assigned; the preferred dispatch target. */
  pool: LaneId;
  /** Extra lanes this job may spill onto when its pool cannot serve it. */
  allowLanes?: LaneId[];
  tier?: string;
  /** Defaults to P1 when absent. */
  priority?: Priority;
  /** Recorded minutes the lane spent on this job once it started. */
  serviceMin: number;
}

export interface QueueV1Cancel {
  v: 1;
  kind: 'cancel';
  at: string;
  id: string;
}

export type QueueV1Record = QueueV1Enqueue | QueueV1Cancel;

export interface LaneSpec {
  id: LaneId;
  /**
   * Guaranteed concurrent slots the driver should try to keep busy on this
   * lane. Running below floor while work waits for the lane is a deficit.
   */
  floor: number;
  /** Hard cap on concurrent jobs. Dispatch above the ceiling is rejected. */
  ceiling: number;
  /** Target completions per hour. The pacing signal a policy burns down to. */
  pacePerHour: number;
}

export interface MemguardOp {
  at: string;
  op: 'PAUSE' | 'RESUME';
  /** Lane ids this op applies to. */
  lanes: LaneId[];
  reason?: string;
}

/** The frozen day a replay runs against. */
export interface DriveStatusDoc {
  v: 1;
  day: string;
  startAt: string;
  endAt: string;
  /** Driver tick period in seconds; decide() runs once per tick. */
  tickSec: number;
  /** Queue wait longer than this counts as starvation. */
  starveAfterMin: number;
  lanes: LaneSpec[];
  memguard: MemguardOp[];
}

export interface SimInput {
  jobs: QueueV1Record[];
  status: DriveStatusDoc;
}

function fail(file: string, line: number, why: string): never {
  throw new Error(`${file}:${line}: ${why}`);
}

const ISO_MS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

function isoMs(file: string, line: number, at: unknown): number {
  if (typeof at !== 'string' || !ISO_MS.test(at)) fail(file, line, `bad timestamp ${JSON.stringify(at)}`);
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) fail(file, line, `unparseable timestamp ${JSON.stringify(at)}`);
  return ms;
}

function isLaneId(v: unknown): v is LaneId {
  return typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(v);
}

const PRIORITIES: readonly Priority[] = ['P0', 'P1', 'P2'];

/**
 * Parse the queue.v1 stub log. Malformed lines throw: a broken fixture should
 * fail the suite loudly, never silently replay fewer jobs than were written.
 */
export function parseJobsJsonl(text: string, file = 'jobs.jsonl'): QueueV1Record[] {
  const out: QueueV1Record[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === '' || raw.startsWith('#')) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(raw);
    } catch {
      fail(file, i + 1, 'not JSON');
    }
    if (rec!.v !== 1) fail(file, i + 1, `unsupported v ${JSON.stringify(rec!.v)}`);
    isoMs(file, i + 1, rec!.at);
    if (rec!.kind === 'cancel') {
      if (typeof rec!.id !== 'string' || rec!.id === '') fail(file, i + 1, 'cancel needs an id');
      out.push(rec as unknown as QueueV1Cancel);
      continue;
    }
    if (rec!.kind !== undefined && rec!.kind !== 'enqueue') {
      fail(file, i + 1, `unknown kind ${JSON.stringify(rec!.kind)}`);
    }
    const id = rec!.id;
    if (typeof id !== 'string' || id === '') fail(file, i + 1, 'enqueue needs an id');
    if (seen.has(id)) fail(file, i + 1, `duplicate id ${id}`);
    seen.add(id);
    if (!isLaneId(rec!.pool)) fail(file, i + 1, `bad pool ${JSON.stringify(rec!.pool)}`);
    if (rec!.allowLanes !== undefined) {
      if (!Array.isArray(rec!.allowLanes) || rec!.allowLanes.some((l) => !isLaneId(l))) {
        fail(file, i + 1, `bad allowLanes ${JSON.stringify(rec!.allowLanes)}`);
      }
      if ((rec!.allowLanes as LaneId[]).includes(rec!.pool as LaneId)) {
        fail(file, i + 1, `allowLanes already contains pool ${JSON.stringify(rec!.pool)}`);
      }
    }
    if (rec!.priority !== undefined && !PRIORITIES.includes(rec!.priority as Priority)) {
      fail(file, i + 1, `bad priority ${JSON.stringify(rec!.priority)}`);
    }
    const serviceMin = rec!.serviceMin;
    if (typeof serviceMin !== 'number' || !Number.isFinite(serviceMin) || serviceMin <= 0) {
      fail(file, i + 1, `bad serviceMin ${JSON.stringify(serviceMin)}`);
    }
    out.push(rec as unknown as QueueV1Enqueue);
  }
  return out;
}

function laneSpec(file: string, line: number, rec: unknown): LaneSpec {
  const r = rec as Partial<LaneSpec> | null;
  if (r === null || typeof r !== 'object') fail(file, line, 'lane must be an object');
  if (!isLaneId(r.id)) fail(file, line, `bad lane id ${JSON.stringify(r.id)}`);
  for (const k of ['floor', 'ceiling'] as const) {
    const v = r[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) fail(file, line, `lane ${r.id}: bad ${k}`);
  }
  if ((r.ceiling as number) < (r.floor as number)) fail(file, line, `lane ${r.id}: floor above ceiling`);
  const pace = r.pacePerHour;
  if (typeof pace !== 'number' || !Number.isFinite(pace) || pace < 0) fail(file, line, `lane ${r.id}: bad pacePerHour`);
  return r as LaneSpec;
}

/** Parse status.json, the frozen lane picture for the replayed day. */
export function parseStatusJson(text: string, file = 'status.json'): DriveStatusDoc {
  let doc: DriveStatusDoc;
  try {
    doc = JSON.parse(text);
  } catch {
    fail(file, 1, 'not JSON');
  }
  const d = doc as unknown as Record<string, unknown>;
  if (d.v !== 1) fail(file, 1, `unsupported v ${JSON.stringify(d.v)}`);
  const startMs = isoMs(file, 1, d.startAt);
  const endMs = isoMs(file, 1, d.endAt);
  if (endMs <= startMs) fail(file, 1, 'endAt must be after startAt');
  if (typeof d.tickSec !== 'number' || !Number.isInteger(d.tickSec) || d.tickSec < 1) {
    fail(file, 1, `bad tickSec ${JSON.stringify(d.tickSec)}`);
  }
  if (typeof d.starveAfterMin !== 'number' || !Number.isFinite(d.starveAfterMin) || d.starveAfterMin <= 0) {
    fail(file, 1, `bad starveAfterMin ${JSON.stringify(d.starveAfterMin)}`);
  }
  if (!Array.isArray(d.lanes) || d.lanes.length === 0) fail(file, 1, 'lanes must be a non-empty array');
  const lanes = (d.lanes as unknown[]).map((l) => laneSpec(file, 1, l));
  const ids = new Set(lanes.map((l) => l.id));
  if (ids.size !== lanes.length) fail(file, 1, 'duplicate lane id');
  const memguard: MemguardOp[] = [];
  if (d.memguard !== undefined) {
    if (!Array.isArray(d.memguard)) fail(file, 1, 'memguard must be an array');
    for (const m of d.memguard as MemguardOp[]) {
      isoMs(file, 1, m.at);
      if (m.op !== 'PAUSE' && m.op !== 'RESUME') fail(file, 1, `bad memguard op ${JSON.stringify(m.op)}`);
      if (!Array.isArray(m.lanes) || m.lanes.some((l) => !isLaneId(l) || !ids.has(l))) {
        fail(file, 1, `bad memguard lanes ${JSON.stringify(m.lanes)}`);
      }
      memguard.push(m);
    }
  }
  return doc;
}

/** Parse both fixture files into one replay input. */
export function parseFixture(jobsJsonl: string, statusJson: string): SimInput {
  const jobs = parseJobsJsonl(jobsJsonl);
  const status = parseStatusJson(statusJson);
  const laneIds = new Set(status.lanes.map((l) => l.id));
  for (const [i, rec] of jobs.entries()) {
    if (rec.kind === 'cancel') continue;
    const enq = rec as QueueV1Enqueue;
    if (!laneIds.has(enq.pool)) fail('jobs.jsonl', i + 1, `job ${enq.id} names unknown pool ${enq.pool}`);
    for (const l of enq.allowLanes ?? []) {
      if (!laneIds.has(l)) fail('jobs.jsonl', i + 1, `job ${enq.id} allows unknown lane ${l}`);
    }
  }
  return { jobs, status };
}

/** Lanes a job may run on: its assigned pool first, then declared alternates. */
export function allowedLanes(job: Pick<QueueV1Enqueue, 'pool' | 'allowLanes'>): LaneId[] {
  return [job.pool, ...(job.allowLanes ?? [])];
}
