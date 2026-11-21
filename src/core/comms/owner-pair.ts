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
 * State is one 0600 file, comms/owner-pair.json (the pending handles, cursor and
 * times). Everything outside the bridge is injected, so tests send nothing.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { parseTeamIdentities, type TeamIdentity } from '../agents/channel-policy.js';
import { parseMasonIdentities } from '../agents/leader-network.js';
import { IMESSAGE_HANDLE_RE, detectOwnIMessageHandles, pollPairReplies, readMaxRowId, sendIMessage } from '../integrations/imessage.js';
import type { AshlrConfig } from '../types.js';
import { readCommsLimits } from './comms-confirm.js';
import { loadOwnerThreadSettings } from './owner-channel.js';

export const PAIR_TEXT = 'Phantom: reply YES to get fleet updates here.';
export const PAIR_TTL_MS = 24 * 60 * 60 * 1000;
const STATE_FILE = 'owner-pair.json';

export const PAIR_MAX_HANDLES = 4;

export interface PairPending { handles: string[]; startedAt: number; expiresAt: number; afterRowId: number }
export interface PairState { pending: PairPending | null; lastStartAt: number | null; /** Set by unpair: the self-tick does not pair again until Mason runs pair. */ autoOff: boolean }

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
  state: 'not-paired' | 'waiting' | 'paired';
  /** One plain line: "not paired", "waiting for YES (sent to N)" or "paired (**ab)". */
  line: string;
  since?: string;
  /** How many own handles the pairing text went to (waiting only). */
  sent?: number;
  /** False when the handle is bound but comms.toml does not confirm it yet. */
  confirmed?: boolean;
}

export type PairStartResult =
  | { status: 'pending'; handles: string[]; since: number }
  | { status: 'already-paired' | 'already-pending' | 'too-soon' | 'none-found' | 'send-failed' | 'messages-unreadable' | 'bad-handle' };
export type PairCheckResult =
  | { status: 'none' | 'waiting' | 'expired' | 'unreadable' }
  | { status: 'bound'; confirmed: boolean; reason?: string };

const mask = (handle: string): string => `**${handle.slice(-2)}`;
const clock = (deps: PairDeps): number => (deps.now ?? Date.now)();

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

function emptyState(): PairState { return { pending: null, lastStartAt: null, autoOff: false }; }

export function readPairState(configDir: string): PairState {
  try {
    const raw = JSON.parse(readFileSync(join(configDir, 'comms', STATE_FILE), 'utf8')) as Record<string, unknown>;
    const p = raw.pending as Record<string, unknown> | null | undefined;
    // Older state files held one `handle`.
    const listed = Array.isArray(p?.handles) ? p.handles : typeof p?.handle === 'string' ? [p.handle] : [];
    const handles = listed.filter((h): h is string => typeof h === 'string' && IMESSAGE_HANDLE_RE.test(h)).slice(0, PAIR_MAX_HANDLES);
    const pending = p && handles.length > 0 && Number.isFinite(p.startedAt) && Number.isFinite(p.expiresAt) && Number.isSafeInteger(p.afterRowId)
      ? { handles, startedAt: p.startedAt as number, expiresAt: p.expiresAt as number, afterRowId: p.afterRowId as number }
      : null;
    return { pending, lastStartAt: Number.isFinite(raw.lastStartAt) ? raw.lastStartAt as number : null, autoOff: raw.autoOff === true };
  } catch { return emptyState(); }
}

function atomicWrite(file: string, text: string, mode: number): void {
  mkdirSync(join(file, '..'), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode });
  chmodSync(temp, mode);
  renameSync(temp, file);
}

function writePairState(configDir: string, state: PairState): void {
  atomicWrite(join(configDir, 'comms', STATE_FILE), JSON.stringify(state), 0o600);
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
  const pending = readPairState(configDir).pending;
  if (pending) return { schema: 'owner-pair.status.v1', state: 'waiting', line: `waiting for YES (sent to ${pending.handles.length})`, since: new Date(pending.startedAt).toISOString(), sent: pending.handles.length };
  return { schema: 'owner-pair.status.v1', state: 'not-paired', line: 'not paired' };
}

