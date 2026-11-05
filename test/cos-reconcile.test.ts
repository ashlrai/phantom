import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCosReconcile } from '../src/cli/fleet-cos-reconcile.js';
import { cosStatus, deliverCosResult, draftCosResult, queueCosEnvelope } from '../src/core/cos/intake.js';
import { readNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';
import { reconcileCosDelivery } from '../src/core/cos/reconcile.js';

let runsDir: string;
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'cos-reconcile-'));
  vi.stubEnv('ASHLR_HOME', join(runsDir, 'home'));
  vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(runsDir, { recursive: true, force: true });
});
const cosDir = () => join(runsDir, 'cos');
const deliveryFile = (id: string) => join(cosDir(), `${id}.delivery.json`);
const REPLY = 'The brief is ready, fake text.';
async function prepare() {
  const id = await queueCosEnvelope({ channel: 'cli', verifiedSenderId: 'test-sender',
    body: 'Prepare a project brief', receivedAt: new Date().toISOString(), dedupeKey: 'b'.repeat(64) }, runsDir);
  const draft = await draftCosResult(id, REPLY, runsDir);
  return { id, draft };
}
async function uncertain() {
  const made = await prepare();
  await expect(deliverCosResult(made.id, made.draft.digest, async () => { throw new Error('boom'); }, runsDir)).rejects.toThrow('boom');
  expect((await cosStatus(made.id, runsDir)).delivery).toBe('uncertain');
  return made;
}
const files = async () => (await readdir(cosDir())).sort();

describe('reconcileCosDelivery', () => {
  it('delivered marks sent, resolves the NEEDS-MASON line and audits without draft text', async () => {
    const { id } = await uncertain();
    expect(readNeedsMason({ runsDir }).items).toHaveLength(1);
    expect(await reconcileCosDelivery(id, 'delivered', { runsDir })).toEqual({ id, from: 'uncertain', to: 'sent' });
    const status = await cosStatus(id, runsDir);
    expect(status.delivery).toBe('sent');
    expect(status.needsYou).toBe(false);
    expect(readNeedsMason({ runsDir }).items).toEqual([]);
    const log = (await readFile(join(cosDir(), 'reconcile.jsonl'), 'utf8')).trimEnd().split('\n');
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0]!)).toMatchObject({ id, from: 'uncertain', verdict: 'delivered' });
    expect(log[0]).not.toContain(REPLY);
    expect(log[0]).not.toContain('test-sender');
  });

  it('retry keeps an audit file and allows exactly one more approved send', async () => {
    const { id, draft } = await uncertain();
    const result = await reconcileCosDelivery(id, 'retry', { runsDir, now: () => 1234 });
    expect(result).toEqual({ id, from: 'uncertain', to: 'cleared' });
    expect(await files()).toContain(`${id}.delivery.1234.reconciled.json`);
    expect(await files()).not.toContain(`${id}.delivery.json`);
    expect(readNeedsMason({ runsDir }).items).toHaveLength(1);
    const send = vi.fn(async () => {});
    await deliverCosResult(id, draft.digest, send, runsDir);
    await expect(deliverCosResult(id, draft.digest, send, runsDir)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refuses a fresh sending claim and accepts a stale one', async () => {
    const { id } = await prepare();
    await writeFile(deliveryFile(id), '{"state":"sending"}');
    await expect(reconcileCosDelivery(id, 'delivered', { runsDir })).rejects.toThrow('still sending');
    const old = new Date(Date.now() - 20 * 60 * 1000);
    await utimes(deliveryFile(id), old, old);
    expect(await reconcileCosDelivery(id, 'delivered', { runsDir })).toEqual({ id, from: 'sending', to: 'sent' });
    await writeFile(deliveryFile(id), '{"state":"sending"}');
    await utimes(deliveryFile(id), new Date(Date.now() - 5_000), new Date(Date.now() - 5_000));
    expect((await reconcileCosDelivery(id, 'retry', { runsDir, staleSendingMs: 1000 })).from).toBe('sending');
  });

  it('refuses no delivery, sent, invalid and unknown ids without touching files', async () => {
    const { id, draft } = await prepare();
    const before = await files();
    await expect(reconcileCosDelivery(id, 'retry', { runsDir })).rejects.toThrow('not started');
    await deliverCosResult(id, draft.digest, async () => {}, runsDir);
    const sent = await files();
    await expect(reconcileCosDelivery(id, 'delivered', { runsDir })).rejects.toThrow('sent');
    await expect(reconcileCosDelivery('nope', 'retry', { runsDir })).rejects.toThrow('Invalid');
    await expect(reconcileCosDelivery(`cos-${'c'.repeat(32)}`, 'retry', { runsDir })).rejects.toThrow('Unknown');
    expect(await files()).toEqual(sent);
    expect(before).not.toContain(`${id}.delivery.json`);
    expect(await readFile(deliveryFile(id), 'utf8')).toBe('{"state":"sent"}');
  });

  it('matches the approval line intake writes', async () => {
    const { id } = await prepare();
    expect(readNeedsMason({ runsDir }).items[0]!.text)
      .toBe(`Approve chief-of-staff reply ${id}; inspect with phm cos status ${id} --json`);
  });
});

describe('cos-reconcile CLI', () => {
  it('exits 2 for two verdict flags and 1 for a refused state', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { id } = await prepare();
    expect(await cmdFleetCosReconcile([id, '--delivered', '--retry'])).toBe(2);
    expect(await cmdFleetCosReconcile([id])).toBe(2);
    expect(await cmdFleetCosReconcile([id, '--retry'])).toBe(1);
  });

  it('prints parseable json and a one-line summary', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { id } = await uncertain();
    expect(await cmdFleetCosReconcile([id, '--retry', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({ id, from: 'uncertain', to: 'cleared' });
    expect(await cmdFleetCosReconcile(['--help'])).toBe(0);
  });
});
