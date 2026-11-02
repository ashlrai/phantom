/**
 * routes/verse/mobile/runs-queries.ts — the phone's end of the fleet-runs
 * family a sibling job is landing on the Mac:
 *
 *   GET  /api/verse/fleet/runs         FleetRunsV1 → FleetRunsLite
 *   POST /api/verse/fleet/runs/inbox   { text, source: 'Phantom mobile' }
 *                                      → 201 { ok, at }
 *                                      → 422 { code: 'INBOX_REFUSED', reason }
 *                                      → 503 { code: 'INBOX_UNAVAILABLE' }
 *
 * The family lands in parallel, so a missing route is "not in this build
 * yet", never an error to retry: the GET's 404 is memoized (same trick as
 * shell/fleet-runs-badge.ts) and a body this build cannot read is rejected,
 * never guessed. `null` in a count is a real reading ("unknown") — it prints
 * as "—", never zero. The wire's types are NOT imported from core: the
 * family may not exist in this build.
 *
 * The POST does not use apiPost: INBOX_REFUSED carries the human reason in
 * `reason`, a field readRefusal does not surface, so the refusal is read
 * here and thrown as FleetRunsInboxError — a plain Error whose message IS
 * the sentence the guard path shows verbatim.
 */
import { touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { isRemoteMobileMode } from '../../../data/remote-mode.js';

export const FLEET_RUNS_PATH = '/api/verse/fleet/runs';
export const FLEET_RUNS_INBOX_PATH = '/api/verse/fleet/runs/inbox';
/** The `source` the leaders see on a line sent from this phone. */
export const FLEET_RUNS_SOURCE = 'Phantom mobile';
/** What the phone says when the Mac's build lacks the family. */
export const NOT_IN_THIS_BUILD = 'Live runs is not in this build yet.';

export interface FleetRunsLane {
  lane: string;
  running: number | null;
  target: number | null;
  queued: number | null;
  held: boolean;
  heldReason: string | null;
}

export interface FleetRunsWorker {
  job: string;
  repo: string;
  lane: string;
  tier: string;
  ageSeconds: number | null;
}

export interface FleetRunsMerge {
  repo: string;
  number: number;
  title: string;
}

export interface FleetRunsInboxEntry {
  at: string;
  source: string;
  text: string;
}

/** FleetRunsV1 narrowed to what the Runs screen renders. */
export interface FleetRunsLite {
  generatedAt: string;
  lastTick: string | null;
  paused: boolean | null;
  claudeLane: string | null;
  lanes: FleetRunsLane[];
  workers: FleetRunsWorker[];
  leaders: Array<{ label: string; ageSeconds: number | null }>;
  mergesLastHour: { count: number | null; items: FleetRunsMerge[] };
  codexPersonal: { usedPct: number | null; resetsAt: string | null; asOf: string | null } | null;
  /** Up to five newest entries, ordered newest LAST (chat-style). */
  inbox: FleetRunsInboxEntry[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || str(v);
const numOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));

const isLane = (v: unknown): v is FleetRunsLane => isRecord(v) && str(v['lane'])
  && numOrNull(v['running']) && numOrNull(v['target']) && numOrNull(v['queued'])
  && typeof v['held'] === 'boolean' && strOrNull(v['heldReason']);
const isWorker = (v: unknown): v is FleetRunsWorker => isRecord(v)
  && str(v['job']) && str(v['repo']) && str(v['lane']) && str(v['tier']) && numOrNull(v['ageSeconds']);
const isLeader = (v: unknown): v is FleetRunsLite['leaders'][number] => isRecord(v) && str(v['label']) && numOrNull(v['ageSeconds']);
const isMerge = (v: unknown): v is FleetRunsMerge => isRecord(v)
  && str(v['repo']) && typeof v['number'] === 'number' && Number.isFinite(v['number']) && str(v['title']);
const isInbox = (v: unknown): v is FleetRunsInboxEntry => isRecord(v) && str(v['at']) && str(v['source']) && str(v['text']);
const isCodex = (v: unknown): v is NonNullable<FleetRunsLite['codexPersonal']> => isRecord(v)
  && numOrNull(v['usedPct']) && strOrNull(v['resetsAt']) && strOrNull(v['asOf']);

/** Structural narrowing — never throws. `null` means "not the contract", not "empty". */
export function readFleetRunsLite(raw: unknown): FleetRunsLite | null {
  if (!isRecord(raw) || raw['v'] !== 1) return null;
  const { generatedAt, lastTick, paused, claudeLane, lanes, workers, leaders, codexPersonal: codex, inbox } = raw;
  const merges = raw['mergesLastHour'];
  if (!str(generatedAt) || !strOrNull(lastTick) || !(paused === null || typeof paused === 'boolean') || !strOrNull(claudeLane)
    || !Array.isArray(lanes) || !lanes.every(isLane)
    || !Array.isArray(workers) || !workers.every(isWorker)
    || !Array.isArray(leaders) || !leaders.every(isLeader)
    || !isRecord(merges) || !numOrNull(merges['count'])
    || !Array.isArray(merges['items']) || !merges['items'].every(isMerge)
    || !(codex === null || isCodex(codex))
    || !Array.isArray(inbox) || !inbox.every(isInbox)) return null;
  return {
    generatedAt, lastTick, paused, claudeLane, lanes, workers, leaders, codexPersonal: codex,
    mergesLastHour: merges as FleetRunsLite['mergesLastHour'],
    inbox: (inbox as FleetRunsInboxEntry[]).slice(0, 5).sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0)),
  };
}

