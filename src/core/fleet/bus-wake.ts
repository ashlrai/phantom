/**
 * RQ-BUS-1B: post-send bridge into RQ-EVENTD. The host supplies its enqueue
 * callback; this module starts no daemon, dispatches no work and grants no authority.
 */
import {
  appendBusHop, busMessageIds, createBusHop,
  type BusMessageIds, type BusTokenCounts,
} from './bus-hoplog.js';

/** The RQ-EVENTD host must deduplicate by message id and reevaluate normal admission. */
export interface BusWakeRequest extends BusMessageIds { readonly kind: 'bus.send' }
export interface BusWakeOptions {
  /** Resolve only after RQ-EVENTD accepts the wake; reject on refusal. */
  enqueue: (request: Readonly<BusWakeRequest>, signal: AbortSignal) => void | Promise<void>;
  hoplogFile?: string;
  /** Bounds the observational tail, not the transport. Default 1000ms. */
  wakeTimeoutMs?: number;
}
export interface BusWakeResult {
  hoplog: 'recorded' | 'failed' | 'invalid-metadata';
  wake: 'queued' | 'failed' | 'timed-out' | 'invalid-metadata';
}

/**
 * Call ONLY after durable send acceptance. Each accepted hop is logged, including
 * retries; event deduplication and durable recovery belong to RQ-EVENTD/transport.
 * An unavailable log must not suppress a wake, nor a failed wake erase a hop.
 */
export function createBusWakeHook(options: BusWakeOptions):
  (message: BusMessageIds, counts?: BusTokenCounts) => Promise<BusWakeResult> {
  const timeoutMs = options.wakeTimeoutMs ?? 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('Bus wake timeout must be an integer from 1 to 60000 milliseconds.');
  }
  const { enqueue, hoplogFile } = options;
  if (typeof enqueue !== 'function') throw new Error('Bus wake requires an RQ-EVENTD enqueue callback.');
  return async (message, counts = {}) => {
    const ids = busMessageIds(message);
    if (!ids) return { hoplog: 'invalid-metadata', wake: 'invalid-metadata' };
    const hop = createBusHop(ids, counts);
    const hoplog = !hop ? 'invalid-metadata' : appendBusHop(hop, hoplogFile) ? 'recorded' : 'failed';
    // Build a fresh allowlisted event; never hand the envelope to the daemon.
    const request = Object.freeze({ kind: 'bus.send' as const, ...ids });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timed-out'>(resolve => {
      timer = setTimeout(() => { resolve('timed-out'); controller.abort(); }, timeoutMs);
    });
    try {
      const accepted = Promise.resolve().then(() => enqueue(request, controller.signal))
        .then(() => 'queued' as const, () => 'failed' as const);
      return { hoplog, wake: await Promise.race([accepted, deadline]) };
    } finally { clearTimeout(timer); }
  };
}

export type BusSendResult =
  | { sent: false; reason: 'invalid-metadata' | 'send-failed' }
  | ({ sent: true } & BusWakeResult);

/**
 * Transport adapter for bus send. The transport owns envelope validation, TTL,
 * delivery and token measurement, preserving supplied IDs. Post-send failures return sent:true so callers
 * retry the wake rather than duplicate a delivered message. Never expose errors.
 */
export async function sendWithBusWake<Message extends BusMessageIds>(
  message: Message,
  options: BusWakeOptions & { send: (message: Message) => void | BusTokenCounts | Promise<void | BusTokenCounts> },
): Promise<BusSendResult> {
  // Check configuration and snapshot routing labels before any transport mutation.
  const hook = createBusWakeHook(options);
  const ids = busMessageIds(message);
  if (!ids) return { sent: false, reason: 'invalid-metadata' };
  let counts: void | BusTokenCounts;
  try { counts = await options.send(message); }
  catch { return { sent: false, reason: 'send-failed' }; }
  return { sent: true, ...await hook(ids, counts ?? {}) };
}
