import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { BOT_ID_PATTERN } from '../agents/bot-templates.js';
import { participantSchema, providerSchema, type Participant } from '../agents/bus-v2-schema.js';
import { readAgentRegistry, resolveAgent, type AgentIdentityKeyFor } from '../agents/bus-identity.js';
import { coordinationRoot, listCoordination, releaseCoordinationBySource, type CoordinationView } from '../agents/claim-store.js';
import { sendDirectMessage } from '../agents/bus-unified.js';
import { localWriteGate } from '../agents/send-gate.js';
import { assertMetadata } from '../connectors/profile.js';
import { budgetEntryQuota } from '../fabric/lane-usage-self.js';
import { DriveNodes, LocalNodesStore, type NodesStore } from '../drive/nodes/index.js';
import type { QueueJobV1 } from '../drive/nodes/queue-v1.js';
import { ashlrHome } from '../cloud/store.js';
import { canonicalPath, privateDirectory } from '../universe/artifacts.js';
import { LEADERS_ADDRESS } from '../fleet/bus-leader-inbox.js';
import { appendBusInbox } from '../fleet/bus-inbox.js';
import { releaseBusWorkClaimForOwner } from '../fleet/bus-work-claims.js';
import { CHANNEL_BUS_TTL_MS } from '../fleet/channel-bus-publish.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { scrubSecrets } from '../util/scrub.js';
import { fsyncDirectory } from '../util/durability.js';
import { fixedOwnerConfigDir, fixedOwnerRunsDir, loadOwnerThreadSettings } from '../comms/owner-channel.js';
import { liveOwnerTransports } from '../comms/owner-live-transport.js';
import { postOwnerNotice, type OwnerThreadOptions } from '../comms/owner-thread.js';
import { createDevinBotAdapter, devinQuota } from './devin-bot-adapter.js';

export type QuotaEvidence = { status: 'measured' | 'exhausted'; usedPct: number; resetAt: string | null; asOf: string; source: string }
  | { status: 'unknown'; reason: string; asOf: string | null };
