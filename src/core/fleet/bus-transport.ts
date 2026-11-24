/**
 * Pluggable bus transports and the role router (docs/AGENT-BUS.md,
 * "Transports and routing").
 *
 * An agent addresses a role; the router picks a live transport for that role
 * by health and route priority, records a delivery receipt, retries with
 * exponential backoff and dead-letters after N attempts. The local file bus
 * (bus-transport-file.ts) and the external agent adapter shape
 * (bus-transport-external.ts) both implement {@link BusTransport}.
 *
 * Egress is off by default: a transport whose boundary is `external` (a human
 * or an outside service) is never selected unless the host passes the explicit
 * `egress: { ownerApproved: true }` flag. Routing labels are not identities and
 * bodies are untrusted data; nothing here authenticates, dispatches or grants
 * authority.
 */
import {
  BUS_PRIORITIES, BUS_PROTOCOL_KINDS, MAX_BUS_ADDRESS_LENGTH, validateBusEnvelope,
  type BusEnvelope, type BusJsonValue, type BusPriority, type BusProtocolKind,
} from './bus-envelope.js';
import { localWriteGate } from '../agents/send-gate.js';

/** Transport-level envelope. `kind` is a bus protocol v1 kind. */
export interface TransportEnvelope {
  /** Sender-assigned message identity; transports deduplicate on it. */
  id: string;
  from: string;
  /** A role or agent routing label. */
  to: string;
  kind: BusProtocolKind;
  /** P0 is highest. */
  priority: BusPriority;
  /** Opaque, untrusted JSON data. */
  body: BusJsonValue;
  /** Groups a request with its replies; a printable token. */
  correlationId: string;
  /** Positive remaining lifetime in milliseconds. */
  ttlMs: number;
}

export type TransportBoundary = 'local' | 'external';
export type TransportHealthState = 'up' | 'degraded' | 'down';
export interface TransportHealth { state: TransportHealthState; detail?: string }

/** `receipt` is the transport's own opaque acceptance reference. */
export type TransportSendResult =
  | { ok: true; receipt: string; duplicate: boolean }
  | { ok: false; retryable: boolean; reason: string };

export interface TransportMessage { cursor: string; receivedAt: number; envelope: TransportEnvelope }
export type TransportPollResult =
  | { ok: true; messages: TransportMessage[]; next: string }
  | { ok: false; retryable: boolean; reason: string };
export type TransportAckResult =
  | { ok: true; replayed: boolean }
  | { ok: false; retryable: boolean; reason: string };

/**
 * One way to move envelopes. `poll(since)` takes an opaque cursor from a prior
 * page (undefined for the start) and never returns acknowledged messages.
 * Persist `next` only after the page is handled and acked.
 */
export interface BusTransport {
  readonly id: string;
  readonly boundary: TransportBoundary;
  send(envelope: TransportEnvelope): Promise<TransportSendResult>;
  poll(since?: string): Promise<TransportPollResult>;
  ack(id: string): Promise<TransportAckResult>;
  health(): Promise<TransportHealth>;
}

// ---------------------------------------------------------------------------
// Envelope validation and the bus v1 wire mapping
// ---------------------------------------------------------------------------

const TOKEN = /^[\x21-\x7e]+(?![\s\S])/;
const BODY_KEYS = ['correlation_id', 'payload', 'protocol'];

export const TRANSPORT_DEFAULT_TTL_MS = 60 * 60 * 1000;

function token(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_BUS_ADDRESS_LENGTH && TOKEN.test(value);
}

/**
 * Bus v1 wire form: the six-field envelope with a protocol v1 body carrying the
 * kind, the correlation id and the opaque payload. Returns null when the result
 * is not a valid bus envelope (bad labels, non-JSON body, over 64 KiB).
 */
export function toBusEnvelope(envelope: TransportEnvelope): BusEnvelope | null {
  if (!envelope || typeof envelope !== 'object') return null;
  const { id, from, to, kind, priority, body, correlationId, ttlMs } = envelope;
  if (!token(correlationId) || !(BUS_PROTOCOL_KINDS as readonly unknown[]).includes(kind)) return null;
  const checked = validateBusEnvelope({
    id, from, to, priority, ttl: ttlMs,
    body: { protocol: { version: 1, kind }, correlation_id: correlationId, payload: body },
  });
  return checked.ok ? checked.value : null;
}

