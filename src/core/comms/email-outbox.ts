/**
 * RQ-PHX-EMAILOUTBOXSEND02: the `.reply.eml` outbox → real mail.
 *
 * The email drop bridge writes acks, pairing and status replies as
 * `*.reply.eml` files into an outbound directory — and nothing ever read them
 * back out, so an email to Phantom earned an inbox entry and silence. This
 * module is the missing half.
 *
 *   readEmailOutbox(dir)   — never mutates. `*.reply.eml` files in dir are
 *     `queued` (with parsed To/Subject), files in `dir/sent/` are `sent`, and
 *     anything unsendable is `stuck` with a reason: symlinks, non-regular
 *     files, replies over EMAIL_OUTBOX_MAX_BYTES, and claims left in
 *     `dir/sending/` by a crashed pass.
 *   sendEmailOutbox(opts)  — one pass over queued replies, in name order. A
 *     reply sends only when its To parses to exactly one address on
 *     `allowedRecipients`; anything else is `refused` and stays in the
 *     outbox. Claiming is an atomic rename into `sending/` — overlapping
 *     passes can never send the same file — then the transport runs and the
 *     claim moves into `sent/`. A transport failure renames back to the
 *     outbox (`failed`) for the next pass; a claim found in `sending/` is
 *     `stuck` and never resent. A lost reply is better than a duplicate
 *     email.
 *   macMailTransport(run)  — darwin-only Mail.app send through osascript.
 *     The script is a fixed literal and To/subject/body travel as argv items
 *     read by its `on run argv` handler — no value is ever interpolated into
 *     script source, so a body containing `do shell script` stays inert.
 *     Mail.app cannot set In-Reply-To or References through AppleScript, so
 *     replies send as a fresh thread — threading is lost.
 *
 * A reply body is never logged: results carry names, addresses and reasons.
 */

import { execFile } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/** Replies larger than this are stuck, not sent — a reply is ack text, not a payload. */
export const EMAIL_OUTBOX_MAX_BYTES = 64 * 1024;
const REPLY_SUFFIX = '.reply.eml';
const SENDING_DIR = 'sending';
const SENT_DIR = 'sent';
const MAIL_TIMEOUT_MS = 30_000;
const ADDRESS = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*/g;

export interface EmailOutboxMessage {
  to: string;
  subject: string;
  body: string;
}

export interface EmailTransportResult {
  ok: boolean;
  error?: string;
}

/** Injected send path — tests substitute a fake; production uses macMailTransport. */
export type EmailTransport = (message: EmailOutboxMessage) => Promise<EmailTransportResult>;

export type EmailOutboxStuckReason = 'symlink' | 'not-regular' | 'oversized' | 'unreadable' | 'interrupted-send';

export interface EmailOutboxEntry {
  name: string;
  state: 'queued' | 'sent' | 'stuck';
  /** Parsed single To address when present; absent when missing or multi-recipient. */
  to?: string;
  subject?: string;
  reason?: EmailOutboxStuckReason;
}

export interface EmailOutboxListing {
  dir: string;
  counts: { queued: number; sent: number; stuck: number };
  entries: EmailOutboxEntry[];
}

export interface EmailOutboxSendOptions {
  dir: string;
  allowedRecipients: ReadonlySet<string>;
  transport: EmailTransport;
  /** Clock seam for tests; stamps `at` on sent details. */
  now?: () => Date;
}

export interface EmailOutboxSendDetail {
  name: string;
  outcome: 'queued' | 'sent' | 'refused' | 'failed' | 'stuck';
  to?: string;
  reason?: string;
  at?: string;
}

export interface EmailOutboxSendResult {
  /** Still pending after this pass — claimed by a concurrent run. */
  queued: number;
  sent: number;
  /** To failed the allowlist gate; the file stays in the outbox. */
  refused: number;
  /** Transport failure; the file was returned to the outbox. */
  failed: number;
  /** Never sent: symlink, oversized, unreadable, or a crashed-run claim. */
  stuck: number;
  details: EmailOutboxSendDetail[];
}

interface ParsedReply {
  /** The single address in To, or null when the count is not exactly one. */
  to: string | null;
  toCount: number;
  subject: string;
  body: string;
}

