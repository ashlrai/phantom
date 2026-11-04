/**
 * session-guidance.ts — per-session operator guidance contract
 * (RQ-PHX-SESSIONINTERJECT: observe, communicate and interject on every
 * running agent session).
 *
 * PURE: no fs, network, clock or env reads — the console bundle imports the
 * strategy table and the ack state machine verbatim. The filesystem side is
 * session-guidance-io.ts; the HTTP edge is in src/core/web/api.ts
 * (POST/GET /api/fleet/sessions/<job>/guidance, GET /api/fleet/guidance).
 *
 * FILE CONTRACT — Phantom writes ONLY this file; dispatchd/launch.sh consume
 * it (their side is a Security proposal, not part of this change):
 *
 *   <runsDir>/queue/guidance/<job>.jsonl — append-only JSONL, directory mode
 *   0700, file mode 0600, one JSON object per line:
 *
 *   {"v":1,"type":"guidance","id","job","at","source","lane","tier",
 *    "strategy","text","truncated"}                       — operator message
 *   {"v":1,"type":"ack","id","at","state":"delivered","turn"}   — consumer ack
 *   {"v":1,"type":"ack","id","at","state":"requeued","to"}      — consumer ack
 *
 * A message's state starts 'queued'. The first VALID ack moves it to
 * 'delivered' (carrying the agent turn it landed on) or 'requeued' (the
 * fallback lane: stop at the next safe point, prepend the text to the job
 * prompt and requeue same lane/tier). Delivered and requeued are terminal —
 * later acks are refused by the machine and counted, never applied.
 */

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

/** api.ts route prefix: /api/fleet/sessions/<job>/guidance. */
export const FLEET_SESSION_GUIDANCE_PREFIX = '/api/fleet/sessions/';
export const FLEET_SESSION_GUIDANCE_SUFFIX = '/guidance';
/** Aggregate read: one poll answers every session's pending/ack state. */
export const FLEET_GUIDANCE_LIST_PATH = '/api/fleet/guidance';

/** Directory under the runs dir holding one <job>.jsonl per session. */
export const GUIDANCE_DIR = 'queue/guidance';
/** One message is capped at 4 KiB of UTF-8 after scrubbing. */
export const GUIDANCE_TEXT_MAX_BYTES = 4 * 1024;
/** A single guidance file stays readable whole; larger files are degraded. */
export const GUIDANCE_FILE_MAX_BYTES = 1024 * 1024;
/** The aggregate read reports at most this many newest sessions. */
export const GUIDANCE_LIST_MAX_JOBS = 50;
/** `source` on a guidance record stays a bounded display label. */
export const GUIDANCE_SOURCE_MAX_CHARS = 40;
export const GUIDANCE_SOURCE_PATTERN = /^[A-Za-z0-9 ._-]{1,40}$/;
/** Bound on id/at/field strings accepted back from the file. */
const FIELD_MAX_CHARS = 200;
const TEXT_MAX_CHARS = GUIDANCE_TEXT_MAX_BYTES + 16;

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/;

/** The filename is `<job>.jsonl`; '..', '/' and control bytes never pass. */
export function isGuidanceJobId(job: unknown): job is string {
  return typeof job === 'string' && JOB_ID.test(job) && !job.includes('..');
}

