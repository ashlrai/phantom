/**
 * Orders from Telegram, email, and the phone go through the Mac helper.
 * MASON-INBOX.md is mode 444, so this process must not write that file.
 * The helper path is absolute. Arguments are an array. The message is stdin.
 */
import { spawn, type SpawnOptions } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { InboxAppendResult } from './mason-inbox.js';
import { scrubPrivateText, scrubSecrets } from '../util/scrub.js';

type AppendChannel = 'email' | 'telegram' | 'mobile' | 'desktop' | 'page' | 'cli';

export const SAVE_FAILED_REPLY = 'save failed, retry';
const APPEND_TIMEOUT_MS = 15_000;

export type InboxAppendSrc = 'telegram' | 'email' | 'phone';

export interface MasonInboxChild {
  stdin: { write(chunk: string): void; end(): void };
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): void };
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: (code: number | null) => void): void;
  kill?: () => void;
}

export type MasonInboxSpawn = (file: string, args: readonly string[]) => MasonInboxChild;

export function masonInboxAppendBinary(home = homedir()): string {
  return join(home, '.ashlr-runs', 'bin', 'mason-inbox-append');
}

/** Identity comes from the verified channel, never from the message text. */
export function channelAppendIdentity(channel: AppendChannel, verifiedSenderId: string): { src: InboxAppendSrc; id: string } | null {
  switch (channel) {
    case 'telegram': {
      const match = /^telegram:([1-9]\d{0,18})$/.exec(verifiedSenderId);
      return match ? { src: 'telegram', id: match[1]! } : null;
    }
    case 'email': {
      const match = /^email:([^\s@]+@[^\s@]+)$/.exec(verifiedSenderId);
      return match ? { src: 'email', id: match[1]! } : null;
    }
    case 'mobile':
      return safeId(verifiedSenderId) ? { src: 'phone', id: verifiedSenderId } : null;
    case 'desktop':
    case 'page':
    case 'cli':
      return null;
    default: {
      const neverChannel: never = channel;
      return neverChannel;
    }
  }
}

function safeId(id: string): boolean {
  if (id.length === 0 || id.length > 128 || scrubSecrets(id) !== id) return false;
  for (const char of id) if (char.charCodeAt(0) < 32) return false;
  return true;
}

function warn(detail: string): void {
  const text = scrubPrivateText(detail)
    .replace(/\/(?:Users|home|private)\/\S+/g, '[path]')
    .replace(/\s+/g, ' ').trim().slice(0, 200);
  console.warn(text ? `mason-inbox-append: ${text}` : 'mason-inbox-append: save failed');
}

export const MASON_INBOX_SPAWN_OPTIONS: SpawnOptions = { shell: false, stdio: ['pipe', 'ignore', 'pipe'] };

export function defaultMasonInboxSpawn(file: string, args: readonly string[]): MasonInboxChild {
  return spawn(file, [...args], MASON_INBOX_SPAWN_OPTIONS) as MasonInboxChild;
}

let spawnForTests: MasonInboxSpawn | null = null;
let receiptRootForTests: string | undefined;

/** Test harness only. Production leaves this unset and spawns the real helper. */
export function setMasonInboxAppendSpawnForTests(spawnImpl: MasonInboxSpawn | null): void {
  spawnForTests = spawnImpl;
}

/** The runs directory the current order was aimed at. Read by the hermetic test double only. */
export function inboxReceiptRootForTests(): string | undefined {
  return receiptRootForTests;
}

function runChild(spawnImpl: MasonInboxSpawn, file: string, args: readonly string[], message: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';
    let child: MasonInboxChild;
    const finish = (error: Error | null, code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ code, stderr });
    };
    try {
      child = spawnImpl(file, args);
    } catch (error) {
      finish(error instanceof Error ? error : new Error('spawn failed'), null);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill?.(); } catch { /* the close or error event still settles this */ }
      finish(new Error('mason-inbox-append timed out'), null);
    }, APPEND_TIMEOUT_MS);
    child.stderr.on('data', (chunk) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (stderr.length > 2_000) stderr = stderr.slice(0, 2_000);
    });
    child.on('error', (error) => finish(error, null));
    child.on('close', (code) => finish(null, code));
    try {
      child.stdin.write(message);
      child.stdin.end();
    } catch (error) {
      finish(error instanceof Error ? error : new Error('stdin failed'), null);
    }
  });
}

/**
 * Spawn the helper. A missing binary, a spawn error, or a nonzero exit is a
 * failure. This function never writes MASON-INBOX.md.
 */
export async function appendMasonInboxOrder(input: {
  src: InboxAppendSrc;
  id: string;
  message: string;
  home?: string;
  /** Hermetic tests record the receipt here. The helper binary never receives it. */
  receiptRoot?: string;
  spawn?: MasonInboxSpawn;
}): Promise<InboxAppendResult> {
  receiptRootForTests = input.receiptRoot;
  if ((input.src !== 'telegram' && input.src !== 'email' && input.src !== 'phone') || !safeId(input.id)) {
    warn('refused an unverified sender');
    return { ok: false, reason: 'write-failed' };
  }
  const message = input.message.replace(/\r\n/g, '\n');
  if (!message.trim()) return { ok: false, reason: 'empty' };
  const file = masonInboxAppendBinary(input.home);
  try {
    const outcome = await runChild(input.spawn ?? spawnForTests ?? defaultMasonInboxSpawn, file, ['--src', input.src, '--id', input.id], message);
    if (outcome.code === 0) return { ok: true, at: new Date().toISOString(), bytes: Buffer.byteLength(message, 'utf8') };
    warn(outcome.stderr || `exited ${outcome.code ?? 'null'}`);
    return { ok: false, reason: 'write-failed' };
  } catch (error) {
    warn(error instanceof Error ? error.message : 'spawn failed');
    return { ok: false, reason: 'write-failed' };
  }
}
