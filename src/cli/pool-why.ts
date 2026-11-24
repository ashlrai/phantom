/** Explain the same typed evidence the leader reads. Read-only. */
import { readFleetPace, type FleetPaceV1 } from '../core/fleet/pace-verdict.js';
export async function cmdPoolWhy(args: string[], read: () => Promise<FleetPaceV1> = readFleetPace): Promise<number> {
  const [pool, ...flags] = args;
  if (!pool || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(pool) || flags.length > 1 || flags.some(f => f !== '--json')) {
    console.error('Usage: phm pool why <pool> [--json]'); return 2;
  }
  const row = (await read()).pools.find(p => p.pool === pool);
  if (!row) { console.error('Pool not recorded'); return 1; }
  const explanation = `${row.line ?? `${pool}: ${row.verdict ?? 'unknown'}`} Source: ${row.source ?? 'queue/status.json; no capture time recorded'}.`;
  console.log(flags.includes('--json') ? JSON.stringify({ schema: 'pool.why.v1', ...row, explanation }) : explanation);
  return 0;
}
