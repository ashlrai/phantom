/**
 * RQ-PHX-EMAILDIAGNOSE04SQU1 — the email leg of `phm comms diagnose`.
 *
 * Before Commsbot is retired an agent must be able to answer "why are email
 * replies not flowing?" from local evidence alone. This module reads the
 * saved email-drop config and the reply outbox and projects both into the
 * same fixed-code check shape the rest of diagnose emits.
 *
 * Projections only: counts, enum states and fixed strings leave this module —
 * never paths, addresses, subjects, bodies or exception text. The outbox
 * directory's availability is probed explicitly because readEmailOutbox
 * degrades an unreadable directory to an empty listing, which would make a
 * broken drop folder look like a healthy empty outbox. Nothing here sends
 * mail or mutates config: `sendReplies` is reported, never toggled.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readEmailDropConfig } from './email-drop-config.js';
import { readEmailOutbox, type EmailOutboxListing } from './email-outbox.js';

export type EmailCheckState = 'ok' | 'blocked' | 'unavailable' | 'unsupported';
export interface EmailCheck { id: string; state: EmailCheckState; reason: string; nextStep: string }

export interface EmailCounts { queued: number; drafted: number; sent: number; stuck: number }
export type EmailConfigState = 'missing' | 'invalid' | 'ok';
export type EmailOutboxAvailability = 'ok' | 'missing' | 'not-directory' | 'unreadable' | 'not-established';
/** `draft-only` and `paused` are deliberate states; `blocked` is a broken delivery path. */
export type EmailRepliesState = 'not-configured' | 'paused' | 'draft-only' | 'blocked' | 'send-enabled';

export interface EmailDiagnosis {
  config: EmailConfigState;
  polling: 'enabled' | 'paused' | 'unknown';
  sendReplies: 'enabled' | 'disabled' | 'unknown';
  outbox: EmailOutboxAvailability;
  /** Observed `*.reply.eml` counts; null when the outbox could not be read. */
  counts: EmailCounts | null;
  replies: EmailRepliesState;
  /** Scope marker: this evidence is local config/outbox observation only. */
  coverage: 'local-evidence-only-not-gmail-triage-or-proof-of-delivery';
  checks: EmailCheck[];
}

export interface EmailDiagnosisDeps {
  readConfig?: typeof readEmailDropConfig;
  /** Availability probe for the outbox dir (test seam). Default probeOutboxDir. */
  probeDir?: (dir: string) => Exclude<EmailOutboxAvailability, 'not-established'>;
  listOutbox?: typeof readEmailOutbox;
}

const COVERAGE = 'local-evidence-only-not-gmail-triage-or-proof-of-delivery' as const;
const NEXT_DIAGNOSE = 'phm comms diagnose --json';
const NEXT_SETUP = 'phm comms setup-email';
const NEXT_CYCLE = 'phm comms email-cycle';
const NEXT_OUTBOX = 'phm fleet email-outbox --json';
const NEXT_DRAFTS = 'phm drafts list --status pending --json';
const OUTBOX_SUBDIRS = ['sending', 'sent', 'drafted'] as const;

/**
 * Establish that the outbox is a readable directory before trusting a
 * listing: readEmailOutbox silently degrades I/O failures to `[]`, so an
 * absent or unreadable drop folder must be classified here first. Errors are
 * mapped to fixed codes only — raw exception text never leaves.
 */
