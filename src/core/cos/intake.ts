/** Durable chief-of-staff handoff. No inference, credentials or network sends. */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ChannelEnvelope, ReceiverChannel } from '../fleet/channel-envelope.js';
import { readNeedsMason, resolveNeedsMason } from '../fleet/needs-mason-resolve.js';
import { QueueStore } from '../queue/store.js';
import { scrubSecrets } from '../util/scrub.js';

export interface CosOrigin { channel: ReceiverChannel; senderId: string; threadId?: string }
export interface CosRoute { kind: 'cos-intake'; origin: CosOrigin }
const COS_JOB_ID_RE = /^cos-[a-f0-9]{32}$/;
const COS_DIGEST_RE = /^[a-f0-9]{64}$/;

export const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export const isCosJobId = (value: unknown): value is string =>
  typeof value === 'string' && COS_JOB_ID_RE.test(value);
export const isCosDigest = (value: unknown): value is string =>
  typeof value === 'string' && COS_DIGEST_RE.test(value);
export const resolveCosRunsDir = (runsDir?: string): string =>
  runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
export const cosDir = (runsDir?: string): string => join(resolveCosRunsDir(runsDir), 'cos');
export const cosQueueStore = (runsDir?: string): QueueStore => new QueueStore(join(resolveCosRunsDir(runsDir), 'queue'), 250);
const cosApprovalTexts = (id: string): readonly [string, string] => [
  `Approve chief-of-staff reply ${id}; inspect with phm fleet cos status ${id} --json`,
  `Approve chief-of-staff reply ${id}; inspect with phm cos status ${id} --json`,
];
export const cosJobId = (dedupeKey: string): string => `cos-${dedupeKey.slice(0, 32)}`;

export function parseCosIntakeRoute(acceptance: string): CosRoute | null {
  try {
    const route: unknown = JSON.parse(acceptance);
    if (!isPlainRecord(route) || route['kind'] !== 'cos-intake') return null;
    const origin: unknown = route['origin'];
    if (!isPlainRecord(origin) || typeof origin['channel'] !== 'string' || typeof origin['senderId'] !== 'string') {
      return null;
    }
    if (origin['threadId'] !== undefined && typeof origin['threadId'] !== 'string') return null;
    return route as unknown as CosRoute;
  } catch {
    return null;
  }
}

const cosDraftDigest = (id: string, origin: CosOrigin, text: string): string =>
  createHash('sha256').update(JSON.stringify([id, origin, text])).digest('hex');

const cosDraftPath = (id: string, runsDir?: string): string => join(cosDir(runsDir), `${id}.json`);

async function readOptionalJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Receiver-validated envelopes only. A duplicate receipt retries a failed queue write. */
export async function queueCosEnvelope(envelope: ChannelEnvelope, runsDir?: string): Promise<string> {
  if (!isCosDigest(envelope.dedupeKey) || !envelope.body.trim() ||
      envelope.body.length > 16_000 || scrubSecrets(envelope.body) !== envelope.body ||
      scrubSecrets(envelope.verifiedSenderId) !== envelope.verifiedSenderId ||
      (envelope.threadId !== undefined && scrubSecrets(envelope.threadId) !== envelope.threadId)) {
    throw new Error('Invalid intake envelope');
  }
  const id = cosJobId(envelope.dedupeKey);
  const queue = cosQueueStore(runsDir);
  if ((await queue.read()).jobs.some(job => job.id === id)) return id;
  const route: CosRoute = { kind: 'cos-intake', origin: { channel: envelope.channel, senderId: envelope.verifiedSenderId,
    ...(envelope.threadId ? { threadId: envelope.threadId } : {}) } };
  try {
    await queue.add({ id, status: 'READY', priority: 'P1', pool: 'work', tier: 'work',
      repo: 'ashlrai/phantom', scope: envelope.body, acceptance: JSON.stringify(route), deps: [], claims: [] });
  } catch (error) {
    // Another receiver may have committed the same receipt concurrently.
    if (!(await queue.read()).jobs.some(job => job.id === id)) throw error;
  }
  return id;
}

