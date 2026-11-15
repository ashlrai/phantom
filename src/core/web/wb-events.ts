/**
 * core/web/wb-events.ts — `GET /api/wb/v1/events` (WB-8): the workbench
 * Server-Sent Events surface for the desktop native shell, sibling to the
 * read routes in wb-read-api.ts.
 *
 * EVENT FAMILY
 *
 *   wb.*        `event: wb.snapshot|wb.action|wb.gh` — the kinds declared by
 *               schema/workbench.v1/event.schema.json. `data:` is a
 *               workbench.event.v1 envelope ONLY ({schema, kind, ts, seq,
 *               repo?, audit?}): an invalidation signal, never a payload.
 *               The client re-reads the matching GET /api/wb/v1/* route.
 *               wb.snapshot / wb.gh are emitted when their read projections
 *               change (digest-compared each tick); wb.action has no poll
 *               source — in-process producers publish it through
 *               publishWbEvent() (the action route lands in a later WB job).
 *
 * SOURCES AND CADENCE
 *
 *   snapshot+budget  ~/.ashlr/routing/capacity.json + ~/.ashlr/budget.json
 *   gh               the shared single-flight wb gh cache (getCachedWbGhStatus)
 *
 * The tick is bounded (WB_EVENTS_POLL_MS) per connection and cleared on
 * disconnect, read-session expiry and server drain. NOTHING here polls
 * `~/.ashlr-runs` or any other Mac-dispatcher path. (The queue.v1 station
 * relay from the original WB-8 design is deferred: its journal producer,
 * RQ-QUEUE-2, has not landed, so there is nothing on disk to relay yet.)
 *
 * SECURITY
 *  - Same boundary as every /api/* GET (server.ts), plus the SSE convention:
 *    the route itself requires a minted read session (SESSION_REQUIRED), and
 *    read-session.ts admits `/api/wb/v1/events` to the `?client=` proof so a
 *    browser EventSource can connect.
 *  - Every emitted byte passes through sanitizePublicJson — secret-shaped
 *    strings become [REDACTED], this user's home paths become `~`.
 *  - Shares the /api/events connection cap (registerSse / deregisterSse).
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AshlrConfig } from '../types.js';
import { sanitizePublicJson } from '../util/public-json.js';
import { loadBudgetPolicy } from '../routing/budget-store.js';
import { listEnrolled } from '../sandbox/policy.js';
import { readVerseGithubSnapshotAsync } from '../verse/github-repo.js';
import { getCachedWbGhStatus } from './fleet-status-cache.js';
import { registerSse, deregisterSse, sseConnectionCapReached } from './api.js';
import { sendJson } from './read-session.js';
import { readWbSnapshot } from './wb-read-api.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const WB_EVENTS_PATH = '/api/wb/v1/events';
export const WB_EVENTS_POLL_MS = 2_000;
export const WB_EVENTS_KEEPALIVE_MS = 15_000;
/** Queued-but-unsent bytes past which a stalled wb stream is closed. */
export const WB_EVENTS_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// wb.* event kinds (schema/workbench.v1/event.schema.json)
// ---------------------------------------------------------------------------

export const WB_EVENT_KINDS = ['wb.snapshot', 'wb.action', 'wb.gh'] as const;
export type WbEventKind = (typeof WB_EVENT_KINDS)[number];

/** event.schema.json `repo` — ashlrai-org only, lowercase. */
const WB_EVENT_REPO_RE = /^ashlrai\/[a-z0-9][a-z0-9-]{0,60}$/;

/** Fields a producer may attach to a wb.* envelope (repo/audit per the schema). */
export interface WbEventFields {
  repo?: string;
  audit?: unknown;
}

type WbPushListener = (kind: WbEventKind, fields: WbEventFields) => void;
const wbPushListeners = new Set<WbPushListener>();

/**
 * Publish a wb.* event to every open /api/wb/v1/events stream. In-process
 * producers only — the poll-derived kinds (wb.snapshot, wb.gh) do not need
 * this; wb.action arrives here when the action route lands. Fields are
 * attached to the workbench.event.v1 envelope and scrubbed at send time.
 */
