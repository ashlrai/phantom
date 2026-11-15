/** Off-host claim/return route on the host's advisory coordination ledger
 * (fleet.coordination.v1): the same claimFleetWork / returnFleetClaim calls
 * `ashlr fleet coordination claim|return` make, so a tailnet agent holding
 * the mutation token can claim work, keep its lease and return a PR, tests,
 * artifact or blocker without a host shell.
 *
 * A claim is advisory: it grants no execution or merge authority, spawns
 * nothing and dispatches nothing. Routing labels (`agent`) do not
 * authenticate the caller; only the lease fences release. A return receipt is
 * evidence, not authority: it does not merge, verify or close anything.
 *
 * The lease is returned once, in the 200 body of POST /claim. It is never
 * logged, never placed in an error, and no other route echoes it
 * (returnFleetClaim never returns it; the GET claims view drops it).
 *
 * The V1 dispatch + mutation-token gate in verse-api.ts runs before this
 * module sees any non-GET request; no second token check lives here. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiModule } from './api-modules.js';
import { readBody, sendJson } from '../web/api.js';
import { claimFleetWork, type FleetClaim, type FleetCoordinationResult } from '../fleet/coordination.js';
import { returnFleetClaim, type FleetClaimReturnInput, type FleetClaimReturnResult } from '../fleet/coordination-return.js';

const BASE = '/api/verse/fleet/coordination-claims';
export const VERSE_FLEET_COORDINATION_CLAIM_PATH = `${BASE}/claim`;
export const VERSE_FLEET_COORDINATION_RETURN_PATH = `${BASE}/return`;
/** Body cap: the largest legal body is ids, a lease and a few KiB of result text. */
export const COORDINATION_MUTATE_MAX_BODY_BYTES = 8 * 1024;
/** Same ceiling the ledger enforces (7 days). */
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

type ClaimResult = FleetCoordinationResult<{ claim: FleetClaim; lease: string }>;

export interface FleetCoordinationMutateApiDeps {
  /** Claim seam for tests. Default: claimFleetWork() on the default ledger. */
  claim?: (input: { repo: string; task: string; agent: string; ttlMs?: number }, now: number) => ClaimResult;
  /** Return seam for tests. Default: returnFleetClaim() on the default ledger. */
  return?: (input: FleetClaimReturnInput, now: number) => FleetClaimReturnResult;
  /** Clock seam for tests; feeds the ledger's claimedAt / expiry. */
  now?: () => Date;
}

