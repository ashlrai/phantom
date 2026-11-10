/**
 * Read-only parser for the dispatcher's text event log (dispatch-events.log).
 *
 * WHY. dispatchd, restock and the planner append plain text rows, not JSON:
 * `%F %T KIND payload` in local time (contrib/mac/dispatchd.py `ev()`).
 * `phm fleet events` (core/fleet/events.ts) replays JSON rows only, so it
 * skips every one of these lines. Recut of #1166: one typed parser and a
 * bounded, `--since`-filtered reader for `phm fleet dispatch-events`.
 *
 * Accepted timestamp forms:
 *   - `YYYY-MM-DD HH:MM:SS`, local wall clock (the form dispatchd writes);
 *   - an ISO instant with an explicit timezone, optionally `[bracketed]`.
 * Any uppercase kind is accepted (dispatchd writes ~40 of them: LAUNCH,
 * LANE_HOLD, DISKGUARD, ...); the payload stays uninterpreted text.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { dispatchEventsCandidates } from '../fleet/dispatch-events-path.js';

export interface DispatchEvent {
  /** Timestamp text as written in the log. */
  timestamp: string;
  /** The same instant as an ISO UTC string. */
  at: string;
  kind: string;
  /** Payload stays as text; no shell evaluation or inferred field types. */
  message: string;
}

export type DispatchEventParseResult =
  | { ok: true; event: DispatchEvent }
  | { ok: false; reason: 'empty' | 'invalid-format' | 'invalid-timestamp' };

/** Most recent events a single read keeps; older matches are counted in `truncated`. */
export const DISPATCH_EVENTS_MAX = 5000;

const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const LOCAL_CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const KIND = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

/** Require an explicit timezone, and reject calendar dates that Date.parse normalizes. */
export function dispatchTimestampMs(value: string): number | null {
  const match = ISO_INSTANT.exec(value);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return null;
  const day = match[1]!;
  const ms = Date.parse(value);
  // Number.isFinite first: toISOString throws on an invalid Date.
  if (!Number.isFinite(ms) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return null;
  return ms;
}

/** `YYYY-MM-DD HH:MM:SS` on the local clock; null for impossible dates or times. */
function localClockMs(value: string): number | null {
  const m = LOCAL_CLOCK.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi, s);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d
    || h > 23 || mi > 59 || s > 59) return null;
  return date.getTime();
}

/** Parse one log line. Never throws. */
export function parseDispatchEventLine(line: string): DispatchEventParseResult {
  const text = line.trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (/[\r\n]/.test(text)) return { ok: false, reason: 'invalid-format' };
  // dispatchd form first: two space-separated clock fields, then the kind.
  const local = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(\S+)(?:[ \t]+(.*))?$/.exec(text);
  const iso = local ? null : /^(?:\[([^\]]+)\]|(\S+))\s+(\S+)(?:[ \t]+(.*))?$/.exec(text);
  const timestamp = local ? local[1]! : iso ? (iso[1] ?? iso[2]!) : null;
  const kind = local ? local[2]! : iso?.[3];
  if (timestamp === null || kind === undefined || !KIND.test(kind)) return { ok: false, reason: 'invalid-format' };
  const ms = local ? localClockMs(timestamp) : dispatchTimestampMs(timestamp);
  if (ms === null) return { ok: false, reason: 'invalid-timestamp' };
  const message = (local ? local[3] : iso![4]) ?? '';
  return { ok: true, event: { timestamp, at: new Date(ms).toISOString(), kind, message } };
}

export interface DispatchEventsReport {
  /** Matching events in file order, at most DISPATCH_EVENTS_MAX (the newest). */
  events: DispatchEvent[];
  /** Older matching events dropped by the bound. */
  truncated: number;
  malformedLines: number;
  emptyLines: number;
  source: 'present' | 'missing';
  path: string;
}

/**
 * Default log: the first regular file among the runs-dir candidates
 * (queue/dispatch-events.log, then dispatch-events.log), else the first.
 */
export async function defaultDispatchEventsPath(runsDir = join(homedir(), '.ashlr-runs')): Promise<string> {
  const candidates = dispatchEventsCandidates(runsDir);
  for (const path of candidates) {
    const info = await stat(path).catch(() => null);
    if (info?.isFile()) return path;
  }
  return candidates[0];
}

export interface ReadDispatchEventsOptions {
  path?: string;
  /** Inclusive lower bound: an ISO timestamp with a timezone. */
  since?: string;
  runsDir?: string;
  max?: number;
}

/** Stream the log in file order. The inclusive since filter compares instants, not strings. */
export async function readDispatchEvents(options: ReadDispatchEventsOptions = {}): Promise<DispatchEventsReport> {
  const since = options.since === undefined ? null : dispatchTimestampMs(options.since);
  if (options.since !== undefined && since === null) throw new Error('--since requires an ISO timestamp with a timezone');
  const max = Math.max(1, Math.floor(options.max ?? DISPATCH_EVENTS_MAX));
  const path = options.path ?? await defaultDispatchEventsPath(options.runsDir);
  const report: DispatchEventsReport = { events: [], truncated: 0, malformedLines: 0, emptyLines: 0, source: 'present', path };
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const result = parseDispatchEventLine(line);
      if (!result.ok) {
        if (result.reason === 'empty') report.emptyLines++;
        else report.malformedLines++;
      } else if (since === null || Date.parse(result.event.at) >= since) {
        report.events.push(result.event);
        // Keep memory bounded on a long-lived log: drop the oldest in chunks.
        if (report.events.length >= max * 2) {
          report.truncated += report.events.length - max;
          report.events = report.events.slice(-max);
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    report.source = 'missing';
  } finally {
    lines.close();
    input.destroy();
  }
  if (report.events.length > max) {
    report.truncated += report.events.length - max;
    report.events = report.events.slice(-max);
  }
  return report;
}
