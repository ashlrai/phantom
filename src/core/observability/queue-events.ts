/** Metadata-only station observations. These events never grant queue authority. */
export const QUEUE_EVENT_NAME = 'queue.v1' as const;

export interface QueueEventV1 {
  job_id: string;
  /** A job can enter a station before its PR exists. */
  pr: number | null;
  station: string;
  pool: string;
  tier: string;
  enter_ts: string;
  /** Null identifies entry; an exit repeats the original entry timestamp. */
  exit_ts: string | null;
}

export type QueueStationIdentity = Pick<QueueEventV1, 'job_id' | 'pr' | 'station' | 'pool' | 'tier'>;
export type QueueAnalyticsCapture = (event: typeof QUEUE_EVENT_NAME, properties: QueueEventV1) => void | Promise<void>;
export interface QueueEventEmitResult { ok: boolean; detail: string }
export interface QueueStationExit { pr?: number | null; exit_ts?: string }
export interface QueueStationHandle {
  readonly enter: Readonly<QueueEventV1>;
  readonly enterResult: QueueEventEmitResult;
  /** One capture attempt per visit, including concurrent calls and delivery failures. */
  exit(options?: QueueStationExit): Promise<QueueEventEmitResult>;
}

const KEYS = ['job_id', 'pr', 'station', 'pool', 'tier', 'enter_ts', 'exit_ts'] as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_UTC.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Closed wire schema: reject extra fields rather than forwarding arbitrary task content. */
export function parseQueueEventV1(value: unknown): QueueEventV1 | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== KEYS.length
      || !KEYS.every((key) => Object.hasOwn(descriptors, key) && 'value' in descriptors[key])) return null;
    const fields = Object.fromEntries(KEYS.map((key) => [key, descriptors[key].value]));
    if (!['job_id', 'station', 'pool', 'tier'].every((key) => typeof fields[key] === 'string' && IDENTIFIER.test(fields[key]))) return null;
    if (fields.pr !== null && !(Number.isSafeInteger(fields.pr) && fields.pr > 0)) return null;
    if (!canonicalTimestamp(fields.enter_ts)
      || (fields.exit_ts !== null && (!canonicalTimestamp(fields.exit_ts) || fields.exit_ts < fields.enter_ts))) return null;
    return {
      job_id: fields.job_id, pr: fields.pr, station: fields.station, pool: fields.pool, tier: fields.tier,
      enter_ts: fields.enter_ts, exit_ts: fields.exit_ts,
    };
  } catch {
    return null;
  }
}

/** The caller supplies Phantom's existing analytics capture; no credentials or transport live here. */
export async function emitQueueEvent(capture: QueueAnalyticsCapture, value: unknown): Promise<QueueEventEmitResult> {
  const event = parseQueueEventV1(value);
  if (!event) return { ok: false, detail: 'invalid queue.v1 event' };
  try {
    await capture(QUEUE_EVENT_NAME, event);
    return { ok: true, detail: 'captured queue.v1 event' };
  } catch {
    // A capture error may contain provider credentials or response text.
    return { ok: false, detail: 'queue.v1 capture failed' };
  }
}

/** Begin one station visit. Reentry uses a new handle with its own original timestamp. */
export async function enterQueueStation(
  capture: QueueAnalyticsCapture,
  identity: QueueStationIdentity,
  clock: () => Date = () => new Date(),
): Promise<QueueStationHandle> {
  let entry: QueueEventV1 | null;
  try {
    entry = parseQueueEventV1({
      job_id: identity.job_id, pr: identity.pr, station: identity.station, pool: identity.pool, tier: identity.tier,
      enter_ts: clock().toISOString(), exit_ts: null,
    });
  } catch {
    entry = null;
  }
  if (!entry) throw new TypeError('Invalid queue station metadata.');
  const enter = Object.freeze(entry);
  const enterResult = await emitQueueEvent(capture, enter);
  let exitAttempt: Promise<QueueEventEmitResult> | undefined;
  return {
    enter,
    enterResult,
    exit(options = {}) {
      if (exitAttempt) return exitAttempt;
      let event: QueueEventV1 | null;
      try {
        const pr = options.pr === undefined ? enter.pr : options.pr;
        // A previously known PR cannot silently change identity at station exit.
        if (enter.pr !== null && pr !== enter.pr) return Promise.resolve({ ok: false, detail: 'invalid queue.v1 event' });
        event = parseQueueEventV1({ ...enter, pr, exit_ts: options.exit_ts ?? clock().toISOString() });
      } catch {
        event = null;
      }
      if (!event) return Promise.resolve({ ok: false, detail: 'invalid queue.v1 event' });
      const exitEvent = event;
      // Publish the attempt before calling user capture, which may synchronously reenter exit().
      exitAttempt = Promise.resolve().then(() => emitQueueEvent(capture, exitEvent));
      return exitAttempt;
    },
  };
}

/** Always pair a station visit, including thrown work; analytics failures never mask its result. */
export async function withQueueStation<T>(
  capture: QueueAnalyticsCapture,
  identity: QueueStationIdentity,
  work: (station: QueueStationHandle) => T | Promise<T>,
  clock?: () => Date,
): Promise<T> {
  const station = await enterQueueStation(capture, identity, clock);
  try {
    return await work(station);
  } finally {
    await station.exit();
  }
}
