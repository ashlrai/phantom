import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { declineCosDraft } from '../src/core/cos/decline.js';
import { cosStatus, deliverCosResult, draftCosResult, queueCosEnvelope } from '../src/core/cos/intake.js';
import { cmdFleetCosDecline } from '../src/cli/fleet-cos-decline.js';

let dir: string;
let id: string;
const claim = () => join(dir, 'cos', `${id}.delivery.json`);
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cos-preserve-'));
  vi.stubEnv('ASHLR_RUNS_DIR', dir);
  id = await queueCosEnvelope({ channel: 'desktop', verifiedSenderId: 'fake', body: 'Prepare a brief',
    receivedAt: '2026-11-01T00:00:00Z', dedupeKey: 'a'.repeat(64) }, dir);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
const draft = () => draftCosResult(id, 'Private draft text', dir);

describe('retained decline', () => {
  it('requires the exact digest, clears attention and blocks delivery', async () => {
    const { digest } = await draft();
    for (const bad of ['b'.repeat(64), 'bad']) await expect(declineCosDraft(id, bad, dir)).rejects.toThrow();
    await expect(stat(claim())).rejects.toMatchObject({ code: 'ENOENT' });
    await declineCosDraft(id, digest, dir);
    expect(await cosStatus(id, dir)).toMatchObject({ delivery: 'declined', needsYou: false });
    expect(await readFile(join(dir, 'NEEDS-MASON.md'), 'utf8')).toContain('- [x]');
    const send = vi.fn(async () => {});
    await expect(deliverCosResult(id, digest, send, dir)).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(declineCosDraft(id, digest, dir)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(send).not.toHaveBeenCalled();
    expect((await stat(claim())).mode & 0o777).toBe(0o600);
  });

  it('preserves sending, sent, and uncertain claims and approved delivery behavior', async () => {
    const { digest } = await draft();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn(async () => gate);
    const delivering = deliverCosResult(id, digest, send, dir);
    while (!send.mock.calls.length) await new Promise(resolve => setTimeout(resolve, 1));
    await expect(declineCosDraft(id, digest, dir)).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await cosStatus(id, dir)).delivery).toBe('sending');
    release(); await delivering;
    await expect(declineCosDraft(id, digest, dir)).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await cosStatus(id, dir)).delivery).toBe('sent');
    expect(send).toHaveBeenCalledOnce();
  });

  it('retains uncertain after a failed send', async () => {
    const { digest } = await draft();
    await expect(deliverCosResult(id, digest, async () => { throw new Error('fake failure'); }, dir)).rejects.toThrow('fake failure');
    await expect(declineCosDraft(id, digest, dir)).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await cosStatus(id, dir)).delivery).toBe('uncertain');
  });

  it('allows only one of concurrent decline and delivery to claim the draft', async () => {
    const { digest } = await draft();
    const send = vi.fn(async () => {});
    const results = await Promise.allSettled([declineCosDraft(id, digest, dir), deliverCosResult(id, digest, send, dir)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const status = await cosStatus(id, dir);
    expect(send).toHaveBeenCalledTimes(status.delivery === 'declined' ? 0 : 1);
  });

  it('validates CLI arguments before writing and prints sanitized status', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { digest } = await draft();
    for (const args of [[], [id, '--digest'], [id, '--digest', 'bad'], [id, '--digest', digest, '--extra']]) {
      expect(await cmdFleetCosDecline([...args, '--json'])).toBe(2);
    }
    await expect(stat(claim())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await cmdFleetCosDecline([id, '--digest', digest, '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toEqual({ v: 1, id, delivery: 'declined' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('Private draft text');
  });
});
