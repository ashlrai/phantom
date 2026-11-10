/**
 * Native MCP handlers for the intent ledger's stale sweep and merge/release
 * evidence, recovered from PR #4235's intent_stale, intent_link and
 * intent_ship registrations onto the current intent modules.
 *
 * These tools persist caller-supplied tracking evidence only. They never read
 * the network, verify a merge or release on GitHub, publish anything, or mark
 * a directive verified. The ledger root is the store default (ASHLR_RUNS_DIR
 * or ~/.ashlr-runs); callers cannot choose a filesystem root.
 */
import { linkMergedPull, MAX_RELEASE_REF } from './evidence.js';
import { noteShippedRelease } from './release.js';
import { MAX_RQ, normalizeRq, validRepo } from './schema.js';
import { readLedger, writeLedger } from './store.js';
import { sweepStale } from './sweep.js';

const STALE_KEYS = ['apply'];
const LINK_KEYS = ['repo', 'number', 'title', 'branch', 'url'];
const SHIP_KEYS = ['release', 'notes', 'rq'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(args: Record<string, unknown>, key: string): boolean {
  return !(key in args) || typeof args[key] === 'string';
}

/**
 * Exact wire-contract check for the intent evidence tools, run by
 * callNativeTool before the safety gate. The general schema validator tolerates
 * unknown keys and cannot see array item types, so these tools validate here:
 * no unknown keys, required fields present, and every value the right type.
 */
export function validNativeEvidence(name: string, raw: unknown): boolean {
  if (name !== 'intent_stale' && name !== 'intent_link' && name !== 'intent_ship') return false;
  if (!isRecord(raw)) return false;
  const allowed = name === 'intent_stale' ? STALE_KEYS : name === 'intent_link' ? LINK_KEYS : SHIP_KEYS;
  if (Object.keys(raw).some((key) => !allowed.includes(key))) return false;
  if (name === 'intent_stale') {
    return !('apply' in raw) || typeof raw['apply'] === 'boolean';
  }
  if (name === 'intent_link') {
    return typeof raw['repo'] === 'string' && validRepo(raw['repo'])
      && typeof raw['number'] === 'number' && Number.isSafeInteger(raw['number']) && (raw['number'] as number) >= 1
      && typeof raw['title'] === 'string' && raw['title'].trim().length > 0
      && optionalString(raw, 'branch') && optionalString(raw, 'url');
  }
  const release = typeof raw['release'] === 'string' ? raw['release'].replace(/[\r\n]+/g, ' ').trim() : '';
  if (!release || release.length > MAX_RELEASE_REF || !optionalString(raw, 'notes')) return false;
  if ('rq' in raw) {
    const rq = raw['rq'];
    if (!Array.isArray(rq) || rq.length > MAX_RQ || rq.some((key) => typeof key !== 'string')) return false;
    try {
      rq.forEach((key) => normalizeRq(key as string));
    } catch {
      return false;
    }
  }
  return true;
}

/** intent_stale: preview unless apply is true; sweepStale never closes or dispatches. */
export async function nativeIntentStale(args: Record<string, unknown>): Promise<unknown> {
  return { ok: true, ...(await sweepStale({ apply: args['apply'] === true })) };
}

/** intent_link: persist one caller-reported merged pull against matching directives. */
export async function nativeIntentLink(args: Record<string, unknown>): Promise<unknown> {
  const ledger = await readLedger();
  if (ledger.items.length === 0) return { ok: true, updated: 0, matches: [] };
  const matched = linkMergedPull(ledger, {
    repo: args['repo'] as string,
    number: args['number'] as number,
    title: args['title'] as string,
    branch: args['branch'] as string | undefined,
    url: args['url'] as string | undefined,
  }, new Date().toISOString());
  if (matched.length > 0) await writeLedger(ledger);
  return {
    ok: true,
    updated: matched.length,
    matches: matched.map(({ id, status }) => ({ id, status })),
  };
}

/** intent_ship: persist one caller-reported release against matching directives. */
export async function nativeIntentShip(args: Record<string, unknown>): Promise<unknown> {
  const result = await noteShippedRelease({
    release: args['release'] as string,
    notes: args['notes'] as string | undefined,
    rq: Array.isArray(args['rq']) ? args['rq'] as string[] : undefined,
  });
  return { ok: true, ...result };
}
