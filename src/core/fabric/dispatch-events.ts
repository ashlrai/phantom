/** Read-only parser for timestamped router dispatch-events.log records. */
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export type DispatchEventKind = 'RESTOCK' | 'LAUNCH_FAILED' | 'LANE_HOLD' | `PUBLISH_${string}`;

interface DispatchEventBase {
  timestamp: string;
  /** Payload stays as text; no shell evaluation or inferred field types. */
  message: string;
}

export type DispatchEvent = {
  [K in DispatchEventKind]: DispatchEventBase & { kind: K };
}[DispatchEventKind];

export type DispatchEventParseResult =
  | { ok: true; event: DispatchEvent }
  | { ok: false; reason: 'empty' | 'invalid-format' | 'invalid-timestamp' | 'unknown-kind' };

/** Require an explicit timezone, and reject calendar dates that Date.parse normalizes. */
export function dispatchTimestampMs(value: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || Number(match[2]) > 23) return null;
  const ms = Date.parse(value);
  const day = match[1]!;
  if (!Number.isFinite(ms) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return null;
  return ms;
}

/** Grammar: ISO timestamp (optionally bracketed), event kind, optional free-text payload. */
export function parseDispatchEventLine(line: string): DispatchEventParseResult {
  const text = line.trim();
  if (!text) return { ok: false, reason: 'empty' };
  const match = /^(?:\[([^\]]+)\]|(\S+))\s+([A-Z][A-Z0-9_]*)(?:[ \t]+(.*))?$/.exec(text);
  if (!match || /[\r\n]/.test(text)) return { ok: false, reason: 'invalid-format' };
  const timestamp = match[1] ?? match[2]!;
  if (dispatchTimestampMs(timestamp) === null) return { ok: false, reason: 'invalid-timestamp' };
  const kind = match[3]!;
  if (kind !== 'RESTOCK' && kind !== 'LAUNCH_FAILED' && kind !== 'LANE_HOLD' && !/^PUBLISH_[A-Z0-9]+(?:_[A-Z0-9]+)*$/.test(kind)) {
    return { ok: false, reason: 'unknown-kind' };
  }
  return { ok: true, event: { timestamp, kind: kind as DispatchEventKind, message: match[4] ?? '' } };
}

export interface DispatchEventsReport {
  events: DispatchEvent[];
  malformedLines: number;
  emptyLines: number;
  source: 'present' | 'missing';
}

export function defaultDispatchEventsPath(): string {
  return join(homedir(), '.ashlr', 'fabric', 'dispatch-events.log');
}

/** Stream the log in file order. The inclusive since filter compares instants, not strings. */
export async function readDispatchEvents(options: { path?: string; since?: string } = {}): Promise<DispatchEventsReport> {
  const since = options.since === undefined ? null : dispatchTimestampMs(options.since);
  if (options.since !== undefined && since === null) throw new Error('--since requires an ISO timestamp with a timezone');
  const report: DispatchEventsReport = { events: [], malformedLines: 0, emptyLines: 0, source: 'present' };
  const input = createReadStream(options.path ?? defaultDispatchEventsPath(), { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const result = parseDispatchEventLine(line);
      if (!result.ok) {
        if (result.reason === 'empty') report.emptyLines++;
        else report.malformedLines++;
      } else if (since === null || dispatchTimestampMs(result.event.timestamp)! >= since) {
        report.events.push(result.event);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    report.source = 'missing';
  } finally {
    lines.close();
    input.destroy();
  }
  return report;
}