/** Inverse of {@link toBusEnvelope}; null for bus traffic not written by a transport. */
export function fromBusEnvelope(envelope: BusEnvelope): TransportEnvelope | null {
  const body = envelope.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body) ||
    Object.keys(body).sort().join() !== BODY_KEYS.join()) return null;
  const protocol = body.protocol;
  if (protocol === null || typeof protocol !== 'object' || Array.isArray(protocol) ||
    Object.keys(protocol).sort().join() !== 'kind,version' || protocol.version !== 1 ||
    !(BUS_PROTOCOL_KINDS as readonly unknown[]).includes(protocol.kind) || !token(body.correlation_id)) return null;
  return {
    id: envelope.id, from: envelope.from, to: envelope.to, kind: protocol.kind as BusProtocolKind,
    priority: envelope.priority, body: body.payload as BusJsonValue,
    correlationId: body.correlation_id, ttlMs: envelope.ttl,
  };
}

/** Detached, validated copy; null when the envelope cannot travel on the bus. */
export function checkTransportEnvelope(input: unknown): TransportEnvelope | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const candidate = input as TransportEnvelope;
  if (!BUS_PRIORITIES.includes(candidate.priority)) return null;
  const wire = toBusEnvelope(candidate);
  return wire ? fromBusEnvelope(wire) : null;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * A transport serving roles. A role is an exact routing label, `*` (any), or a
 * prefix ending in `*` (`agent:*`). Lower `priority` is preferred.
 */
export interface TransportRoute {
  transport: BusTransport;
  roles: readonly string[];
  priority: number;
}

export interface BusRouterBackoff { baseMs: number; factor: number; maxMs: number }

export interface BusRouterOptions {
  routes: readonly TransportRoute[];
  deadLetter: DeadLetterSink;
  /** Attempts before dead-lettering, 1 to 20. Default 5. */
  maxAttempts?: number;
  backoff?: Partial<BusRouterBackoff>;
  /** Per-call health probe budget. Default 2000 ms; a timeout counts as down. */
  healthTimeoutMs?: number;
  /**
   * Outbound to a human or external service. Absent means off: external
   * transports are never selected. Only an owner decision may set this.
   */
  egress?: { ownerApproved: true };
  /**
   * Hold check run before every delivery. Return a static reason to hold, or
   * null to proceed. Defaults to {@link localBusHold} (kill switch, comms pause).
   */
  hold?: () => string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DeliveryAttempt {
  attempt: number;
  transport: string | null;
  outcome: 'delivered' | 'retryable' | 'refused' | 'no-live-transport';
  reason?: string;
  at: number;
}

export interface CandidatePlan {
  /** Live candidates in selection order. */
  live: { transport: string; health: TransportHealthState; priority: number }[];
  /** Matching transports skipped and why. */
  skipped: { transport: string; reason: 'down' | 'egress-not-approved' | 'refused-earlier' }[];
}

export type DeadLetterReason = 'exhausted' | 'expired' | 'no-route';

export interface DeadLetter {
  envelope: TransportEnvelope;
  reason: DeadLetterReason;
  attempts: DeliveryAttempt[];
  deadLetteredAt: number;
}

export interface DeadLetterSink { put(entry: DeadLetter): Promise<{ ok: boolean }> }

export type DeliveryReport =
  | {
    status: 'delivered'; id: string; correlationId: string; transport: string;
    receipt: string; duplicate: boolean; deliveredAt: number; attempts: DeliveryAttempt[];
  }
  | {
    status: 'dead-lettered'; id: string; correlationId: string; reason: DeadLetterReason;
    /** False when the dead-letter sink itself failed; the caller still holds the envelope. */
    recorded: boolean; attempts: DeliveryAttempt[];
  }
  /** Nothing was sent or stored: owner approval missing, or a host hold is on. */
  | { status: 'held'; id: string; correlationId: string; reason: string }
  | { status: 'invalid'; reason: string };

export interface BusRouter {
  deliver(envelope: TransportEnvelope): Promise<DeliveryReport>;
  /** Health-ranked candidates for a role, without sending. */
  plan(role: string): Promise<CandidatePlan>;
}

export const BUS_ROUTER_DEFAULT_ATTEMPTS = 5;
export const BUS_ROUTER_DEFAULT_BACKOFF: BusRouterBackoff = Object.freeze({ baseMs: 500, factor: 2, maxMs: 30_000 });

/** Delay before the attempt after `attempt` (1-based): base * factor^(attempt-1), capped. */
export function backoffDelay(attempt: number, backoff: BusRouterBackoff = BUS_ROUTER_DEFAULT_BACKOFF): number {
  const raw = backoff.baseMs * backoff.factor ** Math.max(0, attempt - 1);
  return Math.min(backoff.maxMs, Number.isFinite(raw) ? raw : backoff.maxMs);
}

export function roleMatches(pattern: string, role: string): boolean {
  if (pattern === '*') return true;
  return pattern.endsWith('*') ? role.startsWith(pattern.slice(0, -1)) : pattern === role;
}

const HEALTH_RANK: Record<TransportHealthState, number> = { up: 0, degraded: 1, down: 2 };
const HEALTH_STATES = new Set<unknown>(Object.keys(HEALTH_RANK));

async function probe(transport: BusTransport, timeoutMs: number): Promise<TransportHealthState> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<TransportHealth>(resolve => {
      timer = setTimeout(() => resolve({ state: 'down', detail: 'timeout' }), timeoutMs);
    });
    const health = await Promise.race([transport.health(), timeout]);
    return HEALTH_STATES.has(health?.state) ? health.state : 'down';
  } catch { return 'down'; }
  finally { clearTimeout(timer); }
}

