import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cosJobId, cosStatus, deliverCosResult, draftCosResult } from '../src/core/cos/intake.js';
import { createChannelReceiver } from '../src/core/fleet/channel-envelope.js';
import { QueueStore } from '../src/core/queue/store.js';
import { deliverTelegramCosResult, recordTelegramToInbox } from '../src/core/comms/telegram-inbox-bridge.js';
import { deliverEmailCosResult } from '../src/core/comms/email-drop-bridge.js';
import type { AshlrConfig } from '../src/core/types.js';
import { cmdCos } from '../src/cli/cos.js';
import { cmdJobQueue } from '../src/cli/job-queue.js';
import { listNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';

let runsDir: string;
beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'cos-intake-')); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(runsDir, { recursive: true, force: true }); });
const message = { channel: 'telegram' as const, verifiedSenderId: 'telegram:123', body: 'Prepare the weekly project brief', threadId: '55' };
async function accept(input = message) {
  const result = await createChannelReceiver({ runsDir, allowedSenderIds: new Set([input.verifiedSenderId]), publish: null })(input);
  if (!result.ok) throw new Error(result.reason);
  return cosJobId(result.ack.dedupeKey);
}

describe('chief-of-staff intake', () => {
  it('supports JSON ask, status and worker completion through the CLI handlers', async () => {
    vi.stubEnv('HOME', runsDir);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdCos(['ask', 'Prepare a project brief', '--channel', 'cli', '--json'])).toBe(0);
    const response = JSON.parse(output.mock.calls.at(-1)![0] as string);
    expect(response.status).toBe('queued');
    expect(await cmdCos(['status', response.id, '--json'])).toBe(0);
    expect(JSON.parse(output.mock.calls.at(-1)![0] as string).job.status).toBe('READY');
    expect(await cmdJobQueue(['claim', response.id, '--owner', 'test-worker', '--json'])).toBe(0);
    expect(await cmdJobQueue(['done', response.id, '--owner', 'test-worker', '--result', 'Brief ready.', '--json'])).toBe(0);
    expect(await cmdCos(['status', response.id, '--json'])).toBe(0);
    const status = JSON.parse(output.mock.calls.at(-1)![0] as string);
    expect(status.job.status).toBe('DONE');
    expect(status.draft.text).toBe('Brief ready.');
    expect(status.needsYou).toBe(true);
  });
  it('queues before the same-channel acknowledgement and retains the originating thread', async () => {
    const config = { comms: { telegram: { chatId: '123' } } } as AshlrConfig;
    const start = performance.now();
    let observedJobs: Awaited<ReturnType<QueueStore['read']>>['jobs'] = [];
    let ackElapsed = Infinity;
    const send = vi.fn(async (_text: string, opts?: { replyToMessageId?: number }) => {
      void opts;
      observedJobs = (await new QueueStore(join(runsDir, 'queue')).read()).jobs;
      ackElapsed = performance.now() - start;
      return { ok: true, messageId: 901 };
    });
    const result = await recordTelegramToInbox({ kind: 'text', updateId: 1, privateChat: true, senderUserId: 123, messageId: 55 }, message.body, config, { runsDir, send });
    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![1]?.replyToMessageId).toBe(55);
    expect(observedJobs).toHaveLength(1);
    expect(JSON.parse(observedJobs[0]!.acceptance).origin).toEqual({ channel: 'telegram', senderId: 'telegram:123', threadId: '55' });
    expect(ackElapsed).toBeLessThan(5000);
  });

  it('reuses the durable job across receiver restarts and duplicate messages', async () => {
    const id = await accept();
    expect(await accept({ ...message, threadId: '56' })).toBe(id);
    expect((await new QueueStore(join(runsDir, 'queue')).read()).jobs).toHaveLength(1);
    expect(JSON.parse((await cosStatus(id, runsDir)).job.acceptance).origin.threadId).toBe('55');
  });

  it('lets a desktop custom sink opt into background intake without changing its write contract', async () => {
    const write = vi.fn(async () => ({ ok: true as const }));
    const receive = createChannelReceiver({ runsDir, allowedSenderIds: new Set(['desktop-operator']),
      write, publish: null, backgroundQueue: true });
    const result = await receive({ channel: 'desktop', verifiedSenderId: 'desktop-operator', body: message.body, threadId: 'verse-thread-1' });
    if (!result.ok) throw new Error(result.reason);
    expect(write).toHaveBeenCalledOnce();
    const { job } = await cosStatus(cosJobId(result.ack.dedupeKey), runsDir);
    expect(JSON.parse(job.acceptance).origin).toEqual({ channel: 'desktop', senderId: 'desktop-operator', threadId: 'verse-thread-1' });
  });

  it('refuses unverified identities without writing a queue', async () => {
    const receive = createChannelReceiver({ runsDir, allowedSenderIds: new Set(), publish: null });
    expect(await receive(message)).toEqual({ ok: false, reason: 'sender-not-allowed' });
    expect((await new QueueStore(join(runsDir, 'queue')).read()).jobs).toEqual([]);
  });

  it('retries a failed queue write without losing the receipted instruction', async () => {
    const queue = join(runsDir, 'queue', 'queue.v1.json');
    await mkdir(queue, { recursive: true });
    const receive = createChannelReceiver({ runsDir, allowedSenderIds: new Set([message.verifiedSenderId]), publish: null });
    expect(await receive(message)).toEqual({ ok: false, reason: 'write-failed' });
    await rm(queue, { recursive: true });
    const retry = await receive(message);
    expect(retry).toMatchObject({ ok: true, ack: { status: 'duplicate' } });
    expect((await new QueueStore(join(runsDir, 'queue')).read()).jobs).toHaveLength(1);
  });

  it('surfaces a completion draft and refuses stale approval before any send', async () => {
    const id = await accept();
    const draft = await draftCosResult(id, 'The weekly brief is ready.', runsDir);
    expect((await cosStatus(id, runsDir)).needsYou).toBe(true);
    expect(await readFile(join(runsDir, 'NEEDS-MASON.md'), 'utf8')).toContain(id);
    expect(listNeedsMason({ runsDir }).some(item => item.text.includes(id))).toBe(true);
    const send = vi.fn(async () => {});
    await expect(deliverCosResult(id, 'unapproved', send, runsDir)).rejects.toThrow('Explicit approval');
    expect(send).not.toHaveBeenCalled();
    await deliverCosResult(id, draft.digest, send, runsDir);
    await expect(deliverCosResult(id, draft.digest, send, runsDir)).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
    expect((await cosStatus(id, runsDir)).needsYou).toBe(false);
  });

  it('posts an approved Telegram result as a reply to the original message', async () => {
    const id = await accept();
    const draft = await draftCosResult(id, 'Brief ready.', runsDir);
    const send = vi.fn(async () => ({ ok: true, messageId: 903 }));
    const config = { comms: { telegram: { chatId: '123' } } } as AshlrConfig;
    await deliverTelegramCosResult(id, draft.digest, config, { runsDir, send });
    expect(send).toHaveBeenCalledWith('Brief ready.', { replyToMessageId: 55 }, config);
  });

  it('keeps transport failures uncertain and prevents automatic resends', async () => {
    const id = await accept();
    const draft = await draftCosResult(id, 'Brief ready.', runsDir);
    const send = vi.fn(async () => { throw new Error('transport failed'); });
    await expect(deliverCosResult(id, draft.digest, send, runsDir)).rejects.toThrow('transport failed');
    expect((await cosStatus(id, runsDir)).delivery).toBe('uncertain');
    await expect(deliverCosResult(id, draft.digest, send, runsDir)).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });

  it('writes approved email results with the original message threading headers', async () => {
    const receive = createChannelReceiver({ runsDir, allowedSenderIds: new Set(['email:operator@example.test']), publish: null });
    const result = await receive({ channel: 'email', verifiedSenderId: 'email:operator@example.test', body: message.body, threadId: 'request@example.test' });
    if (!result.ok) throw new Error(result.reason);
    const id = cosJobId(result.ack.dedupeKey);
    const draft = await draftCosResult(id, 'Brief ready.', runsDir);
    const outboxDir = join(runsDir, 'outbox');
    await deliverEmailCosResult(id, draft.digest, { runsDir, outboxDir });
    const eml = await readFile(join(outboxDir, `${id}.result.eml`), 'utf8');
    expect(eml).toContain('To: operator@example.test');
    expect(eml).toContain('In-Reply-To: <request@example.test>');
    expect(eml).toContain('Brief ready.');
  });
});
