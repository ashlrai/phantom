/**
 * RQ-PHX-EMAILCOSCONTRACT04SQR2 — regression contract for the chief-of-staff
 * email approval → local-outbox path before Commsbot retires.
 *
 * Proves `deliverEmailCosResult` (src/core/comms/email-drop-bridge.ts) on real
 * temp-root queue/draft/approval stores: a receiver-accepted email envelope
 * becomes a durable COS job, its worker result becomes a digest-bound draft,
 * and only the exact displayed digest lets the draft leave as one local
 * `<id>.result.eml` carrying To/In-Reply-To/References. Staging is not
 * sending: `sendEmailOutbox` consumes `*.reply.eml` only, so no Mail.app,
 * network transport or external send can ever see the staged file. Every
 * value here is plainly fake; nothing touches a real inbox or account.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cosJobId, cosStatus, draftCosResult } from '../src/core/cos/intake.js';
import { reconcileCosDelivery } from '../src/core/cos/reconcile.js';
import { deliverEmailCosResult } from '../src/core/comms/email-drop-bridge.js';
import { readEmailOutbox, sendEmailOutbox, type EmailTransport } from '../src/core/comms/email-outbox.js';
import { createChannelReceiver, type ChannelMessage } from '../src/core/fleet/channel-envelope.js';
import { listNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';

const SENDER_ID = 'email:operator@example.test';
const ADDRESS = 'operator@example.test';
const THREAD = 'brief-request-1@example.test';
const RESULT = 'The weekly brief is ready.';

let runsDir: string;
let outboxDir: string;
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'email-cos-contract-'));
  outboxDir = join(runsDir, 'outbox');
});
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

/** `.result.eml` names in the outbox — [] when the dir does not exist yet. */
const staged = async (): Promise<string[]> =>
  readdir(outboxDir).then(names => names.filter(name => name.endsWith('.result.eml')), () => []);

/** A real receiver acceptance → COS queue job → worker draft, digest intact. */
async function emailJob(input: ChannelMessage): Promise<{ id: string; digest: string }> {
  const receive = createChannelReceiver({ runsDir, allowedSenderIds: new Set([input.verifiedSenderId]), publish: null });
  const result = await receive(input);
  if (!result.ok) throw new Error(`receiver refused: ${result.reason}`);
  const id = cosJobId(result.ack.dedupeKey);
  const draft = await draftCosResult(id, RESULT, runsDir);
  return { id, digest: draft.digest };
}

const order = (body: string, threadId?: string): ChannelMessage =>
  ({ channel: 'email', verifiedSenderId: SENDER_ID, body, ...(threadId ? { threadId } : {}) });

