/**
 * Private Comms records. The inbox, drafts and send log live under the runs
 * directory. Standing approvals do not: they are read only from the owner's
 * fixed file, never from `--dir` or ASHLR_RUNS_DIR.
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realHome } from '../real-home.js';
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

export interface InboxRead {
  messages: InboxMessage[];
  rows: Record<string, unknown>[];
}

export type ApprovalsReason = 'missing' | 'ok' | 'malformed' | 'symlink' | 'mode' | 'owner' | 'not-file';

export interface OwnerApprovals {
  approvals: StandingApproval[];
  owners: string[];
  accepted: boolean;
  reason: ApprovalsReason;
}

export interface FileTrustStat {
  isFile: boolean;
  isSymbolicLink: boolean;
  uid: number;
  mode: number;
  nlink: number;
}

const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;

export function commsRunsRoot(override?: string): string {
  if (override && override.trim()) return override;
  return process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
}

export function commsDir(runsDir: string): string {
  return join(runsDir, 'comms-agent');
}

/** Owner-only. Callers cannot point this at another directory, and `$HOME` is ignored. */
export function ownerApprovalsPath(home?: string): string {
  const root = home ?? realHome();
  if (!root) throw new Error('Account home is unavailable.');
  return join(root, '.ashlr', 'comms-agent', 'standing-approvals.json');
}

/** A private regular file owned by this user. Mode 0600 is required where the platform records it. */
export function privateOwnerFile(stat: FileTrustStat, uid: number | null = typeof process.getuid === 'function' ? process.getuid() : null): ApprovalsReason | 'ok' {
  if (stat.isSymbolicLink) return 'symlink';
  if (!stat.isFile || stat.nlink !== 1) return 'not-file';
  if (uid !== null && stat.uid !== uid) return 'owner';
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) return 'mode';
  return 'ok';
}

async function ensureDir(runsDir: string): Promise<string> {
  const dir = commsDir(runsDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Comms agent directory must be a regular directory.');
  await chmod(dir, 0o700);
  return dir;
}

async function assertNoSymlink(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Refusing a symlink.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

async function readRegular(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Comms record must be a regular file.');
    return await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle.close();
  }
}

async function readPrivate(runsDir: string, name: string): Promise<string | null> {
  const file = join(commsDir(runsDir), name);
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error('Refusing a symlink.');
    if (!info.isFile()) throw new Error('Comms record must be a regular file.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return readRegular(file);
}

async function appendPrivate(runsDir: string, name: string, line: string): Promise<void> {
  const dir = await ensureDir(runsDir);
  const file = join(dir, name);
  await assertNoSymlink(file);
  const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Comms record must be a regular file.');
    await handle.appendFile(`${line}\n`);
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

export async function readInbox(runsDir: string): Promise<InboxRead> {
  const text = await readPrivate(runsDir, 'inbox.json');
  if (text === null || text.trim() === '') return { messages: [], rows: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; }
  catch { throw new Error('Inbox file is not valid JSON.'); }
  const inbox = parseInboxDocument(parsed);
  if (!inbox) throw new Error('Inbox file is not a Comms inbox document.');
  return inbox;
}

export async function writeInbox(runsDir: string, messages: readonly InboxMessage[], rows: readonly Record<string, unknown>[] = []): Promise<void> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (typeof row.id === 'string') byId.set(row.id, row);
  }
  const kept = messages.map(message => byId.get(message.id) ?? { ...message });
  const dir = await ensureDir(runsDir);
  const target = join(dir, 'inbox.json');
  await assertNoSymlink(target);
  const temporary = join(dir, `.inbox.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ messages: kept }, null, 2)}\n`);
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await assertNoSymlink(target);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function appendArchive(runsDir: string, message: Record<string, unknown>): Promise<void> {
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
  const text = await readPrivate(runsDir, 'drafts.jsonl');
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
  const text = await readPrivate(runsDir, 'send-log.jsonl');
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

function parseApprovals(text: string): OwnerApprovals {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { approvals: [], owners: [], accepted: false, reason: 'malformed' };
    }
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
    return { approvals, owners, accepted: true, reason: 'ok' };
  } catch {
    return { approvals: [], owners: [], accepted: false, reason: 'malformed' };
  }
}

const emptyApprovals = (reason: ApprovalsReason, accepted: boolean): OwnerApprovals =>
  ({ approvals: [], owners: [], accepted, reason });

/**
 * Open `path` with O_NOFOLLOW and judge that handle. A separate lstat is not
 * the trust decision: the inode that was opened is.
 */
export async function readApprovalsFile(path: string): Promise<OwnerApprovals> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return emptyApprovals('missing', true);
    if (code === 'ELOOP') return emptyApprovals('symlink', false);
    throw error;
  }
  try {
    const info = await handle.stat();
    const trust = privateOwnerFile({
      isFile: info.isFile(),
      isSymbolicLink: info.isSymbolicLink(),
      uid: info.uid,
      mode: info.mode,
      nlink: info.nlink,
    });
    if (trust !== 'ok') return emptyApprovals(trust, false);
    const text = await handle.readFile({ encoding: 'utf8' });
    if (!text.trim()) return emptyApprovals('missing', true);
    return parseApprovals(text);
  } finally {
    await handle.close();
  }
}

/** Read the fixed owner file. A missing file grants nothing. An unsafe file is refused. */
export async function readOwnerApprovals(): Promise<OwnerApprovals> {
  return readApprovalsFile(ownerApprovalsPath());
}
