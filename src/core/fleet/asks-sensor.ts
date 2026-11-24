/**
 * Asks software can answer itself. A usage percent or a reset time is something a sensor already reads, so the
 * fleet uses that reading and records what it did instead of raising an ask for Mason (the record is a
 * `fleet-action` line in the answers ledger, shown by `phm asks list --all`).
 *
 * Reads only: no sign-in, no spend. A reading older than USAGE_RUNWAY_STALE_MS is not used, so the ask is raised
 * as before rather than answered from stale data.
 */
import { USAGE_POOLS } from '../fabric/usage-signal-writer.js';
import { appendAskLedger, readFleetActions, type AskLedgerRecord } from './asks-ledger.js';
import { listAskBatch, type AskBatch, type FleetHandled } from './asks-batch.js';
import { listAsks, raiseAsk, runsDirOf, type AsksOptions, type RaiseAskResult } from './asks.js';
import { readUsageSamples, USAGE_RUNWAY_STALE_MS, type UsageReading } from './usage-history.js';

export interface SensorReading { pool: string; pctUsed: number; resetAt: string | null; sensor: string; at: string }
export interface SensorDeps { readSamples?: (opts: { runsDir: string; nowMs: number }) => Promise<UsageReading[]> }

/** The newest fresh sensor reading for a pool, or null (none, or too old to trust). */
export async function readUsageSensor(pool: string, options: AsksOptions = {}, deps: SensorDeps = {}): Promise<SensorReading | null> {
  const nowMs = (options.now ?? Date.now)();
  let rows: UsageReading[];
  try { rows = await (deps.readSamples ?? readUsageSamples)({ runsDir: runsDirOf(options), nowMs }); } catch { return null; }
  let newest: UsageReading | null = null;
  for (const row of rows) {
    const at = Date.parse(row.observed_at);
    if (row.pool !== pool || !Number.isFinite(at) || !(row.used_pct >= 0 && row.used_pct <= 100) || nowMs - at > USAGE_RUNWAY_STALE_MS) continue;
    if (!newest || at >= Date.parse(newest.observed_at)) newest = row;
  }
  return newest && { pool, pctUsed: newest.used_pct, resetAt: newest.reset_at, sensor: newest.source ?? 'usage-history', at: new Date(newest.observed_at).toISOString() };
}

/** "read from sensor <name> at <time>", then the value, in plain words. */
export const sensorActionText = (r: SensorReading): string =>
  `read from sensor ${r.sensor} at ${r.at}: ${r.pool} is ${r.pctUsed}% used${r.resetAt ? `, resets ${r.resetAt}` : ''}`;

export type AskOrActionResult = RaiseAskResult | { ok: true; handled: true; id: null; action: string };

/**
 * Raise an ask unless software can read the value: a usage ask whose pool has a fresh sensor reading becomes a recorded
 * action. Every other ask goes to raiseAsk unchanged.
 */
export async function raiseAskOrRead(kind: unknown, request: unknown, options: AsksOptions = {},
  extra: { subject?: string; unblocks?: string; expires?: string } = {}, deps: SensorDeps = {}): Promise<AskOrActionResult> {
  const pool = extra.subject?.trim().toLowerCase();
  if (kind === 'usage' && pool && (USAGE_POOLS as readonly string[]).includes(pool)) {
    const reading = await readUsageSensor(pool, options, deps);
    if (reading) {
      const action = sensorActionText(reading);
      const record: AskLedgerRecord = {
        schema: 'asks.ledger.v1', type: 'fleet-action', askId: `fleet-${reading.at}`, kind: 'usage', subject: pool, channel: 'fleet',
        source: 'fleet', at: new Date((options.now ?? Date.now)()).toISOString(), reply: '', pool, pctUsed: reading.pctUsed, action,
        question: typeof request === 'string' ? request.replace(/\s+/g, ' ').trim().slice(0, 200) : '',
      };
      if (!appendAskLedger(runsDirOf(options), record)) return { ok: false, reason: 'The sensor reading was found but the action could not be recorded.' };
      return { ok: true, handled: true, id: null, action };
    }
  }
  return raiseAsk(kind, request, options, extra);
}

/**
 * Everything, for `phm asks list --all`: the open asks of every type, each with what the fleet did instead (a usage ask
 * is read from its sensor now), plus the asks the fleet already answered itself.
 */
export async function listAskBatchAll(options: AsksOptions = {}, deps: SensorDeps = {}): Promise<AskBatch> {
  const open = listAsks(options);
  const readings = new Map<string, SensorReading>();
  for (const ask of open.asks) {
    if (ask.kind === 'usage' && ask.subject && !readings.has(ask.subject)) {
      const reading = await readUsageSensor(ask.subject, options, deps);
      if (reading) readings.set(ask.subject, reading);
    }
  }
  const did = (ask: { kind: string; subject: string | null }): string | null =>
    ask.kind === 'usage' && ask.subject && readings.has(ask.subject) ? sensorActionText(readings.get(ask.subject)!) : null;
  const batch = listAskBatch(options, () => open, true, did);
  const fleetHandled: FleetHandled[] = readFleetActions({ runsDir: runsDirOf(options) })
    .map(row => ({ question: row.question ?? `${row.kind} ask for ${row.subject ?? 'the fleet'}`, fleetDid: row.action!, at: row.at }));
  return { ...batch, fleetHandled };
}
