import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import type { Unknown } from './runtime-identity-model.js';

/** View model for GET /api/verse/fleet/runtime-identity/nodes: the same rows as `phm nodes --json`. */
export type ComputerStateCode = 'ready' | 'busy' | 'held' | 'offline' | 'not-running' | 'unknown';
export interface ComputerCard {
  name: string;
  isSelf: boolean;
  stateCode: ComputerStateCode;
  /** Plain words from the server, shown as they are. */
  state: string;
  freeMemoryBytes: number | Unknown;
  cpuHeadroomPercent: number | Unknown;
  lanes: string[] | Unknown;
  jobsRunning: number | Unknown;
  freeSlots: number | Unknown;
  /** False: seen on Tailscale only. Shown grey with its join command. */
  joined: boolean;
  joinCommand: string | null;
}
export interface ComputersView { computers: ComputerCard[]; reasons: string[] }

const MAX_CARDS = 64;
const MAX_TEXT = 160;
const STATE_CODES: readonly string[] = ['ready', 'busy', 'held', 'offline', 'not-running', 'unknown'];
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): number | Unknown => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 'unknown');
const strings = (v: unknown): string[] | null =>
  (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s !== '').slice(0, MAX_CARDS).map((s) => s.slice(0, MAX_TEXT)) : null);

/** Malformed rows are dropped and malformed fields become "unknown"; nothing is invented. */
export function narrowComputers(raw: unknown): ComputersView | null {
  if (!object(raw) || !Array.isArray(raw.nodes)) return null;
  const computers: ComputerCard[] = [];
  for (const row of raw.nodes.slice(0, MAX_CARDS)) {
    if (!object(row) || typeof row.name !== 'string' || row.name === '') continue;
    const known = typeof row.stateCode === 'string' && STATE_CODES.includes(row.stateCode) && typeof row.state === 'string' && row.state !== '';
    computers.push({
      name: row.name.slice(0, MAX_TEXT),
      isSelf: row.isSelf === true,
      stateCode: known ? row.stateCode as ComputerStateCode : 'unknown',
      state: known ? (row.state as string).slice(0, MAX_TEXT) : 'unknown',
      freeMemoryBytes: count(row.freeMemoryBytes),
      cpuHeadroomPercent: count(row.cpuHeadroomPercent),
      lanes: strings(row.lanes) ?? 'unknown',
      jobsRunning: strings(row.jobsRunning)?.length ?? 'unknown',
      freeSlots: count(row.freeSlots),
      // Older servers send no flag: treat as joined so nothing turns grey by guesswork.
      joined: row.joined !== false,
      joinCommand: row.joined === false && typeof row.joinCommand === 'string' ? row.joinCommand.slice(0, MAX_TEXT) : null,
    });
  }
  return { computers, reasons: strings(raw.reasons) ?? [] };
}

export const computersQuery: QueryDef<ComputersView | null> = {
  key: 'verse-fleet-computers',
  async fetch(signal) {
    try { return narrowComputers(await apiGet<unknown>('/api/verse/fleet/runtime-identity/nodes', signal)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
