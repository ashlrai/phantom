/**
 * core/web/wb-events.ts — `GET /api/wb/v1/events` (WB-8): the workbench
 * Server-Sent Events surface for the desktop native shell, sibling to the
 * read routes in wb-read-api.ts.
 *
 * TWO FAMILIES ON ONE STREAM
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
 *   queue.v1    `event: queue.v1` — the queue.v1 relay. Each frame carries
 *               one station event (`id:` = eventId for Last-Event-ID dedup)
 *               relayed from the RQ-QUEUE-2 station journal. Until that job
 *               lands the journal is simply absent and the relay is silent;
 *               the on-disk contract it reads is the one router-queue's
 *               `observe|publish|poll` verbs append to.
 *
 * SOURCES AND CADENCE
 *
 *   snapshot+budget  ~/.ashlr/routing/capacity.json + ~/.ashlr/budget.json
 *   gh               the shared single-flight wb gh cache (getCachedWbGhStatus)
 *   queue journal    ~/.ashlr/telemetry/router-queue/events.json
 *
 * The tick is bounded (WB_EVENTS_POLL_MS) per connection, stat-gated (a
 * journal/snapshot whose mtime+size is unchanged is never re-parsed), and
 * cleared on disconnect, read-session expiry and server drain. NOTHING here
 * polls `~/.ashlr-runs` or any other Mac-dispatcher path — the queue relay
 * reads only the `.ashlr` journal above.
 *
 * SECURITY
 *  - Same boundary as every /api/* GET (server.ts), plus the SSE convention:
 *    the route itself requires a minted read session (SESSION_REQUIRED), and
 *    read-session.ts admits `/api/wb/v1/events` to the `?client=` proof so a
 *    browser EventSource can connect.
 *  - Every emitted byte passes through sanitizePublicJson — secret-shaped
 *    strings become [REDACTED], this user's home paths become `~`.
 *  - The journal is a private local file; events are shape-validated and
 *    capped before relay. A malformed journal silences the relay for that
 *    tick — it never emits half-parsed content and never logs file data.
 *  - Shares the /api/events connection cap (registerSse / deregisterSse).
 */

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
/** Journal size cap — mirrors the RQ-QUEUE-2 station journal bound. */
export const WB_QUEUE_JOURNAL_MAX_BYTES = 16 * 1024 * 1024;
/** Station events relayed per tick; the remainder follows on later ticks. */
export const WB_QUEUE_MAX_EVENTS_PER_TICK = 200;
/** Seen-eventId memory bound per connection. */
const WB_QUEUE_SEEN_CAP = 20_000;
/** Events array bound accepted from the journal. */
const WB_QUEUE_MAX_JOURNAL_EVENTS = 20_000;

/**
 * The RQ-QUEUE-2 station journal. Deliberately under `~/.ashlr` (Phantom's
 * own tree), NOT `~/.ashlr-runs` — the Mac dispatcher's directory is never
 * polled by this surface.
 */
export function wbQueueEventsJournalPath(): string {
  return join(homedir(), '.ashlr', 'telemetry', 'router-queue', 'events.json');
}

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
// queue.v1 relay — RQ-QUEUE-2 station journal
// ---------------------------------------------------------------------------

/** Station names the relay accepts (the RQ-QUEUE-2 QUEUE_STATIONS contract). */
export const WB_QUEUE_STATIONS = [
  'planned', 'READY', 'claimed', 'publish', 'pr-ci', 'merge-queue', 'merged', 'released', 'fix-main',
] as const;

/** Station → allowed evidence keys, mirroring router-queue.ts EVIDENCE_KEYS. */
const WB_QUEUE_EVIDENCE_KEYS: Record<string, readonly string[]> = {
  planned: [],
  READY: [],
  claimed: ['claimedAt'],
  publish: ['pr', 'headSha', 'publishedAt'],
  'pr-ci': ['pr', 'headSha', 'ci'],
  'merge-queue': ['pr', 'headSha', 'entryId'],
  merged: ['pr', 'headSha', 'mergeSha'],
  released: ['pr', 'mergeSha', 'releaseId', 'tag'],
  'fix-main': ['pr', 'mergeSha', 'runId'],
};

/** Station → the only source allowed to attest it (router-queue.ts SOURCES). */
const WB_QUEUE_STATION_SOURCES: Record<string, string> = {
  planned: 'router-queue',
  READY: 'router-queue',
  claimed: 'claim-ledger',
  publish: 'publish.sh',
  'pr-ci': 'github',
  'merge-queue': 'github',
  merged: 'github',
  released: 'github',
  'fix-main': 'github',
};

export interface WbQueueStationEvent {
  schemaVersion: 1;
  eventId: string;
  jobId: string;
  repo: string;
  attempt: string;
  station: string;
  observedAt: string;
  source: string;
  evidence: Record<string, string | number>;
}

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EVENT_ID_RE = /^[a-f0-9]{64}$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
// router-queue.ts timestamp(): UTC ISO with milliseconds, nothing else.
const OBSERVED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Strict shape gate for one station event. Anything off-contract is dropped
 * individually — a corrupt tail must not blind the relay, and nothing
 * unvalidated is ever emitted. Evidence values stay string|number and small.
 */
