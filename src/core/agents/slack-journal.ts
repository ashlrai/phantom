/**
 * Slack bridge observation journal (RQ-AGENTNET-SLACK-1).
 *
 * Bounded append-only JSONL under `<runs>/slack-bridge/journal.jsonl` (0600).
 * Every Socket Mode delivery the bridge sees lands here as ONE metadata record --
 * ids, timestamps, decision and reason code, plus the event's `messageTs` and
 * thread-root `threadTs` so a later stage can bind each inbound request to the
 * same-thread reply that answered it. Message text, display names, team names,
 * tokens and socket URLs are never written; that is what makes the
 * "ignored and logged without content" rule auditable.
 *
 * The file is capped (256 KiB): when an append would exceed the cap the tail
 * of whole rows (at most 192 KiB) is kept and older observations drop.
 * This journal is evidence, not a ledger.
 */
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import { isSlackChannelId, isSlackTs } from './slack-network.js';
import { isSlackRequestId } from './slack-reply-identity.js';

export const SLACK_JOURNAL_MAX_BYTES = 256 * 1024;
const SLACK_JOURNAL_KEEP_BYTES = 192 * 1024;

export type SlackDecision = 'ingested' | 'ignored';

export interface SlackObservation {
  /** ISO receive time. */
  at: string;
  /** Socket Mode envelope id / Events API event id -- ids only. */
  envelopeId?: string;
  eventId?: string;
  /** Slack channel id (C…/G…) when the event carried one. */
  channelId?: string;
  /** Author's Slack id (U…/W…/B…), never a display name. */
  authorId?: string;
  /** The event's own Slack `ts` -- only ever a `isSlackTs`-shaped id. */
  messageTs?: string;
  /**
   * Thread root `ts`: the event's `thread_ts` when present, else its own `ts`
   * -- the same `rootTs` `slackEventToBus` builds its thread ref from.
   */
  threadTs?: string;
  decision: SlackDecision;
  /** Static reason code for ignored events; absent on ingest. */
  reason?: string;
  /** Local bus append outcome for ingested events. */
  bus?: 'posted' | 'duplicate' | 'failed';
  /**
   * Leader request id (64 hex) of an owner request the Leader network
   * positively routed to the Leader. Absent on legacy rows, on peer-path rows
   * and on owner requests addressed to another agent: absence means a Leader
   * reply identity is unknown, never that no reply exists.
   */
  requestId?: string;
}

export interface SlackJournalRead {
  state: 'ok' | 'missing' | 'degraded';
  entries: SlackObservation[];
  /** Valid stored observations omitted solely by the projection limit. */
  projectionOmitted?: boolean;
}

function runsRoot(runsDir?: string): string {
  return runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
}

export function slackBridgeDir(runsDir?: string): string {
  return join(runsRoot(runsDir), 'slack-bridge');
}

export function slackJournalPath(runsDir?: string): string {
  return join(slackBridgeDir(runsDir), 'journal.jsonl');
}

function boundedField(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 256 &&
    !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}

/** Whitelist copy: only the declared metadata fields, and only bounded strings. */
function sanitize(obs: SlackObservation): Record<string, string> | null {
  if (!boundedField(obs.at) || !Number.isFinite(Date.parse(obs.at)) ||
      (obs.decision !== 'ingested' && obs.decision !== 'ignored') ||
      (obs.channelId !== undefined && !isSlackChannelId(obs.channelId))) return null;
  const out: Record<string, string> = { at: obs.at, decision: obs.decision };
  if (boundedField(obs.envelopeId)) out['envelopeId'] = obs.envelopeId;
  if (boundedField(obs.eventId)) out['eventId'] = obs.eventId;
  if (isSlackChannelId(obs.channelId)) out['channelId'] = obs.channelId;
  if (boundedField(obs.authorId)) out['authorId'] = obs.authorId;
  if (isSlackTs(obs.messageTs)) out['messageTs'] = obs.messageTs;
  if (isSlackTs(obs.threadTs)) out['threadTs'] = obs.threadTs;
  if (boundedField(obs.reason)) out['reason'] = obs.reason;
  if (obs.bus === 'posted' || obs.bus === 'duplicate' || obs.bus === 'failed') out['bus'] = obs.bus;
  if (isSlackRequestId(obs.requestId)) out['requestId'] = obs.requestId;
  return out;
}

/** Distinguish absence from unreadable, oversized or short-read evidence. */
function journalContents(path: string): string | null {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const read = readPrivateFileCapped(path, SLACK_JOURNAL_MAX_BYTES);
  if (read === null || read.truncated || Buffer.byteLength(read.text, 'utf8') !== read.bytes) {
    throw new Error('unreadable Slack journal');
  }
  return read.text;
}

/**
 * Serialize read/append/whole-row retention with the repository's process-owner
 * lock. Contention has a 250 ms retry budget; OS calls/probes add latency.
 * Damaged predecessors are left untouched for inspection; no implicit repair.
 * Never throws -- journaling must not take the ingest path down.
 */
