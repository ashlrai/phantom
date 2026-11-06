/**
 * Drafts-then-approve for outbound mail (RQ-COS-DRAFTS-1).
 *
 * Anything addressed to someone other than the operator's own verified
 * channel is written here as a draft first and surfaces as a needs-you item
 * with Approve / Reject. Nothing in this module sends.
 *
 *   ~/.ashlr-runs/drafts/drafts.jsonl   one record per line, mode 0600. Every
 *     state change appends a full snapshot; the last line for an id wins.
 *     Records carry metadata (id, status, to, subject, digest, source) plus the
 *     body. They never carry credentials: text that looks like a secret is
 *     refused by the same shape gate connector profiles use.
 *
 * Status moves pending -> approved | rejected and stops there. `approved` only
 * records the owner's decision. Turning an approved draft into a send is a
 * separate, security-reviewed step that is not part of this module, so with
 * this change alone approval can never cause an email to leave the machine.
 */
import { createHash } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertMetadata } from '../connectors/profile.js';
import {
  isNeedsYouItem,
  NEEDS_YOU_DETAIL_MAX,
  NEEDS_YOU_TITLE_MAX,
  type NeedsYouItem,
} from '../verse/workbench-types.js';

export class DraftError extends Error {}
const fail = (message: string): never => { throw new DraftError(message); };

export const DRAFT_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export interface Draft {
  id: string;
  status: DraftStatus;
  channel: 'email';
  to: string;
  subject: string;
  body: string;
  /** Where it came from, e.g. the outbox file name. Never a path outside the outbox. */
  source: string;
  /** sha256 over to, subject and body: what an approval is bound to. */
  digest: string;
  createdAt: string;
  decidedAt?: string;
}

export type DraftInput = Pick<Draft, 'to' | 'subject' | 'body' | 'source'>;

const MAX_BODY = 64 * 1024;
const MAX_FIELD = 300;
const ID = /^d-[0-9a-f]{16}$/;
const MIN_DIGEST_PREFIX = 8;
const STALE_MS = 60_000;

export const draftsDir = (runsDir: string = join(homedir(), '.ashlr-runs')): string => join(runsDir, 'drafts');
const storePath = (runsDir?: string): string => join(draftsDir(runsDir), 'drafts.jsonl');

export const draftDigest = (input: Pick<Draft, 'to' | 'subject' | 'body'>): string =>
  createHash('sha256').update(`${input.to}\n${input.subject}\n${input.body}`).digest('hex');

function isDraft(value: unknown): value is Draft {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return typeof d['id'] === 'string' && ID.test(d['id'])
    && (DRAFT_STATUSES as readonly unknown[]).includes(d['status'])
    && d['channel'] === 'email'
    && typeof d['to'] === 'string' && typeof d['subject'] === 'string' && typeof d['body'] === 'string'
    && typeof d['source'] === 'string' && typeof d['digest'] === 'string'
    && typeof d['createdAt'] === 'string' && !Number.isNaN(Date.parse(d['createdAt']))
    && (d['decidedAt'] === undefined || typeof d['decidedAt'] === 'string')
    && draftDigest(d as unknown as Draft) === d['digest'];
}

/** Current record per id, creation order. Malformed, tampered or secret-shaped lines are dropped. */
async function readAll(runsDir?: string): Promise<Draft[]> {
  let raw: string;
  try { raw = await readFile(storePath(runsDir), 'utf8'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const byId = new Map<string, Draft>();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      // The gate covers the text fields only: the digest is hex by design.
      if (isDraft(parsed)) { assertMetadata(textFields(parsed)); byId.set(parsed.id, parsed); }
    } catch { /* skip the bad line, keep the rest */ }
  }
  return [...byId.values()];
}