describe('email chief-of-staff approval → local .result.eml staging', () => {
  it('stages nothing before approval and refuses digests the draft was never bound to', async () => {
    const { id, digest } = await emailJob(order('Prepare the weekly project brief.', THREAD));
    const foreign = await emailJob(order('Prepare the hiring brief.', 'hiring-request-1@example.test'));
    // Queued and drafted, but never approved: no output mail, no delivery claim.
    expect(await staged()).toEqual([]);
    const pending = await cosStatus(id, runsDir);
    expect(pending.draft?.digest).toBe(digest);
    expect(pending.delivery).toBeUndefined();
    expect(pending.needsYou).toBe(true);
    // Garbage, another job's genuine digest, and a well-formed digest forged
    // over tampered text are all refused — approval binds THIS draft only.
    const forged = createHash('sha256').update(JSON.stringify([id, pending.draft!.origin, 'tampered'])).digest('hex');
    for (const wrong of ['f'.repeat(64), foreign.digest, forged]) {
      await expect(deliverEmailCosResult(id, wrong, { runsDir, outboxDir })).rejects.toThrow('Explicit approval');
    }
    expect(await staged()).toEqual([]);
    expect((await cosStatus(id, runsDir)).delivery).toBeUndefined();
    expect(listNeedsMason({ runsDir }).filter(item => item.text.includes(id))).toHaveLength(1);
  });

  it('stages exactly one addressed, threaded .result.eml on approval and cannot repeat', async () => {
    const { id, digest } = await emailJob(order('Prepare the weekly project brief.', THREAD));
    await deliverEmailCosResult(id, digest, { runsDir, outboxDir });
    const files = await staged();
    expect(files).toEqual([`${id}.result.eml`]);
    const path = join(outboxDir, files[0]!);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).toBe(
      `To: ${ADDRESS}\r\nSubject: Phantom result\r\n` +
      `In-Reply-To: <${THREAD}>\r\nReferences: <${THREAD}>\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n\r\n${RESULT}\r\n`);
    const status = await cosStatus(id, runsDir);
    expect(status.delivery).toBe('sent');
    expect(status.needsYou).toBe(false);
    expect(listNeedsMason({ runsDir }).some(item => item.text.includes(id))).toBe(false);
    // The one-shot exclusive claim: the same approval can never stage twice.
    await expect(deliverEmailCosResult(id, digest, { runsDir, outboxDir })).rejects.toThrow('EEXIST');
    expect(await staged()).toEqual([`${id}.result.eml`]);
    expect((await cosStatus(id, runsDir)).delivery).toBe('sent');
  });

  it('refuses non-email origins and missing or invalid thread ids without staging', async () => {
    const cases: { label: string; input: ChannelMessage }[] = [
      { label: 'telegram origin', input: { channel: 'telegram', verifiedSenderId: 'telegram:123', body: 'Prepare the ops brief.', threadId: '55' } },
      { label: 'missing thread id', input: order('Prepare the budget brief.') },
      { label: 'thread id that is not a Message-ID', input: order('Prepare the hiring brief.', 'not-a-message-id') },
      { label: 'email channel with a non-email sender id', input: { channel: 'email', verifiedSenderId: 'desktop-mason', body: 'Prepare the travel brief.', threadId: THREAD } },
      { label: 'sender id whose address cannot parse', input: { channel: 'email', verifiedSenderId: 'email:not-an-address', body: 'Prepare the fleet brief.', threadId: THREAD } },
    ];
    const ids: string[] = [];
    for (const { input } of cases) {
      const { id, digest } = await emailJob(input);
      ids.push(id);
      await expect(deliverEmailCosResult(id, digest, { runsDir, outboxDir })).rejects.toThrow('No verified email origin');
    }
    expect(await staged()).toEqual([]);
    for (const id of ids) {
      // Approval consumed the one-shot claim honestly: recorded uncertain —
      // a human reconciles, nothing is retried or reported as sent.
      const status = await cosStatus(id, runsDir);
      expect(status.delivery).toBe('uncertain');
      expect(status.needsYou).toBe(true);
    }
  });

  it('stages a local file only: the reply pipeline can never pick it up', async () => {
    const { id, digest } = await emailJob(order('Prepare the weekly project brief.', THREAD));
    await deliverEmailCosResult(id, digest, { runsDir, outboxDir });
    // `.result.eml` lacks the `.reply.eml` suffix the sender scans, so the
    // read-only listing sees nothing and a send pass invokes no transport —
    // no Mail.app, no network, no external send from this path.
    expect(readEmailOutbox(outboxDir).counts).toEqual({ queued: 0, sent: 0, stuck: 0 });
    const transport: EmailTransport = vi.fn(async () => ({ ok: true }));
    const pass = await sendEmailOutbox({ dir: outboxDir, allowedRecipients: new Set([ADDRESS]), transport });
    expect(pass).toMatchObject({ queued: 0, sent: 0, drafted: 0, refused: 0, failed: 0, stuck: 0 });
    expect(pass.details).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
    expect(await staged()).toEqual([`${id}.result.eml`]);
  });

  it('records an honest uncertain state on staging failure and reconciles into one approved retry', async () => {
    const { id, digest } = await emailJob(order('Prepare the weekly project brief.', THREAD));
    // The outbox path is a regular file: the staging mkdir can never succeed.
    await writeFile(outboxDir, 'blocked');
    await expect(deliverEmailCosResult(id, digest, { runsDir, outboxDir })).rejects.toThrow();
    const failed = await cosStatus(id, runsDir);
    expect(failed.delivery).toBe('uncertain');
    expect(failed.needsYou).toBe(true);
    expect(await staged()).toEqual([]);
    // The held claim refuses any second attempt until a human reconciles.
    await expect(deliverEmailCosResult(id, digest, { runsDir, outboxDir })).rejects.toThrow('EEXIST');
    expect(await reconcileCosDelivery(id, 'retry', { runsDir })).toEqual({ id, from: 'uncertain', to: 'cleared' });
    await rm(outboxDir);
    await deliverEmailCosResult(id, digest, { runsDir, outboxDir });
    expect(await staged()).toEqual([`${id}.result.eml`]);
    expect((await cosStatus(id, runsDir)).delivery).toBe('sent');
  });
});