export function publishWbEvent(kind: WbEventKind, fields: WbEventFields = {}): void {
  for (const listener of [...wbPushListeners]) {
    try {
      listener(kind, fields);
    } catch {
      // One broken stream must not starve the rest.
    }
  }
}

// ---------------------------------------------------------------------------
// Digests — change detection for the poll-derived kinds
// ---------------------------------------------------------------------------

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The snapshot+budget digest input: exactly what GET /api/wb/v1/snapshot and
 * /budget project, minus volatile ageMs. Any seat, freshness-state, policy
 * or gh-adjacent change flips the digest and emits one wb.snapshot frame.
 */
function snapshotDigestInput(): unknown {
  const reading = readWbSnapshot();
  const policy = loadBudgetPolicy();
  return {
    state: reading.state,
    reason: reading.reason,
    publishedAt: reading.publishedAt,
    seats: reading.seats,
    policy: {
      mode: policy.mode,
      updatedAt: policy.updatedAt,
      seats: Object.keys(policy.seats).sort(),
    },
  };
}

async function ghDigestInput(
  cfg: AshlrConfig,
  deps: WbEventsDeps,
): Promise<unknown> {
  if (deps.ghStatus) return deps.ghStatus(cfg);
  const { value } = await getCachedWbGhStatus(cfg, () =>
    readVerseGithubSnapshotAsync(deps.paths?.() ?? listEnrolled(), deps.gh ? { gh: deps.gh } : {}));
  // Digest the payload only: stale/ageMs/backoff are freshness metadata that
  // flips on a timer without the data changing — they must not emit events.
  return value;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface WbEventsDeps {
  /** Test seam: poll cadence (default WB_EVENTS_POLL_MS). */
  pollMs?: number;
  /** Test seam: keepalive cadence (default WB_EVENTS_KEEPALIVE_MS). */
  keepaliveMs?: number;
  /** Test seam: replaces the cached gh read entirely. */
  ghStatus?: (cfg: AshlrConfig) => Promise<unknown>;
  /** Test seam: replaces the snapshot+budget digest input. */
  snapshotState?: () => unknown;
  /** Test seam: enrolled repo paths for the default gh read (mirrors WbGhDeps). */
  paths?: () => string[];
  /** Test seam: gh subprocess runner for the default gh read (mirrors WbGhDeps). */
  gh?: import('../verse/github-repo.js').VerseGithubReadOptions['gh'];
}

/** workbench.event.v1 `ts` — the schema pattern takes seconds + Z, no millis. */
function wbTimestamp(): string {
  return new Date().toISOString().slice(0, 19) + 'Z';
}

/**
 * Handle GET /api/wb/v1/events. Synchronous entry; the stream lives until
 * the client disconnects, the read session expires, or the server drains SSE.
 */
export function handleWbEventsSse(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AshlrConfig,
  readSession: { id: string; expiresAt: number },
  deps: WbEventsDeps = {},
): void {
  if (sseConnectionCapReached()) {
    sendJson(res, 503, { error: 'too many live connections' });
    return;
  }

  let cleanup: () => void = () => {};
  if (typeof res.on === 'function') res.on('error', () => cleanup());

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });

  try {
    res.write(': connected\n\n');
  } catch {
    return; // Socket already gone.
  }

  let ended = false;
  let congested = false;
  let seq = 0;
  const maxBuffered = WB_EVENTS_MAX_BUFFERED_BYTES;
  if (typeof res.on === 'function') res.on('drain', () => { congested = false; });

  const bufferedBytes = (): number =>
    typeof res.writableLength === 'number' ? res.writableLength : 0;

  /** Write one raw SSE frame; closes the stream past the buffer cap. */
  const sendFrame = (frame: string): void => {
    if (ended) return;
    try {
      const ok = res.write(frame);
      if (ok === false) congested = true;
    } catch {
      return; // Socket closed; cleanup fires on 'close'/'error'.
    }
    if (bufferedBytes() > maxBuffered) cleanup();
  };

  /**
   * Emit a workbench.event.v1 envelope for a wb.* kind. Optional fields are
   * attached only when they keep the envelope schema-valid: `repo` must match
   * the schema's ashlrai-org pattern and `audit` must be an object — a bad
   * producer field degrades to a bare invalidation signal, never an invalid
   * frame.
   */
  const emitWb = (kind: WbEventKind, fields: WbEventFields = {}): void => {
    if (ended) return;
    const event = {
      schema: 'workbench.event.v1',
      kind,
      ts: wbTimestamp(),
      seq: ++seq,
      ...(typeof fields.repo === 'string' && WB_EVENT_REPO_RE.test(fields.repo) ? { repo: fields.repo } : {}),
      ...(fields.audit !== null && typeof fields.audit === 'object' && !Array.isArray(fields.audit)
        ? { audit: fields.audit }
        : {}),
    };
    sendFrame(`event: ${kind}\ndata: ${JSON.stringify(sanitizePublicJson(event))}\n\n`);
  };

  // ── poll-derived wb.* kinds ─────────────────────────────────────────────
  let lastSnapshotDigest: string | null = null;
  let lastGhDigest: string | null = null;
  let inFlight = false;

  const digestOf = (value: unknown): string => sha256(JSON.stringify(value ?? null));

  const tick = async (): Promise<void> => {
    if (ended || inFlight || congested) return;
    inFlight = true;
    try {
      try {
        const input = deps.snapshotState ? deps.snapshotState() : snapshotDigestInput();
        const digest = digestOf(input);
        if (digest !== lastSnapshotDigest) {
          lastSnapshotDigest = digest;
          emitWb('wb.snapshot');
        }
      } catch {
        // A failed read must not kill the stream; retry next tick.
      }
      try {
        const digest = digestOf(await ghDigestInput(cfg, deps));
        if (digest !== lastGhDigest) {
          lastGhDigest = digest;
          emitWb('wb.gh');
        }
      } catch {
        // Same: best-effort slice.
      }
    } finally {
      inFlight = false;
    }
  };

  const keepalive = (): void => {
    if (ended) return;
    try {
      res.write(': keepalive\n\n');
    } catch {
      // Socket closed; cleanup fires on 'close'/'error'.
    }
  };

  const live: {
    pollTimer?: ReturnType<typeof setInterval>;
    keepaliveTimer?: ReturnType<typeof setInterval>;
    expiryTimer?: ReturnType<typeof setTimeout>;
    sseId?: string;
    unsubscribePush?: () => void;
  } = {};

  cleanup = (): void => {
    if (ended) return;
    ended = true;
    if (live.unsubscribePush) {
      try { live.unsubscribePush(); } catch { /* best effort */ }
    }
    if (live.pollTimer !== undefined) clearInterval(live.pollTimer);
    if (live.keepaliveTimer !== undefined) clearInterval(live.keepaliveTimer);
    if (live.expiryTimer !== undefined) clearTimeout(live.expiryTimer);
    if (live.sseId !== undefined) deregisterSse(live.sseId);
    try {
      res.end();
    } catch {
      // Already ended.
    }
  };

  // Register BEFORE the first tick so a drain during it is honored.
  live.sseId = registerSse(cleanup, readSession.id);
  live.expiryTimer = setTimeout(cleanup, Math.max(0, readSession.expiresAt - Date.now()));
  live.keepaliveTimer = setInterval(keepalive, Math.max(1_000, deps.keepaliveMs ?? WB_EVENTS_KEEPALIVE_MS));
  live.pollTimer = setInterval(() => {
    void tick().catch(() => { /* A failed read retries on the next tick. */ });
  }, Math.max(50, deps.pollMs ?? WB_EVENTS_POLL_MS));

  const pushListener: WbPushListener = (kind, fields) => emitWb(kind, fields);
  wbPushListeners.add(pushListener);
  live.unsubscribePush = () => wbPushListeners.delete(pushListener);

  req.on('close', cleanup);
  req.on('error', cleanup);

  // First tick immediately: a fresh client learns the current wb state at
  // once instead of waiting a poll interval.
  void tick().catch(() => { /* Same as the interval path. */ });
}
