/**
 * core/web/ideas-draft-route.ts: POST /api/ideas/draft, the Ideas pane's
 * "Draft job" / "Draft together" action.
 *
 * Turns 1 to 8 backlog ideas into ONE job for the dispatcher by calling the
 * existing drop-job writer (drop-job-writer.ts); it never touches ready.tsv,
 * router-queue.md or the drop folder itself. The draft id is derived from the
 * sorted idea-id set, so a second click on the same set finds the file already
 * there and returns the same draft instead of a copy.
 *
 * Collisions are checked BEFORE the write, the same way `fleet draft-check
 * --queued` does: paths the draft names that a still-waiting queued job also
 * names. They are advisory, but a draft that collides is not written until the
 * caller resends with `confirmCollisions: true`, so they are seen before the
 * job can queue. Backlog text is untrusted: it is scrubbed and clipped before
 * it enters a job body, and the writer's own validation still applies.
 *
 *   body     { ideaIds: string[1..8], confirmCollisions?: boolean }
 *   200      { draftId, collisions, written, existing }
 *   400/404/422/507  { error }
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  countQueuedDropJobPrompts,
  DROP_JOB_QUEUE_LIMIT,
  dropJobExists,
  DropJobExistsError,
  DropJobValidationError,
  resolveDropJobRoot,
  validateDropJob,
  writeDropJob,
  type DropJobInput,
} from '../fleet/drop-job-writer.js';
import { extractJobPaths } from '../fleet/job-precheck.js';
import { queuedCollisions, readQueuedPathClaims, type QueuedCollision, type QueuedPathClaims } from '../fleet/queued-path-claims.js';
import { loadBacklog } from '../portfolio/backlog.js';
import type { Backlog } from '../types.js';
import { scrubSecrets } from '../util/scrub.js';
import { passesMutationGate, readBody, sendJson } from './api.js';

export const IDEAS_DRAFT_PATH = '/api/ideas/draft';
export const IDEAS_DRAFT_MAX = 8;
const DRAFT_LANE = 'claude';
const DRAFT_TIER = 'work';
const TITLE_CHARS = 160;
const DETAIL_CHARS = 500;

export interface IdeasDraftResult {
  draftId: string;
  collisions: QueuedCollision[];
  /** False when the draft was held for collisions or already existed. */
  written: boolean;
  existing: boolean;
}

export interface IdeasDraftDeps {
  backlog?: () => Pick<Backlog, 'items'> | null;
  runsDir?: string;
  readQueuedClaims?: () => Promise<QueuedPathClaims>;
  write?: (root: string, input: DropJobInput) => Promise<unknown>;
}

export class IdeasDraftError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'IdeasDraftError';
  }
}