/** Route segments arrive percent-encoded; a bad decode is a bad id. */
export function guidanceJobFromPath(path: string): string | null {
  if (!path.startsWith(FLEET_SESSION_GUIDANCE_PREFIX) || !path.endsWith(FLEET_SESSION_GUIDANCE_SUFFIX)) return null;
  const segment = path.slice(FLEET_SESSION_GUIDANCE_PREFIX.length, -FLEET_SESSION_GUIDANCE_SUFFIX.length);
  let job: string;
  try {
    job = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return isGuidanceJobId(job) ? job : null;
}

// ---------------------------------------------------------------------------
// Per-lane delivery strategy table (data, not a hardcoded enum)
// ---------------------------------------------------------------------------

export type GuidanceDeliveryKind = 'stream-json-inject' | 'resume-followup' | 'resume' | 'requeue';

export interface GuidanceStrategy {
  /** Engine family the lane resolved to (`agy`, `claude`, `codex`, `grok`, `devin`, `local`, `unknown`). */
  family: string;
  kind: GuidanceDeliveryKind;
  /** Operator-facing short label for the row chip. */
  label: string;
  /** What the consumer does — the dispatchd/launch.sh proposal wording. */
  mechanism: string;
}

interface LaneStrategyRow {
  readonly family: string;
  /** Exact lane names (already lowercased on lookup). */
  readonly lanes: readonly string[];
  /** Lane prefixes (`codex-` covers every codex-* lane the pool adds later). */
  readonly prefixes: readonly string[];
  readonly kind: GuidanceDeliveryKind;
  readonly label: string;
  readonly mechanism: string;
}

const REQUEUE_MECHANISM =
  'stop at the next safe point, prepend the guidance to the job prompt and requeue on the same lane and tier';

export const LANE_GUIDANCE_STRATEGIES: readonly LaneStrategyRow[] = [
  {
    family: 'agy',
    lanes: ['agy'],
    prefixes: ['agy-'],
    kind: 'stream-json-inject',
    label: 'stream inject',
    mechanism:
      'agy --input-format stream-json: the guidance lands as the next NDJSON user message on the agent stdin; after a stop, agy --conversation resume picks the session back up',
  },
  {
    family: 'claude',
    lanes: ['claude', 'claude-api', 'zai'],
    prefixes: ['claude-'],
    kind: 'resume-followup',
    label: 'resume follow-up',
    mechanism:
      'claude --resume <session> with the guidance as the follow-up prompt, fired at the next turn boundary',
  },
  {
    family: 'codex',
    lanes: ['codex-cmp', 'codex-personal', 'codex-local'],
    prefixes: ['codex-'],
    kind: 'resume',
    label: 'resume',
    mechanism:
      'codex resume picks the session back up with the guidance prepended to its working prompt',
  },
  {
    family: 'grok',
    lanes: ['grok'],
    prefixes: ['grok-'],
    kind: 'resume',
    label: 'resume',
    mechanism:
      'grok --resume/--session-id picks the session back up with the guidance prepended to its working prompt',
  },
  {
    family: 'devin',
    lanes: ['devin'],
    prefixes: [],
    kind: 'requeue',
    label: 'requeue',
    mechanism: REQUEUE_MECHANISM,
  },
  {
    family: 'local',
    lanes: ['local'],
    prefixes: [],
    kind: 'requeue',
    label: 'requeue',
    mechanism: REQUEUE_MECHANISM,
  },
];

const FALLBACK_STRATEGY: GuidanceStrategy = {
  family: 'unknown',
  kind: 'requeue',
  label: 'requeue',
  mechanism: REQUEUE_MECHANISM,
};

/**
 * Resolve a lane name to its delivery strategy. Exact lane wins over prefix;
 * a lane the table does not know (gemini, cursor, a name the pool added
 * after this build) falls back to the universal requeue path.
 */
export function strategyForLane(lane: string | null | undefined): GuidanceStrategy {
  const normalized = typeof lane === 'string' ? lane.trim().toLowerCase() : '';
  if (normalized !== '') {
    for (const row of LANE_GUIDANCE_STRATEGIES) {
      if (row.lanes.includes(normalized) || row.prefixes.some((prefix) => normalized.startsWith(prefix))) {
        return { family: row.family, kind: row.kind, label: row.label, mechanism: row.mechanism };
      }
    }
  }
  return { ...FALLBACK_STRATEGY };
}

/** Display facts for a stored strategy kind (labels live in the table row). */
export function guidanceKindInfo(kind: GuidanceDeliveryKind): { label: string; mechanism: string } {
  const row = LANE_GUIDANCE_STRATEGIES.find((candidate) => candidate.kind === kind);
  return { label: row?.label ?? FALLBACK_STRATEGY.label, mechanism: row?.mechanism ?? FALLBACK_STRATEGY.mechanism };
}

const DELIVERY_KINDS: readonly GuidanceDeliveryKind[] = ['stream-json-inject', 'resume-followup', 'resume', 'requeue'];

// ---------------------------------------------------------------------------
// Records, the writer's shape, and the ack state machine
// ---------------------------------------------------------------------------

export type GuidanceAckState = 'queued' | 'delivered' | 'requeued';

/** One guidance message after folding the file's ack lines over it. */
export interface SessionGuidanceEntry {
  id: string;
  at: string;
  source: string;
  lane: string | null;
  tier: string | null;
  strategy: GuidanceDeliveryKind;
  text: string;
  truncated: boolean;
  state: GuidanceAckState;
  /** Set when state === 'delivered': the agent turn the message landed on. */
  turn: number | null;
  /** Set when state === 'requeued': the replacement job id, when known. */
  requeueTo: string | null;
  ackAt: string | null;
}

/** A parsed consumer ack line. */
export interface GuidanceAckRecord {
  id: string;
  at: string | null;
  state: 'delivered' | 'requeued';
  turn: number | null;
  to: string | null;
}

/**
 * One state-machine transition. 'queued' moves to 'delivered' (a turn must
 * be named — "delivered at turn N" is the display contract) or 'requeued'.
 * Terminal states never move; the reducer answers null so the fold can
 * count the refusal instead of corrupting the entry.
 */
export function guidanceAckTransition(
  state: GuidanceAckState,
  ack: { state: 'delivered' | 'requeued'; turn: number | null },
): GuidanceAckState | null {
  if (state !== 'queued') return null;
  if (ack.state === 'delivered' && !(Number.isInteger(ack.turn) && (ack.turn as number) >= 0)) return null;
  return ack.state;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const field = (value: unknown, max = FIELD_MAX_CHARS): string | null =>
  typeof value === 'string' && value.length <= max ? value : null;

function parseGuidanceRecord(value: Record<string, unknown>): SessionGuidanceEntry | null {
  const id = field(value.id);
  const at = field(value.at);
  const source = field(value.source);
  const text = typeof value.text === 'string' && value.text.length <= TEXT_MAX_CHARS ? value.text : null;
  if (id === null || at === null || source === null || text === null) return null;
  const lane = value.lane === null ? null : field(value.lane, 64);
  const tier = value.tier === null || value.tier === undefined ? null : field(value.tier, 32);
  const strategy: GuidanceDeliveryKind = DELIVERY_KINDS.includes(value.strategy as GuidanceDeliveryKind)
    ? (value.strategy as GuidanceDeliveryKind)
    : 'requeue';
  return {
    id, at, source, lane, tier, strategy,
    text, truncated: value.truncated === true,
    state: 'queued', turn: null, requeueTo: null, ackAt: null,
  };
}

function parseAckRecord(value: Record<string, unknown>): GuidanceAckRecord | null {
  const id = field(value.id);
  if (id === null) return null;
  const state = value.state === 'delivered' || value.state === 'requeued' ? value.state : null;
  if (state === null) return null;
  const turn = value.turn === undefined || value.turn === null
    ? null
    : typeof value.turn === 'number' && Number.isInteger(value.turn) && value.turn >= 0 ? value.turn : null;
  const to = value.to === undefined || value.to === null ? null : field(value.to);
  return { id, at: field(value.at), state, turn, to };
}

export interface GuidanceFold {
  entries: SessionGuidanceEntry[];
  /** Acks naming a message id this file has no guidance record for. */
  orphanAcks: number;
  /** Acks the state machine refused (terminal state, or no turn on delivered). */
  invalidAcks: number;
  /** Lines that were not valid guidance or ack records. */
  badLines: number;
}

/**
 * Fold one guidance file's lines into per-message ack state. Order is file
 * order; the first valid ack wins because terminal states reject the rest.
 * Malformed lines degrade counts, never the fold of the good records.
 */
export function foldGuidanceLines(lines: readonly string[]): GuidanceFold {
  const fold: GuidanceFold = { entries: [], orphanAcks: 0, invalidAcks: 0, badLines: 0 };
  const byId = new Map<string, SessionGuidanceEntry>();
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      fold.badLines++;
      continue;
    }
    if (!isRecord(value)) {
      fold.badLines++;
      continue;
    }
    if (value.v === 1 && value.type === 'guidance') {
      const entry = parseGuidanceRecord(value);
      if (entry === null) {
        fold.badLines++;
        continue;
      }
      byId.set(entry.id, entry);
      fold.entries.push(entry);
    } else if (value.v === 1 && value.type === 'ack') {
      const ack = parseAckRecord(value);
      if (ack === null) {
        fold.badLines++;
        continue;
      }
      const entry = byId.get(ack.id);
      if (!entry) {
        fold.orphanAcks++;
        continue;
      }
      const next = guidanceAckTransition(entry.state, ack);
      if (next === null) {
        fold.invalidAcks++;
        continue;
      }
      entry.state = next;
      entry.ackAt = ack.at;
      if (next === 'delivered') entry.turn = ack.turn;
      if (next === 'requeued') entry.requeueTo = ack.to;
    } else {
      fold.badLines++;
    }
  }
  return fold;
}

