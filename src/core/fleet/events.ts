/** Standalone, read-only queue journal stream. Cursors are opaque v1 checkpoints. */
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const SOURCES = ['dispatch-events.log', 'jobs.jsonl'] as const;
type Position = { file: string; offset: number; anchor: string };
type Cursor = Record<string, Position>;
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const encode = (positions: Cursor): string => Buffer.from(JSON.stringify({ v: 1, positions })).toString('base64url');
function decode(token?: string): Cursor {
  if (!token) return {};
  try {
    if (token.length > 4096) throw new Error();
    const value = JSON.parse(Buffer.from(token, 'base64url').toString());
    if (value.v !== 1 || !value.positions || typeof value.positions !== 'object' || Array.isArray(value.positions)) throw new Error();
    for (const [source, p] of Object.entries(value.positions) as [string, Position][]) {
      if (!SOURCES.includes(source as typeof SOURCES[number]) || !p || typeof p.file !== 'string'
        || !Number.isSafeInteger(p.offset) || p.offset < 0 || !/^[a-f0-9]{64}$/.test(p.anchor)) throw new Error();
    }
    return value.positions;
  } catch { throw new Error('Invalid fleet events cursor'); }
}
export interface FleetEvent {
  v: 1; id: string; cursor: string; source: string;
  at: string | null; type: string; job: string | null; pool: string | null;
}
export interface FleetEventsOptions {
  queueDir: string; cursor?: string; follow?: boolean; signal?: AbortSignal; pollMs?: number;
}
/** Replay complete JSON lines, then poll when following. Never reads fleet state.
 * Malformed rows are skipped; partial final rows stay pending. Replacement,
 * shrinkage or changed checkpoint bytes restart only the affected source.
 */
export async function* fleetEvents(options: FleetEventsOptions): AsyncGenerator<FleetEvent> {
  const positions = decode(options.cursor);
  do {
    let progressed = false;
    for (const source of SOURCES) {
      if (options.signal?.aborted) return;
      const file = await open(join(options.queueDir, source), 'r').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!file) continue;
      try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new Error('Fleet events source must be a regular file');
        const identity = `${stat.dev}:${stat.ino}`;
        let p = positions[source];
        const anchorAt = async (offset: number): Promise<string> => {
          const bytes = Buffer.alloc(Math.min(64, offset));
          const read = await file.read(bytes, 0, bytes.length, offset - bytes.length);
          return hash(bytes.subarray(0, read.bytesRead));
        };
        if (!p || p.file !== identity || p.offset > stat.size || p.anchor !== await anchorAt(p.offset)) {
          p = { file: identity, offset: 0, anchor: hash('') };
          positions[source] = p;
        }
        // Bounded reads keep memory and follow-mode latency independent of log size.
        const bytes = Buffer.alloc(64 * 1024);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, p.offset);
        let start = 0;
        for (let end = 0; end < bytesRead; end++) {
          if (bytes[end] !== 10) continue;
          const offset = p.offset;
          const raw = bytes.subarray(start, end).toString('utf8');
          p.offset += end + 1 - start;
          start = end + 1;
          p.anchor = await anchorAt(p.offset);
          progressed = true;
          let row: Record<string, unknown>;
          try { row = JSON.parse(raw); } catch { continue; }
          if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
          const pick = (...keys: string[]): string | null => {
            for (const key of keys) if (typeof row[key] === 'string' && row[key]) return row[key] as string;
            return null;
          };
          yield { v: 1, id: hash(`${source}:${identity}:${offset}:${raw}`), cursor: encode(positions), source,
            at: pick('at', 'ts', 'time', 'timestamp'), type: pick('event', 'type', 'to', 'status', 'state') ?? 'unknown',
            job: pick('job', 'jobId', 'id'), pool: pick('pool', 'lane', 'account') };
        }
        if (bytesRead === bytes.length && start === 0) throw new Error('Fleet event line exceeds 64 KiB');
      } finally { await file.close(); }
    }
    if (progressed) continue;
    if (!options.follow || options.signal?.aborted) return;
    try { await setTimeout(options.pollMs ?? 250, undefined, { signal: options.signal }); }
    catch (error) { if (!options.signal?.aborted) throw error; }
  } while (!options.signal?.aborted);
}
