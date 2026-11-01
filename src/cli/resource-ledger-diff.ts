/** Read-only comparison of captured ledgers; no provider or journal access. */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { ResourceLedgerV1, ResourceLaneRow } from '../core/fleet/runs-resource-ledger.js';
import { QUOTA_EVIDENCE_MAX_AGE_MS } from '../core/fleet/resource-reset-evidence.js';

const MAX_BYTES = 1024 * 1024;
const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const timestamp = (x: unknown): number => typeof x === 'string' && /^\d{4}-\d\d-\d\dT/.test(x) ? Date.parse(x) : NaN;
const nullableNumber = (x: unknown): boolean => x === null || (typeof x === 'number' && Number.isFinite(x) && x >= 0);

/** Bounded descriptor read, rejecting symlinks, non-files and concurrent replacement/mutation. */
export async function readLedgerBaseline(path: string): Promise<ResourceLedgerV1> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_BYTES)) throw new Error('baseline size/type');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const part = await file.read(bytes, length, bytes.length - length, length);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (length !== Number(before.size) || [after, named].some(s => !s.isFile() ||
      s.dev !== before.dev || s.ino !== before.ino || s.size !== before.size ||
      s.mtimeNs !== before.mtimeNs || s.ctimeNs !== before.ctimeNs)) throw new Error('baseline changed');
    const data: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (!object(data) || data.v !== 1 || !Number.isFinite(timestamp(data.generatedAt)) ||
      !(data.asOf === null || Number.isFinite(timestamp(data.asOf))) || !object(data.sources) ||
      !['status', 'apiSpend', 'jobs'].every(key => ['healthy', 'missing', 'degraded'].includes(String((data.sources as Record<string, unknown>)[key]))) ||
      !('apiSpend' in data) || !(data.apiSpend === null || object(data.apiSpend)) ||
      !nullableNumber(data.jobsMalformedRows) || !Array.isArray(data.lanes) || data.lanes.length > 10000 ||
      'laneFilter' in data || 'modelFilter' in data) throw new Error('baseline schema');
    const ids = new Set<string>();
    for (const row of data.lanes) {
      if (!object(row) || typeof row.lane !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,79}$/.test(row.lane) || ids.has(row.lane) ||
        !['weekly', 'credits', 'none'].includes(String(row.window)) ||
        !['usedPct', 'creditsRemaining', 'running', 'target'].every(key => nullableNumber(row[key])) ||
        !(row.held === null || typeof row.held === 'boolean') ||
        !(row.resetAt === null || Number.isFinite(timestamp(row.resetAt))) ||
        !(row.source === null || (typeof row.source === 'string' && row.source.length <= 160)) ||
        (row.observation !== undefined && (!object(row.observation) || !Number.isFinite(timestamp(row.observation.asOf))))) throw new Error('baseline lane');
      ids.add(row.lane);
    }
    return data as unknown as ResourceLedgerV1;
  } finally { await file.close(); }
}

function observation(row: ResourceLaneRow | undefined, ledger: ResourceLedgerV1) {
  return row ? { window: row.window, usedPct: row.usedPct, creditsRemaining: row.creditsRemaining,
    resetAt: row.resetAt, source: row.source, asOf: row.observation?.asOf ?? ledger.asOf,
    running: row.running, target: row.target, held: row.held } : null;
}

export function compareLedgers(prior: ResourceLedgerV1, current: ResourceLedgerV1, now: number) {
  const old = new Map(prior.lanes.map(row => [row.lane, row]));
  const live = new Map(current.lanes.map(row => [row.lane, row]));
  return { v: 1, baselineGeneratedAt: prior.generatedAt, baselineSources: prior.sources,
    maxObservationAgeMs: QUOTA_EVIDENCE_MAX_AGE_MS,
    lanes: [...new Set([...old.keys(), ...live.keys()])].sort().map(lane => {
      const before = observation(old.get(lane), prior);
      const after = observation(live.get(lane), current);
      let reason: string | null = null;
      const fresh = (at: string | null, clock: number) => Number.isFinite(timestamp(at)) &&
        timestamp(at) <= clock && clock - timestamp(at) <= QUOTA_EVIDENCE_MAX_AGE_MS;
      if (!before || !after) reason = before ? 'removed-lane' : 'added-lane';
      else if (!fresh(before.asOf, timestamp(prior.generatedAt)) || !fresh(after.asOf, now)) reason = 'stale-or-invalid-observation';
      else if (timestamp(after.asOf) < timestamp(before.asOf)) reason = 'out-of-order-observation';
      else if (before.window !== after.window || (before.resetAt !== null && after.resetAt !== null &&
        timestamp(before.resetAt) !== timestamp(after.resetAt))) reason = 'window-transition';
      else if (before.window !== 'weekly' || before.usedPct === null || after.usedPct === null) reason = 'unknown-meter';
      else if (before.resetAt === null || after.resetAt === null) reason = 'unknown-window';
      else if (timestamp(before.resetAt) <= timestamp(before.asOf) || timestamp(after.resetAt) <= now) reason = 'expired-window';
      else if (before.source === null || before.source !== after.source) reason = 'unknown-or-changed-source';
      else if ((!old.get(lane)?.observation && prior.sources.status !== 'healthy') ||
        (!live.get(lane)?.observation && current.sources.status !== 'healthy')) reason = 'unhealthy-source';
      else if (after.usedPct < before.usedPct) reason = 'counter-decreased';
      const changed = (key: 'running' | 'target' | 'held') => before?.[key] == null || after?.[key] == null ? null : before[key] !== after[key];
      return { lane, prior: before, current: after, usagePointDelta: reason === null ? after!.usedPct! - before!.usedPct! : null,
        reason, runningChanged: changed('running'), targetChanged: changed('target'), holdChanged: changed('held') };
    }) };
}
