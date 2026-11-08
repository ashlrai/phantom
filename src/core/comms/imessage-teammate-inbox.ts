/**
 * RQ-PHX-TEAMMATETEXTS25: local inbox for allowlisted non-Mason iMessage
 * senders (teammates like Dot / "Ashlr.").
 *
 * The intake bridge keeps its contract: the verified Mason handle is receipted
 * to MASON-INBOX.md and the chief-of-staff queue. An allowlisted handle that is
 * NOT Mason used to be counted and dropped; now it is appended here:
 *
 *   recordTeammateText(msg)          - append one line to
 *     <imessageStateDir>/teammates.jsonl, dir 0700, file 0600.
 *   readTeammateTexts(opts)          - unanswered texts, newest last, each with
 *     its age in minutes; malformed lines flag `degraded`, never an error.
 *   markTeammateTextsAnswered(rowids) - append `{answered:<rowid>}` markers to
 *     the same file; readTeammateTexts hides them unless includeAnswered.
 *   senderIdFor(handle)              - `imessage:<sha256-16>`; the raw handle is
 *     never stored. Shared by the channel envelope's verifiedSenderId, so it
 *     lives in this leaf module and the bridge re-exports it.
 *
 * Text is scrubSecrets'd and capped at 2000 chars before it is written. Nothing
 * here sends a reply and nothing reaches MASON-INBOX.md, the queue or the bus.
 * Every entry point never throws.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { imessageStateDir } from '../integrations/imessage.js';
import { scrubSecrets } from '../util/scrub.js';

const TEAMMATES_FILE = 'teammates.jsonl';
const TEXT_CAP = 2_000;

/** Stable, non-reversible-at-a-glance sender id so handles stay out of stored records. */
export function senderIdFor(handle: string): string {
  return `imessage:${createHash('sha256').update(handle.trim().toLowerCase()).digest('hex').slice(0, 16)}`;
}

export type TeammateSourceState = 'healthy' | 'missing' | 'degraded';