export function probeOutboxDir(dir: string): Exclude<EmailOutboxAvailability, 'not-established'> {
  let stat;
  try {
    stat = statSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? 'missing' : code === 'ENOTDIR' ? 'not-directory' : 'unreadable';
  }
  if (!stat.isDirectory()) return 'not-directory';
  try {
    readdirSync(dir);
    for (const sub of OUTBOX_SUBDIRS) {
      try {
        readdirSync(join(dir, sub));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  } catch {
    return 'unreadable';
  }
  return 'ok';
}

/** Read-only email evidence for `phm comms diagnose`. Never throws. */
export async function diagnoseEmailDrop(runsDir: string, deps: EmailDiagnosisDeps = {}): Promise<EmailDiagnosis> {
  const readConfig = deps.readConfig ?? readEmailDropConfig;
  const probeDir = deps.probeDir ?? probeOutboxDir;
  const listOutbox = deps.listOutbox ?? readEmailOutbox;
  const checks: EmailCheck[] = [];
  const add = (id: string, state: EmailCheckState, reason: string, nextStep = NEXT_DIAGNOSE): void => {
    checks.push({ id, state, reason, nextStep });
  };

  let saved: Awaited<ReturnType<typeof readEmailDropConfig>>;
  try {
    saved = await readConfig(runsDir);
  } catch {
    saved = { state: 'invalid', path: '' };
  }
  if (saved.state !== 'ok' || !saved.config) {
    // A reader answering 'ok' without a config is unusable, not healthy.
    const configState: EmailConfigState = saved.state === 'ok' ? 'invalid' : saved.state;
    add('email-config', 'unavailable', `email-config-${configState}`, NEXT_SETUP);
    add('email-polling', 'unavailable', 'unknown-config-unusable');
    add('email-send', 'unavailable', 'unknown-config-unusable');
    add('email-outbox', 'unavailable', 'unknown-config-unusable');
    return {
      config: configState, polling: 'unknown', sendReplies: 'unknown',
      outbox: 'not-established', counts: null, replies: 'not-configured', coverage: COVERAGE, checks,
    };
  }

  const config = saved.config;
  const paused = config.enabled === false;
  const sendOn = config.sendReplies === true;
  add('email-config', 'ok', 'email-config-present');
  add('email-polling', paused ? 'blocked' : 'ok', paused ? 'email-polling-paused' : 'email-polling-enabled', NEXT_SETUP);
  // sendReplies is opt-in: absent means draft-only by design, not a failure.
  add('email-send', sendOn ? 'ok' : 'unsupported', sendOn ? 'send-replies-enabled' : 'send-replies-disabled-draft-only', NEXT_SETUP);

  // Same resolution the cycle and `fleet email-outbox` use.
  const outboxDir = config.outboxDir ?? join(config.inboxDir, '..', 'outbox');
  let availability: Exclude<EmailOutboxAvailability, 'not-established'>;
  try {
    availability = probeDir(outboxDir);
  } catch {
    availability = 'unreadable';
  }
  let counts: EmailCounts | null = null;
  if (availability !== 'ok') {
    add('email-outbox', 'unavailable', `email-outbox-${availability}`, NEXT_SETUP);
  } else {
    let listing: EmailOutboxListing | null = null;
    try {
      listing = listOutbox(outboxDir);
    } catch {
      listing = null;
    }
    if (!listing) {
      availability = 'unreadable';
      add('email-outbox', 'unavailable', 'email-outbox-unreadable', NEXT_SETUP);
    } else {
      counts = { queued: listing.counts.queued, drafted: listing.counts.drafted, sent: listing.counts.sent, stuck: listing.counts.stuck };
      if (counts.stuck > 0) add('email-outbox', 'blocked', 'stuck-replies-observed', NEXT_OUTBOX);
      else if (counts.queued > 0) add('email-outbox', 'ok',
        sendOn ? 'queued-replies-await-send-cycle' : 'queued-replies-held-send-disabled', sendOn ? NEXT_CYCLE : NEXT_OUTBOX);
      else if (counts.drafted > 0) add('email-outbox', 'ok', 'drafted-replies-await-approval', NEXT_DRAFTS);
      else if (counts.sent > 0) add('email-outbox', 'ok', 'sent-replies-observed');
      else add('email-outbox', 'ok', 'no-replies-observed');
    }
  }

  const replies: EmailRepliesState = paused ? 'paused'
    : availability !== 'ok' || (counts?.stuck ?? 0) > 0 ? 'blocked'
      : !sendOn ? 'draft-only' : 'send-enabled';
  return {
    config: 'ok', polling: paused ? 'paused' : 'enabled',
    sendReplies: sendOn ? 'enabled' : 'disabled',
    outbox: availability, counts, replies, coverage: COVERAGE, checks,
  };
}
