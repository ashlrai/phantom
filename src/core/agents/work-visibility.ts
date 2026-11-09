/**
 * Shared visibility: a compact per-lane brief and claim-before-work.
 * Claims coordinate. They grant no execution authority. Tokens stay in the store.
 */
import { claimKeysOverlap, parseClaimKey } from './bus-v2-schema.js';
import {
  acquireCoordination, listCoordination, releaseLiveClaimByOwner,
  type CoordinationView,
} from './claim-store.js';
import type { WorldModel } from '../world/types.js';

export const CONTEXT_BRIEF_SCHEMA = 'ashlr.context-brief/v1' as const;
export const WORK_CLAIM_SCHEMA = 'ashlr.work-claim/v1' as const;
export const BRIEF_MAX_BYTES = 4096;
const LANE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const WORK_LABEL = /^[\x21-\x7e]{1,120}$/;
const RESOURCE_LEASE_MS = 3_600_000;

export interface OpenWorkPull {
  repo: string;
  number: number;
  state: 'open' | 'merged' | 'closed';
  createdAt: string;
  files?: readonly string[];
  workKey?: string | null;
}

export interface WorkHolder {
  claimId: string;
  lane: string | null;
  key: string;
  repo: string | null;
  pr: number | null;
  branch: string | null;
  started: string | null;
}

export interface ContextBrief {
  schema: typeof CONTEXT_BRIEF_SCHEMA;
  generatedAt: string;
  lane: string;
  bytes: number;
  truncated: boolean;
  working: Array<{ claimId: string; lane: string; repo: string | null; pr: number | null; branch: string | null; started: string | null; key: string }>;
  openPrs: Array<{ repo: string; number: number; createdAt: string }>;
  bottlenecks: Array<{ id: string; metric: string; value: number | null }>;
  blindSpots: Array<{ id: string; path: string }>;
  pacing: { lane: string; pacePerHour: number | null; requiredPacePerHour: number | null; runwayHours: number | null; freshness: string };
}

