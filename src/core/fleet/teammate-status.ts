/**
 * `ashlr fleet teammates` core: agent teammates on one screen — who they are,
 * which channel they use, when each last texted, and how many of their
 * messages still have no reply.
 *
 * Roster sources (all local config, never message content):
 *   - `a2a.counterparts` extension key (src/core/agents/a2a-schema.ts):
 *     bilateral-consent counterpart records. `source: 'a2a-config'`. The
 *     counterpart scope's first entry is the name; an enabled flag only
 *     governs operational wiring, not whether a configured teammate is listed.
 *   - `teammates` extension key, an optional list of
 *     { name?, channel?, handle?, offPlanCapacity? } entries kept in the same
 *     config file. Entries name handles the allowlist knows, or declare a
 *     teammate outright. `source: 'allowlist'`.
 *   - `comms.imessageAllow` handles other than the verified owner handle:
 *     non-self handles allowed to text in are de facto teammates.
 *     `source: 'allowlist'`.
 *
 * Activity comes from chat.db (darwin, sqlite3 -readonly, mode=ro URI) through
 * the `activity` dep; tests inject fakes and never open the real chat.db.
 * `unanswered` counts a teammate's inbound messages newer than the last
 * outbound message to it. When chat.db is blocked or missing the roster is
 * still returned with null times and the `chatDb` state set. Read-only: this
 * module never sends, never writes, and never prints message text or raw
 * handles (handles are masked to their last 4 characters).
 */

import { execFile } from 'node:child_process';
import { a2aConfigSchema } from '../agents/a2a-schema.js';
import {
  appleNsToUnixMs, chatDbPath, imessageAllowlist, isVerifiedMasonHandle,
  probeChatDb, readOnlyUri, type ChatDbState,
} from '../integrations/imessage.js';
import type { AshlrConfig } from '../types.js';

export interface TeammateChatEvent {
  handle: string;
  /** true for messages sent from this account to the handle (replies). */
  fromMe: boolean;
  /** unix ms */
  ts: number;
}

export interface TeammateStatus {
  name: string;
  channel: string;
  handleMasked: string | null;
  /** Teammate runs on its own subscription, not the owner's plan. */
  offPlanCapacity: boolean;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  unanswered: number;
  source: 'a2a-config' | 'allowlist';
}

export interface TeammatesReport {
  v: 1;
  teammates: TeammateStatus[];
  chatDb: ChatDbState;
}

export interface TeammateStatusDeps {
  /** chat.db probe (test seam). Default probeChatDb. */
  probe?: () => ChatDbState;
  /** chat.db activity for the given handles (test seam). Default readChatActivity. */
  activity?: (handles: string[], cfg: AshlrConfig) => Promise<TeammateChatEvent[]>;
}