/** Pure acknowledgements cannot cause agent-to-agent acknowledgement loops. */
export function teammateNeedsReply(text: string): boolean {
  // Code chunks often contain question marks/requests as source literals. They are
  // artifacts to retain, never conversation requests to answer once per chunk.
  if (/^.{0,80}\b(?:patch|artifact|chunk)\s+\d+\/\d+\b/i.test(text) || /^(?:diff --git |--- [ab/] |```)/.test(text)) return false;
  return !/^\s*(ack(?:nowledged)?|thanks|thank you|received|noted|got it|ok(?:ay)?|👍)[.!\s]*$/i.test(text)
    && /\?|\b(?:please|can you|could you|request(?:ing)?|need you|probe)\b/i.test(text);
}

/** Keep requests for a decision or action in the local inbox for leader review. */
export function classifyTeammateIntent(text: string): 'ignore' | 'reply' | 'leader' {
  if (!teammateNeedsReply(text)) return 'ignore';
  if (/\b(?:approve|approval|authorize|authorise|permission|decision|decide|escalat\w*|leader|mason)\b/i.test(text)
      || /\b(?:please|can you|could you|need you to)\s+(?:deploy|release|ship|merge|delete|remove|change|create|pay|buy|run|execute)\b/i.test(text)) return 'leader';
  return 'reply';
}

export interface TeammateText {
  at: string;
  rowid: number;
  senderId: string;
  text: string;
  ageMinutes: number;
}

interface TeammateRow {
  v?: unknown;
  at?: unknown;
  rowid?: unknown;
  senderId?: unknown;
  text?: unknown;
  answered?: unknown;
}

const file = (runsDir?: string): string => join(imessageStateDir(runsDir), TEAMMATES_FILE);
const validRowid = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
type TextRow = TeammateRow & { rowid: number; at: string; senderId: string; text: string };
const isTextRow = (r: TeammateRow): r is TextRow =>
  validRowid(r.rowid) && typeof r.at === 'string' && typeof r.senderId === 'string' && typeof r.text === 'string'
  && Number.isFinite(Date.parse(r.at));

function readRows(runsDir?: string): { rows: TeammateRow[]; state: TeammateSourceState } {
  let raw: string;
  try {
    raw = readFileSync(file(runsDir), 'utf8');
  } catch {
    return { rows: [], state: 'missing' };
  }
  const rows: TeammateRow[] = [];
  let degraded = false;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as unknown;
      if (row && typeof row === 'object') rows.push(row as TeammateRow); else degraded = true;
    } catch {
      degraded = true;
    }
  }
  return { rows, state: degraded ? 'degraded' : 'healthy' };
}

function appendLines(lines: string[], runsDir?: string): void {
  const dir = imessageStateDir(runsDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = file(runsDir);
  appendFileSync(path, lines.map((l) => `${l}\n`).join(''), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Append one teammate text. Idempotent on rowid (a retry after a crash between
 * append and cursor write records nothing twice). Returns false on failure.
 */
export function recordTeammateText(
  msg: { rowid: number; handle: string; text: string },
  runsDir?: string,
  now?: Date,
): boolean {
  try {
    if (!validRowid(msg.rowid) || typeof msg.handle !== 'string' || !msg.handle.trim() || typeof msg.text !== 'string') return false;
    const { rows } = readRows(runsDir);
    if (rows.some((r) => r.rowid === msg.rowid)) return true;
    appendLines([JSON.stringify({
      v: 1,
      at: (now ?? new Date()).toISOString(),
      rowid: msg.rowid,
      senderId: senderIdFor(msg.handle),
      text: scrubSecrets(msg.text).slice(0, TEXT_CAP),
    })], runsDir);
    return true;
  } catch {
    return false;
  }
}

/** Unanswered teammate texts, newest last. Never throws; missing file is `missing`, bad lines are `degraded`. */
export function readTeammateTexts(opts: {
  runsDir?: string;
  sinceMs?: number;
  includeAnswered?: boolean;
  now?: () => number;
} = {}): { sourceState: TeammateSourceState; texts: TeammateText[] } {
  try {
    const now = opts.now ?? (() => Date.now());
    const { rows, state } = readRows(opts.runsDir);
    const answered = new Set<number>();
    for (const r of rows) if (validRowid(r.answered)) answered.add(r.answered);
    const texts: TeammateText[] = [];
    for (const r of rows) {
      if (!isTextRow(r)) continue;
      if (!opts.includeAnswered && answered.has(r.rowid)) continue;
      const ageMs = now() - Date.parse(r.at);
      if (opts.sinceMs !== undefined && ageMs > opts.sinceMs) continue;
      texts.push({
        at: r.at, rowid: r.rowid, senderId: r.senderId, text: r.text,
        ageMinutes: Math.max(0, Math.floor(ageMs / 60_000)),
      });
    }
    texts.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.rowid - b.rowid);
    return { sourceState: state, texts };
  } catch {
    return { sourceState: 'degraded', texts: [] };
  }
}

/**
 * Mark rowids answered by appending marker lines. Only rowids that are recorded
 * and still unanswered count, so retries and typos report honestly. Returns the
 * number of markers written.
 */
export function markTeammateTextsAnswered(rowids: readonly number[], runsDir?: string, now?: Date): number {
  try {
    const want = new Set(rowids.filter(validRowid));
    if (want.size === 0) return 0;
    const { rows } = readRows(runsDir);
    const answered = new Set<number>();
    const present = new Set<number>();
    for (const r of rows) {
      if (validRowid(r.answered)) answered.add(r.answered);
      if (isTextRow(r)) present.add(r.rowid);
    }
    const fresh = [...want].filter((id) => present.has(id) && !answered.has(id));
    if (fresh.length === 0) return 0;
    const at = (now ?? new Date()).toISOString();
    appendLines(fresh.map((rowid) => JSON.stringify({ v: 1, answered: rowid, at })), runsDir);
    return fresh.length;
  } catch {
    return 0;
  }
}
