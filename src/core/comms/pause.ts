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
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readPrivateFileCapped } from '../verse/preferences.js';

export interface PauseState {
  paused: boolean;
  since?: number;
}

function pauseJsonPath(): string {
  return join(homedir(), '.ashlr', 'comms', 'pause.json');
}

export function loadPauseState(): PauseState {
  try {
    let stat;
    try {
      stat = lstatSync(pauseJsonPath());
    } catch (error) {
      return { paused: (error as NodeJS.ErrnoException).code !== 'ENOENT' };
    }
    if (!stat.isFile() || stat.size > 64 * 1024) return { paused: true };
    const read = readPrivateFileCapped(pauseJsonPath(), 64 * 1024);
    if (read === null || read.truncated) return { paused: true };
    const parsed: unknown = JSON.parse(read.text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { paused: true };
    const state = parsed as Partial<PauseState>;
    if (typeof state.paused !== 'boolean') return { paused: true };
    if (!state.paused) return { paused: false };
    return typeof state.since === 'number' ? { paused: true, since: state.since } : { paused: true };
  } catch {
    return { paused: true };
  }
}

export function savePauseState(s: PauseState): void {
  try {
    const dir = join(homedir(), '.ashlr', 'comms');
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