/** Send the one pairing text to each own handle (cap 4) and record one pending pair. `auto` is the self-tick: at most one start per 24 h. */
export async function startOwnerPair(deps: PairDeps, input: { handle?: string; auto?: boolean } = {}): Promise<PairStartResult> {
  const now = clock(deps);
  if (boundHandle(deps.configDir)) return { status: 'already-paired' };
  const state = readPairState(deps.configDir);
  const explicit = input.handle?.trim();
  if (explicit !== undefined && !IMESSAGE_HANDLE_RE.test(explicit)) return { status: 'bad-handle' };
  const live = state.pending && state.pending.expiresAt > now ? state.pending : null;
  if (live && (explicit === undefined || live.handles.some(h => h.toLowerCase() === explicit.toLowerCase()))) return { status: 'already-pending' };
  if (input.auto && (state.autoOff || (state.lastStartAt !== null && now - state.lastStartAt < PAIR_TTL_MS))) return { status: 'too-soon' };

  // --handle narrows to one; otherwise every own handle found is Mason's.
  const targets = explicit !== undefined ? [explicit] : [...new Map((await deps.bridge.ownHandles()).map(h => [h.toLowerCase(), h])).values()].slice(0, PAIR_MAX_HANDLES);
  if (targets.length === 0) return { status: 'none-found' };
  const afterRowId = await deps.bridge.baseline();
  if (afterRowId === null) return { status: 'messages-unreadable' };
  const sent: string[] = [];
  for (const handle of targets) if (await deps.bridge.send(handle, PAIR_TEXT)) sent.push(handle);
  if (sent.length === 0) return { status: 'send-failed' };
  writePairState(deps.configDir, { pending: { handles: sent, startedAt: now, expiresAt: now + PAIR_TTL_MS, afterRowId }, lastStartAt: now, autoOff: false });
  return { status: 'pending', handles: sent, since: now };
}

/** A row that counts as the owner's YES: in a pending handle's chat, exactly YES, never the pairing text itself. */
const isYes = (m: PairInbound): boolean => m.text.trim().toUpperCase() === 'YES' && m.text.trim() !== PAIR_TEXT;

/** Look for a YES in a pending own handle's chat. The first handle to say it binds; everything else binds nothing. */
export async function checkOwnerPair(deps: PairDeps): Promise<PairCheckResult> {
  const now = clock(deps);
  const state = readPairState(deps.configDir);
  const pending = state.pending;
  if (!pending) return { status: 'none' };
  if (pending.expiresAt <= now) { writePairState(deps.configDir, { ...state, pending: null }); return { status: 'expired' }; }
  const inbound = await deps.bridge.replies(pending.afterRowId, pending.handles);
  if (inbound === null) return { status: 'unreadable' };
  const own = new Set(pending.handles.map(h => h.toLowerCase()));
  // Rows at or before the send are older than the pairing; only the chats with pending own handles count.
  const mine = inbound.filter(m => m.rowid > pending.afterRowId && own.has(m.handle.toLowerCase())).sort((a, b) => a.rowid - b.rowid);
  const yes = mine.find(isYes);
  if (!yes) {
    const top = mine.reduce((max, m) => Math.max(max, m.rowid), pending.afterRowId);
    if (top > pending.afterRowId) writePairState(deps.configDir, { ...state, pending: { ...pending, afterRowId: top } });
    return { status: 'waiting' };
  }
  const handle = pending.handles.find(h => h.toLowerCase() === yes.handle.toLowerCase())!;
  return bindOwnerHandle(deps.configDir, handle, state, () => new Date(now));
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
  const state = readPairState(configDir);
  const wasBound = boundHandle(configDir) !== undefined;
  if (!wasBound && !state.pending) return { status: 'not-paired' };
  if (wasBound && !writeNetwork(configDir, (text, section) => withoutIdentity(text, section), ['mason', 'team'])) return { status: 'failed' };
  writePairState(configDir, { pending: null, lastStartAt: state.lastStartAt, autoOff: true });
  return { status: 'unpaired' };
}

const sentLine = (n: number): string => `sent to ${n} handle${n === 1 ? '' : 's'}, waiting for YES`;

export interface PairTickReport { action: 'none' | 'started' | 'waiting' | 'bound' | 'expired'; detail: string }

/**
 * One self-tick step (apply mode, iMessage on): no binding and no pending pair
 * starts one, at most once per 24 h; while pending it looks for the YES.
 */
export async function pairTick(deps: PairDeps): Promise<PairTickReport> {
  if (boundHandle(deps.configDir)) return { action: 'none', detail: 'paired' };
  let expired = false;
  if (readPairState(deps.configDir).pending) {
    const checked = await checkOwnerPair(deps);
    if (checked.status === 'bound') return { action: 'bound', detail: checked.confirmed ? 'paired and confirmed' : `paired; ${checked.reason ?? 'not confirmed'}` };
    if (checked.status !== 'expired') return { action: 'waiting', detail: sentLine(readPairState(deps.configDir).pending?.handles.length ?? 0) };
    expired = true;
  }
  const started = await startOwnerPair(deps, { auto: true });
  if (started.status === 'pending') return { action: 'started', detail: sentLine(started.handles.length) };
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