export function canonicalWorkKey(workKey: string): string | null {
  if (parseClaimKey(workKey)) return workKey;
  if (!WORK_LABEL.test(workKey)) return null;
  const queue = `queue:${workKey}`;
  return parseClaimKey(queue) ? queue : null;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Pull export rows. Invalid rows are skipped. Optional files and workKey are kept. */
export function parseOpenWorkPulls(raw: unknown): OpenWorkPull[] {
  const body = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const rows = Array.isArray(raw) ? raw : Array.isArray(body?.['pulls']) ? body['pulls'] as unknown[] : null;
  if (!rows) return [];
  const pulls: OpenWorkPull[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const item = row as Record<string, unknown>;
    const repo = typeof item['repo'] === 'string' ? item['repo'] : '';
    const number = item['number'];
    const state = item['state'] === 'merged' || item['state'] === 'MERGED' ? 'merged'
      : item['state'] === 'closed' || item['state'] === 'CLOSED' ? 'closed'
      : item['state'] === 'open' || item['state'] === 'OPEN' ? 'open' : null;
    const createdAt = typeof item['createdAt'] === 'string' ? item['createdAt'] : '';
    if (!REPO.test(repo) || typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || !state || !Number.isFinite(Date.parse(createdAt))) continue;
    const files = Array.isArray(item['files']) ? item['files'].filter((file): file is string => typeof file === 'string') : undefined;
    const workKey = typeof item['workKey'] === 'string' ? item['workKey'] : null;
    pulls.push({ repo, number, state, createdAt, files, workKey });
  }
  return pulls;
}

export function pullTouchesKey(pull: OpenWorkPull, key: string): boolean {
  if (pull.state !== 'open') return false;
  const parsed = parseClaimKey(key);
  if (!parsed) return pull.workKey === key;
  if (parsed.kind === 'pr') return pull.repo === parsed.repo && pull.number === parsed.number;
  if (parsed.kind === 'repo') return pull.repo === parsed.repo;
  if (parsed.kind === 'queue') return pull.workKey === key || pull.workKey === parsed.queue;
  if (parsed.kind === 'path') {
    if (pull.repo !== parsed.repo || !pull.files?.length) return false;
    return pull.files.some((file) => {
      const other = `path:${parsed.repo}:${file.replace(/^\/+/, '')}`;
      return parseClaimKey(other) !== undefined && claimKeysOverlap(key, other);
    });
  }
  return false;
}

function prNumber(key: string): number | null {
  const parsed = parseClaimKey(key);
  return parsed?.kind === 'pr' ? parsed.number : null;
}

function repoOf(key: string, row: CoordinationView): string | null {
  if (row.repo) return row.repo;
  const parsed = parseClaimKey(key);
  return parsed && parsed.kind !== 'queue' ? parsed.repo : null;
}

function holderFromClaim(row: CoordinationView): WorkHolder {
  return {
    claimId: row.sourceId,
    lane: row.owner,
    key: row.key,
    repo: repoOf(row.key, row),
    pr: prNumber(row.key),
    branch: row.branch,
    started: row.started,
  };
}

function holderFromPull(pull: OpenWorkPull, key: string): WorkHolder {
  return {
    claimId: `pr:${pull.repo}#${pull.number}`,
    lane: null,
    key,
    repo: pull.repo,
    pr: pull.number,
    branch: null,
    started: pull.createdAt,
  };
}

export interface WorkClaimResult {
  schema: typeof WORK_CLAIM_SCHEMA;
  status: 'acquired' | 'released' | 'conflict' | 'missing' | 'invalid' | 'unavailable';
  key?: string;
  lane?: string;
  reason?: 'open' | 'merge' | 'abandon' | 'live-claim' | 'open-pr';
  holder?: WorkHolder;
  started?: string;
}

export function acquireWorkClaim(input: {
  workKey: string;
  lane: string;
  repo?: string | null;
  pr?: number | null;
  branch?: string | null;
  pulls?: readonly OpenWorkPull[];
  root?: string;
  now?: number;
}): WorkClaimResult {
  const now = input.now ?? Date.now();
  const key = canonicalWorkKey(input.workKey);
  if (!key || !LANE.test(input.lane)) return { schema: WORK_CLAIM_SCHEMA, status: 'invalid' };
  if (input.repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo)) return { schema: WORK_CLAIM_SCHEMA, status: 'invalid' };
  if (input.pr !== undefined && input.pr !== null && (!Number.isSafeInteger(input.pr) || input.pr < 1)) return { schema: WORK_CLAIM_SCHEMA, status: 'invalid' };
  if (input.branch && !WORK_LABEL.test(input.branch)) return { schema: WORK_CLAIM_SCHEMA, status: 'invalid' };
  const open = (input.pulls ?? []).find((pull) => pullTouchesKey(pull, key));
  if (open) return { schema: WORK_CLAIM_SCHEMA, status: 'conflict', key, lane: input.lane, reason: 'open-pr', holder: holderFromPull(open, key) };
  const listed = listCoordination(input.root, now);
  if (listed.source === 'unavailable') return { schema: WORK_CLAIM_SCHEMA, status: 'unavailable' };
  const live = listed.claims.find((row) => row.live && (row.key === key || claimKeysOverlap(row.key, key)));
  if (live && live.owner !== input.lane) {
    return { schema: WORK_CLAIM_SCHEMA, status: 'conflict', key, lane: input.lane, reason: 'live-claim', holder: holderFromClaim(live) };
  }
  const started = new Date(now).toISOString();
  const sourceId = `work:${input.lane}:${key}`.slice(0, 256);
  const acquired = acquireCoordination({
    root: input.root,
    origin: 'resource',
    key,
    owner: input.lane,
    leaseMs: RESOURCE_LEASE_MS,
    leaseUntil: now + RESOURCE_LEASE_MS,
    sourceId,
    now,
    started,
    teamTarget: input.repo ? { repo: input.repo, ...(input.branch ? { branch: input.branch } : {}) } : undefined,
  });
  if (acquired.status === 'conflict') {
    return {
      schema: WORK_CLAIM_SCHEMA, status: 'conflict', key, lane: input.lane, reason: 'live-claim',
      holder: { claimId: acquired.holder.key, lane: acquired.holder.owner, key: acquired.holder.key, repo: input.repo ?? null, pr: input.pr ?? prNumber(acquired.holder.key), branch: input.branch ?? null, started: null },
    };
  }
  if (acquired.status !== 'acquired') return { schema: WORK_CLAIM_SCHEMA, status: acquired.status === 'invalid' ? 'invalid' : 'unavailable' };
  return { schema: WORK_CLAIM_SCHEMA, status: 'acquired', key, lane: input.lane, started };
}

