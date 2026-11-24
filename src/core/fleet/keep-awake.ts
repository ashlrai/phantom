/**
 * Opt-in keep-awake for the self-tick. While jobs are running or queued and the Mac is on power, the tick holds
 * a standard macOS idle-sleep assertion (`caffeinate -i -w <tick pid>`), released as soon as the queue is empty
 * or the tick ends. Off by default; `phm fleet awake on` creates the one switch file, `off` (or deleting that file
 * by hand) is the kill switch. It only ever asks for an assertion: it never reads or changes a system power setting.
 */
import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const KEEP_AWAKE_SCHEMA = 'fleet.awake.v1';
/** The single switch: present = on. Delete it to turn keep-awake off. */
export const KEEP_AWAKE_FILE = 'queue/keep-awake.on';
const LAST_FILE = 'queue/keep-awake-last.json';

export type AwakeState = 'off' | 'held' | 'queue-empty' | 'on-battery' | 'power-unknown' | 'not-macos' | 'unavailable';
export interface AwakeLast { at: string; state: AwakeState; queued: number | null }
export type Power = 'ac' | 'battery' | 'unknown';

export interface AwakeStatus {
  schema: typeof KEEP_AWAKE_SCHEMA;
  enabled: boolean;
  /** Absolute path of the switch file. */
  switchFile: string;
  /** What the last real self-tick did; null before any tick recorded one. */
  last: AwakeLast | null;
  line: string;
}

export const awakeEnabled = (runsDir: string): boolean => existsSync(join(runsDir, KEEP_AWAKE_FILE));

export function setAwake(runsDir: string, on: boolean): void {
  const path = join(runsDir, KEEP_AWAKE_FILE);
  if (on) { mkdirSync(join(runsDir, 'queue'), { recursive: true }); writeFileSync(path, 'on\n', { mode: 0o600 }); }
  else { try { unlinkSync(path); } catch { /* already off */ } }
}

export function readAwakeLast(runsDir: string): AwakeLast | null {
  try {
    const v = JSON.parse(readFileSync(join(runsDir, LAST_FILE), 'utf8')) as AwakeLast;
    return typeof v.at === 'string' && typeof v.state === 'string' ? v : null;
  } catch { return null; }
}

export function awakeStatus(runsDir: string): AwakeStatus {
  const enabled = awakeEnabled(runsDir), last = readAwakeLast(runsDir);
  const now = last ? ({ held: 'holding the Mac awake', 'queue-empty': 'released (queue empty)', 'on-battery': 'not holding (on battery)',
    'power-unknown': 'not holding (power source unknown)', 'not-macos': 'not available (not macOS)', unavailable: 'not available (caffeinate would not start)',
    off: 'off' } as Record<AwakeState, string>)[last.state] : 'no tick has run since it was turned on';
  return { schema: KEEP_AWAKE_SCHEMA, enabled, switchFile: join(runsDir, KEEP_AWAKE_FILE), last,
    line: enabled ? `Keep-awake is on. Last tick: ${now}.` : 'Keep-awake is off. Turn it on with: phm fleet awake on' };
}

/** Read-only power source from ioreg (no pmset). A Mac without a battery counts as on power. */
export function readPower(): Power {
  try {
    const out = execFileSync('ioreg', ['-rn', 'AppleSmartBattery', '-d1'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /"ExternalConnected"\s*=\s*(Yes|No)/.exec(out);
    return m ? (m[1] === 'Yes' ? 'ac' : 'battery') : out.trim() === '' ? 'ac' : 'unknown';
  } catch { return 'unknown'; }
}

export interface AwakeDeps {
  platform?: NodeJS.Platform;
  readPower?: () => Power;
  /** Spawns caffeinate; returns a handle whose kill() releases the assertion, or null when it would not start. */
  spawn?: (args: string[]) => { kill: () => void } | null;
  now?: () => number;
}

export interface AwakeHold { state: AwakeState; release: () => void }

function defaultSpawn(args: string[]): { kill: () => void } | null {
  try {
    const child = nodeSpawn('caffeinate', args, { stdio: 'ignore' });
    child.on('error', () => { /* a missing binary just means nothing is held */ });
    child.unref();
    return child.pid === undefined ? null : { kill: () => { try { child.kill(); } catch { /* gone */ } } };
  } catch { return null; }
}

/**
 * Decide and hold. `queued` is ready plus running jobs (null = unknown, treated as not queued). The returned
 * release() must be called when the tick ends; `caffeinate -w` also lets go on its own when this pid exits.
 */
export function holdKeepAwake(runsDir: string, queued: number | null, deps: AwakeDeps = {}): AwakeHold {
  const none = (state: AwakeState): AwakeHold => ({ state, release: () => undefined });
  const record = (state: AwakeState): void => {
    try {
      const path = join(runsDir, LAST_FILE);
      writeFileSync(`${path}.tmp`, JSON.stringify({ at: new Date((deps.now ?? Date.now)()).toISOString(), state, queued }), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    } catch { /* best effort */ }
  };
  const finish = (state: AwakeState, release: () => void = () => undefined): AwakeHold => { record(state); return { state, release }; };
  if (!awakeEnabled(runsDir)) return none('off');
  if ((deps.platform ?? process.platform) !== 'darwin') return finish('not-macos');
  if (!queued) return finish('queue-empty');
  const power = (deps.readPower ?? readPower)();
  if (power === 'battery') return finish('on-battery');
  if (power === 'unknown') return finish('power-unknown');
  const child = (deps.spawn ?? defaultSpawn)(['-i', '-w', String(process.pid)]);
  return child ? finish('held', () => { child.kill(); }) : finish('unavailable');
}
