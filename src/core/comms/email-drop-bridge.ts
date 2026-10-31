/**
 * RQ-PHX-EMAILDROPCHANNEL31: drop-folder email → MASON-INBOX.md bridge.
 *
 * Mason's Oct 31 order is channel-agnostic input: any verified channel lands in
 * the shared inbox and the agent bus, dedupes, attributes its source, and acks
 * on the same channel. Email joins through a drop folder, not IMAP: any mail
 * path (Mail.app rule, fetchmail, a forwarder script) saves raw RFC 822
 * messages as `*.eml` into an inbound directory. Phantom parses them, verifies
 * the sender against an explicit allowlist, receipt-writes the body into
 * MASON-INBOX.md under channel `email`, mirrors to the durable agent bus, and
 * writes the acknowledgement as a reply `.eml` into an outbound directory the
 * same mail path can send. Transport stays outside Phantom; verification,
 * dedupe, attribution and ack live inside it. No new dependency, no
 * credentials, no network.
 *
 *   parseEmlMessage(raw)              — pure RFC 822 subset parse; null without
 *     a parseable From. Headers unfold continuation lines and are
 *     case-insensitive; the body is the first text/plain part (or the raw body
 *     when not multipart) with `>` quote lines and the `-- ` signature cut,
 *     capped at 8 KB.
 *   emailChannelMessage(parsed, set)  — first gate: null unless the From
 *     address is in the allowlist. Maps to channel `email`, canonical sender
 *     `email:<address>`; the receiver's allowedSenderIds is the second gate —
 *     same split as telegramChannelMessage + configuredOwnerIds.
 *   recordEmailToInbox(raw, opts)     — runs the shared channel receiver for
 *     one raw message; the acknowledge callback writes a reply `.eml` (To the
 *     sender, `Re:` subject, In-Reply-To/References the original Message-ID)
 *     carrying formatChannelAck() plus an `Inbox:` preview line. Message-IDs
 *     of accepted mails persist in <runsDir>/queue/email-drop-seen.jsonl and
 *     are skipped as duplicates on sight — the receiver's body-hash window is
 *     the other dedupe layer.
 *   runEmailDropOnce(opts)            — one pass over `*.eml` in inboxDir in
 *     name order; every handled file is renamed into processedDir (never
 *     deleted) and one bad file never throws or stops the pass.
 *
 * Like Telegram's `sender-not-allowed`, an unverified sender gets no reply and
 * no inbox write. A failed outbox write never unwrites an accepted entry.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createChannelReceiver, type ChannelAck, type ChannelEnvelope, type ChannelMessage, type ChannelReceiveResult } from '../fleet/channel-envelope.js';
import { formatChannelAck } from '../fleet/channel-ack-text.js';

export interface ParsedEml {
  from: string;
  messageId: string | null;
  subject: string;
  body: string;
  inReplyTo: string | null;
}

export interface EmailDropRecordOptions {
  /** Bare lowercase sender addresses admitted through the adapter gate. */
  allowedSenders: ReadonlySet<string>;
  /** Shared runs context (inbox + receipt + seen-id stores). Default ~/.ashlr-runs. */
  runsDir?: string;
  /** Clock seam for tests. */
  now?: () => Date;
  /** Directory reply `.eml` files are written to; no replies without it. */
  outboxDir?: string;
  /** Store root for the default bus publish sink (test seam). */
  busRoot?: string;
}

export interface EmailDropRunOptions extends EmailDropRecordOptions {
  inboxDir: string;
  outboxDir: string;
  processedDir: string;
}

export interface EmailDropCounts {
  accepted: number;
  duplicate: number;
  refused: number;
  failed: number;
}

const BODY_CAP_BYTES = 8 * 1024;
const SEEN_LIMIT = 5_000;
const SEEN_MAX_BYTES = 2 * 1024 * 1024;
const ADDRESS = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*/;

