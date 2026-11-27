/**
 * The owner-pair state file's pending-work read (`comms/owner-pair.json`),
 * split from owner-pair.ts so the unified inbox can consult it without
 * pulling the pairing machinery — the loopback bridge, the agent-network
 * rewrite and the owner-gated confirm route — into the Tier-1 authority
 * import closure. Only modules already inside that closure are imported
 * here; owner-pair.ts re-exports this surface for callers that already
 * depend on it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IMESSAGE_HANDLE_RE } from '../integrations/imessage.js';
import { loadOwnerThreadSettings } from './owner-channel.js';

/** The pending record's own shape: the state file's `pending` value. */
export interface PairPending { handles: string[]; startedAt: number; expiresAt: number; afterRowId: number }

export const PAIR_MAX_HANDLES = 4;
export const OWNER_PAIR_STATE_FILE = 'owner-pair.json';

/** The pending record's own validation, shared by every state read: older
 * files held one `handle`, invalid handles drop out, and a record missing a
 * finite send/expiry pair or a safe cursor is no pending at all. */
export function parsePendingRecord(value: unknown): PairPending | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  // Older state files held one `handle`.
  const listed = Array.isArray(p.handles) ? p.handles : typeof p.handle === 'string' ? [p.handle] : [];
  const handles = listed.filter((h): h is string => typeof h === 'string' && IMESSAGE_HANDLE_RE.test(h)).slice(0, PAIR_MAX_HANDLES);
  return handles.length > 0 && Number.isFinite(p.startedAt) && Number.isFinite(p.expiresAt) && Number.isSafeInteger(p.afterRowId)
    ? { handles, startedAt: p.startedAt as number, expiresAt: p.expiresAt as number, afterRowId: p.afterRowId as number }
    : null;
}

/** The pending record as a pending-work read reports it: a sent-handle count
 * (never the handles), the send and expiry instants, and whether an owner
 * handle is already bound — so a leftover record under a paired owner reads
 * as inert residue, not a live wait. */
export interface OwnerPairPendingSummary {
  sent: number;
  startedAt: number;
  expiresAt: number;
}

/** Honest store states for the pair wait: 'missing' is a verified-absent
 * state file (no pending record can exist), 'ok' a readable file whose
 * pending record validated under the same rule `readPairState` applies,
 * 'unavailable' a file that exists but cannot be read or parsed — a pending
 * YES wait it may be hiding stays unknown, never an empty wait passed off
 * as fact. */
export type OwnerPairPendingRead =
  | { status: 'missing' }
  | { status: 'ok'; pending: OwnerPairPendingSummary | null; paired: boolean }
  | { status: 'unavailable' };

export function readOwnerPairPending(configDir: string): OwnerPairPendingRead {
  const file = join(configDir, 'comms', OWNER_PAIR_STATE_FILE);
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'missing' } : { status: 'unavailable' }; }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { status: 'unavailable' }; }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { status: 'unavailable' };
  const pending = parsePendingRecord((raw as Record<string, unknown>).pending);
  return { status: 'ok', paired: loadOwnerThreadSettings(configDir).owners.imessage !== undefined,
    pending: pending === null ? null : { sent: pending.handles.length, startedAt: pending.startedAt, expiresAt: pending.expiresAt } };
}
