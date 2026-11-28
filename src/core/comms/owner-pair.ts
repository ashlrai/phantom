/**
 * Pair Mason's iMessage handle (`phm owner pair imessage`). The one pairing text
 * goes through the loopback bridge to every own handle on this Mac (cap 4: each is
 * an account signed in here, so each is Mason's); the FIRST handle that answers YES
 * binds. A YES counts from the handle itself or as sent-by-me in the self-chat with
 * it (his phone shares the Apple ID), when it is newer than the send, is exactly
 * YES, and is not the pairing text. A reply from any other handle binds nothing.
 *
 * Binding writes the handle under [mason] and [team] in agent-network.toml, then
 * confirms comms.toml through the owner-gated confirm route's handler-level function
 * (confirmCommsForOwnerProof in web/comms-confirm-route.ts), so the confirm writer
 * keeps its single caller. An existing iMessage owner is never overwritten.
 * RQ-PAIRMULTIN22ZQ8.
 *
 * State is one 0600 file, comms/owner-pair.json (pending handles, reply cursor,
 * and automatic invitation history). Tests inject the bridge and send nothing.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { parseTeamIdentities, type TeamIdentity } from '../agents/channel-policy.js';
import { parseMasonIdentities } from '../agents/leader-network.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { IMESSAGE_HANDLE_RE, detectOwnIMessageHandles, pollPairReplies, readMaxRowId, sendIMessage } from '../integrations/imessage.js';
import type { AshlrConfig } from '../types.js';
import { readCommsLimits } from './comms-confirm.js';
import { loadOwnerThreadSettings } from './owner-channel.js';
import { OWNER_PAIR_STATE_FILE, PAIR_MAX_HANDLES, parsePendingRecord, type PairPending } from './owner-pair-pending.js';

// The pending-record read lives in owner-pair-pending.ts — a leaf module the
// unified inbox can import without pulling this file's bridge, network-rewrite
// and confirm-route edges into the Tier-1 authority closure. Re-exported here
// so the pair surface stays one import site.
export { PAIR_MAX_HANDLES };
export type { PairPending };
export { readOwnerPairPending, type OwnerPairPendingRead, type OwnerPairPendingSummary } from './owner-pair-pending.js';

export const PAIR_TEXT = 'Phantom: reply YES to get fleet updates here.';
export const PAIR_TTL_MS = 24 * 60 * 60 * 1000;
const PAIR_AUTO_LIMIT = 2;
const DECLINED_LINE = 'Automatic pairing invitations stopped. Run phm owner pair imessage to pair by hand.';

interface AutoInvitation { sent: number; declinedAt?: number }
export interface PairState {
  pending: PairPending | null;
  lastStartAt: number | null;
  /** Set by unpair until Mason runs pair. */
  autoOff: boolean;
  /** Keyed by lowercased handle. Omitted in older files and when empty. */
  autoInvitations?: Record<string, AutoInvitation>;
}

/** `fromMe` is a row Mason's own Apple ID sent, e.g. his YES typed on the phone into the self-chat. */
export interface PairInbound { rowid: number; text: string; handle: string; fromMe?: boolean }
/** The loopback iMessage bridge as the pairing needs it. */
export interface PairBridge {
  ownHandles(): Promise<string[]>;
  baseline(): Promise<number | null>;
  send(handle: string, text: string): Promise<boolean>;
  /** Texts after `afterRowId` in the chats with `handles` (received, or sent-by-me); null when Messages is unreadable. */
  replies(afterRowId: number, handles: string[]): Promise<PairInbound[] | null>;
}
export interface PairDeps { configDir: string; bridge: PairBridge; now?: () => number }

export interface OwnerPairStatusV1 {
  schema: 'owner-pair.status.v1';
  state: 'not-paired' | 'waiting' | 'paired' | 'declined_auto';
  /** One plain line describing pairing and any next step. */
  line: string;
  since?: string;
  /** How many own handles the pairing text went to (waiting only). */
  sent?: number;
  /** False when the handle is bound but comms.toml does not confirm it yet. */
  confirmed?: boolean;
}

export type PairStartResult =
  | { status: 'pending'; handles: string[]; since: number }
  | { status: 'already-paired' | 'already-pending' | 'too-soon' | 'declined_auto' | 'none-found' | 'send-failed' | 'messages-unreadable' | 'bad-handle' };
export type PairCheckResult =
  | { status: 'none' | 'waiting' | 'expired' | 'unreadable' }
  | { status: 'bound'; confirmed: boolean; reason?: string };

const mask = (handle: string): string => `**${handle.slice(-2)}`;
const clock = (deps: PairDeps): number => (deps.now ?? Date.now)();

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

