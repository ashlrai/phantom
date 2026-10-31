import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { busHoplogPath } from './bus-hoplog.js';
import { scrubSecrets } from '../util/scrub.js';

export const VERSE_FLEET_LIVE_BUS_PATH = '/api/verse/fleet/live/bus';
export type BusFeedSourceState = 'healthy' | 'missing' | 'degraded';
export interface BusFeedHop { id: string; from: string; to: string; inputTokens: number | null; outputTokens: number | null }
export type BusFeedEventKind = 'inbox' | 'orch' | 'incident' | 'lane-hold' | 'launch' | 'published' | 'other';
export interface BusFeedEvent { at: string; kind: BusFeedEventKind; text: string }
export interface FleetBusFeedV1 {
  v: 1;
  hops: BusFeedHop[];
  hopsDropped: number;
  lastHopAt: string | null;
  events: BusFeedEvent[];
  sources: { hops: BusFeedSourceState; events: BusFeedSourceState };
}
export interface BusFeedOptions { runsDir?: string; hopsFile?: string; limit?: number }
const MAX_READ_BYTES = 256 * 1024;
const count = (value: unknown): value is number | null => value === null ||
  (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

export function parseBusHops(text: string): { hops: BusFeedHop[]; dropped: number } {
  const hops: BusFeedHop[] = [];
  let dropped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid row');
      const { id, from, to, inputTokens, outputTokens } = row as Record<string, unknown>;
      if (![id, from, to].every((part) => typeof part === 'string' && part.length > 0) ||
          !count(inputTokens) || !count(outputTokens)) throw new Error('invalid fields');
      hops.push({ id: scrubSecrets(id as string), from: scrubSecrets(from as string),
        to: scrubSecrets(to as string), inputTokens, outputTokens });
    } catch { dropped += 1; }
  }
  return { hops, dropped };
}

export function parseDispatchEvents(text: string): BusFeedEvent[] {
  const events: BusFeedEvent[] = [];
  for (const line of text.split('\n')) {
    const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(\S+)(.*)$/.exec(line);
    if (!match) continue;
    const timestamp = match[1].replace(' ', 'T') + 'Z';
    const parsed = new Date(timestamp);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== timestamp.slice(0, 19)) continue;
    const token = match[2];
    const kinds: Record<string, BusFeedEventKind> = { INBOX: 'inbox', INCIDENT: 'incident',
      LANE_HOLD: 'lane-hold', LAUNCH: 'launch', PUBLISHED: 'published' };
    const kind = token.startsWith('ORCH-') ? 'orch' : (Object.hasOwn(kinds, token) ? kinds[token] : 'other');
    events.push({ at: scrubSecrets(match[1]), kind, text: scrubSecrets(token + match[3]).slice(0, 400) });
  }
  const known = events.filter((event) => event.kind !== 'other').length;
  let fillers = Math.max(0, 5 - known);
  return events.reverse().filter((event) => event.kind !== 'other' || fillers-- > 0).reverse();
}

async function tail(file: () => string): Promise<{ state: BusFeedSourceState; text: string; at: string | null }> {
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
    if (offset > 0) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    return { state: 'healthy', text, at: stat.mtime.toISOString() };
  } catch (error) {
    return { state: !handle && (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'degraded', text: '', at: null };
  } finally { await handle?.close().catch(() => undefined); }
}

export async function readFleetBusFeed(opts: BusFeedOptions = {}): Promise<FleetBusFeedV1> {
  const limit = Math.min(500, Math.max(1, Math.floor(Number.isNaN(opts.limit) ? 100 : opts.limit ?? 100)));
  const [hops, events] = await Promise.all([
    tail(() => opts.hopsFile ?? busHoplogPath()),
    tail(() => join(opts.runsDir ?? join(homedir(), '.ashlr-runs'), 'dispatch-events.log')),
  ]);
  const parsed = parseBusHops(hops.text);
  return { v: 1, hops: parsed.hops.slice(-limit), hopsDropped: parsed.dropped,
    lastHopAt: hops.at, events: parseDispatchEvents(events.text).slice(-limit),
    sources: { hops: hops.state, events: events.state } };
}