/** A header value that can never inject extra headers into a reply. */
function safeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** Bare lowercase address from a From value, or null when nothing parses. */
function extractAddress(header: string | undefined): string | null {
  if (!header) return null;
  const bracketed = /<([^<>]+)>/.exec(header);
  const match = (bracketed ? bracketed[1]! : header).match(ADDRESS);
  return match ? match[0].toLowerCase() : null;
}

/** Message-ID / In-Reply-To inner token, without angle brackets. */
function messageIdToken(header: string | undefined): string | null {
  if (!header) return null;
  const bracketed = /<([^<>]+)>/.exec(header);
  const token = (bracketed ? bracketed[1]! : header).trim().split(/\s+/)[0];
  return token && token.length <= 998 ? token : null;
}

/** Unfolded header lines → lowercase-name map (first occurrence wins). */
function parseHeaders(section: string): Map<string, string> {
  const headers = new Map<string, string>();
  let name: string | null = null;
  for (const line of section.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (name !== null) headers.set(name, `${headers.get(name)} ${line.trim()}`);
      continue;
    }
    const match = /^([!-9;-~]+):\s*(.*)$/.exec(line);
    name = match ? match[1]!.toLowerCase() : null;
    if (name !== null && !headers.has(name)) headers.set(name, match![2]!.trim());
  }
  return headers;
}

/** Split headers and body at the first blank line. */
function splitMessage(raw: string): { headerSection: string; body: string } {
  const match = /\r?\n\r?\n/.exec(raw);
  return match
    ? { headerSection: raw.slice(0, match.index), body: raw.slice(match.index + match[0].length) }
    : { headerSection: raw, body: '' };
}

/**
 * First text/plain body in a multipart tree; unlabelled parts are text/plain.
 * The walk is line-based so preamble and `--boundary--` epilogue never count
 * as parts, and nested multipart sections recurse.
 */
function firstTextPlain(contentType: string | undefined, body: string): string | null {
  if (!/^multipart\//i.test(contentType ?? '')) return null;
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType ?? '')?.[1]?.trim();
  if (!boundary) return null;
  const marker = `--${boundary}`;
  const segments: string[] = [];
  let current: string[] | null = null;
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed === marker) {
      if (current !== null) segments.push(current.join('\n'));
      current = [];
    } else if (trimmed === `${marker}--`) {
      if (current !== null) segments.push(current.join('\n'));
      break;
    } else if (current !== null) {
      current.push(line);
    }
  }
  if (current !== null) segments.push(current.join('\n')); // truncated tail part still counts
  for (const segment of segments) {
    const normalized = segment.replace(/\r\n/g, '\n');
    if (!normalized.trim()) continue;
    // A part always opens with its header lines or with one empty line meaning
    // "no headers" — a leading empty line is never body text itself.
    const part = normalized.startsWith('\n')
      ? { headerSection: '', body: normalized.slice(1) }
      : splitMessage(normalized);
    const partType = parseHeaders(part.headerSection).get('content-type');
    if (partType && /^multipart\//i.test(partType)) {
      const nested = firstTextPlain(partType, part.body);
      if (nested !== null) return nested;
    } else if (!partType || /^text\/plain(?:\s*;|$)/i.test(partType)) {
      return part.body;
    }
  }
  return null;
}

/** Longest UTF-8 prefix within `maxBytes` — the body cap is a byte cap. */
function capUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

/**
 * Parse one raw RFC 822 message. Returns null without a parseable From — the
 * adapter's only identity evidence is that header, so an absent or unreadable
 * one fails closed.
 */
export function parseEmlMessage(raw: string): ParsedEml | null {
  if (typeof raw !== 'string' || !raw) return null;
  const { headerSection, body } = splitMessage(raw);
  const headers = parseHeaders(headerSection);
  const from = extractAddress(headers.get('from'));
  if (!from) return null;
  const text = firstTextPlain(headers.get('content-type'), body) ?? body;
  const kept: string[] = [];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^--\s*$/.test(line)) break; // signature separator ends the message text
    if (!line.startsWith('>')) kept.push(line);
  }
  return {
    from,
    messageId: messageIdToken(headers.get('message-id')),
    subject: headers.get('subject') ?? '',
    body: capUtf8Bytes(kept.join('\n'), BODY_CAP_BYTES).trim(),
    inReplyTo: messageIdToken(headers.get('in-reply-to')),
  };
}