export function recordSlackObservation(
  obs: SlackObservation,
  options: { runsDir?: string } = {},
): 'recorded' | 'failed' {
  let lock: ReturnType<typeof acquireLocalStoreLock> = null;
  try {
    const clean = sanitize(obs);
    if (clean === null) return 'failed';
    const dir = slackBridgeDir(options.runsDir);
    const path = slackJournalPath(options.runsDir);
    ensurePrivateDirectory(dir);
    lock = acquireLocalStoreLock(`${path}.lock`, 250);
    if (lock === null) return 'failed';
    const existing = journalContents(path) ?? '';
    if (parseJournal(existing, 0).state === 'degraded') return 'failed';
    let body = `${existing}${JSON.stringify(clean)}\n`;
    if (Buffer.byteLength(body, 'utf8') > SLACK_JOURNAL_MAX_BYTES) {
      const lines = body.split('\n').filter((line) => line.length > 0);
      const kept: string[] = [];
      let bytes = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = `${lines[i]!}\n`;
        const size = Buffer.byteLength(line, 'utf8');
        if (bytes + size > SLACK_JOURNAL_KEEP_BYTES) break;
        kept.push(line);
        bytes += size;
      }
      body = kept.reverse().join('');
    }
    writePrivateFileAtomic(path, body);
    return 'recorded';
  } catch {
    return 'failed';
  } finally {
    if (lock !== null) releaseLocalStoreLock(lock);
  }
}

/**
 * Structural validation of one persisted row against the metadata contract
 * `sanitize` writes. Required `at`/`decision` must be present and well-formed;
 * optional fields that ARE present must satisfy their own rules (bounded
 * string, Slack identity or timestamp, or a known bus outcome). Absent optionals -- including
 * `bus` on legacy ingested rows and `messageTs`/`threadTs`/`reason` on rows
 * dropped before channel validation -- stay legitimately absent. Returns null
 * for a corrupted row so the caller can mark the read degraded and skip it
 * rather than let damaged evidence masquerade as a clean ignored event.
 */
function projectObservation(row: Record<string, unknown>): SlackObservation | null {
  const at = row['at'];
  const decision = row['decision'];
  if (!boundedField(at) || !Number.isFinite(Date.parse(at))) return null;
  if (decision !== 'ingested' && decision !== 'ignored') return null;
  for (const key of ['envelopeId', 'eventId', 'authorId', 'reason'] as const) {
    const value = row[key];
    if (value !== undefined && !boundedField(value)) return null;
  }
  if (row['channelId'] !== undefined && !isSlackChannelId(row['channelId'])) return null;
  for (const key of ['messageTs', 'threadTs'] as const) {
    const value = row[key];
    if (value !== undefined && !isSlackTs(value)) return null;
  }
  const bus = row['bus'];
  if (bus !== undefined && bus !== 'posted' && bus !== 'duplicate' && bus !== 'failed') return null;
  if (row['requestId'] !== undefined && !isSlackRequestId(row['requestId'])) return null;
  const out: SlackObservation = { at, decision };
  if (typeof row['envelopeId'] === 'string') out.envelopeId = row['envelopeId'];
  if (typeof row['eventId'] === 'string') out.eventId = row['eventId'];
  if (typeof row['channelId'] === 'string') out.channelId = row['channelId'];
  if (typeof row['authorId'] === 'string') out.authorId = row['authorId'];
  if (isSlackTs(row['messageTs'])) out.messageTs = row['messageTs'];
  if (isSlackTs(row['threadTs'])) out.threadTs = row['threadTs'];
  if (typeof row['reason'] === 'string') out.reason = row['reason'];
  if (bus === 'posted' || bus === 'duplicate' || bus === 'failed') out.bus = bus;
  if (isSlackRequestId(row['requestId'])) out.requestId = row['requestId'];
  return out;
}

/** Newest-first bounded read. Never takes a lock, repairs or creates files. */
export function readSlackJournal(
  options: { runsDir?: string; limit?: number } = {},
): SlackJournalRead {
  const limit = Math.max(1, Math.min(options.limit ?? 500, 4096));
  try {
    const text = journalContents(slackJournalPath(options.runsDir));
    return text === null ? { state: 'missing', entries: [] } : parseJournal(text, limit);
  } catch {
    return { state: 'degraded', entries: [] };
  }
}

function parseJournal(text: string, limit: number): SlackJournalRead {
  const entries: SlackObservation[] = [];
  let projectionOmitted = false;
  let degraded = text.length > 0 && !text.endsWith('\n');
  const lines = text.split('\n').filter((line) => line.length > 0);
  // Validate all bounded evidence even when the projection limit is reached.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed: unknown = JSON.parse(lines[i]!);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        degraded = true;
        continue;
      }
      const obs = projectObservation(parsed as Record<string, unknown>);
      if (obs === null) {
        degraded = true;
        continue;
      }
      if (entries.length < limit) entries.push(obs);
      else projectionOmitted = true;
    } catch {
      degraded = true;
    }
  }
  return { state: degraded ? 'degraded' : 'ok', entries, projectionOmitted };
}