const clean = (value: unknown, max: number): string => {
  const text = typeof value === 'string' ? scrubSecrets(value).replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** Stable per idea set: order and duplicates in the request do not matter. */
export function ideasDraftId(ideaIds: readonly string[]): string {
  const digest = createHash('sha256').update([...ideaIds].sort().join('\n')).digest('hex');
  return `IDEA${digest.slice(0, 12).toUpperCase()}`;
}

function draftBody(items: ReadonlyArray<Record<string, unknown>>): string {
  const entry = (item: Record<string, unknown>) => [
    `${clean(item['title'], TITLE_CHARS) || clean(item['id'], TITLE_CHARS)} (repo: ${clean(item['repo'], 200) || 'unknown'})`,
    `Why: ${clean(item['detail'], DETAIL_CHARS) || 'no rationale recorded'}`,
    `Source: ${clean(item['source'], 40) || 'unknown'}, idea ${clean(item['id'], 200)}, score ${typeof item['score'] === 'number' ? item['score'] : 'unscored'}`,
  ];
  const lines = items.length === 1
    ? ['Goal: ' + entry(items[0]!).join('\n')]
    : ['Goal: deliver these related ideas together as one change:', ...items.map((item, i) => `${i + 1}. ${entry(item).join('\n   ')}`)];
  return `${lines.join('\n')}\n\nDrafted from the Ideas pane. Check the Source line against the repository before editing; one PR, tests included.`;
}

/** Validate, check collisions, then write (or find) the one draft for this idea set. */
export async function draftIdeas(
  input: { ideaIds: unknown; confirmCollisions?: unknown },
  deps: IdeasDraftDeps = {},
): Promise<IdeasDraftResult> {
  const raw = input.ideaIds;
  if (!Array.isArray(raw) || raw.some(id => typeof id !== 'string' || id === '' || id.length > 400)) {
    throw new IdeasDraftError(400, 'ideaIds must be a list of idea id strings');
  }
  const ids = [...new Set(raw as string[])];
  if (ids.length < 1 || ids.length > IDEAS_DRAFT_MAX) {
    throw new IdeasDraftError(400, `draft 1 to ${IDEAS_DRAFT_MAX} ideas at a time`);
  }
  const known = new Map<string, Record<string, unknown>>();
  for (const item of (deps.backlog ?? loadBacklog)()?.items ?? []) known.set(item.id, item as unknown as Record<string, unknown>);
  const missing = ids.filter(id => !known.has(id));
  if (missing.length > 0) throw new IdeasDraftError(404, `idea not in the backlog: ${clean(missing[0], 80)}`);

  const id = ideasDraftId(ids);
  const job: DropJobInput = {
    id, lane: DRAFT_LANE, tier: DRAFT_TIER,
    body: draftBody([...ids].sort().map(key => known.get(key)!)),
  };
  const verdict = validateDropJob(job);
  if (!verdict.ok) throw new IdeasDraftError(422, `draft refused: ${verdict.reasons.join(', ')}`);

  let collisions: QueuedCollision[] = [];
  try {
    const claims = await (deps.readQueuedClaims ?? readQueuedPathClaims)();
    collisions = queuedCollisions([{ name: `RQ-PHX-${id}.md`, paths: extractJobPaths(job.body) }], claims.claims);
  } catch { /* advisory: an unreadable queue never blocks a draft */ }

  const root = resolveDropJobRoot(deps.runsDir);
  if (await dropJobExists(root, id)) return { draftId: id, collisions, written: false, existing: true };
  if (collisions.length > 0 && input.confirmCollisions !== true) return { draftId: id, collisions, written: false, existing: false };
  if (!deps.write && await countQueuedDropJobPrompts(root) >= DROP_JOB_QUEUE_LIMIT) throw new IdeasDraftError(507, 'the job queue is full');
  try {
    await (deps.write ?? writeDropJob)(root, job);
  } catch (e) {
    if (e instanceof DropJobExistsError) return { draftId: id, collisions, written: false, existing: true };
    if (e instanceof DropJobValidationError) throw new IdeasDraftError(422, `draft refused: ${e.reasons.join(', ')}`);
    throw e;
  }
  return { draftId: id, collisions, written: true, existing: false };
}

export const isIdeasDraftPath = (path: string): boolean => path === IDEAS_DRAFT_PATH;

/** POST only, behind the same dispatch + token gate as every other mutation route. */
export async function handleIdeasDraftApi(
  ctx: { token: string; allowDispatch: boolean },
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  deps: IdeasDraftDeps = {},
): Promise<boolean> {
  if (method !== 'POST' || !ctx.allowDispatch) {
    sendJson(res, 404, { error: 'not found' });
    return true;
  }
  if (!passesMutationGate(req, res, ctx.token)) return true;
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req, 16_384));
  } catch {
    sendJson(res, 400, { error: 'expected a bounded JSON body' });
    return true;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)
    || Object.keys(body).some(key => key !== 'ideaIds' && key !== 'confirmCollisions')) {
    sendJson(res, 400, { error: 'expected only ideaIds and confirmCollisions' });
    return true;
  }
  try {
    sendJson(res, 200, await draftIdeas(body as { ideaIds: unknown; confirmCollisions?: unknown }, deps));
  } catch (e) {
    if (e instanceof IdeasDraftError) sendJson(res, e.status, { error: e.message });
    else sendJson(res, 500, { error: 'could not write the draft' });
  }
  return true;
}
