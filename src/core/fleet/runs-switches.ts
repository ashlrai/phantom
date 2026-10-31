import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const VERSE_FLEET_CONTROL_SWITCHES_PATH = '/api/verse/fleet/control/switches';
export const RUNS_SWITCHES = [
  { id: 'ORCH_OFF', file: 'ORCH_OFF', effect: 'Stops new Claude and Sol leader passes. Workers keep running.' },
  { id: 'OPUS_LEADER_OFF', file: 'OPUS_LEADER_OFF', effect: 'Stops the hourly Opus leader.' },
  { id: 'PAUSE', file: 'PAUSE', effect: 'No new jobs launch. Running jobs finish.' },
  { id: 'PUBLISH_HOLD', file: 'PUBLISH_HOLD', effect: 'Finished jobs are not published as pull requests.' },
  { id: 'HOLD', file: 'HOLD', effect: 'Holds the dispatcher.' },
  { id: 'QUEUE_DISABLE', file: 'queue/DISABLE', effect: 'Disables the job queue.' },
] as const;
export type RunsSwitchId = (typeof RUNS_SWITCHES)[number]['id'];
export interface RunsSwitchRow { id: RunsSwitchId; on: boolean; since: string | null; effect: string }
export interface RunsSwitchesV1 { v: 1; switches: RunsSwitchRow[]; sourceState: 'healthy' | 'missing' | 'degraded' }
export interface RunsSwitchesOptions { runsDir?: string; now?: () => Date }

/** ASHLR_RUNS_DIR overrides ~/.ashlr-runs; only absolute paths are accepted. */
function runsDirectory(opts: RunsSwitchesOptions): string {
  const dir = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(dir)) throw new Error('runs directory must be absolute');
  return dir;
}
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
const owned = (stat: Stats): boolean => typeof process.getuid !== 'function' || stat.uid === process.getuid();
async function directory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || !owned(stat)) throw new Error('unsafe directory');
}

export function parseSwitchAction(body: unknown): { id: RunsSwitchId; on: boolean } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { id, on } = body as Record<string, unknown>;
  if (!RUNS_SWITCHES.some((row) => row.id === id) || typeof on !== 'boolean') return null;
  return { id: id as RunsSwitchId, on };
}

export async function readRunsSwitches(opts: RunsSwitchesOptions = {}): Promise<RunsSwitchesV1> {
  const state: RunsSwitchesV1 = { v: 1, switches: [], sourceState: 'healthy' };
  let dir: string;
  try {
    dir = runsDirectory(opts);
    await directory(dir);
  } catch (error) {
    state.sourceState = missing(error) ? 'missing' : 'degraded';
    state.switches = RUNS_SWITCHES.map(({ id, effect }) => ({ id, effect, on: false, since: null }));
    return state;
  }
  for (const { id, file, effect } of RUNS_SWITCHES) {
    const row: RunsSwitchRow = { id, effect, on: false, since: null };
    try {
      if (id === 'QUEUE_DISABLE') await directory(join(dir, 'queue'));
      const stat = await lstat(join(dir, file));
      row.on = true;
      row.since = stat.mtime.toISOString();
      if (!stat.isFile() || !owned(stat) || stat.nlink !== 1) state.sourceState = 'degraded';
    } catch (error) {
      if (!missing(error)) state.sourceState = 'degraded';
    }
    state.switches.push(row);
  }
  return state;
}

export async function setRunsSwitch(id: RunsSwitchId, on: boolean, opts: RunsSwitchesOptions = {}): Promise<RunsSwitchesV1> {
  const entry = RUNS_SWITCHES.find((row) => row.id === id);
  // Validate before even resolving a filesystem path, including for untyped callers.
  if (!entry || typeof on !== 'boolean') return { v: 1, sourceState: 'degraded', switches: RUNS_SWITCHES.map(({ id, effect }) => ({ id, effect, on: false, since: null })) };
  let failed = false;
  try {
    const dir = runsDirectory(opts);
    await directory(dir);
    if (id === 'QUEUE_DISABLE') {
      if (on) await mkdir(join(dir, 'queue'), { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      await directory(join(dir, 'queue'));
    }
    const path = join(dir, entry.file);
    if (on) {
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
        .catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; return null; });
      if (handle) {
        try { await handle.writeFile(`set by Phantom desktop ${(opts.now ?? (() => new Date()))().toISOString()}\n`); }
        finally { await handle.close(); }
      }
    } else {
      const stat = await lstat(path);
      if (stat.isFile() && owned(stat) && stat.nlink === 1) await unlink(path);
    }
  } catch (error) { failed = !missing(error); }
  const state = await readRunsSwitches(opts);
  if (failed && state.sourceState === 'healthy') state.sourceState = 'degraded';
  return state;
}