const CLAIM_KEYS = new Set(['repo', 'task', 'agent', 'ttlSeconds']);
const RETURN_KEYS = new Set(['claimId', 'agent', 'lease', 'result', 'ttlSeconds']);
const RESULT_KEYS = new Set(['pr', 'head', 'tests', 'artifact', 'blocked']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Absent → undefined (ledger default); an integer 1..604800 → ms; anything else → null. */
function ttlMs(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_TTL_SECONDS
    ? (value as number) * 1000 : null;
}

const ERROR_STATUS: Record<string, number> = {
  'invalid-input': 400, 'not-found': 404, 'not-owner': 403, duplicate: 409, unavailable: 503,
};

/** Return outcome → HTTP status. released-unposted → 202: the claim was
 * released but its receipt was not posted; the body carries id and body so
 * the caller can repost the evidence. */
function returnStatus(outcome: FleetClaimReturnResult['outcome']): number {
  if (outcome === 'returned' || outcome === 'already-returned') return 200;
  if (outcome === 'released-unposted') return 202;
  return ERROR_STATUS[outcome] ?? 503;
}

/** Read and parse a JSON object body whose keys are all in `keys`; on failure
 * the error response is already sent and null is returned. */
async function readObject(req: IncomingMessage, res: ServerResponse, keys: Set<string>, shape: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readBody(req, COORDINATION_MUTATE_MAX_BODY_BYTES);
  } catch {
    sendJson(res, 413, { error: 'request body too large' });
    return null;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { parsed = undefined; }
  if (!isRecord(parsed) || Object.keys(parsed).some(k => !keys.has(k))) {
    sendJson(res, 400, { ok: false, outcome: 'invalid-input', error: `body must be ${shape}.` });
    return null;
  }
  return parsed;
}

const invalid = (res: ServerResponse, error: string): void => {
  sendJson(res, 400, { ok: false, outcome: 'invalid-input', error });
};

async function handleClaim(req: IncomingMessage, res: ServerResponse,
  claim: NonNullable<FleetCoordinationMutateApiDeps['claim']>, now: () => Date): Promise<void> {
  const body = await readObject(req, res, CLAIM_KEYS, '{repo, task, agent, ttlSeconds?}');
  if (!body) return;
  const { repo, task, agent } = body;
  const ttl = ttlMs(body.ttlSeconds);
  if (typeof repo !== 'string' || typeof task !== 'string' || typeof agent !== 'string') {
    return invalid(res, 'repo, task and agent must be strings.');
  }
  if (ttl === null) return invalid(res, `ttlSeconds must be an integer from 1 to ${MAX_TTL_SECONDS}.`);
  let result: ClaimResult;
  try {
    result = claim({ repo, task, agent, ...(ttl !== undefined ? { ttlMs: ttl } : {}) }, now().getTime());
  } catch {
    result = { ok: false, error: 'unavailable' };
  }
  if (!result.ok) {
    sendJson(res, ERROR_STATUS[result.error] ?? 503, { ok: false, outcome: result.error });
    return;
  }
  const { id, repo: r, task: t, agent: a, claimedAt, expiresAt } = result.value.claim;
  const view = { id, repo: r, task: t, agent: a,
    claimedAt: new Date(claimedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() };
  // sendJson runs sanitizePublicJson over every body; the lease is a UUID it
  // leaves intact (the round-trip test proves the returned lease releases).
  sendJson(res, 200, { ok: true, outcome: 'claimed', claim: view, lease: result.value.lease });
}

async function handleReturn(req: IncomingMessage, res: ServerResponse,
  ret: NonNullable<FleetCoordinationMutateApiDeps['return']>, now: () => Date): Promise<void> {
  const body = await readObject(req, res, RETURN_KEYS, '{claimId, agent, lease, result, ttlSeconds?}');
  if (!body) return;
  const { claimId, agent, lease, result } = body;
  const ttl = ttlMs(body.ttlSeconds);
  if (typeof claimId !== 'string' || typeof agent !== 'string' || typeof lease !== 'string') {
    return invalid(res, 'claimId, agent and lease must be strings.');
  }
  if (ttl === null) return invalid(res, `ttlSeconds must be an integer from 1 to ${MAX_TTL_SECONDS}.`);
  const resultForm = 'result must be exactly one of {pr, head}, {tests}, {artifact} or {blocked}.';
  if (!isRecord(result) || Object.keys(result).some(k => !RESULT_KEYS.has(k))) return invalid(res, resultForm);
  const { pr, head, tests, artifact, blocked } = result;
  const str = (v: unknown): v is string | undefined => v === undefined || typeof v === 'string';
  if (!(pr === undefined || typeof pr === 'number' || typeof pr === 'string')
    || !str(head) || !str(tests) || !str(artifact) || !str(blocked)) return invalid(res, resultForm);
  // returnFleetClaim enforces exactly one form and validates pr/head/text.
  let out: FleetClaimReturnResult;
  try {
    out = ret({ id: claimId, agent, lease, pr, head, tests, artifact, blocked,
      ...(ttl !== undefined ? { ttlMs: ttl } : {}) }, now().getTime());
  } catch {
    out = { ok: false, outcome: 'unavailable', claimId };
  }
  if (out.outcome === 'invalid-input') return invalid(res, `${resultForm} pr is a positive integer and head a 7-40 hex sha; ids are [A-Za-z0-9._:-].`);
  sendJson(res, returnStatus(out.outcome), out);
}

export function createFleetCoordinationMutateApi(deps: FleetCoordinationMutateApiDeps = {}): ApiModule {
  const claim = deps.claim ?? ((input, now) => claimFleetWork(input, { now }));
  const ret = deps.return ?? ((input, now) => returnFleetClaim(input, { now }));
  const now = deps.now ?? (() => new Date());
  return async (_ctx, req, res, path, method) => {
    if (path !== VERSE_FLEET_COORDINATION_CLAIM_PATH && path !== VERSE_FLEET_COORDINATION_RETURN_PATH) return false;
    if (method !== 'POST') sendJson(res, 405, { error: 'method not allowed' });
    else if (path === VERSE_FLEET_COORDINATION_CLAIM_PATH) await handleClaim(req, res, claim, now);
    else await handleReturn(req, res, ret, now);
    return true;
  };
}

export const handleFleetCoordinationMutateApi: ApiModule = createFleetCoordinationMutateApi();
