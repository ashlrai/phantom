/**
 * Enforced Comms send policy (RQ-COMMSAGENT-1). Prompt text is not an input.
 * This module never delivers. Callers may deliver only after status is `sent`,
 * and only through an existing ChannelAdapter or a sanctioned LinkedIn connector.
 */
import { scrubSecrets } from '../util/scrub.js';
import { isPaused } from '../comms/pause.js';
import { readKillSwitch } from '../sandbox/policy.js';
import type { DeliverResult } from '../agents/channel-policy.js';

export const COMMS_TRANSPORTS = ['email', 'imessage', 'linkedin', 'bus', 'slack', 'telegram', 'handoff'] as const;
export type CommsTransport = (typeof COMMS_TRANSPORTS)[number];

export const LINKEDIN_MODES = ['official-api', 'sanctioned-connector', 'scrape', 'unspecified'] as const;
export type LinkedInMode = (typeof LINKEDIN_MODES)[number];

export type KillState = 'inactive' | 'active' | 'unknown';

export interface StandingApproval {
  transport: CommsTransport;
  recipient: string;
}

/** A requested send. `promptText` is accepted and ignored so a prompt cannot authorize delivery. */
export interface SendAttempt {
  transport: CommsTransport;
  recipient: string;
  text: string;
  subject?: string;
  credentialHandle?: string;
  linkedinMode?: LinkedInMode;
  /** Ignored by the decision. A prompt cannot authorize a send. */
  promptText?: string;
}

export interface SendPolicyContext {
  kill: KillState;
  paused: boolean;
  approvals: readonly StandingApproval[];
}

const HANDLE = /^phm_[A-Za-z0-9_-]+$/;
const MAX_TEXT = 64 * 1024;
const MAX_RECIPIENT = 256;

export function isCommsTransport(value: string): value is CommsTransport {
  return (COMMS_TRANSPORTS as readonly string[]).includes(value);
}

export function isLinkedInMode(value: string): value is LinkedInMode {
  return (LINKEDIN_MODES as readonly string[]).includes(value);
}

export function readKillState(): KillState {
  try {
    const state = readKillSwitch().state;
    if (state === 'inactive') return 'inactive';
    if (state === 'active') return 'active';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export function readPauseState(): boolean {
  try { return isPaused(); } catch { return true; }
}

function cleanRecipient(value: string): string | null {
  const recipient = value.trim();
  if (!recipient || recipient.length > MAX_RECIPIENT) return null;
  if ([...recipient].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  return recipient;
}

function secretShaped(value: string): boolean {
  return scrubSecrets(value) !== value;
}

/**
 * Decide a send. Standing approval is an exact transport + recipient pair
 * configured by the owner. Anything else is a draft, except KILL, pause,
 * secret-shaped text, a raw credential, and LinkedIn paths that are not an
 * official API or a sanctioned connector.
 */
export function decideSend(attempt: SendAttempt, context: SendPolicyContext): DeliverResult {
  if (context.kill !== 'inactive') return { status: 'refused', reason: 'KILL halts all sends.' };
  if (context.paused) return { status: 'refused', reason: 'Communications are paused.' };
  if (!isCommsTransport(attempt.transport)) return { status: 'refused', reason: 'Unknown transport.' };
  if (attempt.credentialHandle !== undefined && !HANDLE.test(attempt.credentialHandle)) {
    return { status: 'refused', reason: 'Credentials must be Phantom Secrets handles.' };
  }
  const recipient = cleanRecipient(attempt.recipient);
  if (!recipient) return { status: 'refused', reason: 'Recipient is missing.' };
  if (attempt.text.length > MAX_TEXT || secretShaped(attempt.text) || secretShaped(recipient) || (attempt.subject !== undefined && secretShaped(attempt.subject))) {
    return { status: 'refused', reason: 'Message text is not sendable.' };
  }
  if (attempt.transport === 'linkedin') {
    const mode = attempt.linkedinMode ?? 'unspecified';
    if (!isLinkedInMode(mode)) return { status: 'refused', reason: 'LinkedIn sends only through an official API or a sanctioned connector.' };
    switch (mode) {
      case 'official-api':
      case 'sanctioned-connector':
        break;
      case 'scrape':
      case 'unspecified':
        return { status: 'refused', reason: 'LinkedIn sends only through an official API or a sanctioned connector.' };
      default: {
        const unexpected: never = mode;
        return { status: 'refused', reason: `LinkedIn mode ${String(unexpected)} is not sendable.` };
      }
    }
  }
  const approved = context.approvals.some(approval =>
    approval.transport === attempt.transport && approval.recipient === recipient);
  if (!approved) {
    return { status: 'drafted', reason: 'No owner standing approval for this recipient. Novel recipients need the owner.' };
  }
  return { status: 'sent', reason: 'Owner standing approval covers this recipient.' };
}
