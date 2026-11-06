/**
 * routes/verse/ops/ops-queries.ts : the Ops section's reads and its one
 * write. Every read is a projection over the shared buses (team event log,
 * fleet queue/tick, calibration harness, companion ledger) served by
 * /api/verse/ops/*; the write posts to the leaders' channel on the team bus,
 * the same `message.posted` event `phm team say` appends.
 *
 * Narrowing is load-bearing: the buses are local files a future schema can
 * grow, so each fetch validates the rows it renders and fails the query
 * (into the view's unavailable state) rather than render a wrong shape.
 */
import type {
  OpsBoardV1,
  OpsFleetV1,
  OpsLeadersV1,
  OpsReleasesV1,
  OpsTaskRow,
} from '../../../../core/verse/ops-types.js';
import {
  VERSE_OPS_BOARD_PATH,
  VERSE_OPS_FLEET_PATH,
  VERSE_OPS_LEADERS_MESSAGES_PATH,
  VERSE_OPS_LEADERS_PATH,
  VERSE_OPS_RELEASES_PATH,
} from '../../../../core/verse/ops-types.js';
import { apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { invalidate } from '../../../data/cache.js';
import type { QueryDef } from '../../../data/queries.js';
import { VerseMutationLockedError } from '../verse-queries.js';

export const OPS_BOARD_KEY = 'verse-ops-board';
export const OPS_FLEET_KEY = 'verse-ops-fleet';
export const OPS_RELEASES_KEY = 'verse-ops-releases';
export const OPS_LEADERS_KEY = 'verse-ops-leaders';

const COLUMNS = ['next', 'active', 'held', 'done', 'closed'] as const;
const SOURCES = ['fleet', 'handoff', 'companion'] as const;
const SOURCE_STATES = ['healthy', 'degraded'] as const;

const isStr = (v: unknown): v is string => typeof v === 'string';
const optStr = (v: unknown): v is string | null => v === null || typeof v === 'string';

function validTaskRow(row: unknown): row is OpsTaskRow {
  const r = row as OpsTaskRow;
  return !!r && typeof r === 'object'
    && isStr(r.id) && (SOURCES as readonly string[]).includes(r.source) && isStr(r.title)
    && optStr(r.repo) && (COLUMNS as readonly string[]).includes(r.column)
    && optStr(r.assignee) && optStr(r.estimate)
    && (r.outcome === null || (!!r.outcome && typeof r.outcome === 'object' && isStr(r.outcome.state) && optStr(r.outcome.text)))
    && typeof r.needsYou === 'boolean' && isStr(r.updatedAt);
}

export const opsBoardQuery: QueryDef<OpsBoardV1> = {
  key: OPS_BOARD_KEY,
  async fetch(signal) {
    const value = await apiGet<OpsBoardV1>(VERSE_OPS_BOARD_PATH, signal);
    if (!value || value.v !== 1 || !value.columns || !value.counts || !value.sources) throw new Error('The board is unavailable.');
    if (!COLUMNS.every((c) => Array.isArray(value.columns[c]) && value.columns[c].every(validTaskRow) && typeof value.counts[c] === 'number')
      || !SOURCES.every((s) => (SOURCE_STATES as readonly string[]).includes(value.sources[s]))) throw new Error('The board is unavailable.');
    return value;
  },
};

export const opsFleetQuery: QueryDef<OpsFleetV1> = {
  key: OPS_FLEET_KEY,
  async fetch(signal) {
    const value = await apiGet<OpsFleetV1>(VERSE_OPS_FLEET_PATH, signal);
    if (!value || value.v !== 1 || !value.sources
      || !(SOURCE_STATES as readonly string[]).includes(value.sources.tick)
      || !(SOURCE_STATES as readonly string[]).includes(value.sources.journal)
      || !(SOURCE_STATES as readonly string[]).includes(value.sources.learning)
      || !(value.lanes === null || Array.isArray(value.lanes))
      || !Array.isArray(value.held) || !Array.isArray(value.decisions) || !Array.isArray(value.experiments)) {
      throw new Error('The fleet projection is unavailable.');
    }
    return value;
  },
};

export const opsReleasesQuery: QueryDef<OpsReleasesV1> = {
  key: OPS_RELEASES_KEY,
  async fetch(signal) {
    const value = await apiGet<OpsReleasesV1>(VERSE_OPS_RELEASES_PATH, signal);
    if (!value || value.v !== 1 || !Array.isArray(value.repos)
      || !(SOURCE_STATES as readonly string[]).includes(value.sourceState)) throw new Error('Release status is unavailable.');
    return value;
  },
};

export const opsLeadersQuery: QueryDef<OpsLeadersV1> = {
  key: OPS_LEADERS_KEY,
  async fetch(signal) {
    const value = await apiGet<OpsLeadersV1>(VERSE_OPS_LEADERS_PATH, signal);
    if (!value || value.v !== 1 || !Array.isArray(value.leaders) || !Array.isArray(value.messages)
      || !Array.isArray(value.channels) || !Array.isArray(value.openHandoffs) || !Array.isArray(value.pendingApprovals)
      || typeof value.canPost !== 'boolean') throw new Error('The leaders channel is unavailable.');
    return value;
  },
};

/** Post to the leaders' channel on the team bus. Rejects when the console is read-only. */
export async function postLeaderMessage(text: string): Promise<void> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const result = await apiPost<{ ok?: boolean }>(VERSE_OPS_LEADERS_MESSAGES_PATH, { text }, token);
  if (!result || result.ok !== true) throw new Error('The message could not be confirmed. Refresh and check the channel.');
  touchMutationHold();
  invalidate(OPS_LEADERS_KEY);
}
