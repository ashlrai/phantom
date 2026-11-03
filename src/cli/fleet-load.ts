import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sanitizePublicJson } from '../core/util/public-json.js';

export interface FleetLoad {
  status: 'ok' | 'warn' | 'red';
  load1: number | null; ncpu: number | null; load_max: number | null;
  procs: number | null; worktrees: number | null; running: number | null;
  cap: number | null; daemon_tick_age_s: number | null;
  warnings: string[];
}
export interface FleetLoadOptions {
  read?: (path: string) => Promise<string>;
  write?: (text: string) => void;
}

/** Read only the dispatcher's admission projection; never probe or change the host. */
export async function readFleetLoad(read: NonNullable<FleetLoadOptions['read']> = path => readFile(path, 'utf8')): Promise<FleetLoad> {
  let admission: Record<string, unknown> = {};
  let unavailable = false;
  try {
    const raw: unknown = JSON.parse(await read(join(homedir(), '.ashlr-runs', 'queue', 'status.json')));
    const value = (raw as { admission?: unknown } | null)?.admission;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('missing admission');
    admission = value as Record<string, unknown>;
  } catch { unavailable = true; }
  const number = (key: string): number | null => {
    const value = admission[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  };
  const result: FleetLoad = {
    status: 'ok', load1: number('load1'), ncpu: number('ncpu'), load_max: number('load_max'),
    procs: number('procs'), worktrees: number('worktrees'), running: number('running'),
    cap: number('cap'), daemon_tick_age_s: number('daemon_tick_age_s'),
    warnings: Array.isArray(admission.warnings) ? admission.warnings.filter((v): v is string => typeof v === 'string') : [],
  };
  if (unavailable) result.warnings.push('Queue status is unavailable.');
  if (Object.values(result).some(value => value === null)) result.warnings.push('Some load measurements are unknown.');
  const loadHigh = result.load1 !== null && result.load_max !== null && result.load1 > result.load_max;
  const loadRed = result.load1 !== null && result.load_max !== null && result.load1 > 2 * result.load_max;
  const tickRed = result.daemon_tick_age_s !== null && result.daemon_tick_age_s > 1800;
  if (loadHigh) result.warnings.push('Load is above the load limit.');
  if (tickRed) result.warnings.push('The daemon last tick was over 1800 seconds ago.');
  if (result.worktrees !== null && result.worktrees > 40) result.warnings.push('Worktrees are above 40.');
  result.status = unavailable || loadRed || tickRed ? 'red' : result.warnings.length ? 'warn' : 'ok';
  return sanitizePublicJson(result) as FleetLoad;
}

export async function cmdFleetLoad(args: string[], options: FleetLoadOptions = {}): Promise<number> {
  const write = options.write ?? (text => process.stdout.write(text));
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    write('Usage: ashlr fleet load [--json]\nRead queue load, running jobs and admission warnings.\n');
    return 0;
  }
  if (args.some(arg => arg !== '--json') || args.length > 1) return 2;
  const result = await readFleetLoad(options.read);
  const show = (value: number | null) => value ?? 'unknown';
  write(args.includes('--json') ? JSON.stringify(result) + '\n' : [
    `Fleet load: ${result.status}`,
    `Load: ${show(result.load1)}; CPUs: ${show(result.ncpu)}; load limit: ${show(result.load_max)}`,
    `Processes: ${show(result.procs)}; worktrees: ${show(result.worktrees)}`,
    `Running: ${show(result.running)} of ${show(result.cap)}`,
    `Daemon last tick: ${show(result.daemon_tick_age_s)} seconds ago`,
    ...result.warnings.map(warning => `Warning: ${warning}`),
  ].join('\n') + '\n');
  return result.status === 'red' ? 1 : 0;
}