/**
 * First gate: map a parsed message to a canonical channel message only when
 * its From is on the allowlist; the receiver allowlist is the second gate.
 * The body carries the subject line first so attribution and search see it.
 */
export function emailChannelMessage(parsed: ParsedEml, allowedSenders: ReadonlySet<string>): ChannelMessage | null {
  if (!parsed || !allowedSenders.has(parsed.from)) return null;
  const subject = parsed.subject.trim();
  return {
    channel: 'email',
    verifiedSenderId: `email:${parsed.from}`,
    body: subject ? `${subject}\n\n${parsed.body}` : parsed.body,
  };
}

/** Runs dir for both the receiver stores and the seen file (same default). */
function runsRoot(runsDir: string | undefined): string {
  return runsDir ?? join(homedir(), '.ashlr-runs');
}

function seenFilePath(runsDir: string | undefined): string {
  return join(runsRoot(runsDir), 'queue', 'email-drop-seen.jsonl');
}

/** Message-IDs recorded for accepted receipts — the last SEEN_LIMIT lines win. */
function readSeenMessageIds(runsDir: string | undefined): Set<string> {
  const ids = new Set<string>();
  try {
    const file = seenFilePath(runsDir);
    if (!existsSync(file) || statSync(file).size > SEEN_MAX_BYTES) return ids;
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
    for (const line of lines.slice(-SEEN_LIMIT)) {
      try {
        const row: unknown = JSON.parse(line);
        if (row && typeof (row as { id?: unknown }).id === 'string') ids.add((row as { id: string }).id);
      } catch { /* a torn line is ignored, never fatal */ }
    }
  } catch { /* an unreadable seen file degrades to receiver dedupe only */ }
  return ids;
}

