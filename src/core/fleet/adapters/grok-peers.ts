import { execFile } from 'node:child_process';

/** Locus owns identity and delivery. The adapter never reads Grok files. */
export interface LocusPeersEndpoint {
  request(operation: 'register' | 'inbox' | 'unregister', sessionId: string): Promise<unknown>;
}

export interface UntrustedPeerInbox {
  readonly source: 'locus-peers';
  readonly trust: 'untrusted';
  readonly sessionId: string;
  /** JSON data only. Never append this to system instructions or execute it. */
  readonly data: string;
}

const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const MAX_INBOX_BYTES = 64 * 1024;

function validateSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) throw new Error('Invalid Grok peers session ID');
}

/**
 * CLI transport for the Locus peers contract: peers <operation>
 * --session-id <id> --client grok --json. No shell, token, or auth-file access.
 * Supply an endpoint when the installed Locus uses a different wire contract.
 */
export function createLocusPeersCliEndpoint(binary = 'locus'): LocusPeersEndpoint {
  return {
    request(operation, sessionId) {
      validateSessionId(sessionId);
      return new Promise((resolve, reject) => {
        execFile(binary, ['peers', operation, '--session-id', sessionId, '--client', 'grok', '--json'], {
          encoding: 'utf8', timeout: 10_000, maxBuffer: MAX_INBOX_BYTES,
        }, (error, stdout) => {
          // Child output and errors can contain private data. Do not echo them.
          if (error) return reject(new Error(`Locus peers ${operation} failed`));
          try { resolve(JSON.parse(stdout) as unknown); }
          catch { reject(new Error(`Locus peers ${operation} returned invalid JSON`)); }
        });
      });
    },
  };
}

function requireSuccess(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      !('ok' in value) || value.ok !== true) {
    throw new Error('Locus peers refused the session operation');
  }
}

/**
 * Register one caller-supplied Grok CLI session, relay one inbox snapshot as
 * explicitly untrusted data, then run the caller's CLI action. Always unregister
 * after successful registration, including when delivery or the CLI action fails.
 * No timers or background polling survive the action. Call relayInbox again from
 * the action at safe turn boundaries for long-lived sessions.
 */
export async function withGrokPeersSession<T>(options: {
  sessionId: string;
  endpoint?: LocusPeersEndpoint;
  relay: (inbox: UntrustedPeerInbox) => Promise<void>;
  run: (relayInbox: () => Promise<void>) => Promise<T>;
}): Promise<T> {
  validateSessionId(options.sessionId);
  const endpoint = options.endpoint ?? createLocusPeersCliEndpoint();
  const sessionId = options.sessionId;
  requireSuccess(await endpoint.request('register', sessionId));
  let active = true;
  const relayInbox = async (): Promise<void> => {
    if (!active) throw new Error('Grok peers session is closed');
    const response = await endpoint.request('inbox', sessionId);
    if (!active) throw new Error('Grok peers session is closed');
    requireSuccess(response);
    if (!('messages' in (response as object)) ||
        !Array.isArray((response as { messages?: unknown }).messages)) {
      throw new Error('Invalid Locus peers inbox');
    }
    const data = JSON.stringify((response as { messages: unknown[] }).messages);
    if (Buffer.byteLength(data) > MAX_INBOX_BYTES) throw new Error('Locus peers inbox exceeds limit');
    await options.relay(Object.freeze({ source: 'locus-peers', trust: 'untrusted', sessionId, data }));
  };
  let failed = false;
  const unregister = async (): Promise<void> => {
    try { requireSuccess(await endpoint.request('unregister', sessionId)); }
    catch {
      if (!failed) throw new Error('Locus peers session cleanup failed');
    }
  };
  try {
    await relayInbox();
    return await options.run(relayInbox);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    active = false;
    await unregister();
  }
}
