/**
 * The one reader for the memory pause switches in the runs directory.
 *   PAUSE        stops all new launches (real pressure).
 *   PAUSE_LOCAL  stops new local-model launches only (level-1 memory reading); cloud lanes keep running.
 * Each file holds one line: a timestamp, then the reasons. Missing file = off. A file that cannot be
 * read is "unknown", never "off". Read-only: no probes, no writes.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type PauseSwitchState = 'on' | 'off' | 'unknown';

export interface PauseSwitch {
  state: PauseSwitchState;
  /** ISO time the pause started; null when the file has no readable timestamp. */
  since: string | null;
  reasons: string[];
}

export interface PauseState {
  global: PauseSwitch;
  local: PauseSwitch;
}

export interface PausePaths { pausePath?: string; pauseLocalPath?: string }

const OFF: PauseSwitch = { state: 'off', since: null, reasons: [] };

function toIso(token: string): string | null {
  const ms = /^\d{10}(\d{3})?$/.test(token) ? Number(token) * (token.length === 10 ? 1000 : 1) : Date.parse(token);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Pure: file text in, switch out. A leading timestamp is split off; the rest is split into reasons. */
export function parsePauseFile(text: string): PauseSwitch {
  const line = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).join('; ');
  let since: string | null = null;
  let rest = line;
  // The timestamp is the first two tokens ("2026-11-21 00:50:00") or the first one (ISO or epoch).
  const tokens = line.split(/\s+/);
  for (const n of [2, 1]) {
    const iso = tokens.length >= n ? toIso(tokens.slice(0, n).join(' ')) : null;
    if (iso && /\d/.test(tokens[0]!)) { since = iso; rest = tokens.slice(n).join(' '); break; }
  }
  const reasons = rest.split(/[;,]\s*|\s{2,}/).map(r => r.trim()).filter(Boolean);
  return { state: 'on', since, reasons };
}

async function readSwitch(path: string): Promise<PauseSwitch> {
  try {
    return parsePauseFile(await readFile(path, 'utf8'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { ...OFF } : { state: 'unknown', since: null, reasons: [] };
  }
}

export function defaultPauseDir(): string {
  return process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
}

export async function readPauseState(paths: PausePaths = {}, runsDir = defaultPauseDir()): Promise<PauseState> {
  const [global, local] = await Promise.all([
    readSwitch(paths.pausePath ?? join(runsDir, 'PAUSE')),
    readSwitch(paths.pauseLocalPath ?? join(runsDir, 'PAUSE_LOCAL')),
  ]);
  return { global, local };
}

const why = (s: PauseSwitch): string => s.reasons.length ? `: ${s.reasons.join('; ')}` : '';

/** Plain words for the state, or null when nothing is paused. A global pause wins over a local one. */
export function pauseLine(p: PauseState): string | null {
  if (p.global.state === 'on') return `All launches paused${why(p.global)}`;
  if (p.global.state === 'unknown') return 'All-launches pause could not be read; treat launches as paused until it can';
  if (p.local.state === 'on') return `Local models paused, cloud lanes running${why(p.local)}`;
  if (p.local.state === 'unknown') return 'Local-models pause could not be read; local launches may be paused';
  return null;
}