function checkId(id: string): void {
  if (!isCosJobId(id)) throw new Error('Invalid chief-of-staff job id');
}
export async function cosStatus(id: string, runsDir?: string) {
  checkId(id);
  const job = (await cosQueueStore(runsDir).read()).jobs.find(job => job.id === id);
  if (!job) throw new Error('Unknown chief-of-staff job');
  const draft = await readOptionalJson<CosDraft>(cosDraftPath(id, runsDir));
  const delivery = (await readOptionalJson<{ state?: CosDelivery }>(cosDeliveryPath(id, runsDir)))?.state;
  return { job, draft, delivery, needsYou: draft !== undefined && delivery !== 'sent' && delivery !== 'declined' };
}

export interface CosDraft { id: string; origin: CosOrigin; text: string; digest: string }
/** States of the exclusive `<id>.delivery.json` claim. `declined` is terminal: no transport ever runs. */
export type CosDelivery = 'sending' | 'sent' | 'uncertain' | 'declined';
/** Completion is a draft. External transports must obtain explicit approval. */
export async function draftCosResult(id: string, text: string, runsDir?: string): Promise<CosDraft> {
  if (!text.trim() || text.length > 16_000 || scrubSecrets(text) !== text) throw new Error('Invalid result text');
  const { job } = await cosStatus(id, runsDir);
  const route = parseCosIntakeRoute(job.acceptance);
  if (!route) throw new Error('Job has no intake origin');
  const draft: CosDraft = { id, origin: route.origin, text, digest: cosDraftDigest(id, route.origin, text) };
  await mkdir(cosDir(runsDir), { recursive: true, mode: 0o700 });
  try { await writeFile(cosDraftPath(id, runsDir), JSON.stringify(draft), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = (await cosStatus(id, runsDir)).draft;
    if (existing?.digest !== draft.digest) throw new Error('Result already drafted; retain the original approval binding');
  }
  await appendFile(join(resolveCosRunsDir(runsDir), 'NEEDS-MASON.md'),
    `- [ ] ${cosApprovalTexts(id)[0]}\n`, { mode: 0o600 });
  return draft;
}

/**
 * The stored draft, only when `digest` is the one displayed for it and the
 * draft still hashes to that digest. Approval and decline share this binding.
 */
export async function boundCosDraft(id: string, digest: string, runsDir?: string): Promise<CosDraft | undefined> {
  const { draft } = await cosStatus(id, runsDir);
  if (!draft || !isCosDigest(digest) || draft.digest !== digest
    || draft.digest !== cosDraftDigest(draft.id, draft.origin, draft.text)) return undefined;
  return draft;
}

export const cosDeliveryPath = (id: string, runsDir?: string): string => join(cosDir(runsDir), `${id}.delivery.json`);

export function writeCosDeliveryState(path: string, state: CosDelivery, opts?: { exclusive?: boolean }): Promise<void> {
  return writeFile(path, JSON.stringify({ state }), opts?.exclusive ? { flag: 'wx', mode: 0o600 } : { mode: 0o600 });
}

/** Best effort: close the needs-you item. Callers keep their recorded delivery state if this fails. */
export function closeCosNeedsYou(id: string, runsDir?: string, source: 'desktop' | 'cli' = 'desktop'): void {
  try {
    const resolvedRunsDir = resolveCosRunsDir(runsDir);
    const item = readNeedsMason({ runsDir: resolvedRunsDir }).items.find(item => cosApprovalTexts(id).some(text => item.text === text));
    if (item) resolveNeedsMason({ itemId: item.id }, { runsDir: resolvedRunsDir, source });
  } catch { /* needs-you cleanup must never change a delivery state */ }
}

/** Trusted UI approval must bind the exact displayed draft digest, never message text. */
export async function deliverCosResult(id: string, approvedDigest: string,
  send: (draft: CosDraft) => Promise<void>, runsDir?: string): Promise<void> {
  const draft = await boundCosDraft(id, approvedDigest, runsDir);
  if (!draft) throw new Error('Explicit approval of the current draft is required');
  const path = cosDeliveryPath(id, runsDir);
  // Exclusive claim prevents two approved callers from sending twice, and a
  // decline from racing a send. A crash or transport failure requires
  // reconciliation, never an automatic resend.
  await writeCosDeliveryState(path, 'sending', { exclusive: true });
  try {
    await send(draft);
    await writeCosDeliveryState(path, 'sent');
  } catch (error) {
    await writeCosDeliveryState(path, 'uncertain');
    throw error;
  }
  closeCosNeedsYou(id, runsDir);
}