async function append(draft: Draft, runsDir?: string): Promise<void> {
  const dir = draftsDir(runsDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) fail('Drafts directory must be a regular directory.');
  const file = storePath(runsDir);
  await appendFile(file, `${JSON.stringify(draft)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

const textFields = (d: DraftInput): string => JSON.stringify({ to: d.to, subject: d.subject, body: d.body, source: d.source });

function clean(input: DraftInput): DraftInput {
  const to = input.to.trim().toLowerCase();
  const subject = input.subject.replace(/[\r\n]+/g, ' ').trim();
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+$/.test(to) || to.length > MAX_FIELD) fail('Draft needs exactly one recipient address.');
  if (subject.length > MAX_FIELD || input.source.length > MAX_FIELD) fail('Draft subject or source is too long.');
  if (input.body.length > MAX_BODY) fail('Draft body is too large.');
  try { assertMetadata(textFields({ to, subject, body: input.body, source: input.source })); }
  catch { fail('Secret-shaped draft refused. Credentials belong in Phantom Secrets, referred to by binding name only.'); }
  return { to, subject, body: input.body, source: input.source };
}

/**
 * Write a pending draft. Idempotent: the id comes from the content and source,
 * so a retried pass returns the existing record instead of a second draft.
 */
export async function createDraft(input: DraftInput, runsDir?: string, now: () => Date = () => new Date()): Promise<Draft> {
  const c = clean(input);
  const digest = draftDigest(c);
  const id = `d-${createHash('sha256').update(`${c.source}\n${digest}`).digest('hex').slice(0, 16)}`;
  const existing = (await readAll(runsDir)).find((d) => d.id === id);
  if (existing) return existing;
  const draft: Draft = { id, status: 'pending', channel: 'email', ...c, digest, createdAt: now().toISOString() };
  await append(draft, runsDir);
  return draft;
}

export async function listDrafts(opts: { runsDir?: string; status?: DraftStatus } = {}): Promise<Draft[]> {
  const all = await readAll(opts.runsDir);
  return opts.status ? all.filter((d) => d.status === opts.status) : all;
}

export async function getDraft(id: string, runsDir?: string): Promise<Draft | null> {
  return (await readAll(runsDir)).find((d) => d.id === id) ?? null;
}

async function decide(
  id: string, status: 'approved' | 'rejected', runsDir: string | undefined, digest: string | undefined, now: () => Date,
): Promise<Draft> {
  const draft = await getDraft(id, runsDir);
  if (!draft) return fail('No such draft.');
  if (draft.status !== 'pending') return fail(`Draft is already ${draft.status}.`);
  if (digest !== undefined) {
    const given = digest.toLowerCase();
    if (given.length < MIN_DIGEST_PREFIX || !draft.digest.startsWith(given)) {
      return fail('Digest does not match the draft. Run phm drafts show to read the current text.');
    }
  }
  const next: Draft = { ...draft, status, decidedAt: now().toISOString() };
  await append(next, runsDir);
  return next;
}

/** Record the owner's approval. This does not send; see the module header. Optional digest prefix binds it to the text shown. */
export function approveDraft(id: string, opts: { runsDir?: string; digest?: string; now?: () => Date } = {}): Promise<Draft> {
  return decide(id, 'approved', opts.runsDir, opts.digest, opts.now ?? (() => new Date()));
}

export function rejectDraft(id: string, opts: { runsDir?: string; now?: () => Date } = {}): Promise<Draft> {
  return decide(id, 'rejected', opts.runsDir, undefined, opts.now ?? (() => new Date()));
}

// ---------------------------------------------------------------------------
// Needs-you producer (same cache contract as automations/needs-you.ts)
// ---------------------------------------------------------------------------

let cache: NeedsYouItem[] = [];
let cachedAt = 0;
let refreshing: Promise<void> | null = null;

const cap = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * One pending draft as an item with Approve / Reject. Actions carry no route:
 * the drawer opens the target and the decision is taken with
 * `phm drafts approve|reject <id>`, named in the detail line.
 */
export function draftNeedsYouItem(draft: Draft): NeedsYouItem {
  return {
    id: `approvals:approval:draft-${draft.id}`,
    source: 'approvals',
    kind: 'approval',
    severity: 'info',
    title: cap(`Approve outbound email to ${draft.to}`, NEEDS_YOU_TITLE_MAX),
    detail: cap(`${draft.subject || '(no subject)'} · digest ${draft.digest.slice(0, 12)} · phm drafts show ${draft.id}`, NEEDS_YOU_DETAIL_MAX),
    since: draft.createdAt,
    expiresAt: null,
    subject: { repo: null, pr: null, seatId: null, sessionId: null, engine: null },
    target: { kind: 'section', section: 'command', anchor: draft.id },
    actions: [
      {
        kind: 'approve',
        label: 'Approve',
        request: null,
        confirm: {
          title: 'Approve this draft?',
          body: `Records your approval of the email to ${draft.to}. Approval alone does not send it.`,
          confirmLabel: 'Approve',
        },
        destructive: false,
      },
      { kind: 'reject', label: 'Reject', request: null, confirm: null, destructive: true },
    ],
  };
}

export async function refreshDraftsNeedsYou(runsDir?: string): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      cache = (await listDrafts({ runsDir, status: 'pending' })).map(draftNeedsYouItem).filter(isNeedsYouItem);
      cachedAt = Date.now();
    } catch {
      // Keep the last good answer; the next poll retries.
    }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/** Pure, from cache (refreshed off-stack when older than a minute). */
export function needsYouItems(): NeedsYouItem[] {
  if (Date.now() - cachedAt > STALE_MS && !refreshing) void refreshDraftsNeedsYou();
  return [...cache];
}

export function resetDraftsNeedsYouForTest(): void {
  cache = [];
  cachedAt = 0;
  refreshing = null;
}