export function releaseWorkClaim(input: {
  workKey: string;
  lane: string;
  reason: 'open' | 'merge' | 'abandon';
  root?: string;
  now?: number;
}): WorkClaimResult {
  const key = canonicalWorkKey(input.workKey);
  if (!key || !LANE.test(input.lane) || !['open', 'merge', 'abandon'].includes(input.reason)) {
    return { schema: WORK_CLAIM_SCHEMA, status: 'invalid' };
  }
  const released = releaseLiveClaimByOwner({ root: input.root, key, owner: input.lane, now: input.now });
  if (released.status === 'released') return { schema: WORK_CLAIM_SCHEMA, status: 'released', key, lane: input.lane, reason: input.reason };
  if (released.status === 'lost') return { schema: WORK_CLAIM_SCHEMA, status: 'missing', key, lane: input.lane, reason: input.reason };
  if (released.status === 'conflict') {
    return {
      schema: WORK_CLAIM_SCHEMA, status: 'conflict', key, lane: input.lane, reason: 'live-claim',
      holder: { claimId: released.holder.key, lane: released.holder.owner, key: released.holder.key, repo: null, pr: prNumber(released.holder.key), branch: null, started: null },
    };
  }
  return { schema: WORK_CLAIM_SCHEMA, status: 'unavailable', key, lane: input.lane, reason: input.reason };
}

export interface BriefParts {
  nowMs: number;
  lane: string;
  world: WorldModel;
  claims: readonly CoordinationView[];
  pulls: readonly OpenWorkPull[];
  bottlenecks?: readonly { id: string; metric: string; value: number | null }[];
}

function pacingFor(world: WorldModel, lane: string): ContextBrief['pacing'] {
  const row = world.sensors.lanes.find((item) => item.lane === lane)
    ?? world.sensors.lanes.find((item) => item.lane.startsWith(`${lane}-`) || lane.startsWith(`${item.lane}-`));
  if (!row) return { lane, pacePerHour: null, requiredPacePerHour: null, runwayHours: null, freshness: 'unknown' };
  return {
    lane: row.lane,
    pacePerHour: row.pacePerHour.value,
    requiredPacePerHour: row.requiredPacePerHour.value,
    runwayHours: row.runwayHours.value,
    freshness: row.pacePerHour.freshness,
  };
}

/** Compact brief. The JSON is at most BRIEF_MAX_BYTES. */
export function buildContextBrief(input: BriefParts): ContextBrief {
  const working = input.claims.filter((row) => row.live).map((row) => ({
    claimId: row.sourceId,
    lane: row.owner,
    repo: repoOf(row.key, row),
    pr: prNumber(row.key),
    branch: row.branch,
    started: row.started,
    key: row.key,
  }));
  const openPrs = input.pulls.filter((pull) => pull.state === 'open').map((pull) => ({
    repo: pull.repo, number: pull.number, createdAt: pull.createdAt,
  }));
  const bottlenecks = [...(input.bottlenecks ?? [])];
  const blindSpots = input.world.blindSpots.map((spot) => ({ id: spot.id, path: spot.path }));
  let truncated = false;
  const fit = (): ContextBrief => {
    const brief: ContextBrief = {
      schema: CONTEXT_BRIEF_SCHEMA,
      generatedAt: new Date(input.nowMs).toISOString(),
      lane: input.lane,
      bytes: 0,
      truncated,
      working,
      openPrs,
      bottlenecks,
      blindSpots,
      pacing: pacingFor(input.world, input.lane),
    };
    for (let pass = 0; pass < 3; pass += 1) brief.bytes = Buffer.byteLength(JSON.stringify(brief));
    return brief;
  };
  let brief = fit();
  while (brief.bytes > BRIEF_MAX_BYTES && (working.length > 0 || openPrs.length > 0 || bottlenecks.length > 0 || blindSpots.length > 0)) {
    truncated = true;
    if (blindSpots.length > 0) blindSpots.pop();
    else if (openPrs.length > working.length && openPrs.length > 0) openPrs.pop();
    else if (working.length > 0) working.pop();
    else if (bottlenecks.length > 0) bottlenecks.pop();
    else openPrs.pop();
    brief = fit();
  }
  if (brief.bytes > BRIEF_MAX_BYTES) {
    brief.working = [];
    brief.openPrs = [];
    brief.bottlenecks = [];
    brief.blindSpots = [];
    brief.truncated = true;
    for (let pass = 0; pass < 3; pass += 1) brief.bytes = Buffer.byteLength(JSON.stringify(brief));
  }
  return brief;
}
