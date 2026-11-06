import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { fsyncDirectory } from '../util/durability.js';

/** The producer's decoder must select metadata only; raw spool rows never leave disk. */
export interface QueueReplayEvent {
  id: string;
  distinctId: string;
  timestamp: string;
  properties: Readonly<Record<string, string | number | boolean | null>>;
}

export interface QueueSpoolReplayOptions {
  /** File within a dedicated owned spool directory; the replay lock enforces private directory permissions. */
  spoolPath: string;
  /** Explicit opt-in, supplied only after the capture route is live. No environment probes. */
  route?: { endpoint: string; projectToken: string };
  /** Required until the producer's queue.v1 spool contract is available here. */
  decode: (row: unknown) => QueueReplayEvent;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxEvents?: number;
}

export interface QueueSpoolReplayResult {
  status: 'disabled' | 'complete' | 'partial' | 'busy' | 'invalid-route' |
    'invalid-spool' | 'invalid-checkpoint' | 'storage-unavailable' | 'route-unavailable';
  sent: number;
  skipped: number;
  /** A writer's incomplete final JSONL row is left for the next invocation. */
  deferred: number;
}

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const HEX_DIGEST = /^[a-f0-9]{64}$/;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** RFC 4122 UUIDv5: stable across restarts, including non-UUID producer event ids. */
function eventUuid(id: string): string {
  if (/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(id)) return id.toLowerCase();
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
  const bytes = createHash('sha1').update(namespace).update(`https://phm.dev/queue.v1/${id}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function captureEvent(event: QueueReplayEvent): string {
  if (!event || typeof event.id !== 'string' || !event.id.trim() || event.id.length > 512 ||
    typeof event.distinctId !== 'string' || !event.distinctId.trim() || event.distinctId.length > 200 ||
    typeof event.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(event.timestamp) ||
    !Number.isFinite(Date.parse(event.timestamp)) || !event.properties || typeof event.properties !== 'object' ||
    Array.isArray(event.properties)) throw new Error('Invalid event');
  const entries = Object.entries(event.properties).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (entries.some(([key, value]) => key.length > 200 ||
    !(value === null || typeof value === 'boolean' || typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value))))) throw new Error('Invalid metadata');
  const body = JSON.stringify({ event: 'queue.v1', uuid: eventUuid(event.id), distinct_id: event.distinctId,
    timestamp: event.timestamp, properties: { ...Object.fromEntries(entries), $process_person_profile: false } });
  if (Buffer.byteLength(body) > MAX_LINE_BYTES) throw new Error('Event too large');
  return body;
}

async function checkedFile(path: string, flags: number): Promise<FileHandle> {
  const file = await open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('Unsafe file');
    if ((flags & constants.O_RDWR) && ((process.platform !== 'win32' && (stat.mode & 0o077) !== 0) ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()))) throw new Error('Unsafe checkpoint');
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

/** Bounded snapshot: concurrent appends belong to a later replay, never to a rewrite. */
async function snapshot(file: FileHandle): Promise<string> {
  const { size } = await file.stat();
  if (size > MAX_BYTES) throw new Error('File too large');
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await file.read(bytes, offset, size - offset, offset);
    if (!bytesRead) throw new Error('File changed');
    offset += bytesRead;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function accepted(response: Response): Promise<boolean> {
  if (!response.ok) { await response.body?.cancel(); return false; }
  const reader = response.body?.getReader();
  if (!reader) return false;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 4_096) return false;
      chunks.push(chunk.value);
    }
    const reply: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    // PostHog may report quota rejection in a 200 body. Never acknowledge it.
    return !!reply && typeof reply === 'object' && (reply as { status?: unknown }).status === 1 &&
      !Object.hasOwn(reply, 'quota_limited');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/**
 * Replay an explicit JSONL spool to PostHog, without modifying the producer's file.
 * A decoder adapts the producer's schema and enforces its metadata allowlist.
 * A separate fsynced ledger acknowledges each id only after a positive response.
 * PostHog also receives the original time, identity and a stable UUID, so a crash
 * after capture but before checkpoint can be retried with the same dedup tuple.
 * https://posthog.com/docs/data-pipelines/troubleshooting
 * No scheduler/producer is wired here until #951's contract is available.
 */
export async function replayQueueSpool(options: QueueSpoolReplayOptions): Promise<QueueSpoolReplayResult> {
  const result: QueueSpoolReplayResult = { status: 'disabled', sent: 0, skipped: 0, deferred: 0 };
  if (!options.route) return result;
  const { endpoint, projectToken } = options.route;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const maxEvents = options.maxEvents ?? 100;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      typeof projectToken !== 'string' || !projectToken.trim() ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
      !Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 10_000) throw new Error('Invalid route');
  } catch { return { ...result, status: 'invalid-route' }; }

  const spoolPath = resolve(options.spoolPath);
  const checkpointPath = `${spoolPath}.replayed.jsonl`;
  let spool: FileHandle;
  try { spool = await checkedFile(spoolPath, constants.O_RDONLY); }
  catch (error) {
    return { ...result, status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'complete' : 'storage-unavailable' };
  }
  const acquisition = acquireLocalStoreLockWithOutcome(`${checkpointPath}.lock`, 0);
  if (acquisition.state !== 'acquired') {
    await spool.close();
    return { ...result, status: acquisition.state === 'contended' ? 'busy' : 'storage-unavailable' };
  }
  const { lock } = acquisition;
  let checkpoint: FileHandle | undefined;
  try {
    result.status = 'invalid-spool';
    const content = await snapshot(spool);
    const boundary = content.lastIndexOf('\n') + 1;
    result.deferred = content.slice(boundary).trim() ? 1 : 0;
    const events = new Map<string, { body: string; hash: string }>();
    for (const line of content.slice(0, boundary).split('\n')) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('Line too large');
      const decoded = options.decode(JSON.parse(line));
      const body = captureEvent(decoded);
      const id = digest(decoded.id);
      const hash = digest(body);
      const prior = events.get(id);
      if (prior && prior.hash !== hash) throw new Error('Conflicting event id');
      if (prior) result.skipped++;
      else events.set(id, { body, hash });
    }
    if (!events.size) return { ...result, status: result.deferred ? 'partial' : 'complete' };

    result.status = 'storage-unavailable';
    checkpoint = await checkedFile(checkpointPath, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND);
    result.status = 'invalid-checkpoint';
    let ledger = await snapshot(checkpoint);
    // Bind receipts to their destination without persisting the token itself.
    const header = JSON.stringify({ version: 1, target: digest(`${endpoint}\n${projectToken}`) });
    const acknowledged = new Map<string, string>();
    const completeLedger = ledger.slice(0, ledger.lastIndexOf('\n') + 1);
    if (ledger && !completeLedger && !`${header}\n`.startsWith(ledger)) throw new Error('Invalid checkpoint header');
    if (completeLedger) {
      const [first, ...lines] = completeLedger.trimEnd().split('\n');
      if (first !== header) throw new Error('Checkpoint destination mismatch');
      for (const line of lines) {
        const row = JSON.parse(line) as { id: string; hash: string };
        if (!row || !HEX_DIGEST.test(row.id) || !HEX_DIGEST.test(row.hash) ||
          (acknowledged.has(row.id) && acknowledged.get(row.id) !== row.hash)) throw new Error('Invalid receipt');
        acknowledged.set(row.id, row.hash);
      }
    }
    for (const [id, event] of events) {
      if (acknowledged.has(id) && acknowledged.get(id) !== event.hash) throw new Error('Changed acknowledged event');
    }
    result.status = 'storage-unavailable';
    if (ledger !== completeLedger) {
      // A crash may tear only the last receipt. Its event is safe to recapture
      // with the same UUID. Complete malformed receipts still fail closed above.
      await checkpoint.truncate(Buffer.byteLength(completeLedger));
      await checkpoint.sync();
      ledger = completeLedger;
    }
    if (!ledger) {
      ledger = `${header}\n`;
      await checkpoint.writeFile(ledger);
      await checkpoint.sync();
    }
    fsyncDirectory(dirname(checkpointPath));
    let ledgerBytes = Buffer.byteLength(ledger);
    for (const [id, event] of events) {
      if (acknowledged.has(id)) { result.skipped++; continue; }
      if (result.sent >= maxEvents) return { ...result, status: 'partial' };
      const receipt = `${JSON.stringify({ id, hash: event.hash })}\n`;
      const receiptBytes = Buffer.byteLength(receipt);
      if (ledgerBytes + receiptBytes > MAX_BYTES) throw new Error('Checkpoint full');
      result.status = 'route-unavailable';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await (options.fetchImpl ?? fetch)(endpoint, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: projectToken, ...JSON.parse(event.body) }),
        });
        if (!await accepted(response)) return result;
      } finally { clearTimeout(timer); }
      result.status = 'storage-unavailable';
      await checkpoint.writeFile(receipt);
      await checkpoint.sync();
      ledgerBytes += receiptBytes;
      acknowledged.set(id, event.hash);
      result.sent++;
    }
    return { ...result, status: result.deferred ? 'partial' : 'complete' };
  } catch {
    // Do not expose decoder errors, raw response bodies, tokens or transport errors.
    return result;
  } finally {
    await checkpoint?.close().catch(() => {});
    await spool.close().catch(() => {});
    releaseLocalStoreLock(lock);
  }
}