function emptyState(): PairState { return { pending: null, lastStartAt: null, autoOff: false }; }

function parseAutoInvitations(value: unknown): Record<string, AutoInvitation> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid invitation history');
  return Object.fromEntries(Object.entries(value).map(([handle, entry]: [string, unknown]) => {
    const { sent, declinedAt } = (entry ?? {}) as Partial<AutoInvitation>;
    if (!IMESSAGE_HANDLE_RE.test(handle) || typeof sent !== 'number' || !Number.isSafeInteger(sent) || sent < 0 || sent > PAIR_AUTO_LIMIT ||
        (declinedAt !== undefined && !Number.isFinite(declinedAt))) throw new Error('Invalid invitation history');
    return [handle.toLowerCase(), { sent, declinedAt }];
  }));
}

export function readPairState(configDir: string): PairState {
  try {
    const raw = JSON.parse(readFileSync(join(configDir, 'comms', OWNER_PAIR_STATE_FILE), 'utf8')) as Record<string, unknown>;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid pair state');
    const autoInvitations = parseAutoInvitations(raw.autoInvitations);
    return { pending: parsePendingRecord(raw.pending),
      lastStartAt: Number.isFinite(raw.lastStartAt) ? raw.lastStartAt as number : null, autoOff: raw.autoOff === true,
      ...(autoInvitations === undefined ? {} : { autoInvitations }) };
  } catch (error) {
    // Only a missing file is a fresh start. An explicit start can replace damaged history.
    return { ...emptyState(), autoOff: (error as NodeJS.ErrnoException).code !== 'ENOENT' };
  }
}

function atomicWrite(file: string, text: string, mode: number): void {
  mkdirSync(join(file, '..'), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode });
  chmodSync(temp, mode);
  renameSync(temp, file);
}

function writePairState(configDir: string, state: PairState): void {
  atomicWrite(join(configDir, 'comms', OWNER_PAIR_STATE_FILE), JSON.stringify(state), 0o600);
}

function acquirePairLock(configDir: string) {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const acquired = acquireLocalStoreLockWithOutcome(join(configDir, 'comms', '.owner-pair-lock', 'state.lock'), 0, { anchorPath: configDir });
  if (acquired.state === 'unavailable') throw new Error('Pairing state lock unavailable');
  return acquired.lock;
}

async function withPairLock<T>(configDir: string, busy: T, run: () => Promise<T>): Promise<T> {
  const lock = acquirePairLock(configDir);
  if (!lock) return busy;
  try { return await run(); } finally { releaseLocalStoreLock(lock); }
}

// ---------------------------------------------------------------------------
// agent-network.toml: add or remove the iMessage identity under [mason] / [team]
// ---------------------------------------------------------------------------

