/**
 * Native MCP `intent_add` / `intent_update`: create and revise local intent
 * ledger directives through the existing edit transaction
 * (src/core/intent/edit.ts). Recovered from PR #4516
 * (RQ-PHX-INTENTEDITNATIVE09SQA1) against the current schema, store and edit
 * contracts: IDs validate with validIntentId (not the retired int-<hex> shape),
 * evidence stays caller-reported tracking, and every refusal leaves the
 * persisted ledger bytes untouched. Static imports stay pure; the module is
 * only loaded by callNativeTool's gated dispatch, never by tools/list.
 */
import { fixedOwnerRunsDir } from '../comms/owner-channel.js';
import { addIntent, updateIntent, type IntentAddInput, type IntentUpdateInput } from './edit.js';
import {
  MAX_OWNER, MAX_RQ, MAX_SOURCE, MAX_TITLE, isIntentStatus, normalizeRq, validIntentId,
} from './schema.js';

const ADD_KEYS = ['title', 'source', 'owner', 'rq', 'status', 'verbatim', 'staleAfterMs', 'partial'];
const UPDATE_KEYS = ['id', 'title', 'source', 'owner', 'rq', 'status', 'evidence', 'partial'];
const MAX_STALE_AFTER_MS = 365 * 24 * 60 * 60 * 1000;

const boundedText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

/** Exact wire contract for intent_add / intent_update; rejects before any persistence. */
export function validNativeEdit(name: string, raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const args = raw as Record<string, unknown>;
  const add = name === 'intent_add';
  const allowed = add ? ADD_KEYS : UPDATE_KEYS;
  if (Object.keys(args).some(key => !allowed.includes(key))) return false;
  if (add) {
    if (!boundedText(args.title, MAX_TITLE) || !boundedText(args.source, MAX_SOURCE)) return false;
  } else if (typeof args.id !== 'string' || !validIntentId(args.id)) {
    return false;
  }
  if ('title' in args && !add && !boundedText(args.title, MAX_TITLE)) return false;
  if ('source' in args && !add && !boundedText(args.source, MAX_SOURCE)) return false;
  if ('owner' in args && !boundedText(args.owner, MAX_OWNER)) return false;
  if ('status' in args && (typeof args.status !== 'string' || !isIntentStatus(args.status))) return false;
  for (const key of ['partial', 'verbatim'] as const) {
    if (key in args && typeof args[key] !== 'boolean') return false;
  }
  if ('staleAfterMs' in args &&
      (!Number.isSafeInteger(args.staleAfterMs) ||
        (args.staleAfterMs as number) < 60_000 || (args.staleAfterMs as number) > MAX_STALE_AFTER_MS)) return false;
  if ('rq' in args) {
    if (!Array.isArray(args.rq) || args.rq.length > MAX_RQ ||
        args.rq.some(key => typeof key !== 'string')) return false;
    try { (args.rq as string[]).forEach(key => normalizeRq(key)); } catch { return false; }
  }
  if ('evidence' in args && !boundedText(args.evidence, MAX_SOURCE)) return false;
  return true;
}

/**
 * Record the directive through the ledger transaction. Caller evidence is
 * tracking only — never proof of shipment or verification. Any failure
 * (validation, capacity, secret-shaped text, lock contention) is a refusal
 * payload; the persisted bytes stay untouched.
 */
export async function nativeEdit(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    const { assertMetadata } = await import('../connectors/profile.js');
    assertMetadata(JSON.stringify(args));
    const root = fixedOwnerRunsDir();
    if (name === 'intent_add') {
      return { ok: true, item: await addIntent(args as unknown as IntentAddInput, root) };
    }
    const { id, evidence, ...patch } = args;
    return {
      ok: true,
      item: await updateIntent(id as string, {
        ...patch,
        ...(evidence !== undefined ? { evidence: { ref: evidence as string } } : {}),
      } as IntentUpdateInput, root),
    };
  } catch {
    return { error: 'Intent edit failed.' };
  }
}
