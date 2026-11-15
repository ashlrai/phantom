/**
 * fleet_intent_read — read-only access to the local ashlr.intent-ledger/v1
 * (owner directives and design ideas with their source, RQ keys and pulls),
 * through the same `readLedger` and status/id contract as
 * `ashlr fleet intent-read` — never a second parser. `list` returns compact
 * rows (optionally for one status) with the total matching count and a
 * truncation flag; `get` returns one directive in full. The runs directory is
 * resolved server-side by the store; there is deliberately no caller path,
 * root, environment or command argument, and nothing here writes.
 *
 * A missing ledger is an honest empty result. A corrupt, oversized, symlinked
 * or wrong-schema ledger throws, and the server reports it as a sanitized
 * tool error — never as empty success. An unknown id is a distinct
 * `found: false` result, not an error.
 */
import { INTENT_LEDGER_SCHEMA, isIntentStatus, validIntentId, type IntentItem, type IntentStatus } from '../core/intent/schema.js';
import { readLedger } from '../core/intent/store.js';

export const DEFAULT_FLEET_INTENT_LIMIT = 25;
export const MAX_FLEET_INTENT_LIMIT = 100;

export type FleetIntentReadArgs =
  | { action: 'list'; status?: IntentStatus; limit: number }
  | { action: 'get'; id: string };

export interface FleetIntentReadDeps {
  read?: typeof readLedger;
}

const LIST_KEYS = new Set(['action', 'status', 'limit']);
const GET_KEYS = new Set(['action', 'id']);

/**
 * Runtime validation: low-level SDK servers never check the tools/list
 * schema. Unknown keys, a key belonging to the other action, a bad status,
 * an invalid id and an out-of-range limit are all rejected before any read.
 */
export function parseFleetIntentReadArgs(args: Record<string, unknown>): FleetIntentReadArgs | null {
  const action = args['action'];
  if (action !== 'list' && action !== 'get') return null;
  if (Object.keys(args).some(key => !(action === 'list' ? LIST_KEYS : GET_KEYS).has(key))) return null;
  if (action === 'get') {
    const id = args['id'];
    return typeof id === 'string' && validIntentId(id) ? { action, id } : null;
  }
  const status = args['status'];
  const limit = args['limit'] ?? DEFAULT_FLEET_INTENT_LIMIT;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_FLEET_INTENT_LIMIT) return null;
  if (status === undefined) return { action, limit };
  return typeof status === 'string' && isIntentStatus(status) ? { action, status, limit } : null;
}

/** Compact list row: enough to choose a directive, small enough for 100 rows. */
function row(item: IntentItem) {
  return {
    id: item.id, title: item.title, status: item.status, source: item.source, owner: item.owner,
    rq: [...item.rq], partial: item.partial, closureProposal: item.closureProposal, lastTouchedAt: item.lastTouchedAt,
  };
}

/** Every schema field, projected by name so unknown ledger keys never pass through. */
function full(item: IntentItem) {
  return {
    ...row(item),
    prs: item.prs.map(pull => ({ repo: pull.repo, number: pull.number, url: pull.url, state: pull.state })),
    evidence: item.evidence.map(entry => ({ at: entry.at, kind: entry.kind, ref: entry.ref, note: entry.note })),
    provenance: item.provenance.map(entry => ({
      source: entry.source, date: entry.date, verbatim: entry.verbatim, partial: entry.partial,
    })),
    staleAfterMs: item.staleAfterMs, createdAt: item.createdAt, updatedAt: item.updatedAt,
  };
}

/**
 * One ledger read. Store failures propagate (the server sanitizes them); the
 * message text is never copied into the result.
 */
export async function readFleetIntent(input: FleetIntentReadArgs, deps: FleetIntentReadDeps = {}) {
  const ledger = await (deps.read ?? readLedger)();
  const base = { schemaVersion: 1 as const, schema: INTENT_LEDGER_SCHEMA, authority: 'none' as const };
  if (input.action === 'get') {
    const item = ledger.items.find(record => record.id === input.id);
    return item ? { ...base, action: 'get' as const, found: true, item: full(item) }
      : { ...base, action: 'get' as const, found: false, id: input.id };
  }
  const matching = input.status === undefined ? ledger.items : ledger.items.filter(item => item.status === input.status);
  return {
    ...base, action: 'list' as const,
    ...(input.status === undefined ? {} : { status: input.status }),
    total: matching.length, limit: input.limit, truncated: matching.length > input.limit,
    records: matching.slice(0, input.limit).map(row),
  };
}