type Section = 'mason' | 'team';
const read = (section: Section, text: string): TeamIdentity[] => (section === 'mason' ? parseMasonIdentities(text) : parseTeamIdentities(text));
const sameList = (a: TeamIdentity[], b: TeamIdentity[]): boolean => a.length === b.length && a.every((x, i) => x.channel === b[i]!.channel && x.id === b[i]!.id);
const HEADER = /^\s*\[([^\]\n]+)\]\s*(#.*)?$/;

/** Line range [start, end) of `[section]`'s body, or null. */
function bodyOf(lines: string[], section: Section): { header: number; end: number } | null {
  const header = lines.findIndex(l => HEADER.exec(l)?.[1]?.trim() === section);
  if (header < 0) return null;
  let end = lines.length;
  for (let i = header + 1; i < lines.length; i++) if (HEADER.test(lines[i]!)) { end = i; break; }
  return { header, end };
}

/** The text with the iMessage identity added to `[section]`, or null when that cannot be done safely. */
export function withIdentity(text: string, section: Section, id: string): string | null {
  const before = read(section, text);
  if (before.some(x => x.channel === 'imessage')) return null;
  const element = `{ channel = "imessage", id = ${JSON.stringify(id)} }`;
  const lines = text.split('\n');
  const body = bodyOf(lines, section);
  if (!body) {
    lines.push(...(text === '' || text.endsWith('\n') ? [] : ['']), '', `[${section}]`, `identities = [${element}]`, '');
  } else {
    const at = lines.findIndex((l, i) => i > body.header && i < body.end && /^\s*identities\s*=\s*\[/.test(l));
    if (at >= 0) lines[at] = lines[at]!.replace(/^(\s*identities\s*=\s*\[)/, `$1${element}, `);
    else lines.splice(body.header + 1, 0, `identities = [${element}]`);
  }
  const next = lines.join('\n');
  // Every existing identity must survive, in order, with ours added.
  const after = read(section, next);
  return sameList(after, [{ channel: 'imessage', id } as TeamIdentity, ...before]) ? next : null;
}

/** The text with every iMessage identity removed from `[section]`, or null when that cannot be done safely. */
export function withoutIdentity(text: string, section: Section): string | null {
  const before = read(section, text);
  const keep = before.filter(x => x.channel !== 'imessage');
  if (keep.length === before.length) return text;
  const lines = text.split('\n');
  const body = bodyOf(lines, section);
  if (!body) return null;
  const inline = /\{[^{}\n]*channel\s*=\s*"imessage"[^{}\n]*\}\s*,?/;
  for (let i = body.header + 1; i < body.end; i++) lines[i] = lines[i]!.replace(inline, '');
  // A trailing comma left behind is valid TOML; the result must parse to exactly the kept identities.
  const next = lines.join('\n');
  try { parse(next); } catch { return null; }
  return sameList(read(section, next), keep) ? next : null;
}

function writeNetwork(configDir: string, edit: (text: string, section: Section) => string | null, sections: Section[]): boolean {
  const file = join(configDir, 'agent-network.toml');
  let text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  for (const section of sections) {
    const next = edit(text, section);
    if (next === null) return false;
    text = next;
  }
  atomicWrite(file, text, existsSync(file) ? statSync(file).mode & 0o600 || 0o600 : 0o600);
  return true;
}

// ---------------------------------------------------------------------------
// Start, check, status, unpair
// ---------------------------------------------------------------------------

const boundHandle = (configDir: string): string | undefined => loadOwnerThreadSettings(configDir).owners.imessage;

export function readOwnerPairStatus(configDir: string): OwnerPairStatusV1 {
  const bound = boundHandle(configDir);
  if (bound) {
    const confirmed = readCommsLimits(configDir).state === 'confirmed';
    return { schema: 'owner-pair.status.v1', state: 'paired', line: `paired (${mask(bound)})`, confirmed };
  }
  const { pending, autoInvitations } = readPairState(configDir);
  if (pending?.handles.some(handle => autoInvitations?.[handle.toLowerCase()]?.declinedAt === undefined)) {
    return { schema: 'owner-pair.status.v1', state: 'waiting', line: `waiting for YES (sent to ${pending.handles.length})`, since: new Date(pending.startedAt).toISOString(), sent: pending.handles.length };
  }
  const declinedAt = Object.values(autoInvitations ?? {}).reduce((latest, entry) => Math.max(latest, entry.declinedAt ?? -Infinity), -Infinity);
  if (Number.isFinite(declinedAt)) return { schema: 'owner-pair.status.v1', state: 'declined_auto', line: DECLINED_LINE, since: new Date(declinedAt).toISOString() };
  return { schema: 'owner-pair.status.v1', state: 'not-paired', line: 'not paired' };
}

/** Automatic starts are limited to two invitations per handle and one round per 24 hours. */
export function startOwnerPair(deps: PairDeps, input: { handle?: string; auto?: boolean } = {}): Promise<PairStartResult> {
  return withPairLock<PairStartResult>(deps.configDir, { status: 'too-soon' }, () => startPair(deps, input));
}

async function startPair(deps: PairDeps, input: { handle?: string; auto?: boolean }): Promise<PairStartResult> {
  const now = clock(deps);
  if (boundHandle(deps.configDir)) return { status: 'already-paired' };
  const explicit = input.handle?.trim();
  if (explicit !== undefined && !IMESSAGE_HANDLE_RE.test(explicit)) return { status: 'bad-handle' };
  let state = readPairState(deps.configDir);
  if (input.auto && state.pending && state.pending.expiresAt <= now) {
    await checkPair(deps, state, now);
    state = readPairState(deps.configDir);
  }
  const history = state.autoInvitations ?? {};
  const live = state.pending && state.pending.expiresAt > now ? state.pending : null;
  if (live?.handles.some(h => (explicit === undefined || h.toLowerCase() === explicit.toLowerCase()) &&
      (input.auto || history[h.toLowerCase()]?.declinedAt === undefined))) return { status: 'already-pending' };
  if (input.auto && (state.autoOff || (state.lastStartAt !== null && now - state.lastStartAt < PAIR_TTL_MS))) return { status: 'too-soon' };

  // --handle narrows to one; otherwise every own handle found is Mason's.
  const found = explicit !== undefined ? [explicit] : [...new Map((await deps.bridge.ownHandles()).map(h => [h.toLowerCase(), h])).values()];
  if (found.length === 0) return { status: Object.values(history).some(entry => entry.declinedAt !== undefined) && input.auto ? 'declined_auto' : 'none-found' };
  const targets = (input.auto ? found.filter(h => {
    const entry = history[h.toLowerCase()];
    return entry?.declinedAt === undefined && (entry?.sent ?? 0) < PAIR_AUTO_LIMIT;
  }) : found).slice(0, PAIR_MAX_HANDLES);
  if (targets.length === 0) return { status: 'declined_auto' };
  const afterRowId = await deps.bridge.baseline();
  if (afterRowId === null) return { status: 'messages-unreadable' };
  const sent: string[] = [];
  let invitations = { ...history };
  const pendingState = (handles: string[], autoInvitations: Record<string, AutoInvitation>): PairState => ({
    pending: { handles, startedAt: now, expiresAt: now + PAIR_TTL_MS, afterRowId }, lastStartAt: now, autoOff: false,
    ...(Object.keys(autoInvitations).length === 0 ? {} : { autoInvitations }),
  });
  for (const handle of targets) {
    const key = handle.toLowerCase();
    const attempt = { ...invitations, [key]: { sent: (invitations[key]?.sent ?? 0) + 1 } };
    // Record before sending so an interrupted or ambiguous send still uses a slot.
    if (input.auto) writePairState(deps.configDir, pendingState([...sent, handle], attempt));
    if (await deps.bridge.send(handle, PAIR_TEXT)) {
      sent.push(handle);
      if (input.auto) invitations = attempt;
      else delete invitations[key];
    } else if (input.auto) {
      // A definite failure can be retried. Keep any earlier sends in this round.
      writePairState(deps.configDir, sent.length === 0 ? state : pendingState(sent, invitations));
    }
  }
  if (sent.length === 0) return { status: 'send-failed' };
  if (!input.auto) writePairState(deps.configDir, pendingState(sent, invitations));
  return { status: 'pending', handles: sent, since: now };
}

/** A row that counts as the owner's YES: in a pending handle's chat, exactly YES, never the pairing text itself. */
const isYes = (m: PairInbound): boolean => m.text.trim().toUpperCase() === 'YES' && m.text.trim() !== PAIR_TEXT;

/** Look for a YES in a pending own handle's chat. The first handle to say it binds; everything else binds nothing. */
export function checkOwnerPair(deps: PairDeps): Promise<PairCheckResult> {
  if (!readPairState(deps.configDir).pending) return Promise.resolve({ status: 'none' });
  return withPairLock<PairCheckResult>(deps.configDir, { status: 'waiting' }, () => checkPair(deps, readPairState(deps.configDir), clock(deps)));
}

async function checkPair(deps: PairDeps, state: PairState, now: number): Promise<PairCheckResult> {
  const pending = state.pending;
  if (!pending) return { status: 'none' };
  const expired = pending.expiresAt <= now;
  const inbound = await deps.bridge.replies(pending.afterRowId, pending.handles);
  if (inbound === null && !expired) return { status: 'unreadable' };
  const own = new Set(pending.handles.map(h => h.toLowerCase()));
  // Rows at or before the send are older than the pairing; only the chats with pending own handles count.
  const mine = (inbound ?? []).filter(m => m.rowid > pending.afterRowId && own.has(m.handle.toLowerCase())).sort((a, b) => a.rowid - b.rowid);
  const yes = expired ? undefined : mine.find(isYes);
  if (yes) {
    const handle = pending.handles.find(h => h.toLowerCase() === yes.handle.toLowerCase())!;
    return bindOwnerHandle(deps.configDir, handle, state, () => new Date(now));
  }
  let history = { ...state.autoInvitations };
  // A reply observed between ticks still opts out. The prompt's self-chat echo is not a reply.
  const declined = new Set(mine.filter(m => m.text.trim() !== PAIR_TEXT && !isYes(m)).map(m => m.handle.toLowerCase()));
  for (const handle of own) {
    const entry = history[handle];
    if (entry?.declinedAt === undefined && (declined.has(handle) || (expired && entry?.sent === PAIR_AUTO_LIMIT))) {
      history = { ...history, [handle]: { sent: entry?.sent ?? 0, declinedAt: now } };
    }
  }
  const top = mine.at(-1)?.rowid ?? pending.afterRowId;
  if (expired || top > pending.afterRowId) {
    writePairState(deps.configDir, { ...state, pending: expired ? null : { ...pending, afterRowId: top },
      ...(Object.keys(history).length === 0 ? {} : { autoInvitations: history }) });
  }
  return { status: expired ? 'expired' : 'waiting' };
}

async function bindOwnerHandle(configDir: string, handle: string, state: PairState, at: () => Date): Promise<PairCheckResult> {
  // An existing iMessage owner is never overwritten.
  if (!boundHandle(configDir)) {
    const done = writeNetwork(configDir, (text, section) => withIdentity(text, section, handle), ['team', 'mason']);
    if (!done) return { status: 'waiting' };
  }
  writePairState(configDir, { ...state, pending: null });
  // A YES from an own handle is the owner's proof. The confirmation goes through the owner-gated
  // route's handler-level function, which stays the only caller of the confirm writer. Loaded on
  // demand: the web layer is heavy and the self-tick needs it only here.
  if (readCommsLimits(configDir).state === 'confirmed') return { status: 'bound', confirmed: true };
  const { confirmCommsForOwnerProof } = await import('../web/comms-confirm-route.js');
  const result = confirmCommsForOwnerProof(configDir, at());
  if (result.ok) return { status: 'bound', confirmed: true };
  return { status: 'bound', confirmed: false, reason: `not confirmed (${result.reason}): confirm in the desktop Comms panel, or set confirmedByMason = true in ~/.ashlr/comms.toml` };
}

/** Remove only the iMessage binding from [mason] and [team], and drop any pending pair. */
export function unpairOwner(configDir: string): { status: 'unpaired' | 'not-paired' | 'failed' } {
  const lock = acquirePairLock(configDir);
  if (!lock) return { status: 'failed' };
  try {
    const state = readPairState(configDir);
    const wasBound = boundHandle(configDir) !== undefined;
    if (wasBound && !writeNetwork(configDir, (text, section) => withoutIdentity(text, section), ['mason', 'team'])) return { status: 'failed' };
    writePairState(configDir, { ...state, pending: null, autoOff: true });
    return { status: wasBound || state.pending ? 'unpaired' : 'not-paired' };
  } finally { releaseLocalStoreLock(lock); }
}

const sentLine = (n: number): string => `sent to ${n} handle${n === 1 ? '' : 's'}, waiting for YES`;

export interface PairTickReport { action: 'none' | 'started' | 'waiting' | 'bound' | 'expired' | 'declined_auto'; detail: string }

/**
 * One self-tick step (apply mode, iMessage on): no binding and no pending pair
 * starts one for eligible handles; while pending it looks for the YES.
 */
export async function pairTick(deps: PairDeps): Promise<PairTickReport> {
  if (boundHandle(deps.configDir)) return { action: 'none', detail: 'paired' };
  let expired = false;
  if (readPairState(deps.configDir).pending) {
    const checked = await checkOwnerPair(deps);
    if (checked.status === 'bound') return { action: 'bound', detail: checked.confirmed ? 'paired and confirmed' : `paired; ${checked.reason ?? 'not confirmed'}` };
    if (checked.status === 'unreadable') return { action: 'waiting', detail: 'Messages replies are unreadable; YES cannot currently be checked' };
    if (checked.status === 'waiting') {
      const status = readOwnerPairStatus(deps.configDir);
      if (status.state === 'declined_auto') return { action: 'declined_auto', detail: status.line };
      return { action: 'waiting', detail: sentLine(status.sent ?? 0) };
    }
    expired = checked.status === 'expired';
  }
  const started = await startOwnerPair(deps, { auto: true });
  if (started.status === 'pending') return { action: 'started', detail: sentLine(started.handles.length) };
  if (started.status === 'declined_auto') return { action: 'declined_auto', detail: DECLINED_LINE };
  return { action: expired ? 'expired' : 'none', detail: started.status };
}

// ---------------------------------------------------------------------------
// The real loopback bridge
// ---------------------------------------------------------------------------

/** Scoped to one destination in memory only; nothing is written to config. */
const scoped = (cfg: AshlrConfig, handle: string): AshlrConfig => ({ ...cfg, comms: { ...cfg.comms, enabled: true, imessageHandle: handle } });

export function loopbackPairBridge(cfg: AshlrConfig): PairBridge {
  return {
    async ownHandles() {
      const configured = cfg.comms?.imessageHandle?.trim();
      const found = await detectOwnIMessageHandles();
      const all = configured && IMESSAGE_HANDLE_RE.test(configured) ? [configured, ...found] : found;
      return [...new Map(all.map(h => [h.toLowerCase(), h])).values()];
    },
    async baseline() { const r = await readMaxRowId(); return r.ok ? r.rowid : null; },
    async send(handle, text) { return (await sendIMessage(text, scoped(cfg, handle), handle)).ok; },
    async replies(afterRowId, handles) { return (await pollPairReplies(afterRowId, handles)) ?? null; },
  };
}
