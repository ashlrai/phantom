/**
 * Native MCP `intent_stale`: preview or apply the local stale-directive sweep.
 * Preview never writes; apply persists only the tracking transitions
 * sweepStale permits (live directives re-queue, other stale entries keep
 * their status and gain a sweep evidence row). Nothing here closes an
 * outcome, dispatches work, verifies anything remotely or claims completion.
 * The ledger root is the store default (ASHLR_RUNS_DIR or ~/.ashlr-runs);
 * callers cannot choose a filesystem root. Store imports stay lazy so
 * tools/list does not load the ledger.
 */
import { assertMetadata } from '../connectors/profile.js';

const STALE_KEYS = ['apply'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Exact wire-contract check for intent_stale, run by callNativeTool before
 * the safety gate. The general schema validator tolerates unknown keys and
 * cannot see array item types, so this tool validates here: object only, no
 * unknown keys, and `apply` boolean when present.
 */
export function validStaleArgs(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  if (Object.keys(raw).some((key) => !STALE_KEYS.includes(key))) return false;
  return !('apply' in raw) || typeof raw['apply'] === 'boolean';
}

/** intent_stale: preview unless apply is true; sweepStale never closes or dispatches. */
export async function nativeIntentStale(args: Record<string, unknown>): Promise<unknown> {
  try {
    assertMetadata(JSON.stringify(args));
    const { sweepStale } = await import('./sweep.js');
    return { ok: true, ...(await sweepStale({ apply: args['apply'] === true })) };
  } catch {
    return { error: 'Intent stale sweep could not run.' };
  }
}
