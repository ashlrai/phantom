/**
 * M212: Soft-pause flag for the comms dispatch cycle.
 *
 * Dual interface:
 *   isPaused() / setPause(on)      — boolean interface (used by dispatch.ts fast-path)
 *   loadPauseState() / savePauseState(s) — JSON-object-based (used by elon-dialogue, handlers)
 *
 * Both back onto ~/.ashlr/comms/pause.json so state is consistent across callers.
 *
 * Never throws; invalid or inaccessible pause state fails closed.
 */

import { lstatSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { readPrivateFileCapped } from '../verse/preferences.js';

export interface PauseState {
  paused: boolean;
  since?: number;
}

function pauseJsonPath(): string {
  return join(userInfo().homedir, '.ashlr', 'comms', 'pause.json');
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
  try {
    const path = pauseJsonPath();
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ENOENT' ? { paused: false } : failClosed(`is not inspectable (${code ?? 'unknown'})`);
    }
    if (stat.isSymbolicLink()) return failClosed('is a symlink');
    if (!stat.isFile()) return failClosed('is not a regular file');
    if (stat.size > MAX_PAUSE_BYTES) return failClosed('is larger than 64 KiB');
    const read = readPrivateFileCapped(path, MAX_PAUSE_BYTES);
    if (read === null) return failClosed('is unreadable');
    if (read.truncated) return failClosed('is larger than 64 KiB');
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      return failClosed('is not valid JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return failClosed('is not a JSON object');
    const state = parsed as Partial<PauseState>;
    if (typeof state.paused !== 'boolean') return failClosed('has a non-boolean "paused"');
    if (!state.paused) return { paused: false };
    return typeof state.since === 'number' ? { paused: true, since: state.since } : { paused: true };
  } catch {
    return failClosed('could not be checked');
  }
}

export function savePauseState(s: PauseState): void {
  try {
    const dir = join(userInfo().homedir, '.ashlr', 'comms');
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
