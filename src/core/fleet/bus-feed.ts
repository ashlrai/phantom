import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createBusHop } from './bus-hoplog.js';
import { readBusHopsDetailed } from './bus-hoplog-reader.js';
import { scrubSecrets } from '../util/scrub.js';

export const VERSE_FLEET_LIVE_BUS_PATH = '/api/verse/fleet/live/bus';
export type BusFeedSourceState = 'healthy' | 'missing' | 'degraded';
export interface BusFeedHop { id: string; from: string; to: string; inputTokens: number | null; outputTokens: number | null }
export type BusFeedEventKind = 'inbox' | 'orch' | 'incident' | 'lane-hold' | 'launch' | 'published' | 'other';
export interface BusFeedEvent { at: string; atIso?: string; kind: BusFeedEventKind; text: string }
export interface FleetBusFeedV1 {
  v: 1;
  hops: BusFeedHop[];
  /** Invalid complete rows plus an unfinished final row in the scanned tail; omitted history is unknown. */
  hopsDropped: number;
  /** The hop log contains no timestamps, so this is always null. */
  lastHopAt: string | null;
  events: BusFeedEvent[];
  sources: { hops: BusFeedSourceState; events: BusFeedSourceState };
}
export interface BusFeedOptions { runsDir?: string; hopsFile?: string; limit?: number }
const MAX_READ_BYTES = 256 * 1024;
/** Parse complete newline-terminated rows, like the durable hop log reader.
 * An unfinished final row is excluded and counted as dropped. */
export function parseBusHops(text: string): { hops: BusFeedHop[]; dropped: number } {
  const hops: BusFeedHop[] = [];
  const lines = text.split('\n');
  const final = lines.pop()!;
  let dropped = final.length > 0 ? 1 : 0;
  for (const line of lines) {
    try {
      const row: unknown = JSON.parse(line);
      const hop = createBusHop(row, row);
      if (!hop) throw new Error('invalid row');
      hops.push(hop);
    } catch { dropped += 1; }
  }
  return { hops, dropped };
}

export function parseDispatchEvents(text: string): BusFeedEvent[] {
  const events: BusFeedEvent[] = [];
  for (const line of text.split('\n')) {
    const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(\S+)(.*)$/.exec(line);
    if (!match) continue;
    const timestamp = match[1].replace(' ', 'T');
    const parsed = new Date(timestamp);
    const parts = [timestamp.slice(0, 4), timestamp.slice(5, 7), timestamp.slice(8, 10),
      timestamp.slice(11, 13), timestamp.slice(14, 16), timestamp.slice(17, 19)].map(Number);
    if (!Number.isFinite(parsed.getTime()) ||
      [parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate(), parsed.getHours(), parsed.getMinutes(), parsed.getSeconds()]
        .some((value, index) => value !== parts[index])) continue;
    const offset = -parsed.getTimezoneOffset();
    const pad = (value: number) => String(value).padStart(2, '0');
    const atIso = `${timestamp}${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
    const token = match[2];
    const kinds: Record<string, BusFeedEventKind> = { INBOX: 'inbox', INCIDENT: 'incident',
      LANE_HOLD: 'lane-hold', LAUNCH: 'launch', PUBLISHED: 'published' };
    const kind = token.startsWith('ORCH-') ? 'orch' : (Object.hasOwn(kinds, token) ? kinds[token] : 'other');
    // Some historical offsets contain seconds and cannot be represented by an ISO minute offset.
    events.push({ at: scrubSecrets(match[1]), ...(Date.parse(atIso) === parsed.getTime() ? { atIso } : {}),
      kind, text: scrubSecrets(token + match[3]).slice(0, 400) });
  }
  const known = events.filter((event) => event.kind !== 'other').length;
  let fillers = Math.max(0, 5 - known);
  return events.reverse().filter((event) => event.kind !== 'other' || fillers-- > 0).reverse();
}

async function tail(file: () => string): Promise<{ state: BusFeedSourceState; text: string }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file(), 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('not a regular file');
    const offset = Math.max(0, stat.size - MAX_READ_BYTES);
    const buffer = Buffer.alloc(stat.size - offset);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await handle.read(buffer, bytes, buffer.length - bytes, offset + bytes);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
    }
    let text = buffer.subarray(0, bytes).toString('utf8');
    const partialFinalRow = text.length > 0 && !text.endsWith('\n');
    if (partialFinalRow) text = text.slice(0, text.lastIndexOf('\n') + 1);
    if (offset > 0) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    return { state: partialFinalRow ? 'degraded' : 'healthy', text };
  } catch (error) {
    return { state: !handle && (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'degraded', text: '' };
  } finally { await handle?.close().catch(() => undefined); }
}

export async function readFleetBusFeed(opts: BusFeedOptions = {}): Promise<FleetBusFeedV1> {
  const limit = Math.min(500, Math.max(1, Math.floor(Number.isNaN(opts.limit) ? 100 : opts.limit ?? 100)));
  const hops = readBusHopsDetailed({ file: opts.hopsFile, maxBytes: MAX_READ_BYTES, maxRows: limit });
  const events = await tail(() => join(opts.runsDir ?? join(homedir(), '.ashlr-runs'), 'dispatch-events.log'));
  const hopState: BusFeedSourceState = hops.status === 'missing' ? 'missing' :
    hops.status === 'unreadable' || hops.invalidRows > 0 || hops.partialFinalRow ||
    hops.byteTruncated || hops.rowTruncated ? 'degraded' : 'healthy';
  return { v: 1, hops: hops.hops, hopsDropped: hops.invalidRows + Number(hops.partialFinalRow),
    lastHopAt: null, events: parseDispatchEvents(events.text).slice(-limit),
    sources: { hops: hopState, events: events.state } };
}