/** Append-only journal of accepted Message-IDs; bounded at read, never fatal. */
function recordSeenMessageId(runsDir: string | undefined, id: string): void {
  try {
    const file = seenFilePath(runsDir);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ id })}\n`, 'utf8');
  } catch { /* a lost seen row only means a future redelivery re-acks */ }
}

function sanitizeFileStem(id: string): string {
  const stem = id.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 120);
  return stem || 'message';
}

/**
 * The same-channel acknowledgement: a reply `.eml` any mail path can send.
 * Header values are sanitized against injection; the body carries the shared
 * ack text and the first 60 chars of the normalized inbox body. Best effort —
 * callers catch, and a transport failure never unwrites a receipt.
 */
function writeReplyEml(outboxDir: string, parsed: ParsedEml, ack: ChannelAck, preview: string, stem: string): void {
  const headers = [
    `To: ${parsed.from}`,
    `Subject: Re: ${safeHeaderValue(parsed.subject) || '(no subject)'}`,
  ];
  if (parsed.messageId) {
    headers.push(`In-Reply-To: <${parsed.messageId}>`);
    headers.push(`References: <${parsed.messageId}>`);
  }
  headers.push('Content-Type: text/plain; charset=utf-8');
  mkdirSync(outboxDir, { recursive: true });
  writeFileSync(join(outboxDir, `${stem}.reply.eml`), `${headers.join('\r\n')}\r\n\r\n${formatChannelAck(ack)}\nInbox: ${preview}\r\n`, 'utf8');
}

/**
 * Record one raw `.eml` into the shared channel receiver. Unparseable input is
 * `invalid`; an unlisted sender is `sender-not-allowed` (silent, like
 * Telegram); a Message-ID already journaled returns a duplicate ack without a
 * second inbox write and still leaves a reply for the mail path to send.
 */
export async function recordEmailToInbox(
  raw: string,
  opts: EmailDropRecordOptions,
): Promise<ChannelReceiveResult> {
  const parsed = parseEmlMessage(raw);
  if (!parsed) return { ok: false, reason: 'invalid' };
  const message = emailChannelMessage(parsed, opts.allowedSenders);
  if (!message) return { ok: false, reason: 'sender-not-allowed' };
  // Same normalization the receiver applies, so the preview matches the entry.
  const normalized = message.body.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  const preview = normalized.slice(0, 60);
  const stem = parsed.messageId
    ? sanitizeFileStem(parsed.messageId)
    : `no-id-${createHash('sha256').update(normalized).digest('hex').slice(0, 24)}`;
  const reply = async (ack: ChannelAck): Promise<void> => {
    if (!opts.outboxDir) return;
    try { writeReplyEml(opts.outboxDir, parsed, ack, preview, stem); } catch { /* best-effort transport */ }
  };
  try {
    // The seen journal dedupes whole files across passes — including deliveries
    // after the body-hash window has expired or with a fresh receiver.
    if (parsed.messageId && readSeenMessageIds(opts.runsDir).has(parsed.messageId)) {
      const dedupeKey = createHash('sha256').update(JSON.stringify(['email-message-id', parsed.messageId])).digest('hex');
      const at = (opts.now ?? (() => new Date()))();
      const envelope: ChannelEnvelope = {
        channel: 'email', verifiedSenderId: message.verifiedSenderId,
        receivedAt: at.toISOString(), body: normalized, dedupeKey,
      };
      const ack: ChannelAck = { channel: 'email', dedupeKey, status: 'duplicate' };
      await reply(ack);
      return { ok: true, envelope, ack };
    }
    const receive = createChannelReceiver({
      allowedSenderIds: new Set([message.verifiedSenderId]),
      runsDir: opts.runsDir,
      now: opts.now,
      busRoot: opts.busRoot,
      acknowledge: reply,
    });
    const result = await receive(message);
    if (result.ok && result.ack.status === 'accepted' && parsed.messageId) {
      recordSeenMessageId(opts.runsDir, parsed.messageId);
    }
    return result;
  } catch {
    return { ok: false, reason: 'write-failed' };
  }
}

/**
 * One pass over `*.eml` in inboxDir, in name order. Each handled file is
 * renamed into processedDir (never deleted; a colliding name gains a suffix)
 * and one bad file never throws or stops the pass.
 */
export async function runEmailDropOnce(opts: EmailDropRunOptions): Promise<EmailDropCounts> {
  const counts: EmailDropCounts = { accepted: 0, duplicate: 0, refused: 0, failed: 0 };
  let names: string[];
  try {
    mkdirSync(opts.processedDir, { recursive: true });
    names = readdirSync(opts.inboxDir)
      .filter((name) => name.toLowerCase().endsWith('.eml'))
      .sort();
  } catch {
    return counts; // a missing/unreadable inbox dir is an empty pass, not a crash
  }
  const move = (name: string): boolean => {
    const source = join(opts.inboxDir, name);
    try {
      let target = join(opts.processedDir, name);
      for (let suffix = 1; existsSync(target); suffix++) {
        target = join(opts.processedDir, `${name}.${suffix}`);
      }
      try {
        renameSync(source, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        copyFileSync(source, target); // cross-device drop folders still move
        rmSync(source);
      }
      return true;
    } catch {
      return false;
    }
  };
  for (const name of names) {
    let result: ChannelReceiveResult = { ok: false, reason: 'invalid' };
    try {
      const raw = readFileSync(join(opts.inboxDir, name), 'utf8');
      result = await recordEmailToInbox(raw, opts);
    } catch { /* one bad file stays a single failure */ }
    if (!move(name)) {
      counts.failed += 1;
      continue;
    }
    if (result.ok) counts[result.ack.status === 'accepted' ? 'accepted' : 'duplicate'] += 1;
    else if (result.reason === 'sender-not-allowed') counts.refused += 1;
    else counts.failed += 1;
  }
  return counts;
}