/** A 404 is permanent for the life of this build, so the first one is remembered and never asked again. */
let missing: ApiError | null = null;

export const fleetRunsQuery: QueryDef<FleetRunsLite> = {
  key: 'verse-fleet-runs',
  fetch: async (signal) => {
    if (missing) throw missing;
    try {
      const lite = readFleetRunsLite(await apiGet<unknown>(FLEET_RUNS_PATH, signal));
      if (lite === null) throw new ApiError(`GET ${FLEET_RUNS_PATH} answered a shape this build cannot read.`, 502, FLEET_RUNS_PATH, 'Unrecognized response — update Phantom.');
      return lite;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) missing = error;
      throw error;
    }
  },
};

/** Test hygiene: the not-in-this-build memo outlives a cache eviction. */
export function resetFleetRunsMissingForTest(): void {
  missing = null;
}

/** A refusal whose message is display-ready: the toast text, verbatim. */
export class FleetRunsInboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleetRunsInboxError';
  }
}

async function readInboxRefusal(res: Response): Promise<Error> {
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch { /* a non-JSON refusal still maps on its status */ }
  const code = body && str(body['code']) ? body['code'] : null;
  const sentence = body ? (['reason', 'error', 'note', 'message'] as const).map((k) => body[k]).find(str) ?? null : null;
  if (res.status === 404 || res.status === 503 || code === 'INBOX_UNAVAILABLE') return new FleetRunsInboxError(NOT_IN_THIS_BUILD);
  if (res.status === 422 || code === 'INBOX_REFUSED') return new FleetRunsInboxError(sentence ?? 'The leaders refused this message.');
  return new ApiError(`POST ${FLEET_RUNS_INBOX_PATH} failed (HTTP ${res.status})${sentence ? `: ${sentence}` : ''}.`, res.status, FLEET_RUNS_INBOX_PATH, sentence, code);
}

/**
 * Append `text` to the leaders' inbox on the Mac. `token` is the held
 * mutation token (the guard path collects it before run() is ever called).
 * A send the server accepted but acknowledged oddly is still a send.
 */
export async function postFleetRunsInbox(text: string, token: string): Promise<{ ok: boolean; at: string | null }> {
  const body = { text, source: FLEET_RUNS_SOURCE };
  if (isRemoteMobileMode()) {
    const raw = await (await import('../../../data/remote-session.js')).remoteMutate('POST', FLEET_RUNS_INBOX_PATH, body);
    touchMutationHold();
    return { ok: true, at: isRecord(raw) && str(raw['at']) ? raw['at'] : null };
  }
  const res = await fetch(FLEET_RUNS_INBOX_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'x-ashlr-token': token },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new ApiError('Mutation token was rejected.', 401, FLEET_RUNS_INBOX_PATH);
  if (!res.ok) throw await readInboxRefusal(res);
  touchMutationHold();
  const raw = await res.json() as unknown;
  return { ok: true, at: isRecord(raw) && str(raw['at']) ? raw['at'] : null };
}
