/**
 * M212: Soft-pause flag for the comms dispatch cycle.
 *
 * Three readers over the same file:
 *   isPaused() / setPause(on)                    — boolean interface (used by dispatch.ts fast-path)
 *   loadPauseState() / savePauseState(s)         — JSON-object-based (used by elon-dialogue, handlers)
 *   probePauseState()                            — inspection verdict for status probes
 *
 * All back onto ~/.ashlr/comms/pause.json so state is consistent across callers.
 *
 * Never throws; invalid or inaccessible pause state fails closed.
 */

import { lstatSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { realHome } from '../real-home.js';
import { readPrivateFileCapped } from '../verse/preferences.js';

export interface PauseState {
  paused: boolean;
  since?: number;
}

/** What one inspection of pause.json proved. `degraded` carries the same
 * fail-closed reason `failClosed` logs — a fixed phrase, never a path or
 * file contents. */
type PauseFileRead =
  | { kind: 'absent' }
  | { kind: 'clear' }
  | { kind: 'paused'; since?: number }
  | { kind: 'degraded'; reason: string };

/** The single pause.json inspection both readers share. Never throws and
 * never logs: `loadPauseState` keeps the once-per-reason fail-closed log,
 * `probePauseState` reports the reason instead of repeating it. */
function readPauseFile(): PauseFileRead {
  try {
    const path = pauseJsonPath();
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ENOENT' ? { kind: 'absent' } : { kind: 'degraded', reason: `is not inspectable (${code ?? 'unknown'})` };
    }
    if (stat.isSymbolicLink()) return { kind: 'degraded', reason: 'is a symlink' };
    if (!stat.isFile()) return { kind: 'degraded', reason: 'is not a regular file' };
    if (stat.size > MAX_PAUSE_BYTES) return { kind: 'degraded', reason: 'is larger than 64 KiB' };
    const read = readPrivateFileCapped(path, MAX_PAUSE_BYTES);
    if (read === null) return { kind: 'degraded', reason: 'is unreadable' };
    if (read.truncated) return { kind: 'degraded', reason: 'is larger than 64 KiB' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      return { kind: 'degraded', reason: 'is not valid JSON' };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'degraded', reason: 'is not a JSON object' };
    const state = parsed as Partial<PauseState>;
    if (typeof state.paused !== 'boolean') return { kind: 'degraded', reason: 'has a non-boolean "paused"' };
    if (!state.paused) return { kind: 'clear' };
    return typeof state.since === 'number' ? { kind: 'paused', since: state.since } : { kind: 'paused' };
  } catch {
    return { kind: 'degraded', reason: 'could not be checked' };
  }
}

function commsHome(): string {
  const home = realHome();
  if (!home) throw new Error('Account home is unavailable.');
  return home;
}

function pauseJsonPath(): string {
  return join(commsHome(), '.ashlr', 'comms', 'pause.json');
}

const MAX_PAUSE_BYTES = 64 * 1024;

/** Reasons already logged, so a polling dispatch loop does not repeat itself. */
const loggedReasons = new Set<string>();

function failClosed(reason: string): PauseState {
  if (!loggedReasons.has(reason)) {
    loggedReasons.add(reason);
    console.error(`comms pause: treating as PAUSED, pause.json ${reason}`);
  }
  return { paused: true };
}

export function loadPauseState(): PauseState {
  const read = readPauseFile();
  if (read.kind === 'degraded') return failClosed(read.reason);
  if (read.kind === 'paused') {
    return read.since === undefined ? { paused: true } : { paused: true, since: read.since };
  }
  return { paused: false };
}

/** The inspection verdict behind `isPaused`, kept instead of collapsed:
 * `agents bus status` reports it so an agent can tell a real pause flag
 * from a pause.json it could not read — both refuse sends, but only one
 * is a decision someone made. Never throws, writes or logs. */
export interface PauseProbe {
  /** 'paused' a valid flag is set; 'clear' the file was inspected and
   * holds no pause (absent or `paused:false`); 'unknown' the file could
   * not be inspected — the send gate still fails closed and treats it as
   * paused, so unknown is never clear. */
  state: 'paused' | 'clear' | 'unknown';
  /** Epoch ms the pause began, when the file recorded a numeric `since`;
   * null otherwise. */
  since: number | null;
  /** Why the read failed closed ('is a symlink', 'is not valid JSON', …);
   * null unless state is 'unknown'. Fixed strings only — never a path or
   * file contents. */
  reason: string | null;
}

export function probePauseState(): PauseProbe {
  const read = readPauseFile();
  if (read.kind === 'paused') return { state: 'paused', since: read.since ?? null, reason: null };
  if (read.kind === 'degraded') return { state: 'unknown', since: null, reason: read.reason };
  return { state: 'clear', since: null, reason: null };
}

export function savePauseState(s: PauseState): void {
  try {
    const dir = join(commsHome(), '.ashlr', 'comms');
    mkdirSync(dir, { recursive: true });
    writeFileSync(pauseJsonPath(), JSON.stringify(s, null, 2) + '\n', 'utf8');
  } catch { /* best-effort */ }
}

/** Returns true when the fleet soft-pause flag is active. Never throws. */
export function isPaused(): boolean {
  try { return loadPauseState().paused === true; } catch { return true; }
}

export function setPause(on: boolean): void {
  try {
    if (on) {
      savePauseState({ paused: true, since: Date.now() });
    } else {
      rmSync(pauseJsonPath(), { force: true });
    }
  } catch { /* best-effort */ }
}