function parseStationEvent(value: unknown): WbQueueStationEvent | null {
  if (!isRecord(value)) return null;
  const { schemaVersion, eventId, jobId, repo, attempt, station, observedAt, source, evidence } = value;
  if (schemaVersion !== 1) return null;
  if (typeof eventId !== 'string' || !EVENT_ID_RE.test(eventId)) return null;
  if (typeof jobId !== 'string' || !TOKEN_RE.test(jobId)) return null;
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) return null;
  if (typeof attempt !== 'string' || !TOKEN_RE.test(attempt)) return null;
  if (typeof station !== 'string' || !(WB_QUEUE_STATIONS as readonly string[]).includes(station)) return null;
  if (typeof observedAt !== 'string' || !OBSERVED_AT_RE.test(observedAt)
    || !Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) return null;
  // The station→source attestation pair is part of the contract: a 'github'
  // event can never claim the 'planned' station, and vice versa.
  if (typeof source !== 'string' || WB_QUEUE_STATION_SOURCES[station] !== source) return null;
  if (!isRecord(evidence)) return null;
  const keys = Object.keys(evidence);
  const allowed = WB_QUEUE_EVIDENCE_KEYS[station] ?? [];
  if (keys.length !== allowed.length || !keys.every(k => allowed.includes(k))) return null;
  const clean: Record<string, string | number> = {};
  for (const key of keys) {
    if (key.length > 60) return null;
    const v = evidence[key];
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return null;
      clean[key] = v;
    } else if (typeof v === 'string') {
      if (v.length > 500) return null;
      clean[key] = v;
    } else {
      return null;
    }
  }
  return { schemaVersion: 1, eventId, jobId, repo, attempt, station, observedAt, source, evidence: clean };
}

export interface WbQueueJournalRead {
  /** mtimeMs:size — re-parse only when the file actually changed. */
  signature: string;
  events: WbQueueStationEvent[];
}

/**
 * Read + validate the station journal. Returns null when the file is absent,
 * unsafe (symlink/non-regular/oversized), malformed, or carries no valid
 * envelope — every failure mode is "relay nothing", never a throw and never
 * a partial emit.
 */
export function readWbQueueJournal(path: string = wbQueueEventsJournalPath()): WbQueueJournalRead | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return null; // absent (ENOENT) or unreadable — same honest answer
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > WB_QUEUE_JOURNAL_MAX_BYTES) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  // Same envelope the RQ-QUEUE-2 store writes/reads: exactly these two keys.
  if (!isRecord(doc) || Object.keys(doc).sort().join(',') !== 'events,schemaVersion'
    || doc['schemaVersion'] !== 1 || !Array.isArray(doc['events'])) return null;
  const raw = doc['events'];
  if (raw.length > WB_QUEUE_MAX_JOURNAL_EVENTS) return null;
  const events: WbQueueStationEvent[] = [];
  for (const entry of raw) {
    const event = parseStationEvent(entry);
    if (event) events.push(event);
  }
  return { signature: `${stat.mtimeMs}:${stat.size}`, events };
}

/** Synchronous baseline read used once at connect (before the first tick). */
function baselineQueueJournal(
  seen: Set<string>,
  state: { signature: string | null },
  path: string,
): void {
  const read = readWbQueueJournal(path);
  if (!read) return;
  state.signature = read.signature;
  for (const event of read.events) {
    if (seen.size < WB_QUEUE_SEEN_CAP) seen.add(event.eventId);
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
  /** Test seam: replaces the queue journal path. */
  queueJournalPath?: string;
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
 * Handle GET /api/wb/v1/events. Synchronous entry; the stream lives until the
 * client disconnects, the read session expires, or the server drains SSE.
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

  // ── queue.v1 relay state ────────────────────────────────────────────────
  const journalPath = deps.queueJournalPath ?? wbQueueEventsJournalPath();
  const queueSeen = new Set<string>();
  const queueState: { signature: string | null } = { signature: null };
  // Baseline BEFORE the first tick: events already in the journal are
  // history, not news — the relay announces transitions, not backlog.
  baselineQueueJournal(queueSeen, queueState, journalPath);

  const relayQueue = (): void => {
    if (ended || congested) return;
    const read = readWbQueueJournal(journalPath);
    if (!read) return; // absent/unreadable/malformed — silent, retried next tick
    if (read.signature === queueState.signature) return;
    let emitted = 0;
    let pending = false;
    for (const event of read.events) {
      if (queueSeen.has(event.eventId)) continue;
      if (emitted >= WB_QUEUE_MAX_EVENTS_PER_TICK) {
        pending = true;
        break;
      }
      queueSeen.add(event.eventId);
      emitted += 1;
      if (queueSeen.size > WB_QUEUE_SEEN_CAP) {
        // Bound memory: drop the oldest insertions, keep the newest.
        const excess = queueSeen.size - WB_QUEUE_SEEN_CAP;
        let i = 0;
        for (const id of queueSeen) {
          if (i++ >= excess) break;
          queueSeen.delete(id);
        }
      }
      sendFrame(`id: ${event.eventId}\nevent: queue.v1\ndata: ${JSON.stringify(sanitizePublicJson(event))}\n\n`);
      if (ended) return;
    }
    // Only mark the signature consumed when every valid event was relayed;
    // a capped batch keeps the old signature so the next tick resumes.
    if (!pending) queueState.signature = read.signature;
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
      relayQueue();
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
