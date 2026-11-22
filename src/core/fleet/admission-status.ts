import { homedir } from 'node:os';
import { join } from 'node:path';
import { readTelemetryFile } from '../resources/telemetry.js';

export interface FleetStartStatus {
  state: 'blocked' | 'settling' | 'open' | 'unknown';
  reason: string;
  summary: string;
  settle_s: number | null;
  why: string | null;
  load1: number | null;
  load5: number | null;
  owned_load1: number | null;
  total_running: number | null;
  max_total_running: number | null;
  last_admit: number | null;
  ts: number | null;
  nextStartSeconds: number | null;
  startsPerHourCap: number | null;
}

const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const count = (v: unknown): number | null => Number.isSafeInteger(v) ? number(v) : null;

/** Only the guard's public measurements are projected; malformed or old observations cannot say open. */
export function admissionStatus(text: string | null, now = Date.now()): FleetStartStatus {
  const unknown = (reason: string): FleetStartStatus => ({ state: 'unknown', reason,
    summary: `starts unknown: ${reason}`, settle_s: null, why: null, load1: null, load5: null,
    owned_load1: null, total_running: null, max_total_running: null, last_admit: null, ts: null,
    nextStartSeconds: null, startsPerHourCap: null });
  if (text === null) return unknown('admission file missing or unreadable');
  let raw: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown('invalid admission file');
    raw = value as Record<string, unknown>;
  } catch { return unknown('invalid admission file'); }
  const ts = number(raw.ts);
  if (ts === null || ts * 1000 > now) return unknown('invalid admission timestamp');
  if (now - ts * 1000 > 300_000) return unknown('admission file older than 5 min');
  const settle_s = number(raw.settle_s), last_admit = number(raw.last_admit);
  const total_running = count(raw.total_running), max_total_running = count(raw.max_total_running);
  const load1 = number(raw.load1), load5 = number(raw.load5), owned_load1 = number(raw.owned_load1);
  if (settle_s === null || last_admit === null || last_admit > ts || total_running === null || max_total_running === null ||
      typeof raw.why !== 'string') return unknown('incomplete admission file');
  const nextStartSeconds = Math.max(0, Math.ceil(last_admit + settle_s - now / 1000));
  const why = ['over_host', 'over_owned', 'over_total', 'pool_empty', 'settle', 'settling', 'open', 'ok', 'admit', ''].includes(raw.why) ? raw.why : null;
  const blocked = why === null || ['over_host', 'over_owned', 'over_total', 'pool_empty'].includes(why) || total_running >= max_total_running;
  const state = blocked ? 'blocked' : nextStartSeconds > 0 ? 'settling' : 'open';
  const reason = why === 'over_host' ? 'host busy' : why === 'over_owned' ? 'fleet load high' : why === 'pool_empty' ? 'pool empty'
    : total_running >= max_total_running || why === 'over_total' ? 'running limit reached'
      : why === null ? 'guard reports a wait' : state === 'settling' ? 'waiting between starts' : 'guard allows a start';
  const wait = nextStartSeconds > 0 ? ` · ${blocked ? 'pacing window' : 'next start'} in ~${nextStartSeconds < 60 ? `${nextStartSeconds} sec` : `${Math.ceil(nextStartSeconds / 60)} min`}` : '';
  const host = load1 === null ? '' : ` (load ${load1}, fleet owns ${owned_load1 ?? 'unknown'})`;
  const summary = `${state === 'blocked' ? 'starts blocked' : state === 'settling' ? 'starts settling' : 'starts open'}: ${reason}${why === 'over_host' ? host : ''}${wait} · ${total_running} of ${max_total_running} running`;
  return { state, reason, summary, settle_s, why, load1, load5, owned_load1, total_running, max_total_running,
    last_admit, ts, nextStartSeconds, startsPerHourCap: settle_s > 0 ? 3600 / settle_s : null };
}

/** Same reader for the CLI and local API; no dispatcher or settings changes. */
export async function readFleetStartStatus(options: {
  runsDir?: string; now?: number; read?: (path: string) => Promise<string | null>;
} = {}): Promise<FleetStartStatus> {
  const path = process.env.ASHLR_ADMISSION_CTL_PATH ?? join(options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'queue', 'admission-ctl.json');
  let text: string | null = null;
  try { text = await (options.read ?? readTelemetryFile)(path); } catch { /* Unknown, without leaking paths or contents. */ }
  return admissionStatus(text, options.now);
}