/** A header value that can never carry CRLF onward into the transport. */
function cleanHeader(value: string | undefined): string {
  return (value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

/** Unfolded header lines → lowercase-name map (first occurrence wins). */
function replyHeaders(section: string): Map<string, string> {
  const headers = new Map<string, string>();
  let name: string | null = null;
  for (const line of section.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (name !== null) headers.set(name, `${headers.get(name)} ${line.trim()}`);
      continue;
    }
    const match = /^([!-9;-~]+):\s*(.*)$/.exec(line);
    name = match ? match[1]!.toLowerCase() : null;
    if (name !== null && !headers.has(name)) headers.set(name, match![2]!);
  }
  return headers;
}

/**
 * Minimal RFC 822 subset parse for a reply the bridge wrote: To, Subject and
 * the raw body. The bridge's own parser does not fit — it requires a From and
 * strips quoted lines, neither of which applies to an outbound reply.
 */
function parseReplyEml(raw: string): ParsedReply {
  const split = /\r?\n\r?\n/.exec(raw);
  const headers = replyHeaders(split ? raw.slice(0, split.index) : raw);
  const body = split ? raw.slice(split.index + split[0].length) : '';
  const addresses = cleanHeader(headers.get('to')).match(ADDRESS) ?? [];
  return {
    to: addresses.length === 1 ? addresses[0]!.toLowerCase() : null,
    toCount: addresses.length,
    subject: cleanHeader(headers.get('subject')),
    body,
  };
}

/** `*.reply.eml` names in one directory, name order; unreadable dir → empty. */
function replyNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.toLowerCase().endsWith(REPLY_SUFFIX)).sort();
  } catch {
    return [];
  }
}

interface ScannedEntry {
  name: string;
  stuck?: EmailOutboxStuckReason | 'vanished';
  reply?: ParsedReply;
}

/** Classify each outbox reply: sendable (parsed) or stuck with a reason. */
function scanOutbox(dir: string): ScannedEntry[] {
  const entries: ScannedEntry[] = [];
  for (const name of replyNames(dir)) {
    try {
      const stat = lstatSync(join(dir, name));
      if (stat.isSymbolicLink()) entries.push({ name, stuck: 'symlink' });
      else if (!stat.isFile()) entries.push({ name, stuck: 'not-regular' });
      else if (stat.size > EMAIL_OUTBOX_MAX_BYTES) entries.push({ name, stuck: 'oversized' });
      else entries.push({ name, reply: parseReplyEml(readFileSync(join(dir, name), 'utf8')) });
    } catch (error) {
      entries.push({ name, stuck: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'vanished' : 'unreadable' });
    }
  }
  return entries;
}

/** Read-only view of the outbox: queued replies, sent history, stuck files. */
export function readEmailOutbox(dir: string): EmailOutboxListing {
  const entries: EmailOutboxEntry[] = [];
  for (const entry of scanOutbox(dir)) {
    if (entry.stuck === 'vanished') continue; // claimed by a concurrent pass
    entries.push(entry.stuck
      ? { name: entry.name, state: 'stuck', reason: entry.stuck }
      : { name: entry.name, state: 'queued', to: entry.reply?.to ?? undefined, subject: entry.reply?.subject });
  }
  for (const name of replyNames(join(dir, SENDING_DIR))) {
    entries.push({ name, state: 'stuck', reason: 'interrupted-send' });
  }
  for (const name of replyNames(join(dir, SENT_DIR))) {
    entries.push({ name, state: 'sent' });
  }
  const counts = { queued: 0, sent: 0, stuck: 0 };
  for (const entry of entries) counts[entry.state] += 1;
  return { dir, counts, entries };
}

/**
 * One send pass. Each discovered reply ends in exactly one outcome: `sent`
 * (claim moved to sent/), `refused` (To gate, left in the outbox), `failed`
 * (transport error, renamed back), `stuck` (unsendable or orphaned claim) or
 * `queued` (claimed by a concurrent run — still pending, never double-sent).
 */
