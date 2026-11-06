import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { readFleetLeaderHealth } from './fleet-leader-health.js';
import { readLoginHealth } from './fleet-login-health.js';

export type VerdictState = 'ok' | 'warn' | 'down';
export interface FleetVerdictOptions {
  read?: (path: string) => Promise<string>;
  now?: number;
}
export interface FleetVerdict {
  schema: 'fleet.verdict.v1';
  overall: VerdictState;
  checks: { name: 'leader' | 'login' | 'admission' | 'held-lanes'; status: VerdictState | 'unknown' }[];
  leader: Awaited<ReturnType<typeof readFleetLeaderHealth>>;
  login: Awaited<ReturnType<typeof readLoginHealth>>;
  admission: { admit: boolean; reason: string | null; load1: number | null; worktrees: number | null } | null;
  heldLanes: string[] | null;
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const measurement = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Local evidence only. An unread or invalid source can never establish health. */
export async function readFleetVerdict(opts: FleetVerdictOptions = {}): Promise<FleetVerdict> {
  const reader = opts.read ?? (path => readFile(path, 'utf8'));
  const [leader, login, status] = await Promise.all([
    readFleetLeaderHealth({ readEvents: reader, now: opts.now }), readLoginHealth(reader),
    (async (): Promise<unknown> => {
      try { return JSON.parse(await reader(join(homedir(), '.ashlr-runs', 'queue', 'status.json'))); }
      catch { return null; }
    })(),
  ]);
  let admission: FleetVerdict['admission'] = null;
  let heldLanes: string[] | null = null;
  if (record(status)) {
    const a = status.admission;
    if (record(a) && typeof a.admit === 'boolean' && (a.reason === null || typeof a.reason === 'string')) {
      admission = { admit: a.admit, reason: a.reason, load1: measurement(a.load1), worktrees: measurement(a.worktrees) };
    }
    if (record(status.lanes) && Object.values(status.lanes).every(lane => record(lane) && typeof lane.held === 'boolean')) {
      heldLanes = Object.entries(status.lanes).filter(([, lane]) => (lane as Record<string, unknown>).held).map(([name]) => name).sort();
    }
  }
  const checks: FleetVerdict['checks'] = [
    { name: 'leader', status: leader.consecutiveFailures === null ? 'unknown' : leader.consecutiveFailures >= 3 ? 'down' : leader.consecutiveFailures > 0 ? 'warn' : 'ok' },
    { name: 'login', status: login.lanes === null ? 'unknown' : login.lanes.some(lane => lane.hold && !lane.recovered) ? 'warn' : 'ok' },
    { name: 'admission', status: admission === null ? 'unknown' : !admission.admit ? 'warn' : admission.load1 === null || admission.worktrees === null ? 'unknown' : 'ok' },
    { name: 'held-lanes', status: heldLanes === null ? 'unknown' : heldLanes.length ? 'warn' : 'ok' },
  ];
  const overall = checks.some(check => check.status === 'down') ? 'down' : checks.every(check => check.status === 'ok') ? 'ok' : 'warn';
  return { schema: 'fleet.verdict.v1', overall, checks, leader, login, admission, heldLanes };
}

export async function cmdFleetVerdict(args: string[], opts: FleetVerdictOptions = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('Usage: ashlr fleet verdict [--json]\nRead leader, login, admission and held lanes. Missing evidence is unknown. Overall: ok, warn or down. Exit 0 for ok, 1 otherwise.');
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) return 2;
  const report = await readFleetVerdict(opts);
  console.log(args.includes('--json') ? JSON.stringify(sanitizePublicJson(report)) :
    [...report.checks.map(check => `${check.name}: ${check.status}`), report.overall].join('\n'));
  return report.overall === 'ok' ? 0 : 1;
}
