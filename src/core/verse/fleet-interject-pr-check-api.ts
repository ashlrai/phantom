/** Desktop second reader for the "Tell the leaders" box: an inbox entry the
 * order trace calls merged is the trace's word until GitHub agrees. Takes
 * `?pr=<n>` (repeatable, max 5); the repo is fixed to ashlrai/phantom and no
 * repo input exists. GET only, read-only, authority-free: it never writes,
 * comments or merges, and never sends gh or parser error text. Unknown
 * verdicts carry only a fixed reason code. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { defaultGh, type Gh } from '../autopilot/github.js';

export const VERSE_FLEET_INTERJECT_PR_CHECK_PATH = '/api/verse/fleet/control/interject-pr-check';
export const INTERJECT_PR_CHECK_REPO = 'ashlrai/phantom';
export const INTERJECT_PR_CHECK_MAX_PRS = 5;
export const INTERJECT_PR_CHECK_CACHE_MS = 60_000;
export const INTERJECT_PR_CHECK_TIMEOUT_MS = 20_000;

export type InterjectPrVerdict = 'merged' | 'open' | 'closed-unmerged' | 'unknown';
export type InterjectPrReason = 'read-failed' | 'invalid-response-identity' | 'unparseable' | 'deadline';

export interface InterjectPrCheckItem {
  pr: number;
  verdict: InterjectPrVerdict;
  mergedAt: string | null;
  reason?: InterjectPrReason;
}

export interface InterjectPrCheckBody {
  v: 1;
  authority: 'none';
  generatedAt: string;
  items: InterjectPrCheckItem[];
}

export interface FleetInterjectPrCheckApiDeps {
  /** GitHub seam for tests. Default: the gh CLI. */
  gh?: Gh;
  /** Clock seam for tests. */
  now?: () => number;
  timeoutMs?: number;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const unknown = (pr: number, reason: InterjectPrReason, mergedAt: string | null = null): InterjectPrCheckItem =>
  ({ pr, verdict: 'unknown', mergedAt, reason });

async function readOne(gh: Gh, pr: number): Promise<InterjectPrCheckItem> {
  let raw: Json;
  try {
    raw = obj(JSON.parse(await gh(['api', '-H', 'Accept: application/vnd.github+json', `repos/${INTERJECT_PR_CHECK_REPO}/pulls/${pr}`])));
  } catch {
    return unknown(pr, 'read-failed');
  }
  // Same identity binding as return-pr-check.ts: a supplied identity must match.
  const base = raw['base'];
  const baseRepo = obj(base)['repo'];
  const fullName = obj(baseRepo)['full_name'];
  if (('number' in raw && raw['number'] !== pr)
    || ('base' in raw && (base === null || typeof base !== 'object' || Array.isArray(base)))
    || ('repo' in obj(base) && (baseRepo === null || typeof baseRepo !== 'object' || Array.isArray(baseRepo)))
    || ('full_name' in obj(baseRepo) && (typeof fullName !== 'string' || fullName.toLowerCase() !== INTERJECT_PR_CHECK_REPO))) {
    return unknown(pr, 'invalid-response-identity');
  }
  const mergedAt = typeof raw['merged_at'] === 'string' && raw['merged_at'].length > 0 ? raw['merged_at'] : null;
  if (raw['merged'] === true || mergedAt !== null) return { pr, verdict: 'merged', mergedAt };
  if (raw['state'] === 'open') return { pr, verdict: 'open', mergedAt: null };
  if (raw['state'] === 'closed') return { pr, verdict: 'closed-unmerged', mergedAt: null };
  return unknown(pr, 'unparseable');
}

/** Null when the query is not exactly 1..5 `pr` keys of safe integers >= 1. */
export function parseInterjectPrQuery(url: string): number[] | null {
  const q = url.indexOf('?');
  if (q === -1) return null;
  const prs: number[] = [];
  for (const [key, value] of new URLSearchParams(url.slice(q + 1))) {
    if (key !== 'pr' || !/^[0-9]{1,15}$/.test(value)) return null;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1) return null;
    if (!prs.includes(n)) prs.push(n);
    if (prs.length > INTERJECT_PR_CHECK_MAX_PRS) return null;
  }
  return prs.length > 0 ? prs : null;
}

export function createFleetInterjectPrCheckApi(deps: FleetInterjectPrCheckApiDeps = {}): ApiModule {
  const gh = deps.gh ?? defaultGh;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? INTERJECT_PR_CHECK_TIMEOUT_MS;
  // Per-PR cache: only real reads are held; deadline and failure rows are retried.
  const cache = new Map<number, { at: number; item: InterjectPrCheckItem }>();
  const inflight = new Map<number, Promise<InterjectPrCheckItem>>();

  function read(pr: number): Promise<InterjectPrCheckItem> {
    let p = inflight.get(pr);
    if (!p) {
      p = readOne(gh, pr).then(item => {
        if (item.reason !== 'read-failed') cache.set(pr, { at: now(), item });
        return item;
      }).finally(() => { inflight.delete(pr); });
      inflight.set(pr, p);
    }
    return p;
  }

  async function sweep(prs: number[]): Promise<InterjectPrCheckBody> {
    const start = now();
    const deadline = start + timeoutMs;
    const items: InterjectPrCheckItem[] = [];
    let expired = false;
    for (const pr of prs) {
      const hit = cache.get(pr);
      if (hit && now() - hit.at >= 0 && now() - hit.at < INTERJECT_PR_CHECK_CACHE_MS) { items.push(hit.item); continue; }
      const remaining = deadline - now();
      if (expired || remaining <= 0) { items.push(unknown(pr, 'deadline')); continue; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), remaining); });
      const item = await Promise.race([read(pr), timeout]).finally(() => clearTimeout(timer));
      if (item === null) { expired = true; items.push(unknown(pr, 'deadline')); } else items.push(item);
    }
    return { v: 1, authority: 'none', generatedAt: new Date(start).toISOString(), items };
  }

  return async (_ctx, req, res, path, method) => {
    if (path !== VERSE_FLEET_INTERJECT_PR_CHECK_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    const prs = parseInterjectPrQuery(req.url ?? '');
    if (prs === null) {
      sendJson(res, 400, { error: 'expected 1 to 5 pr parameters, each a positive integer' });
      return true;
    }
    try {
      sendJson(res, 200, await sweep(prs));
    } catch {
      sendJson(res, 500, { error: 'interject pr check failed' });
    }
    return true;
  };
}

export const handleFleetInterjectPrCheckApi: ApiModule = createFleetInterjectPrCheckApi();
