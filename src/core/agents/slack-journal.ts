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
 * is kept and older observations drop -- a journal is evidence, not a ledger.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import { isSlackTs } from './slack-network.js';

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
}

export interface SlackJournalRead {
  state: 'ok' | 'missing' | 'degraded';
  entries: SlackObservation[];
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
  if (!boundedField(obs.at) || (obs.decision !== 'ingested' && obs.decision !== 'ignored')) return null;
  const out: Record<string, string> = { at: obs.at, decision: obs.decision };
  if (boundedField(obs.envelopeId)) out['envelopeId'] = obs.envelopeId;
  if (boundedField(obs.eventId)) out['eventId'] = obs.eventId;
  if (boundedField(obs.channelId)) out['channelId'] = obs.channelId;
  if (boundedField(obs.authorId)) out['authorId'] = obs.authorId;
  if (isSlackTs(obs.messageTs)) out['messageTs'] = obs.messageTs;
  if (isSlackTs(obs.threadTs)) out['threadTs'] = obs.threadTs;
  if (boundedField(obs.reason)) out['reason'] = obs.reason;
  if (obs.bus === 'posted' || obs.bus === 'duplicate' || obs.bus === 'failed') out['bus'] = obs.bus;
  return out;
}

/**
 * Append one observation. Read-modify-write keeps the cap simple: the file
 * stays well under 256 KiB, so a full rewrite on overflow is cheap. Never
 * throws -- journaling must not take the ingest path down.
 */
export function recordSlackObservation(
  obs: SlackObservation,
  options: { runsDir?: string } = {},
): 'recorded' | 'failed' {
  try {
    const clean = sanitize(obs);
    if (clean === null) return 'failed';
    const dir = slackBridgeDir(options.runsDir);
    const path = slackJournalPath(options.runsDir);
    ensurePrivateDirectory(dir);
    const existing = readPrivateFileCapped(path, SLACK_JOURNAL_MAX_BYTES * 2);
    let body = existing === null || existing.truncated ? '' : existing.text;
    body += `${JSON.stringify(clean)}\n`;
    if (Buffer.byteLength(body, 'utf8') > SLACK_JOURNAL_MAX_BYTES) {
      const lines = body.split('\n').filter((line) => line.length > 0);
      let kept = '';
      for (let i = lines.length - 1; i >= 0 && Buffer.byteLength(kept, 'utf8') <= SLACK_JOURNAL_KEEP_BYTES; i--) {
        kept = `${lines[i]!}\n${kept}`;
      }
      body = kept;
    }
    writePrivateFileAtomic(path, body);
    return 'recorded';
  } catch {
    return 'failed';
  }
}

/**
 * Structural validation of one persisted row against the metadata contract
 * `sanitize` writes. Required `at`/`decision` must be present and well-formed;
 * optional fields that ARE present must satisfy their own rules (bounded
 * string, `isSlackTs`, or a known bus outcome). Absent optionals -- including
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
  for (const key of ['envelopeId', 'eventId', 'channelId', 'authorId', 'reason'] as const) {
    const value = row[key];
    if (value !== undefined && !boundedField(value)) return null;
  }
  for (const key of ['messageTs', 'threadTs'] as const) {
    const value = row[key];
    if (value !== undefined && !isSlackTs(value)) return null;
  }
  const bus = row['bus'];
  if (bus !== undefined && bus !== 'posted' && bus !== 'duplicate' && bus !== 'failed') return null;
  const out: SlackObservation = { at, decision };
  if (typeof row['envelopeId'] === 'string') out.envelopeId = row['envelopeId'];
  if (typeof row['eventId'] === 'string') out.eventId = row['eventId'];
  if (typeof row['channelId'] === 'string') out.channelId = row['channelId'];
  if (typeof row['authorId'] === 'string') out.authorId = row['authorId'];
  if (isSlackTs(row['messageTs'])) out.messageTs = row['messageTs'];
  if (isSlackTs(row['threadTs'])) out.threadTs = row['threadTs'];
  if (typeof row['reason'] === 'string') out.reason = row['reason'];
  if (bus === 'posted' || bus === 'duplicate' || bus === 'failed') out.bus = bus;
  return out;
}

/** Newest-first bounded read for status surfaces. `degraded` on unreadable or malformed lines. */
export function readSlackJournal(
  options: { runsDir?: string; limit?: number } = {},
): SlackJournalRead {
  const limit = Math.max(1, Math.min(options.limit ?? 500, 4096));
  const read = readPrivateFileCapped(slackJournalPath(options.runsDir), SLACK_JOURNAL_MAX_BYTES);
  if (read === null) return { state: 'missing', entries: [] };
  if (read.truncated) return { state: 'degraded', entries: [] };
  const entries: SlackObservation[] = [];
  let degraded = false;
  const lines = read.text.split('\n').filter((line) => line.length > 0);
  for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
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
      entries.push(obs);
    } catch {
      degraded = true;
    }
  }
  return { state: degraded ? 'degraded' : 'ok', entries };
}
