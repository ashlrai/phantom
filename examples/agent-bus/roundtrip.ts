/** A local, fake-worker recipe. The embedding host owns identity and progress. */
import { isAbsolute } from 'node:path';
import type { BusJsonValue } from '../../src/core/fleet/bus-envelope.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxPage, type BusInboxPost } from '../../src/core/fleet/bus-inbox.js';

export const WORKER_A = 'fake-worker-a';
export const WORKER_B = 'fake-worker-b';
export type Worker = typeof WORKER_A | typeof WORKER_B;

// Requiring an absolute root prevents accidentally falling back to Phantom's real inbox.
function validRoot(root: string): boolean {
  return typeof root === 'string' && isAbsolute(root);
}

/** Supply the same ID and body on retries. TTL is in milliseconds. */
export function postRequest(root: string, id: string, body: BusJsonValue, ttl: number): BusInboxPost {
  if (!validRoot(root)) return { status: 'invalid' };
  return appendBusInbox({ id, from: WORKER_A, to: WORKER_B, priority: 'P2', ttl, body }, { root });
}

/** A fixed reply is data; it does not interpret the request body. */
export function postReply(root: string, id: string, inReplyTo: string, ttl: number): BusInboxPost {
  if (!validRoot(root)) return { status: 'invalid' };
  return appendBusInbox({
    id, from: WORKER_B, to: WORKER_A, priority: 'P2', ttl,
    body: { inReplyTo, result: 'fake acknowledgement' },
  }, { root });
}

/** Pass the host's last persisted cursor for this worker, initially zero. */
export function readForWorker(root: string, worker: Worker, nextCursor: number, limit = 50): BusInboxPage {
  if (!validRoot(root) || (worker !== WORKER_A && worker !== WORKER_B)) return { status: 'invalid' };
  const page = listBusInboxAfter(nextCursor, limit, { root });
  if (page.status !== 'ok') return page;
  return { ...page, messages: page.messages.filter(({ envelope }) => envelope.to === worker) };
}