export interface SeatAdapter {
  kind: string;
  message(text: string): Promise<Record<string, unknown>>;
  status(): Promise<Record<string, unknown>>;
  usage(): Promise<QuotaEvidence>;
}
const seatSchema = z.object({
  id: z.string().regex(BOT_ID_PATTERN), kind: z.enum(['devin-bot', 'grok-bot', 'openai-bot', 'local', 'other']),
  displayName: participantSchema.shape.displayName, capabilities: participantSchema.shape.capabilities,
  participantId: participantSchema.shape.wake.shape.target, provider: providerSchema.optional(),
  quota: z.discriminatedUnion('source', [z.object({ source: z.literal('devin-acu') }).strict(),
    z.object({ source: z.literal('lane-budget'), lane: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/) }).strict(),
    z.object({ source: z.literal('none') }).strict()]),
  nodeId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/).optional(),
  secretHandle: z.string().regex(/^phm_[a-z][a-z0-9_]{0,63}$/).optional(),
}).strict().refine(s => s.kind !== 'other' || s.provider !== undefined);
export type BotSeat = z.infer<typeof seatSchema>;
export interface SeatState { state: 'active' | 'draining' | 'idle'; since: string; exhaustedReset: string | null }
export function transitionSeatState(prev: SeatState, state: SeatState['state'], now: string): SeatState {
  if (({ active: 'draining', draining: 'idle', idle: 'active' } as const)[prev.state] !== state) throw new Error('Invalid seat transition.');
  return { ...prev, state, since: now };
}
export function nextSeatState(prev: SeatState, input: { quota: QuotaEvidence; openWork: number; now: string }): SeatState {
  const { quota, openWork, now } = input;
  if (quota.status === 'unknown') return prev;
  if (prev.state === 'active' && quota.status === 'exhausted') return { ...transitionSeatState(prev, 'draining', now), exhaustedReset: quota.resetAt };
  if (prev.state === 'draining' && openWork === 0) return transitionSeatState(prev, 'idle', now);
  if (prev.state === 'idle' && quota.status === 'measured' && quota.usedPct < 100 && Date.parse(quota.asOf) > Date.parse(prev.since)
    && (prev.exhaustedReset === null || Date.parse(now) >= Date.parse(prev.exhaustedReset))) return transitionSeatState(prev, 'active', now);
  return prev;
}
export interface SeatHandoff {
  schema: 'phantom-bot-handoff.v1'; handoffId: string; seatId: string; work: { kind: 'node-job' | 'bus-claim'; ref: string };
  done: string; left: string; branch: string | null; pr: string | null; createdAt: string;
}
export interface SeatOptions {
  home?: string; runs?: string; now?: () => number; nodesStore?: NodesStore;
  /** Fleet root the coordination table and identity registry read; default
   * `<home>/.ashlr/fleet` when `home` is set, else the shared coordination
   * root (`<ashlrHome>/fleet`). Set it when the caller's bus/claim stores
   * live under a different fleet root so seat work joins the same table. */
  fleetRoot?: string;
  readQuota?: (seat: BotSeat) => Promise<QuotaEvidence>;
  ownerOptions?: OwnerThreadOptions;
  ownerNotice?: (input: { text: string; idempotencyKey: string }) => Promise<unknown>;
  busPost?: (input: { from: string; text: string; id: string; thread?: string }) => Promise<unknown>;
  releaseNode?: (claim: NonNullable<QueueJobV1['claim']>) => boolean;
}
const root = (o: SeatOptions) => join(o.home ?? homedir(), '.phantom', 'bots');
const runs = (o: SeatOptions) => o.runs ?? (o.home ? join(o.home, '.ashlr-runs') : process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'));
const fleet = (o: SeatOptions) => o.fleetRoot ?? (o.home ? join(o.home, '.ashlr', 'fleet') : coordinationRoot());
function ownerOptions(o: SeatOptions): OwnerThreadOptions {
  if (o.ownerOptions) return o.ownerOptions;
  const settings = loadOwnerThreadSettings(o.home ? join(o.home, '.ashlr') : fixedOwnerConfigDir());
  const runsDir = o.runs ?? (o.home ? runs(o) : fixedOwnerRunsDir());
  return { runsDir, settings, transports: liveOwnerTransports(settings, runsDir), busRoot: fleet(o) };
}
const SEAT_FILE_MAX_BYTES = 4 * 1024 * 1024;
async function safe(o: SeatOptions, file: string) {
  for (const path of [join(o.home ?? homedir(), '.phantom'), root(o)]) {
    try { if (!(await lstat(path)).isDirectory()) throw new Error('Unsafe bot directory.'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  const path = join(root(o), file);
  try { const stat = await lstat(path); if (!stat.isFile() || stat.size > SEAT_FILE_MAX_BYTES) throw new Error('Unsafe seat file.'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return path;
}
async function read(o: SeatOptions, file: string): Promise<string | null> {
  const path = await safe(o, file);
  try { return await readFile(path, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
const seatRosterFileSchema = z.object({ schema: z.literal('phantom-bot-seats.v1'), seats: z.array(seatSchema) }).strict();
/** Parse and validate seats.json text — shared by the async roster read and
 * the synchronous store probe so the two can never disagree on what counts
 * as a valid roster. Throws exactly where roster() threw. */
function parseSeatRoster(text: string): BotSeat[] {
  assertMetadata(text);
  const result = seatRosterFileSchema.safeParse(JSON.parse(text));
  if (!result.success) throw new Error('Invalid seat configuration.');
  const seats = result.data.seats;
  if (new Set(seats.map(s => s.id)).size !== seats.length || new Set(seats.map(s => s.participantId)).size !== seats.length) throw new Error('Duplicate seat identity.');
  return seats;
}
async function roster(o: SeatOptions) {
  const text = await read(o, 'seats.json');
  if (text === null) return [];
  return parseSeatRoster(text);
}
const provider = (s: BotSeat): Participant['provider'] => s.kind === 'other' ? s.provider! : ({ 'devin-bot': 'devin', 'grok-bot': 'grokbot', 'openai-bot': 'openai-dot', local: 'local' } as const)[s.kind];
function participant(seat: BotSeat, state: SeatState): Participant {
  return participantSchema.parse({ participantId: seat.participantId, provider: provider(seat), displayName: seat.displayName,
    capabilities: seat.capabilities, status: state.state === 'active' ? 'active' : 'idle', wake: { kind: 'poll', target: seat.participantId } });
}
async function quota(s: BotSeat, o: SeatOptions): Promise<QuotaEvidence> {
  if (o.readQuota) return o.readQuota(s);
  if (s.quota.source === 'devin-acu') return devinQuota();
  if (s.quota.source === 'lane-budget') {
    let entries: Record<string, Record<string, unknown>> = {};
    try { entries = JSON.parse(await readFile(join(runs(o), 'queue', 'budget-overrides.json'), 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { status: 'unknown', reason: 'stale-or-missing', asOf: null }; }
    const entry = entries[s.quota.lane], evidence = budgetEntryQuota(entry, (o.now ?? Date.now)());
    if (!evidence.value) return { status: 'unknown', reason: 'stale-or-missing', asOf: evidence.asOf };
    const usedPct = evidence.value.usedPercent;
    return { status: usedPct >= 100 ? 'exhausted' : 'measured', usedPct, asOf: evidence.asOf!, resetAt: typeof entry?.['reset_at'] === 'string' ? entry['reset_at'] : null, source: 'lane-budget' };
  }
  return { status: 'unknown', reason: 'no-quota-source', asOf: null };
}
export function advisorySeatAdapter(s: BotSeat, usage: () => Promise<QuotaEvidence>): SeatAdapter {
  return { kind: s.kind, usage, status: async () => ({ status: 'unknown', reason: 'advisory-only' }),
    async message(text) { assertMetadata(text); return { status: 'advisory', reason: s.kind === 'local' ? 'loopback-only-no-execution' : 'no-documented-bot-messaging-api' }; } };
}
function nodes(o: SeatOptions): NodesStore {
  return o.nodesStore ?? { transaction: fn => new LocalNodesStore(privateDirectory(canonicalPath(join(o.home ? join(o.home, '.ashlr') : ashlrHome(), 'nodes')))).transaction(fn) };
}
interface SeatClaimOwners {
  identityOf: AgentIdentityKeyFor | undefined;
  registry: 'missing' | 'available' | 'unavailable';
}

/** One registry snapshot for matching and diagnostics; labels are never authentication. */
function claimOwnerResolver(o: SeatOptions): SeatClaimOwners {
  const read = readAgentRegistry({ root: fleet(o), now: o.now });
  if (read.status !== 'ok') return { registry: 'unavailable', identityOf: undefined };
  const cache = new Map<string, string | undefined>();
  return { registry: read.source, identityOf: label => {
    if (!cache.has(label)) cache.set(label, (resolveAgent(read.registry, label) ?? resolveAgent(read.registry, label.toLowerCase()))?.id);
    return cache.get(label);
  } };
}

async function openWork(s: BotSeat, o: SeatOptions, owners: SeatClaimOwners) {
  const { identityOf } = owners;
  const coordination = listCoordination(fleet(o), (o.now ?? Date.now)());
  if (coordination.source === 'unavailable') throw new Error('Coordination store unavailable.');
  // A seat's open claims are the live rows its participantId owns — or any
  // other label of the same registered bus identity, the same owner matching
  // `claim list --owner` applies. An unresolvable participantId or unreadable
  // registry keeps exact-label matching: unknown identity state never widens
  // what a draining seat must hand off.
  const ownerKey = identityOf?.(s.participantId);
  const claims = coordination.claims.filter(c => c.live &&
    (c.owner === s.participantId || (ownerKey !== undefined && identityOf?.(c.owner) === ownerKey)));
  let jobs: QueueJobV1[] = [];
  if (s.nodeId) {
    const path = join(o.home ? join(o.home, '.ashlr') : ashlrHome(), 'nodes', 'nodes.json');
    let exists = Boolean(o.nodesStore);
    if (!exists) {
      try { await lstat(path); exists = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (exists) jobs = nodes(o).transaction(state => structuredClone(state.jobs));
    jobs = jobs.filter(j => j.state === 'running' && j.claim?.nodeId === s.nodeId);
  }
  return { claims, jobs, claimsOwner: { ref: s.participantId, identity: ownerKey ?? null, registry: owners.registry } };
}
async function snapshot(o: SeatOptions) {
  const states = JSON.parse(await read(o, 'seat-state.json') ?? '{}') as Record<string, SeatState>;
  const history = (await read(o, 'handoffs.jsonl') ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line) as SeatHandoff);
  const now = new Date((o.now ?? Date.now)()).toISOString();
  const owners = claimOwnerResolver(o);
  const seats = await Promise.all((await roster(o)).map(async seat => {
    const evidence = await quota(seat, o), work = await openWork(seat, o, owners);
    const state = nextSeatState(states[seat.id] ?? { state: 'active', since: now, exhaustedReset: null }, { quota: evidence, openWork: work.claims.length + work.jobs.length, now });
    return { seat, quota: evidence, work, state };
  }));
  return { seats, states, history, now };
}
async function persist(states: Record<string, SeatState>, o: SeatOptions) {
  const path = await safe(o, 'seat-state.json');
  await mkdir(root(o), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(states) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
}
async function seatsView(o: SeatOptions, persistProjected: boolean) {
  const data = await snapshot(o);
  const seats = await Promise.all(data.seats.map(async ({ seat, quota: evidence, state, work }) => {
    const adapter = seat.kind === 'devin-bot' ? createDevinBotAdapter({ ...seat, readUsage: async () => evidence }) : advisorySeatAdapter(seat, async () => evidence);
    return { ...seat, provider: provider(seat), participant: participant(seat, state), state: state.state, acceptsNewWork: state.state === 'active' && evidence.status === 'measured', quota: evidence,
      claims: work.claims, claimsOwner: work.claimsOwner, inFlight: work.jobs.map(j => ({ id: j.id, state: j.state })), handoffs: data.history.filter(h => h.seatId === seat.id).slice(-20), adapter: await adapter.status() };
  }));
  const output = { schema: 'phantom-bot-seats.v1' as const, seats };
  assertMetadata(JSON.stringify({ ...output, seats: output.seats.map(s => ({ ...s, handoffs: s.handoffs.map(({ handoffId: _id, ...h }) => h) })) }));
  if (persistProjected) {
    let changed = false;
    for (const row of data.seats) {
      if (row.state.state !== (data.states[row.seat.id]?.state ?? 'active')) {
        data.states[row.seat.id] = row.state;
        changed = true;
      }
    }
    if (changed) await persist(data.states, o);
  }
  return output;
}
export function listSeats(o: SeatOptions = {}) {
  return seatsView(o, true);
}
/**
 * The same seat views `listSeats` computes — quota evidence, projected
 * lifecycle state, `acceptsNewWork`, live claims, in-flight jobs and recent
 * handoffs — minus the persist-on-read lifecycle write `phm bots seats`
 * performs, for surfaces that must never mutate seat state (the isolated
 * fleet MCP server's `fleet_bot_seats`). Claims still coordinate only; the
 * roster grants no execution authority.
 */
export function readBotSeats(o: SeatOptions = {}) {
  return seatsView(o, false);
}
/** The roster `readBotSeats`/`listSeats` return — one entry per configured seat. */
export type BotSeatsRoster = Awaited<ReturnType<typeof readBotSeats>>;
export async function seatMayClaim(id: string, o: SeatOptions = {}): Promise<boolean> {
  return (await listSeats(o)).seats.find(s => s.id === id)?.acceptsNewWork ?? false;
}
export async function seatParticipants(o: SeatOptions = {}): Promise<Participant[]> {
  return (await listSeats(o)).seats.map(s => s.participant);
}

/** What `inspectSeatStore` reports about the four files under
 * `<home>/.phantom/bots` — retained counts only, never seat contents. */
export interface SeatStoreInspection {
  /** 'missing' when the bots directory itself is absent — a verified-empty
   * store whose counts are real zeros; 'unavailable' when the directory or
   * any present file fails the same checks `safe()`/`read()` apply, the same
   * failure that makes `planSeatHandoffs` throw; 'available' when the
   * directory exists and every present file read cleanly. */
  source: 'missing' | 'available' | 'unavailable';
  /** Roster rows in seats.json; null when that file could not be read or
   * fails `parseSeatRoster` validation — the failure `roster()` throws on. */
  seats: number | null;
  /** seat-state.json state-map entries; null when the file could not be
   * read or parses to `null`, the one JSON value `snapshot()` cannot index
   * by seat id. */
  states: number | null;
  /** Retained handoffs.jsonl records; null when the journal could not be
   * read or holds a line `snapshot()` cannot parse — `null` parses but
   * throws on the `.seatId`/`.handoffId` lookups downstream. */
  handoffs: number | null;
  /** handoff-notices.json receipt-map entries; null when the file could not
   * be read or does not parse to the plain object `applySeatHandoff` indexes
   * and rewrites — every other JSON shape throws on a receipt lookup or
   * silently drops receipts on the next `saveReceipts`, so applies would
   * fail or resend while a seats/states/handoffs-only probe stayed green. */
  notices: number | null;
}

type SeatFileInspection = { kind: 'absent' } | { kind: 'unsafe' } | { kind: 'text'; text: string };

/** The synchronous twin of `safe()`+`read()` for one seat file: the same
 * regular-file and size rules, the same ENOENT-tolerant absence — reported
 * instead of thrown so the probe can name exactly which file is sick. */
function inspectSeatFile(dir: string, name: string): SeatFileInspection {
  const path = join(dir, name);
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unsafe' };
  }
  if (!stat.isFile() || stat.size > SEAT_FILE_MAX_BYTES) return { kind: 'unsafe' };
  try { return { kind: 'text', text: readFileSync(path, 'utf8') }; }
  catch { return { kind: 'unsafe' }; }
}

/**
 * Read-only probe of the seat store `planSeatHandoffs`, `listSeats`, the
 * unified bus's seats surfaces and the apply path's notice receipts share —
 * the synchronous counterpart of the file half of `snapshot()` plus the
 * `handoff-notices.json` map `applySeatHandoff` indexes and rewrites.
 * Never throws and never writes: an absent bots
 * directory is a verified-empty store (real zeros); a directory or file
 * failing the `safe()` checks, or a file whose contents `roster()`/
 * `snapshot()`/the receipts read would reject, reports `unavailable` with
 * that file's count null while the other files still report what they
 * really hold. Seat contents, live claims and quota evidence are never
 * read here — this names store health only.
 */
export function inspectSeatStore(home?: string): SeatStoreInspection {
  const unavailable: SeatStoreInspection = { source: 'unavailable', seats: null, states: null, handoffs: null, notices: null };
  const phantomDir = join(home ?? homedir(), '.phantom');
  const dir = join(phantomDir, 'bots');
  // The same directory rule safe() enforces on every read: each existing
  // level must be a real directory — a file or symlink where a directory
  // belongs makes every file under it unsafe.
  let dirPresent = false;
  for (const path of [phantomDir, dir]) {
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return unavailable;
    }
    if (!stat.isDirectory()) return unavailable;
    if (path === dir) dirPresent = true;
  }
  if (!dirPresent) return { source: 'missing', seats: 0, states: 0, handoffs: 0, notices: 0 };

  let degraded = false;

  const seatsFile = inspectSeatFile(dir, 'seats.json');
  let seats: number | null = 0;
  if (seatsFile.kind === 'unsafe') { seats = null; degraded = true; }
  else if (seatsFile.kind === 'text') {
    try { seats = parseSeatRoster(seatsFile.text).length; }
    catch { seats = null; degraded = true; }
  }

  const statesFile = inspectSeatFile(dir, 'seat-state.json');
  let states: number | null = 0;
  if (statesFile.kind === 'unsafe') { states = null; degraded = true; }
  else if (statesFile.kind === 'text') {
    try {
      const parsed: unknown = JSON.parse(statesFile.text);
      // snapshot() indexes the parsed value by seat id: `null` throws, and
      // any other non-map JSON reads as empty — only a plain object's keys
      // are real state rows.
      if (parsed === null) throw new Error('Invalid seat state.');
      states = typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).length : 0;
    } catch { states = null; degraded = true; }
  }

  const handoffsFile = inspectSeatFile(dir, 'handoffs.jsonl');
  let handoffs: number | null = 0;
  if (handoffsFile.kind === 'unsafe') { handoffs = null; degraded = true; }
  else if (handoffsFile.kind === 'text') {
    try {
      const lines = handoffsFile.text.split('\n').filter(Boolean);
      for (const line of lines) {
        if (JSON.parse(line) === null) throw new Error('Invalid handoff record.');
      }
      handoffs = lines.length;
    } catch { handoffs = null; degraded = true; }
  }

  const noticesFile = inspectSeatFile(dir, 'handoff-notices.json');
  let notices: number | null = 0;
  if (noticesFile.kind === 'unsafe') { notices = null; degraded = true; }
  else if (noticesFile.kind === 'text') {
    try {
      const parsed: unknown = JSON.parse(noticesFile.text);
      // applySeatHandoff keeps this file as a receipts map it indexes by
      // handoff id and rewrites through saveReceipts: only a plain object
      // survives that round trip. `null` throws on the lookup, primitives
      // throw on the write and an array silently drops the string-keyed
      // receipts on stringify — all three leave applies failing or
      // resending notices the file was meant to suppress.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Invalid handoff notices.');
      }
      notices = Object.keys(parsed).length;
    } catch { notices = null; degraded = true; }
  }

  return { source: degraded ? 'unavailable' : 'available', seats, states, handoffs, notices };
}
/** The journal's own row-label rule: printable ASCII, at most 128 chars. A
 * claim whose id or owner cannot name a journal row — a hand-built
 * `origin:'message'` lease, say — falls back to the coordination release
 * alone, which is safe because no journal lease can exist for it. */
const JOURNAL_LABEL = /^[\x21-\x7e]{1,128}$/;
/** The journal coordinates a message claim's `queue:<id>` key and
 * `<id>:<cursor>:<receivedAt>` sourceId carry — the same triple the
 * claim-store drift read joins the two stores on. Undefined when the claim
 * is not a standard bus-work-claims row (a foreign `queue:` key or an
 * unparseable sourceId), in which case only the coordination release below
 * applies. An id may itself contain ':'; the tail is split only after the
 * known `<id>:` prefix, the same rule the drift read applies. */
function busWorkClaimTarget(claim: CoordinationView): { id: string; cursor: number; receivedAt: number } | undefined {
  if (!claim.key.startsWith('queue:')) return undefined;
  const id = claim.key.slice('queue:'.length);
  if (!JOURNAL_LABEL.test(id) || !JOURNAL_LABEL.test(claim.owner)) return undefined;
  const prefix = `${id}:`;
  if (!claim.sourceId.startsWith(prefix)) return undefined;
  const tail = claim.sourceId.slice(prefix.length).split(':');
  if (tail.length !== 2 || !/^\d+$/.test(tail[0]!) || !/^\d+$/.test(tail[1]!)) return undefined;
  const cursor = Number(tail[0]), receivedAt = Number(tail[1]);
  if (!Number.isSafeInteger(cursor) || cursor < 1 || !Number.isSafeInteger(receivedAt)) return undefined;
  return { id, cursor, receivedAt };
}
function handoff(seatId: string, kind: SeatHandoff['work']['kind'], ref: string, identity: string, now: string, claim?: CoordinationView): SeatHandoff {
  return { schema: 'phantom-bot-handoff.v1', handoffId: createHash('sha256').update(JSON.stringify([seatId, kind, ref, identity])).digest('hex'), seatId,
    work: { kind, ref }, done: 'unknown', left: 'unknown', branch: claim?.branch ?? null, pr: claim?.key.startsWith('pr:') ? claim.key.slice(3) : null, createdAt: now };
}
type SeatOpenWork = Awaited<ReturnType<typeof openWork>>;
/** The eligibility rule plan and apply share: draining seats always qualify;
 * idle seats qualify while they still hold work or carry handoff history —
 * apply retries their unfinished notice receipts even with nothing left to
 * release. Active seats and idle seats with neither are refused. */
function seatHandoffEligible(state: SeatState['state'], work: SeatOpenWork, history: readonly SeatHandoff[], seatId: string): boolean {
  return state === 'draining' ||
    (state === 'idle' && (work.claims.length > 0 || work.jobs.length > 0 || history.some(h => h.seatId === seatId)));
}
/** Every live claim and fenced node job as a deterministic handoff record. */
function seatHandoffRecords(seatId: string, work: SeatOpenWork, now: string): SeatHandoff[] {
  return [...work.claims.map(c => handoff(seatId, 'bus-claim', c.key, `${c.origin}:${c.sourceId}:${c.leaseUntil}`, now, c)),
    ...work.jobs.map(j => handoff(seatId, 'node-job', j.id, `${j.claim!.session}:${j.claim!.token}`, now))];
}
async function plan(id: string, o: SeatOptions) {
  const data = await snapshot(o), row = data.seats.find(s => s.seat.id === id);
  if (!row) throw new Error('Unknown seat.');
  if (!seatHandoffEligible(row.state.state, row.work, data.history, id)) throw new Error('Seat must be draining or idle with open work.');
  const records = seatHandoffRecords(id, row.work, data.now);
  assertMetadata(JSON.stringify(records.map(({ handoffId: _id, ...h }) => h)));
  return { data, row, records };
}
export async function planSeatHandoff(id: string, o: SeatOptions = {}) {
  const { data, row, records } = await plan(id, o);
  return { schema: 'phantom-bot-handoff-plan.v1', seatId: id, state: row.state.state, apply: false, handoffs: records.filter(h => !data.history.some(old => old.handoffId === h.handoffId)) };
}

/** One roster seat's slice of the fleet handoff plan. */
export interface SeatHandoffPlanEntry {
  seatId: string;
  /** The bus routing label the seat's claims and messages answer to. */
  participantId: string;
  /** Projected lifecycle state at the read instant — the same state listSeats reports. */
  state: SeatState['state'];
  /** Same eligibility rule planSeatHandoff/applySeatHandoff enforce; false means apply would refuse this seat. */
  eligible: boolean;
  /** Pending work records — live claims and fenced node jobs not yet journaled — for eligible seats only; empty for ineligible ones, whose work is not handoff candidates. */
  handoffs: SeatHandoff[];
}
export interface SeatHandoffsPlan {
  schema: 'phantom-bot-handoffs-plan.v1';
  apply: false;
  seats: SeatHandoffPlanEntry[];
}

/**
 * The optional narrowing `phm bots handoffs` applies to the fleet plan read:
 * `seat` keeps the one entry whose roster `seatId` matches exactly, `state`
 * keeps entries projected into that lifecycle state, and `pending` keeps only
 * entries still carrying handoff records not yet journaled — the same
 * `handoffs.length > 0` rule the unified inbox seats source and `work mine`'s
 * seats section already apply, so "which seats still have work to move" is
 * one filtered read instead of paging the whole roster. An unmatched filter
 * is an honest empty `seats` list, never an error or an invented seat.
 */
export interface SeatHandoffsPlanFilter {
  seat?: string;
  state?: SeatState['state'];
  pending?: boolean;
}

/**
 * Narrow a fleet handoff plan without touching it: the result keeps the
 * `phantom-bot-handoffs-plan.v1` shape and `apply:false`, so a filtered read
 * stays a plan — nothing is released, journaled or notified, and filtering
 * can never widen eligibility or invent records.
 */
export function filterSeatHandoffsPlan(plan: SeatHandoffsPlan, filter: SeatHandoffsPlanFilter): SeatHandoffsPlan {
  const seats = plan.seats.filter(entry =>
    (filter.seat === undefined || entry.seatId === filter.seat) &&
    (filter.state === undefined || entry.state === filter.state) &&
    (filter.pending !== true || entry.handoffs.length > 0));
  return { ...plan, seats };
}

/**
 * Fleet-wide dry-run of every seat handoff: one snapshot answers "which seats
 * need draining and what work would move" instead of one planSeatHandoff call
 * per seat. Every roster seat is listed — ineligible ones report
 * `eligible: false` with no records rather than erroring — so the whole
 * roster's handoff posture reads in one call. Eligibility and pending records
 * follow the same rules the single-seat plan enforces; handoff ids are the
 * same deterministic ids apply journals, so a later per-seat apply dedupes.
 * Read-only: no locks, no writes, no releases, no notices.
 */
export async function planSeatHandoffs(o: SeatOptions = {}): Promise<SeatHandoffsPlan> {
  const data = await snapshot(o);
  const seats = data.seats.map(({ seat, state, work }) => {
    const eligible = seatHandoffEligible(state.state, work, data.history, seat.id);
    const handoffs = eligible
      ? seatHandoffRecords(seat.id, work, data.now).filter(h => !data.history.some(old => old.handoffId === h.handoffId))
      : [];
    return { seatId: seat.id, participantId: seat.participantId, state: state.state, eligible, handoffs };
  });
  assertMetadata(JSON.stringify({ schema: 'phantom-bot-handoffs-plan.v1', apply: false,
    seats: seats.map(({ handoffs, ...rest }) => ({ ...rest, handoffs: handoffs.map(({ handoffId: _id, ...h }) => h) })) }));
  return { schema: 'phantom-bot-handoffs-plan.v1', apply: false, seats };
}
export type NoticeStatus = 'posted' | 'accepted' | 'sent' | 'duplicate' | 'halted' | 'refused' | 'unavailable' | 'failed' | 'unknown';
export type NoticeReceipt = { bus?: NoticeStatus; owner?: NoticeStatus };
/** One journaled handoff record plus its per-channel notification receipts —
 * the element `applySeatHandoff` reports per applied record and
 * `applySeatHandoffs` carries into its per-seat result. */
export type AppliedSeatHandoff = SeatHandoff & { notifications: NoticeReceipt };
async function noticeStatus(send: () => Promise<unknown>): Promise<NoticeStatus> {
  try {
    const result = await send();
    const status = result && typeof result === 'object' && 'status' in result ? result.status : 'unknown';
    return ['posted', 'accepted', 'sent', 'duplicate', 'halted', 'refused', 'unavailable'].includes(String(status)) ? status as NoticeStatus : 'unknown';
  } catch { return 'failed'; }
}
/** The `job:<id>` thread label a handoff bus note cites for a node-job record —
 * the same job citation the unified inbox seats source and `work mine --job`
 * already apply to a `node-job` ref, so every `--job` bus read and the job's
 * conversation thread find the notice. A `bus-claim` ref is a coordination
 * claim key, never a job citation, and a ref that cannot form a valid bus
 * label cites nothing rather than a guessed thread. */
function handoffJobThread(record: SeatHandoff): string | undefined {
  if (record.work.kind !== 'node-job') return undefined;
  const thread = `job:${record.work.ref}`;
  return /^[\x21-\x7e]{1,128}$/.test(thread) ? thread : undefined;
}
/**
 * The per-record bus note: one system envelope on the shared bus addressed to
 * the fleet work sink (`leaders`), the same place work announcements and peer
 * escalations land. A seat participantId is a bus label, not a registered
 * identity, so this cannot go through postChannelMessage (which requires a
 * registered sender and channel membership); it follows the owner-thread
 * mirror instead — appendBusInbox with the channel metadata group, KILL and
 * the comms pause honored, no wake for a P2 notice. The handoff id is the
 * envelope id, so a crash-retry dedupes to `duplicate` rather than doubling.
 */
async function seatHandoffBusNotice(input: { from: string; text: string; id: string; thread?: string }, o: SeatOptions) {
  const blocked = localWriteGate();
  if (blocked) return { status: blocked.status };
  if (scrubSecrets(input.text) !== input.text) return { status: 'refused' };
  const posted = appendBusInbox({
    id: input.id, from: input.from, to: LEADERS_ADDRESS, priority: 'P2', ttl: CHANNEL_BUS_TTL_MS,
    body: { kind: 'note', text: input.text, ...(input.thread === undefined ? {} : { thread: input.thread }) },
    channel: 'bus', channel_ref: `seat-handoff:${input.id}`,
    sender: { agent_id: input.from, vendor: 'phantom', human: false, team: true },
    external: false, origin_bridge: 'bot-seats',
  }, { root: fleet(o), now: o.now });
  return { status: posted.status === 'posted' || posted.status === 'duplicate' ? posted.status
    : posted.status === 'unavailable' || posted.status === 'retryable' || posted.status === 'full'
      ? 'unavailable' : 'refused' };
}

async function saveReceipts(receipts: Record<string, NoticeReceipt>, o: SeatOptions) {
  const path = await safe(o, 'handoff-notices.json');
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(receipts) + '\n'); await file.sync(); } finally { await file.close(); }
  await rename(temp, path);
  fsyncDirectory(root(o));
}
export async function applySeatHandoff(id: string, o: SeatOptions = {}) {
  await safe(o, 'handoffs.jsonl');
  await mkdir(root(o), { recursive: true, mode: 0o700 });
  const lock = acquireLocalStoreLock(join(root(o), 'handoff.lock'), 2000);
  if (!lock) throw new Error('Seat handoff store unavailable or contended.');
  try {
    const { data, row, records } = await plan(id, o);
    const owners = claimOwnerResolver(o);
    const receipts = JSON.parse(await read(o, 'handoff-notices.json') ?? '{}') as Record<string, NoticeReceipt>;
    const pending = [...records];
    for (const old of data.history.filter(h => h.seatId === id)) {
      if (!pending.some(h => h.handoffId === old.handoffId) && (!receipts[old.handoffId]?.bus || !receipts[old.handoffId]?.owner)) pending.push(old);
    }
    const applied: Array<SeatHandoff & { notifications: NoticeReceipt }> = [];
    data.states[id] = row.state;
    await persist(data.states, o);
    for (const record of pending) {
      const existing = data.history.some(h => h.handoffId === record.handoffId);
      if (!existing) {
        const file = await open(await safe(o, 'handoffs.jsonl'), 'a', 0o600);
        try { await file.writeFile(JSON.stringify(record) + '\n'); await file.sync(); } finally { await file.close(); }
        fsyncDirectory(root(o));
      }
      const held = records.some(h => h.handoffId === record.handoffId);
      if (held && record.work.kind === 'node-job') {
        const claim = row.work.jobs.find(j => j.id === record.work.ref)!.claim!;
        const released = o.releaseNode ? o.releaseNode(claim) : new DriveNodes(nodes(o), { now: o.now }).release(claim, true);
        if (!released && (await openWork(row.seat, o, owners)).jobs.some(j => j.claim?.token === claim.token && j.id === claim.jobId)) throw new Error('Node claim release refused.');
      } else if (held) {
        const claim = row.work.claims.find(c => c.key === record.work.ref)!;
        if (claim.origin === 'queue') throw new Error('Bus claim release refused.');
        // An origin 'message' claim is dual-written to the bus work-claims
        // journal: releasing only the coordination row would leave the
        // journal lease live — the message stays claimed and the claim-drift
        // read reports it forever. The journal's owner-authorized release
        // settles both stores under its writer lock first; the by-source
        // release below then answers 'lost' for the already-dropped partner
        // or finishes a claim that never journaled. Journal-side refusals
        // (unavailable, contended, a disagreeing live partner) fail the
        // apply honestly so a retry resumes the release.
        if (claim.origin === 'message') {
          const target = busWorkClaimTarget(claim);
          if (target !== undefined) {
            const journal = releaseBusWorkClaimForOwner({ ...target, owner: claim.owner,
              root: fleet(o), now: (o.now ?? Date.now)() });
            if (!['released', 'lost', 'expired', 'completed'].includes(journal.status)) {
              throw new Error('Bus claim release refused.');
            }
          }
        }
        const result = releaseCoordinationBySource({ root: fleet(o), origin: claim.origin, sourceId: claim.sourceId,
          owner: claim.owner, leaseUntil: claim.leaseUntil, now: (o.now ?? Date.now)() });
        if (!['released', 'lost', 'stale', 'expired'].includes(result.status)) throw new Error('Bus claim release refused.');
      }
      const notifications = receipts[record.handoffId] ?? {};
      if (existing && notifications.bus && notifications.owner && !held) continue;
      const notice = { text: `Seat ${id} handed off ${record.work.kind} ${record.work.ref}. Done: ${record.done}; left: ${record.left}.`, idempotencyKey: `seat-handoff:${record.handoffId}` };
      receipts[record.handoffId] = notifications;
      const thread = handoffJobThread(record);
      if (!notifications.bus) {
        notifications.bus = await noticeStatus(() => o.busPost
          ? o.busPost({ from: row.seat.participantId, text: notice.text, id: record.handoffId,
              ...(thread === undefined ? {} : { thread }) })
          : seatHandoffBusNotice({ from: row.seat.participantId, text: notice.text, id: record.handoffId, thread }, o));
        await saveReceipts(receipts, o);
      }
      if (!notifications.owner) {
        notifications.owner = await noticeStatus(() => o.ownerNotice ? o.ownerNotice(notice) : postOwnerNotice(notice, ownerOptions(o)));
        await saveReceipts(receipts, o);
      }
      applied.push({ ...record, notifications });
    }
    const remaining = await openWork(row.seat, o, owners);
    data.states[id] = nextSeatState(row.state, { quota: row.quota, openWork: remaining.claims.length + remaining.jobs.length, now: data.now });
    await persist(data.states, o);
    return { schema: 'phantom-bot-handoff-plan.v1', seatId: id, state: data.states[id]!.state, apply: true, handoffs: applied };
  } finally { releaseLocalStoreLock(lock); }
}

/** One seat's slice of the fleet apply result. */
export interface SeatHandoffsApplySeat {
  seatId: string;
  /** The bus routing label the seat's claims and messages answer to. */
  participantId: string;
  /** Plan-time eligibility under the same rule plan/apply enforce; false means
   * no apply was attempted for this seat. */
  eligible: boolean;
  /** 'applied' the seat's pending records journaled, held work released and
   * notices receipted — already-complete records count, the apply is
   * idempotent; 'skipped' the seat was ineligible at plan time or stopped
   * qualifying before its turn; 'contended' the shared handoff-store lock
   * could not be taken; 'failed' the apply threw — `reason` then names the
   * fixed failure class, 'unavailable' when the thrown error is not one of
   * the module's value-free phrases (a filesystem error can carry a path). */
  outcome: 'applied' | 'skipped' | 'contended' | 'failed';
  /** The seat's lifecycle state after its turn: the apply's reported state on
   * 'applied', the plan's projection otherwise. A 'failed' apply can still
   * have persisted its projected transition before throwing, so only 'applied'
   * carries a verified post-apply state. */
  state: SeatState['state'];
  /** Journaled handoff records with their notification receipts — populated
   * only on 'applied'; a skipped, contended or failed seat lists none even
   * though its pending records still wait (re-run the plan to see them). */
  handoffs: AppliedSeatHandoff[];
  /** The fixed failure phrase on 'contended'/'failed'; absent otherwise. */
  reason?: string;
}
export interface SeatHandoffsApply {
  schema: 'phantom-bot-handoffs-apply.v1';
  apply: true;
  seats: SeatHandoffsApplySeat[];
}
/** The value-free failure phrases `applySeatHandoff` throws — the only error
 * messages a fleet apply may surface verbatim; anything else collapses to
 * 'unavailable' because a filesystem error can carry a path. */
const APPLY_FIXED_REASONS: ReadonlySet<string> = new Set([
  'Unknown seat.',
  'Seat must be draining or idle with open work.',
  'Seat handoff store unavailable or contended.',
  'Node claim release refused.',
  'Bus claim release refused.',
]);
function applySeatFailure(error: unknown): { outcome: 'skipped' | 'contended' | 'failed'; reason?: string } {
  const message = error instanceof Error ? error.message : '';
  if (message === 'Seat must be draining or idle with open work.') return { outcome: 'skipped' };
  if (message === 'Seat handoff store unavailable or contended.') return { outcome: 'contended', reason: message };
  return { outcome: 'failed', reason: APPLY_FIXED_REASONS.has(message) ? message : 'unavailable' };
}
/**
 * Fleet-wide apply of every eligible seat handoff — the write half of the
 * `planSeatHandoffs` dry-run `phm bots handoffs` and `fleet_seat_handoffs`
 * serve. One plan snapshot picks the candidates, then each eligible seat
 * runs the same `applySeatHandoff` a per-seat `--apply` runs, serialized by
 * the shared handoff-store lock it already takes: journal-before-release,
 * idempotent notices and stale-safe claim fencing are unchanged, so seats
 * are independent and a partial fleet apply is safely re-run — applied seats
 * simply find nothing pending on the next pass.
 *
 * Per-seat outcomes are honest and independent: 'applied' seats report the
 * apply's own state and journaled records; 'skipped' seats were ineligible at
 * plan time or stopped qualifying before their turn; 'contended' seats never
 * got the store lock; 'failed' seats threw — `reason` is one of the module's
 * fixed phrases or 'unavailable', never a raw error that could carry a path.
 * A throwing plan read propagates exactly as `planSeatHandoffs` does: with no
 * roster snapshot there is nothing per-seat to report. This grants no
 * authority beyond the per-seat apply — claims still coordinate scope only.
 */
export async function applySeatHandoffs(o: SeatOptions = {}): Promise<SeatHandoffsApply> {
  const plan = await planSeatHandoffs(o);
  const seats: SeatHandoffsApplySeat[] = [];
  for (const entry of plan.seats) {
    if (!entry.eligible) {
      seats.push({ seatId: entry.seatId, participantId: entry.participantId,
        eligible: false, outcome: 'skipped', state: entry.state, handoffs: [] });
      continue;
    }
    try {
      const applied = await applySeatHandoff(entry.seatId, o);
      seats.push({ seatId: entry.seatId, participantId: entry.participantId,
        eligible: true, outcome: 'applied', state: applied.state, handoffs: applied.handoffs });
    } catch (error) {
      const failure = applySeatFailure(error);
      seats.push({ seatId: entry.seatId, participantId: entry.participantId,
        eligible: true, outcome: failure.outcome, state: entry.state, handoffs: [],
        ...(failure.reason === undefined ? {} : { reason: failure.reason }) });
    }
  }
  assertMetadata(JSON.stringify({ schema: 'phantom-bot-handoffs-apply.v1', apply: true,
    seats: seats.map(({ handoffs, ...rest }) => ({ ...rest, handoffs: handoffs.map(({ handoffId: _id, ...h }) => h) })) }));
  return { schema: 'phantom-bot-handoffs-apply.v1', apply: true, seats };
}
export async function sendSeatMessage(input: { from: string; to: string; text: string }, o: SeatOptions = {}) {
  assertMetadata(input.text);
  const seats = await roster(o);
  const sender = seats.find(s => s.id === input.from || s.participantId === input.from);
  // `to` resolves like `from`: a participantId wins over a seat id, so both
  // roster spellings reach the same seat and 'owner' stays the thread target.
  const target = input.to === 'owner' ? undefined
    : seats.find(s => s.participantId === input.to) ?? seats.find(s => s.id === input.to);
  if (!sender || (input.to !== 'owner' && !target)) throw new Error('Unknown seat.');
  if (input.to === 'owner') {
    const notice = { text: input.text, idempotencyKey: `seat-message:${randomUUID()}` };
    if (o.ownerNotice) return o.ownerNotice(notice);
    return postOwnerNotice(notice, ownerOptions(o));
  }
  // The DM resolves identities and appends through the same fleet root and
  // clock the seat's claims and handoff notices use; runsRoot only places the
  // wake hint queue.
  return sendDirectMessage({ from: sender.participantId, to: target!.participantId, text: input.text },
    { root: fleet(o), runsRoot: runs(o), now: o.now });
}
