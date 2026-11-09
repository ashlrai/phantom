/**
 * Private Comms agent records under <runs>/comms-agent. Mode 0600.
 * Records hold draft text and Phantom Secrets handles, never raw credentials.
 */
import { appendFile, chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import { isCommsTransport, type CommsTransport, type StandingApproval } from './policy.js';
import { parseInboxDocument, type InboxMessage } from './triage.js';

export interface CommsDraft {
  id: string;
  status: 'pending';
  transport: CommsTransport;
  recipient: string;
  subject: string;
  body: string;
  messageId: string;
  createdAt: string;
}

export interface SendLogEntry {
  at: string;
  transport: CommsTransport;
  recipient: string;
  credentialHandle: string | null;
  result: 'sent';
}

export interface OwnerThreadNotice {
  at: string;
  kind: 'draft';
  draftId: string;
  transport: CommsTransport;
  recipient: string;
}

export function commsRunsRoot(override?: string): string {
  if (override && override.trim()) return override;
  return process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
}

export function commsDir(runsDir: string): string {
  return join(runsDir, 'comms-agent');
}

async function ensureDir(runsDir: string): Promise<string> {
  const dir = commsDir(runsDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Comms agent directory must be a regular directory.');
  await chmod(dir, 0o700);
  return dir;
}

async function readText(runsDir: string, name: string): Promise<string | null> {
  try { return await readFile(join(commsDir(runsDir), name), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writePrivate(runsDir: string, name: string, text: string): Promise<void> {
  const dir = await ensureDir(runsDir);
  const file = join(dir, name);
  await writeFile(file, text, { mode: 0o600 });
  await chmod(file, 0o600);
}

async function appendPrivate(runsDir: string, name: string, line: string): Promise<void> {
  const dir = await ensureDir(runsDir);
  const file = join(dir, name);
  await appendFile(file, `${line}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

export async function readInbox(runsDir: string): Promise<InboxMessage[]> {
  const text = await readText(runsDir, 'inbox.json');
  if (text === null || text.trim() === '') return [];
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; }
  catch { throw new Error('Inbox file is not valid JSON.'); }
  const messages = parseInboxDocument(parsed);
  if (!messages) throw new Error('Inbox file is not a Comms inbox document.');
  return messages;
}

export async function writeInbox(runsDir: string, messages: readonly InboxMessage[]): Promise<void> {
  await writePrivate(runsDir, 'inbox.json', `${JSON.stringify({ messages }, null, 2)}\n`);
}

export async function appendArchive(runsDir: string, message: InboxMessage): Promise<void> {
  await appendPrivate(runsDir, 'archive.jsonl', JSON.stringify(message));
}

function isDraft(value: unknown): value is CommsDraft {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  return draft.status === 'pending'
    && typeof draft.id === 'string'
    && typeof draft.transport === 'string' && isCommsTransport(draft.transport)
    && typeof draft.recipient === 'string'
    && typeof draft.subject === 'string'
    && typeof draft.body === 'string'
    && typeof draft.messageId === 'string'
    && typeof draft.createdAt === 'string'
    && scrubSecrets(JSON.stringify({ recipient: draft.recipient, subject: draft.subject, body: draft.body })) === JSON.stringify({ recipient: draft.recipient, subject: draft.subject, body: draft.body });
}

export async function appendDraft(runsDir: string, draft: CommsDraft): Promise<void> {
  if (!isDraft(draft)) throw new Error('Draft is not storable.');
  await appendPrivate(runsDir, 'drafts.jsonl', JSON.stringify(draft));
}

export async function listDrafts(runsDir: string): Promise<CommsDraft[]> {
  const text = await readText(runsDir, 'drafts.jsonl');
  if (text === null) return [];
  const drafts: CommsDraft[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isDraft(parsed)) drafts.push(parsed);
    } catch { /* skip a bad line */ }
  }
  return drafts;
}

export async function appendSendLog(runsDir: string, entry: SendLogEntry): Promise<void> {
  if (entry.result !== 'sent') throw new Error('Only completed sends are logged.');
  if (entry.credentialHandle !== null && !/^phm_[A-Za-z0-9_-]+$/.test(entry.credentialHandle)) {
    throw new Error('Send log credentials must be Phantom Secrets handles.');
  }
  await appendPrivate(runsDir, 'send-log.jsonl', JSON.stringify(entry));
}

export async function readSendLog(runsDir: string): Promise<SendLogEntry[]> {
  const text = await readText(runsDir, 'send-log.jsonl');
  if (text === null) return [];
  const entries: SendLogEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const entry = parsed as Partial<SendLogEntry>;
        if (entry.result === 'sent' && typeof entry.transport === 'string' && isCommsTransport(entry.transport) && typeof entry.recipient === 'string') {
          entries.push(entry as SendLogEntry);
        }
      }
    } catch { /* skip */ }
  }
  return entries;
}

export async function appendOwnerNotice(runsDir: string, notice: OwnerThreadNotice): Promise<void> {
  await appendPrivate(runsDir, 'owner-thread.jsonl', JSON.stringify(notice));
}

export async function readOwnerConfig(runsDir: string): Promise<{ approvals: StandingApproval[]; owners: string[] }> {
  const text = await readText(runsDir, 'standing-approvals.json');
  if (text === null || text.trim() === '') return { approvals: [], owners: [] };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { approvals: [], owners: [] };
    const record = parsed as { approvals?: unknown; owners?: unknown };
    const approvals: StandingApproval[] = [];
    if (Array.isArray(record.approvals)) {
      for (const row of record.approvals) {
        if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
        const approval = row as { transport?: unknown; recipient?: unknown };
        if (typeof approval.transport === 'string' && isCommsTransport(approval.transport)
          && typeof approval.recipient === 'string' && approval.recipient.trim() && approval.recipient.length <= 256) {
          approvals.push({ transport: approval.transport, recipient: approval.recipient.trim() });
        }
      }
    }
    const owners = Array.isArray(record.owners)
      ? record.owners.filter((owner): owner is string => typeof owner === 'string' && owner.trim().length > 0).map(owner => owner.trim())
      : [];
    return { approvals, owners };
  } catch {
    return { approvals: [], owners: [] };
  }
}
