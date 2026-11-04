/** Durable chief-of-staff handoff. No inference, credentials or network sends. */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ChannelEnvelope, InboundChannel } from '../fleet/channel-envelope.js';
import { QueueStore } from '../queue/store.js';
import { scrubSecrets } from '../util/scrub.js';

export interface CosOrigin { channel: InboundChannel; senderId: string; threadId?: string }
export interface CosRoute { kind: 'cos-intake'; origin: CosOrigin }
const root = (runsDir?: string): string => runsDir ?? join(homedir(), '.ashlr-runs');
const store = (runsDir?: string): QueueStore => new QueueStore(join(root(runsDir), 'queue'), 250);
export const cosJobId = (dedupeKey: string): string => `cos-${dedupeKey.slice(0, 32)}`;

/** Receiver-validated envelopes only. A duplicate receipt retries a failed queue write. */
export async function queueCosEnvelope(envelope: ChannelEnvelope, runsDir?: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(envelope.dedupeKey) || !envelope.body.trim() ||
      envelope.body.length > 16_000 || scrubSecrets(envelope.body) !== envelope.body ||
      scrubSecrets(envelope.verifiedSenderId) !== envelope.verifiedSenderId ||
      (envelope.threadId !== undefined && scrubSecrets(envelope.threadId) !== envelope.threadId)) {
    throw new Error('Invalid intake envelope');
  }
  const id = cosJobId(envelope.dedupeKey);
  const queue = store(runsDir);
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
  if (!/^cos-[a-f0-9]{32}$/.test(id)) throw new Error('Invalid chief-of-staff job id');
}
export async function cosStatus(id: string, runsDir?: string) {
  checkId(id);
  const job = (await store(runsDir).read()).jobs.find(job => job.id === id);
  if (!job) throw new Error('Unknown chief-of-staff job');
  let draft: CosDraft | undefined;
  try { draft = JSON.parse(await readFile(join(root(runsDir), 'cos', `${id}.json`), 'utf8')) as CosDraft; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let delivery: 'sending' | 'sent' | 'uncertain' | undefined;
  try { delivery = JSON.parse(await readFile(join(root(runsDir), 'cos', `${id}.delivery.json`), 'utf8')).state; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { job, draft, delivery, needsYou: draft !== undefined && delivery !== 'sent' };
}

export interface CosDraft { id: string; origin: CosOrigin; text: string; digest: string }
/** Completion is a draft. External transports must obtain explicit approval. */
export async function draftCosResult(id: string, text: string, runsDir?: string): Promise<CosDraft> {
  if (!text.trim() || text.length > 16_000 || scrubSecrets(text) !== text) throw new Error('Invalid result text');
  const { job } = await cosStatus(id, runsDir);
  const route = JSON.parse(job.acceptance) as CosRoute;
  if (route.kind !== 'cos-intake') throw new Error('Job has no intake origin');
  const draft: CosDraft = { id, origin: route.origin, text,
    digest: createHash('sha256').update(JSON.stringify([id, route.origin, text])).digest('hex') };
  const directory = join(root(runsDir), 'cos');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { await writeFile(join(directory, `${id}.json`), JSON.stringify(draft), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = (await cosStatus(id, runsDir)).draft;
    if (existing?.digest !== draft.digest) throw new Error('Result already drafted; retain the original approval binding');
  }
  await appendFile(join(root(runsDir), 'NEEDS-MASON.md'),
    `- [ ] Approve chief-of-staff reply ${id}; inspect with phm cos status ${id} --json\n`, { mode: 0o600 });
  return draft;
}

/** Trusted UI approval must bind the exact displayed draft digest, never message text. */
export async function deliverCosResult(id: string, approvedDigest: string,
  send: (draft: CosDraft) => Promise<void>, runsDir?: string): Promise<void> {
  const { draft } = await cosStatus(id, runsDir);
  if (!draft || draft.digest !== approvedDigest || draft.digest !== createHash('sha256')
    .update(JSON.stringify([draft.id, draft.origin, draft.text])).digest('hex')) {
    throw new Error('Explicit approval of the current draft is required');
  }
  const path = join(root(runsDir), 'cos', `${id}.delivery.json`);
  // Exclusive claim prevents two approved callers from sending twice. A crash
  // or transport failure requires reconciliation, never an automatic resend.
  await writeFile(path, JSON.stringify({ state: 'sending' }), { flag: 'wx', mode: 0o600 });
  try {
    await send(draft);
    await writeFile(path, JSON.stringify({ state: 'sent' }), { mode: 0o600 });
  } catch (error) {
    await writeFile(path, JSON.stringify({ state: 'uncertain' }), { mode: 0o600 });
    throw error;
  }
}