/** Keep the last 4 characters; star the rest. Handles ≤4 chars mask fully. */
export function maskHandle(handle: string): string {
  const trimmed = handle.trim();
  return trimmed.length <= 4 ? '****' : `${'*'.repeat(trimmed.length - 4)}${trimmed.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Roster from config extension keys
// ---------------------------------------------------------------------------

interface DeclaredTeammate {
  name?: string;
  channel?: string;
  handle?: string;
  offPlanCapacity?: boolean;
}

interface RosterDraft {
  name: string;
  channel: string;
  handle?: string;
  offPlanCapacity: boolean;
  source: 'a2a-config' | 'allowlist';
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

/** Loose parse of the optional `teammates` config list; malformed entries drop. */
function declaredTeammates(raw: unknown): DeclaredTeammate[] {
  if (!Array.isArray(raw)) return [];
  const out: DeclaredTeammate[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const name = text(rec['name']);
    const handle = text(rec['handle']);
    if (name === undefined && handle === undefined) continue;
    out.push({
      ...(name !== undefined ? { name } : {}),
      ...(text(rec['channel']) !== undefined ? { channel: text(rec['channel'])!.toLowerCase() } : {}),
      ...(handle !== undefined ? { handle } : {}),
      ...(typeof rec['offPlanCapacity'] === 'boolean' ? { offPlanCapacity: rec['offPlanCapacity'] } : {}),
    });
  }
  return out;
}

function buildRoster(cfg: AshlrConfig): RosterDraft[] {
  const ext = cfg as unknown as Record<string, unknown>;
  const parsed = a2aConfigSchema.safeParse(ext['a2a']);
  const counterparts = parsed.success ? parsed.data.counterparts : [];
  const declared = declaredTeammates(ext['teammates']);
  const allowHandles = imessageAllowlist(cfg).filter((h) => !isVerifiedMasonHandle(h, cfg));

  const claimed = new Set<string>();
  const usedEntries = new Set<number>();
  const claimIMessageHandle = (): string | undefined => {
    const next = allowHandles.find((h) => !claimed.has(h.toLowerCase()));
    if (next !== undefined) claimed.add(next.toLowerCase());
    return next;
  };
  const claimExplicit = (handle: string | undefined): string | undefined => {
    if (handle !== undefined) claimed.add(handle.toLowerCase());
    return handle;
  };

  const roster: RosterDraft[] = [];
  for (const cp of counterparts) {
    const scopeName = cp.scope[0]!;
    const idx = declared.findIndex(
      (e, i) => !usedEntries.has(i) && e.name !== undefined && e.name.toLowerCase() === scopeName.toLowerCase(),
    );
    const entry = idx >= 0 ? declared[idx]! : undefined;
    if (idx >= 0) usedEntries.add(idx);
    const handle = entry?.handle !== undefined
      ? claimExplicit(entry.handle)
      : cp.channel === 'imessage' ? claimIMessageHandle() : undefined;
    roster.push({
      name: entry?.name ?? scopeName,
      channel: cp.channel,
      handle,
      offPlanCapacity: entry?.offPlanCapacity ?? true,
      source: 'a2a-config',
    });
  }

  declared.forEach((e, i) => {
    if (usedEntries.has(i)) return;
    const channel = e.channel ?? 'imessage';
    const handle = e.handle !== undefined
      ? claimExplicit(e.handle)
      : channel === 'imessage' ? claimIMessageHandle() : undefined;
    roster.push({
      name: e.name ?? (handle !== undefined ? maskHandle(handle) : 'unknown'),
      channel,
      handle,
      offPlanCapacity: e.offPlanCapacity ?? true,
      source: 'allowlist',
    });
  });

  for (const handle of allowHandles) {
    if (claimed.has(handle.toLowerCase())) continue;
    roster.push({
      name: maskHandle(handle), channel: 'imessage', handle, offPlanCapacity: true, source: 'allowlist',
    });
    claimed.add(handle.toLowerCase());
  }
  return roster;
}

// ---------------------------------------------------------------------------
// chat.db activity (darwin, read-only)
// ---------------------------------------------------------------------------

const SQLITE_TIMEOUT_MS = 5_000;
const ACTIVITY_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * All inbound and outbound chat.db rows for the given handles, oldest first.
 * For direct chats `message.handle_id` names the other party in both
 * directions, matching the join pollInboundSince uses. Returns [] on any
 * failure (non-darwin, missing sqlite3, unreadable db). Never throws, never
 * returns message text.
 */
export async function readChatActivity(handles: string[], _cfg?: AshlrConfig): Promise<TeammateChatEvent[]> {
  if (process.platform !== 'darwin') return [];
  const wanted = [...new Set(handles.map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0))];
  if (wanted.length === 0) return [];
  const list = wanted.map((h) => `'${h.replace(/'/g, "''")}'`).join(',');
  const sql =
    'SELECT h.id AS handle, m.is_from_me AS fromMe, m.date AS date FROM message m ' +
    'JOIN handle h ON m.handle_id = h.ROWID ' +
    `WHERE m.associated_message_type = 0 AND lower(h.id) IN (${list}) ` +
    'ORDER BY m.date ASC;';
  const out = await new Promise<{ ok: boolean; stdout: string }>((resolve) => {
    try {
      execFile('sqlite3', ['-readonly', '-json', readOnlyUri(chatDbPath()), sql],
        { timeout: SQLITE_TIMEOUT_MS, maxBuffer: ACTIVITY_MAX_BUFFER }, (err, stdout) => {
          resolve(err ? { ok: false, stdout: '' } : { ok: true, stdout });
        });
    } catch {
      resolve({ ok: false, stdout: '' });
    }
  });
  if (!out.ok) return [];
  let rows: unknown;
  try { rows = out.stdout.trim() ? JSON.parse(out.stdout) : []; } catch { return []; }
  if (!Array.isArray(rows)) return [];
  const events: TeammateChatEvent[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const { handle, fromMe, date } = row ?? {};
    if (typeof handle !== 'string' || !wanted.includes(handle.toLowerCase())) continue;
    if (typeof date !== 'number' || !isFinite(date)) continue;
    events.push({ handle, fromMe: fromMe === 1, ts: appleNsToUnixMs(date) });
  }
  return events;
}

// ---------------------------------------------------------------------------
// readTeammates
// ---------------------------------------------------------------------------

export async function readTeammates(cfg: AshlrConfig, deps: TeammateStatusDeps = {}): Promise<TeammatesReport> {
  const roster = buildRoster(cfg);
  const chatDb = (deps.probe ?? probeChatDb)();
  let events: TeammateChatEvent[] = [];
  const handles = [...new Set(roster.flatMap((r) => (r.handle !== undefined ? [r.handle.toLowerCase()] : [])))];
  if (chatDb === 'ok' && handles.length > 0) {
    try {
      events = await (deps.activity ?? readChatActivity)(handles, cfg);
    } catch {
      events = [];
    }
  }

  const teammates: TeammateStatus[] = roster.map((draft) => {
    const mine = draft.handle !== undefined
      ? events.filter((e) => e.handle.toLowerCase() === draft.handle!.toLowerCase())
      : [];
    let lastIn = -Infinity;
    let lastOut = -Infinity;
    for (const e of mine) {
      if (e.fromMe) { if (e.ts > lastOut) lastOut = e.ts; }
      else if (e.ts > lastIn) lastIn = e.ts;
    }
    const unanswered = mine.filter((e) => !e.fromMe && e.ts > lastOut).length;
    return {
      name: draft.name,
      channel: draft.channel,
      handleMasked: draft.handle !== undefined ? maskHandle(draft.handle) : null,
      offPlanCapacity: draft.offPlanCapacity,
      lastInboundAt: lastIn === -Infinity ? null : new Date(lastIn).toISOString(),
      lastOutboundAt: lastOut === -Infinity ? null : new Date(lastOut).toISOString(),
      unanswered,
      source: draft.source,
    };
  });
  return { v: 1, teammates, chatDb };
}
