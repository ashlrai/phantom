/** Mirrors the fleet's own dispatch-log events onto the durable local agent
 * bus, so an agent that follows the bus from its cursor sees launches,
 * publishes, lane holds, incidents and inbox arrivals next to Mason's
 * interjections and other agents' messages. The mirror is read-only on the
 * dispatch log and strictly best effort on the store: it reserves headroom
 * for agents and Mason, treats an identical re-post as success, persists a
 * {at, key} cursor under the runs dir, and never throws — a non-ok reason
 * carries the failure. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readFleetBusFeed, type BusFeedEvent, type FleetBusFeedV1 } from './bus-feed.js';
import { appendBusInbox, inspectBusInbox, type BusInboxInspection, type BusInboxOptions, type BusInboxPost } from './bus-inbox.js';
import { CHANNEL_BUS_TTL_MS } from './channel-bus-publish.js';
import type { BusEnvelope } from './bus-envelope.js';

export const BUS_MIRROR_INTERVAL_MS = 30_000;
export const BUS_MIRROR_HEADROOM_COUNT = 900;
export const BUS_MIRROR_HEADROOM_BYTES = 0.9;
export const BUS_MIRROR_EVENT_TEXT_MAX = 500;
export const BUS_MIRROR_JOB_RE = /\bRQ-PHX-[A-Z0-9]+/;
/** Lane names the dispatch log has ever used: the dispatcher's lanes plus the
 * current fleet engine ids. A whitespace-delimited token must match exactly. */
export const BUS_MIRROR_KNOWN_LANES: ReadonlySet<string> = new Set([
  'codex-cmp', 'codex-personal', 'claude', 'devin', 'claude-api', 'codex-local',
  'local', 'grok-cli', 'claude-cli', 'codex', 'devin-cli',
]);
export interface BusMirrorCursor { at: string; key: string }
export type BusMirrorReason = 'ok' | 'headroom' | 'full' | 'unavailable' | 'retryable';
export interface BusMirrorRunResult {
  scanned: number; posted: number; duplicate: number; skipped: number;
  reason: BusMirrorReason;
}
export interface MirrorDispatchDeps {
  read?: (opts: { limit: number }) => Promise<Pick<FleetBusFeedV1, 'events'>>;
  append?: (envelope: BusEnvelope, options?: BusInboxOptions) => BusInboxPost;
  inspect?: (options?: BusInboxOptions) => BusInboxInspection;
  cursorFile?: string;
  now?: () => number;
  limit?: number;
}
export interface StartBusMirrorOptions extends MirrorDispatchDeps { intervalMs?: number }

function runsDir(): string { return process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'); }
function defaultCursorFile(): string { return join(runsDir(), 'queue', 'bus-mirror.cursor'); }
function clampLimit(limit: number | undefined): number {
  const value = Number.isFinite(limit) ? Math.floor(limit!) : 50;
  return Math.min(500, Math.max(1, value));
}

/** fleet-<kind>-<16 hex of sha256(at + text)>: one id per distinct event, so a
 * re-scan of the same log rows dedupes in the store instead of double-posting. */
export function fleetBusEventId(kind: string, at: string, text: string): string {
  return `fleet-${kind}-${createHash('sha256').update(at + text, 'utf8').digest('hex').slice(0, 16)}`;
}

/** One fleet -> all P2 envelope per feed event; body carries the event kind,
 * the log timestamp, bounded text, and the first job token / known lane name. */
export function buildFleetBusEnvelope(event: BusFeedEvent): BusEnvelope {
  const text = event.text.slice(0, BUS_MIRROR_EVENT_TEXT_MAX);
  const job = BUS_MIRROR_JOB_RE.exec(text)?.[0];
  const lane = text.split(/\s+/).find((token) => BUS_MIRROR_KNOWN_LANES.has(token));
  return {
    id: fleetBusEventId(event.kind, event.at, text),
    from: 'fleet',
    to: 'all',
    priority: 'P2',
    ttl: CHANNEL_BUS_TTL_MS,
    body: {
      kind: 'fleet-event', event: event.kind, at: event.at, text,
      ...(job ? { job } : {}), ...(lane ? { lane } : {}),
    },
  };
}

function readCursor(file: string): BusMirrorCursor | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const { at, key } = raw as Record<string, unknown>;
    return typeof at === 'string' && typeof key === 'string' ? { at, key } : null;
  } catch { return null; }
}

/** Temp + rename inside the cursor's own directory, like the other runs-dir
 * state writers (slots.json, lane-target-changes.log). */