function checkedRoutes(routes: readonly TransportRoute[]): TransportRoute[] {
  const ids = new Set<string>();
  return routes.map(route => {
    const { transport, roles, priority } = route;
    if (!transport || !token(transport.id) || ids.has(transport.id) ||
      (transport.boundary !== 'local' && transport.boundary !== 'external') ||
      !Array.isArray(roles) || roles.length === 0 || roles.some(role => !token(role)) ||
      !Number.isSafeInteger(priority)) {
      throw new TypeError('Invalid transport route.');
    }
    ids.add(transport.id);
    return { transport, roles: [...roles], priority };
  });
}

export function createBusRouter(options: BusRouterOptions): BusRouter {
  const routes = checkedRoutes(options.routes);
  const maxAttempts = options.maxAttempts ?? BUS_ROUTER_DEFAULT_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new TypeError('maxAttempts must be an integer from 1 to 20.');
  }
  const backoff = { ...BUS_ROUTER_DEFAULT_BACKOFF, ...options.backoff };
  if (![backoff.baseMs, backoff.factor, backoff.maxMs].every(n => Number.isFinite(n) && n >= 0) || backoff.factor < 1) {
    throw new TypeError('Invalid backoff.');
  }
  const healthTimeoutMs = options.healthTimeoutMs ?? 2000;
  // Strict identity check: a truthy look-alike is not owner approval.
  const egressApproved = options.egress?.ownerApproved === true;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));

  const matching = (role: string) => routes.filter(route => route.roles.some(pattern => roleMatches(pattern, role)));

  async function rank(role: string, refused: ReadonlySet<string>): Promise<{ plan: CandidatePlan; order: TransportRoute[] }> {
    const plan: CandidatePlan = { live: [], skipped: [] };
    const allowed: TransportRoute[] = [];
    for (const route of matching(role)) {
      const id = route.transport.id;
      if (route.transport.boundary === 'external' && !egressApproved) plan.skipped.push({ transport: id, reason: 'egress-not-approved' });
      else if (refused.has(id)) plan.skipped.push({ transport: id, reason: 'refused-earlier' });
      else allowed.push(route);
    }
    const states = await Promise.all(allowed.map(route => probe(route.transport, healthTimeoutMs)));
    const live = allowed
      .map((route, index) => ({ route, state: states[index]!, index }))
      .filter(entry => {
        if (entry.state !== 'down') return true;
        plan.skipped.push({ transport: entry.route.transport.id, reason: 'down' });
        return false;
      })
      .sort((a, b) => HEALTH_RANK[a.state] - HEALTH_RANK[b.state] || a.route.priority - b.route.priority || a.index - b.index);
    plan.live = live.map(entry => ({ transport: entry.route.transport.id, health: entry.state, priority: entry.route.priority }));
    return { plan, order: live.map(entry => entry.route) };
  }

  async function deadLetter(envelope: TransportEnvelope, reason: DeadLetterReason, attempts: DeliveryAttempt[]): Promise<DeliveryReport> {
    let recorded = false;
    try { recorded = (await options.deadLetter.put({ envelope, reason, attempts, deadLetteredAt: now() })).ok === true; }
    catch { recorded = false; }
    return { status: 'dead-lettered', id: envelope.id, correlationId: envelope.correlationId, reason, recorded, attempts };
  }

  async function deliver(input: TransportEnvelope): Promise<DeliveryReport> {
    const envelope = checkTransportEnvelope(input);
    if (!envelope) return { status: 'invalid', reason: 'Envelope cannot travel on the bus.' };
    const { id, correlationId } = envelope;
    const held = (options.hold ?? localBusHold)();
    if (held) return { status: 'held', id, correlationId, reason: held };
    const candidates = matching(envelope.to);
    if (candidates.length === 0) return deadLetter(envelope, 'no-route', []);
    if (!egressApproved && candidates.every(route => route.transport.boundary === 'external')) {
      // Nothing local could carry it and egress is off: hold, never send or store.
      return { status: 'held', id, correlationId, reason: 'Outbound to an external transport needs owner approval.' };
    }
    const started = now();
    const attempts: DeliveryAttempt[] = [];
    const refused = new Set<string>();
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const elapsed = Math.max(0, now() - started);
      if (elapsed >= envelope.ttlMs) return deadLetter(envelope, 'expired', attempts);
      const { order } = await rank(envelope.to, refused);
      if (order.length === 0) {
        attempts.push({ attempt, transport: null, outcome: 'no-live-transport', at: now() });
        // Every candidate refused permanently: retrying cannot help.
        if (candidates.every(route => refused.has(route.transport.id) ||
          (route.transport.boundary === 'external' && !egressApproved))) break;
      }
      for (const route of order) {
        const transport = route.transport;
        let result: TransportSendResult;
        try {
          result = await transport.send({ ...envelope, ttlMs: envelope.ttlMs - elapsed });
        } catch {
          result = { ok: false, retryable: true, reason: 'Transport threw.' };
        }
        if (result?.ok === true) {
          const deliveredAt = now();
          attempts.push({ attempt, transport: transport.id, outcome: 'delivered', at: deliveredAt });
          return {
            status: 'delivered', id, correlationId, transport: transport.id,
            receipt: String(result.receipt), duplicate: result.duplicate === true, deliveredAt, attempts,
          };
        }
        const retryable = result?.ok === false && result.retryable === true;
        if (!retryable) refused.add(transport.id);
        attempts.push({
          attempt, transport: transport.id, outcome: retryable ? 'retryable' : 'refused',
          reason: typeof result?.reason === 'string' ? result.reason.slice(0, 200) : 'Transport failed.', at: now(),
        });
      }
      if (attempt < maxAttempts) await sleep(backoffDelay(attempt, backoff));
    }
    return deadLetter(envelope, Math.max(0, now() - started) >= envelope.ttlMs ? 'expired' : 'exhausted', attempts);
  }

  return {
    deliver,
    async plan(role) { return (await rank(role, new Set())).plan; },
  };
}

/** Kill switch and comms pause: the same gate every local bus write honours. */
export function localBusHold(): string | null {
  return localWriteGate()?.reason ?? null;
}

/** Non-durable sink for tests and dry runs. */
export function createMemoryDeadLetterSink(): DeadLetterSink & { entries: DeadLetter[] } {
  const entries: DeadLetter[] = [];
  return { entries, async put(entry) { entries.push(structuredClone(entry)); return { ok: true }; } };
}
