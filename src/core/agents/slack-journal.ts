/**
 * Slack bridge observation journal (RQ-AGENTNET-SLACK-1).
 *
 * Bounded append-only JSONL under `<runs>/slack-bridge/journal.jsonl` (0600).
 * Every Socket Mode delivery the bridge sees lands here as ONE metadata record --
 * ids, timestamps, decision and reason code. Message text, display names, team
 * names, tokens and socket URLs are never written; that is what makes the
 * "ignored and logged without content" rule auditable.
 *
 * The file is capped (256 KiB): when an append would exceed the cap the tail
 * is kept and older observations drop -- a journal is evidence, not a ledger.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';

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
      const row = parsed as Record<string, unknown>;
      entries.push({
        at: typeof row['at'] === 'string' ? row['at'] : '',
        ...(typeof row['envelopeId'] === 'string' ? { envelopeId: row['envelopeId'] } : {}),
        ...(typeof row['eventId'] === 'string' ? { eventId: row['eventId'] } : {}),
        ...(typeof row['channelId'] === 'string' ? { channelId: row['channelId'] } : {}),
        ...(typeof row['authorId'] === 'string' ? { authorId: row['authorId'] } : {}),
        decision: row['decision'] === 'ingested' ? 'ingested' : 'ignored',
        ...(typeof row['reason'] === 'string' ? { reason: row['reason'] } : {}),
        ...(row['bus'] === 'posted' || row['bus'] === 'duplicate' || row['bus'] === 'failed' ? { bus: row['bus'] } : {}),
      });
    } catch {
      degraded = true;
    }
  }
  return { state: degraded ? 'degraded' : 'ok', entries };
}
