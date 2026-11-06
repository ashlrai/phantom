import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sanitizePublicJson } from '../core/util/public-json.js';

export type LoginHealthReader = (path: string) => Promise<string>;
export interface LoginHealthLane {
  lane: string;
  hold: { ts: string; pattern: string } | null;
  recovered: boolean | null;
}

/** Read only metrics; never probe credentials or start a job. */
export async function readLoginHealth(reader: LoginHealthReader = path => readFile(path, 'utf8')) {
  const unknown = { schema: 'fleet.login-health.v1', status: 'unknown', lanes: null } as const;
  let contents: string;
  try { contents = await reader(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl')); }
  catch { return unknown; }
  const events: { lane: string; ts: string; time: number; event: unknown; pattern: unknown; empty: unknown }[] = [];
  for (const line of contents.split('\n').filter(line => line.trim())) {
    try {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) return unknown;
      const r = row as Record<string, unknown>;
      if (typeof r.lane !== 'string' || !r.lane) continue;
      if (typeof r.ts !== 'string' || !Number.isFinite(Date.parse(r.ts))) return unknown;
      events.push({ lane: r.lane, ts: r.ts, time: Date.parse(r.ts), event: r.event, pattern: r.pattern, empty: r.empty });
    } catch { return unknown; }
  }
  events.sort((a, b) => a.time - b.time);
  const lanes = new Map<string, LoginHealthLane>();
  for (const row of events) {
    let lane = lanes.get(row.lane);
    if (!lane) { lane = { lane: row.lane, hold: null, recovered: null }; lanes.set(row.lane, lane); }
    if (row.event === 'autobackoff_hold' && typeof row.pattern === 'string' && /expired/i.test(row.pattern)) {
      lane.hold = { ts: row.ts, pattern: row.pattern };
      lane.recovered = false;
    } else if (row.event === 'finish' && row.empty === false && lane.hold && row.time > Date.parse(lane.hold.ts)) {
      lane.recovered = true;
    }
  }
  return { schema: 'fleet.login-health.v1', status: 'ok', lanes: [...lanes.values()].sort((a, b) => a.lane.localeCompare(b.lane)) };
}

export async function cmdFleetLoginHealth(args: string[], reader?: LoginHealthReader): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('Usage: ashlr fleet login-health [--json]\nShow expired-login holds and later nonempty finishes. Unread metrics are unknown.');
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) return 2;
  const result = await readLoginHealth(reader);
  console.log(sanitizePublicJson(args.includes('--json') ? JSON.stringify(sanitizePublicJson(result)) : result.lanes === null ? 'Login health: unknown'
    : result.lanes.length === 0 ? 'No lanes observed.' : result.lanes.map(lane =>
      `${lane.lane}: ${lane.hold ? `expired login at ${lane.hold.ts}; later nonempty finish: ${lane.recovered ? 'yes' : 'no'}` : 'no expired-login hold observed'}`).join('\n')));
  return 0;
}