export async function sendEmailOutbox(opts: EmailOutboxSendOptions): Promise<EmailOutboxSendResult> {
  const sending = join(opts.dir, SENDING_DIR);
  const sentDir = join(opts.dir, SENT_DIR);
  mkdirSync(sending, { recursive: true });
  mkdirSync(sentDir, { recursive: true });
  const now = opts.now ?? (() => new Date());
  const result: EmailOutboxSendResult = { queued: 0, sent: 0, refused: 0, failed: 0, stuck: 0, details: [] };
  const record = (name: string, outcome: EmailOutboxSendDetail['outcome'], extra?: Partial<EmailOutboxSendDetail>): void => {
    result[outcome] += 1;
    result.details.push({ name, outcome, ...extra });
  };

  // Claims orphaned by a crashed pass are never resent — a lost reply is
  // better than a duplicate email.
  for (const name of replyNames(sending)) record(name, 'stuck', { reason: 'interrupted-send' });

  for (const entry of scanOutbox(opts.dir)) {
    if (entry.stuck === 'vanished') { record(entry.name, 'queued'); continue; }
    if (entry.stuck) { record(entry.name, 'stuck', { reason: entry.stuck }); continue; }
    const reply = entry.reply!;
    if (reply.to === null || !opts.allowedRecipients.has(reply.to)) {
      record(entry.name, 'refused', {
        to: reply.to ?? undefined,
        reason: reply.toCount > 1 ? 'multiple-recipients' : reply.to === null ? 'no-recipient' : 'recipient-not-allowed',
      });
      continue;
    }
    const claim = join(sending, entry.name);
    try {
      renameSync(join(opts.dir, entry.name), claim); // atomic claim — only one pass wins
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') record(entry.name, 'queued', { to: reply.to });
      else record(entry.name, 'failed', { to: reply.to, reason: 'claim-failed' });
      continue;
    }
    let outcome: EmailTransportResult;
    try {
      outcome = await opts.transport({ to: reply.to, subject: reply.subject, body: reply.body });
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (outcome.ok) {
      try {
        renameSync(claim, join(sentDir, entry.name));
      } catch {
        // Sent but unmarked: the claim stays in sending/ and reports stuck —
        // it is never resent.
      }
      record(entry.name, 'sent', { to: reply.to, at: now().toISOString() });
    } else {
      try {
        renameSync(claim, join(opts.dir, entry.name));
        record(entry.name, 'failed', { to: reply.to, reason: outcome.error ?? 'transport-failed' });
      } catch {
        record(entry.name, 'stuck', { to: reply.to, reason: 'interrupted-send' });
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Mail.app transport (darwin)
// ---------------------------------------------------------------------------

export interface MailRunnerResult {
  /** Process exit code; any non-zero value is a send failure. */
  code: number;
  stderr?: string;
}

/** Runner seam: receives the full argv (osascript first) plus the timeout. */
export type OsaScriptRunner = (argv: string[], timeoutMs: number) => Promise<MailRunnerResult>;

const execFileRunner: OsaScriptRunner = (argv, timeoutMs) => new Promise((resolve) => {
  try {
    execFile(argv[0]!, argv.slice(1), { timeout: timeoutMs }, (error, _stdout, stderr) => {
      if (!error) { resolve({ code: 0 }); return; }
      const code = (error as { code?: unknown }).code;
      resolve({
        code: typeof code === 'number' && code !== 0 ? code : 1,
        stderr: typeof stderr === 'string' && stderr.trim() ? stderr.trim() : undefined,
      });
    });
  } catch {
    resolve({ code: 1 });
  }
});

// Fixed script literal: To/subject/body arrive as argv items, never as
// interpolated source. Mail.app cannot set In-Reply-To/References through
// AppleScript, so replies send as a fresh thread and threading is lost.
const MAIL_SCRIPT = [
  'on run argv',
  '  set toAddr to item 1 of argv',
  '  set subj to item 2 of argv',
  '  set bodyText to item 3 of argv',
  '  tell application "Mail"',
  '    set outgoing to make new outgoing message with properties {subject:subj, content:bodyText, visible:false}',
  '    tell outgoing to make new to recipient at end of to recipients with properties {address:toAddr}',
  '    send outgoing',
  '  end tell',
  'end run',
].join('\n');

/**
 * Production transport: send one reply through Mail.app via osascript with a
 * 30 s bound. Non-darwin fails without spawning; a non-zero exit, a timeout or
 * a spawn failure all return { ok: false } and never throw.
 */
export function macMailTransport(runner: OsaScriptRunner = execFileRunner): EmailTransport {
  return async (message) => {
    if (process.platform !== 'darwin') return { ok: false, error: 'mac-mail requires darwin' };
    let ran: MailRunnerResult;
    try {
      ran = await runner(
        ['osascript', '-e', MAIL_SCRIPT, message.to, message.subject, message.body],
        MAIL_TIMEOUT_MS,
      );
    } catch {
      return { ok: false, error: 'osascript spawn failed' };
    }
    return ran.code === 0
      ? { ok: true }
      : { ok: false, error: ran.stderr ?? `osascript exited ${ran.code}` };
  };
}