function writeCursor(file: string, cursor: BusMirrorCursor): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = join(dirname(file), `.bus-mirror-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(cursor)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* temp may already be gone */ }
    throw error;
  }
}

/** Only an inspected store can be near-full; missing reads as empty. */
function headroomReached(inspection: BusInboxInspection): boolean {
  if (inspection.source !== 'available') return false;
  if (inspection.retainedCount !== null && inspection.retainedCount >= BUS_MIRROR_HEADROOM_COUNT) return true;
  return inspection.retainedBytes !== null &&
    inspection.retainedBytes >= BUS_MIRROR_HEADROOM_BYTES * inspection.maxBytes;
}

/** One bounded pass: read the newest dispatch events, drop the ones the cursor
 * already covered, and append the rest oldest first. The cursor only advances
 * over events the store accepted (posted, duplicate) or permanently refused
 * (invalid, conflict); a transient stop leaves it for the next run to retry. */
export async function mirrorDispatchToBus(deps: MirrorDispatchDeps = {}): Promise<BusMirrorRunResult> {
  const result: BusMirrorRunResult = { scanned: 0, posted: 0, duplicate: 0, skipped: 0, reason: 'ok' };
  try {
    const read = deps.read ?? ((opts: { limit: number }) => readFleetBusFeed(opts));
    const append = deps.append ?? appendBusInbox;
    const inspect = deps.inspect ?? inspectBusInbox;
    const clock = deps.now ?? Date.now;
    const cursorFile = deps.cursorFile ?? defaultCursorFile();
    const feed = await read({ limit: clampLimit(deps.limit) });
    const events = [...(feed.events ?? [])]
      .map((event) => ({ event, envelope: buildFleetBusEnvelope(event) }))
      .sort((a, b) => (a.event.at < b.event.at ? -1 : a.event.at > b.event.at ? 1 : 0));
    result.scanned = events.length;
    const cursor = readCursor(cursorFile);
    let index = 0;
    if (cursor !== null) {
      while (index < events.length && events[index]!.event.at < cursor.at) { result.skipped++; index++; }
      const keyIndex = events.findIndex((row, i) => i >= index &&
        row.event.at === cursor.at && row.envelope.id === cursor.key);
      // Equal timestamps order by log position; the recorded key marks the last
      // mirrored one. A key that aged out of the window leaves the same-second
      // rows to the store's id dedupe rather than dropping real events.
      if (keyIndex >= 0) while (index <= keyIndex) { result.skipped++; index++; }
    }
    let advanced: BusMirrorCursor | null = null;
    for (; index < events.length; index++) {
      const { event, envelope } = events[index]!;
      let inspection: BusInboxInspection;
      try { inspection = inspect({ now: clock }); }
      catch { result.reason = 'unavailable'; break; }
      if (inspection.source === 'unavailable') { result.reason = 'unavailable'; break; }
      if (headroomReached(inspection)) { result.reason = 'headroom'; break; }
      let post: BusInboxPost;
      try { post = append(envelope, { now: clock }); }
      catch { result.reason = 'unavailable'; break; }
      if (post.status === 'posted') result.posted++;
      else if (post.status === 'duplicate') result.duplicate++;
      else if (post.status === 'full' || post.status === 'unavailable' || post.status === 'retryable') {
        result.reason = post.status; break;
      } else result.skipped++; // invalid or conflict: this event can never mirror; move past it.
      advanced = { at: event.at, key: envelope.id };
    }
    if (advanced !== null) {
      try { writeCursor(cursorFile, advanced); }
      catch { result.reason = 'unavailable'; }
    }
  } catch { result.reason = 'unavailable'; }
  return result;
}

// ---------------------------------------------------------------------------
// The in-process loop — one unref'd interval per process, armed on first call.
// ---------------------------------------------------------------------------

export interface BusMirrorState {
  started: boolean; lastRunAt: string | null;
  posted: number; skipped: number; reason: BusMirrorReason | null;
}
const mirrorState: BusMirrorState = { started: false, lastRunAt: null, posted: 0, skipped: 0, reason: null };
let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight: Promise<void> | null = null;

/** Idempotent: a second call while running is a no-op that returns the same
 * stop function. The first pass runs immediately; each tick is guarded so a
 * slow run never overlaps itself and a thrown mirror can never escape. */
export function startBusMirrorLoop(opts: StartBusMirrorOptions = {}): () => void {
  if (mirrorState.started) return stopBusMirrorLoop;
  mirrorState.started = true;
  const intervalMs = Number.isFinite(opts.intervalMs) && opts.intervalMs! > 0
    ? Math.floor(opts.intervalMs!) : BUS_MIRROR_INTERVAL_MS;
  const fire = (): void => {
    if (tickInFlight) return;
    tickInFlight = Promise.resolve()
      .then(() => mirrorDispatchToBus(opts))
      .then((run) => {
        mirrorState.lastRunAt = new Date((opts.now ?? Date.now)()).toISOString();
        mirrorState.posted += run.posted;
        mirrorState.skipped += run.skipped;
        mirrorState.reason = run.reason;
      })
      .catch(() => { mirrorState.reason = 'unavailable'; })
      .finally(() => { tickInFlight = null; });
  };
  timer = setInterval(fire, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  fire();
  return stopBusMirrorLoop;
}

export function getBusMirrorState(): BusMirrorState { return { ...mirrorState }; }

export function stopBusMirrorLoop(): void {
  if (timer) { clearInterval(timer); timer = null; }
  mirrorState.started = false;
}