// ---------------------------------------------------------------------------
// The 4 KiB cap (pure UTF-8 byte truncation)
// ---------------------------------------------------------------------------

/**
 * Cap a message at `maxBytes` of UTF-8, never cutting inside a multibyte
 * sequence. A byte with the 10xxxxxx form is a continuation byte, so backing
 * off while the first dropped byte has that form lands the cut on a
 * character boundary — TextEncoder output is always valid UTF-8, so after
 * the loop the kept region ends with a complete character.
 */
export function capGuidanceText(text: string, maxBytes: number = GUIDANCE_TEXT_MAX_BYTES): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

// ---------------------------------------------------------------------------
// Wire shapes the routes answer
// ---------------------------------------------------------------------------

export interface FleetSessionGuidanceReadV1 {
  v: 1;
  job: string;
  generatedAt: string;
  sourceState: 'healthy' | 'missing' | 'degraded';
  lane: string | null;
  /** The strategy a NEW message to this job would take. */
  strategy: GuidanceDeliveryKind;
  pending: number;
  entries: SessionGuidanceEntry[];
  orphanAcks: number;
  invalidAcks: number;
}

export interface FleetGuidanceSessionV1 {
  job: string;
  lane: string | null;
  strategy: GuidanceDeliveryKind;
  /** Messages still 'queued' — null when the file could not be read. */
  pending: number | null;
  latest: {
    id: string;
    at: string;
    state: GuidanceAckState;
    turn: number | null;
    requeueTo: string | null;
  } | null;
}

export interface FleetGuidanceListV1 {
  v: 1;
  generatedAt: string;
  sourceState: 'healthy' | 'missing' | 'degraded';
  sessions: FleetGuidanceSessionV1[];
}
