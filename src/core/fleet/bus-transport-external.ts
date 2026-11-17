/**
 * Adapter shape for external agent transports (hosted agent services, remote
 * bots, anything off this machine). A host supplies an {@link ExternalAgentClient}
 * that speaks the service's own API; this adapter turns it into a
 * {@link BusTransport} with boundary `external`.
 *
 * Off by default, independently of the router gate: without
 * `egress: { ownerApproved: true }` every operation refuses before the client
 * is touched, because polling, acking or probing a remote service contacts it
 * just as a send does. No concrete external client ships in this module.
 *
 * Everything the client returns is untrusted: inbound envelopes are revalidated
 * and invalid ones dropped, and client error text never reaches reports.
 */
import {
  checkTransportEnvelope,
  type BusTransport, type TransportAckResult, type TransportEnvelope, type TransportHealth,
  type TransportHealthState, type TransportMessage, type TransportPollResult, type TransportSendResult,
} from './bus-transport.js';

/** Thrown by a client to say whether a failure is worth retrying. */
export class ExternalTransportError extends Error {
  constructor(readonly retryable: boolean, message = 'External transport failed.') { super(message); }
}

export interface ExternalAgentClient {
  send(envelope: TransportEnvelope, signal: AbortSignal): Promise<{ receipt: string; duplicate?: boolean }>;
  poll(since: string | undefined, signal: AbortSignal): Promise<{
    messages: { cursor: string; receivedAt: number; envelope: unknown }[];
    next: string;
  }>;
  ack(id: string, signal: AbortSignal): Promise<{ replayed?: boolean } | void>;
  health(signal: AbortSignal): Promise<TransportHealthState>;
}

export interface ExternalAgentTransportOptions {
  id: string;
  client: ExternalAgentClient;
  /** Absent means every operation refuses without contacting the service. */
  egress?: { ownerApproved: true };
  /** Per-call budget; default 10000 ms. */
  timeoutMs?: number;
  /** Max inbound envelopes kept per poll page; default 100. */
  maxPage?: number;
}

const NOT_APPROVED = 'External transport is off: owner approval is required.';
const MAX_RECEIPT_LENGTH = 256;

async function bounded<T>(timeoutMs: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      call(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ExternalTransportError(true, 'External transport timed out.'));
        }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

function failure(error: unknown): { ok: false; retryable: boolean; reason: string } {
  // Static reasons only: client error text may carry endpoints or credentials.
  if (error instanceof ExternalTransportError) {
    return { ok: false, retryable: error.retryable, reason: error.retryable ? 'External transport failed; retryable.' : 'External transport refused.' };
  }
  return { ok: false, retryable: true, reason: 'External transport failed; retryable.' };
}

export function createExternalAgentTransport(options: ExternalAgentTransportOptions): BusTransport {
  const { id, client } = options;
  const approved = options.egress?.ownerApproved === true;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxPage = options.maxPage ?? 100;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxPage) || maxPage < 1) {
    throw new TypeError('Invalid external transport options.');
  }

  async function send(input: TransportEnvelope): Promise<TransportSendResult> {
    if (!approved) return { ok: false, retryable: false, reason: NOT_APPROVED };
    const envelope = checkTransportEnvelope(input);
    if (!envelope) return { ok: false, retryable: false, reason: 'Invalid envelope.' };
    try {
      const result = await bounded(timeoutMs, signal => client.send(envelope, signal));
      if (!result || typeof result.receipt !== 'string' || result.receipt.length === 0) {
        return { ok: false, retryable: true, reason: 'External transport returned no receipt.' };
      }
      return { ok: true, receipt: result.receipt.slice(0, MAX_RECEIPT_LENGTH), duplicate: result.duplicate === true };
    } catch (error) { return failure(error); }
  }

  async function poll(since?: string): Promise<TransportPollResult> {
    if (!approved) return { ok: false, retryable: false, reason: NOT_APPROVED };
    try {
      const page = await bounded(timeoutMs, signal => client.poll(since, signal));
      if (!page || !Array.isArray(page.messages) || typeof page.next !== 'string') {
        return { ok: false, retryable: true, reason: 'External transport returned a malformed page.' };
      }
      const messages: TransportMessage[] = [];
      for (const row of page.messages.slice(0, maxPage)) {
        const envelope = checkTransportEnvelope(row?.envelope);
        if (!envelope || typeof row.cursor !== 'string' || !Number.isSafeInteger(row.receivedAt)) continue;
        messages.push({ cursor: row.cursor, receivedAt: row.receivedAt, envelope });
      }
      return { ok: true, messages, next: page.next };
    } catch (error) { return failure(error); }
  }

  async function ack(messageId: string): Promise<TransportAckResult> {
    if (!approved) return { ok: false, retryable: false, reason: NOT_APPROVED };
    try {
      const result = await bounded(timeoutMs, signal => client.ack(messageId, signal));
      return { ok: true, replayed: result?.replayed === true };
    } catch (error) { return failure(error); }
  }

  async function health(): Promise<TransportHealth> {
    if (!approved) return { state: 'down', detail: NOT_APPROVED };
    try {
      const state = await bounded(timeoutMs, signal => client.health(signal));
      return state === 'up' || state === 'degraded' ? { state } : { state: 'down' };
    } catch { return { state: 'down', detail: 'External transport health failed.' }; }
  }

  return { id, boundary: 'external', send, poll, ack, health };
}
