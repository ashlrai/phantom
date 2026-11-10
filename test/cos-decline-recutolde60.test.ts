// Recut of #4259 (RQ-PHX-RECONCILEDECLINE09STM1): retained chief-of-staff decline.
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { cmdFleetCosDecline } from '../src/cli/fleet-cos-decline.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { declineCosDraft } from '../src/core/cos/decline.js';
import { cosStatus, deliverCosResult, draftCosResult, queueCosEnvelope } from '../src/core/cos/intake.js';
import { listCosTasks } from '../src/core/cos/list.js';
import { reconcileCosDelivery } from '../src/core/cos/reconcile.js';

let dir: string;
let id: string;
const claim = () => join(dir, 'cos', `${id}.delivery.json`);
const draft = () => draftCosResult(id, 'Private draft text', dir);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cos-decline-recutolde60-'));
  vi.stubEnv('ASHLR_RUNS_DIR', dir);
  id = await queueCosEnvelope({ channel: 'desktop', verifiedSenderId: 'fake-sender', body: 'Prepare a brief',
    receivedAt: '2026-11-01T00:00:00Z', dedupeKey: 'a'.repeat(64) }, dir);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('chief-of-staff decline', () => {
  it('requires the exact digest, clears needs-you and blocks a later approved send', async () => {
    const { digest } = await draft();
    for (const bad of ['b'.repeat(64), 'bad', digest.toUpperCase()]) {
      await expect(declineCosDraft(id, bad, dir)).rejects.toThrow('Explicit decline of the current draft is required');
    }
    await expect(stat(claim())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await cosStatus(id, dir)).toMatchObject({ needsYou: true });

    expect(await declineCosDraft(id, digest, dir)).toEqual({ id, delivery: 'declined' });
    expect(await cosStatus(id, dir)).toMatchObject({ delivery: 'declined', needsYou: false });
    expect(await readFile(join(dir, 'NEEDS-MASON.md'), 'utf8')).toContain('- [x]');
    expect((await stat(claim())).mode & 0o777).toBe(0o600);
    expect(await listCosTasks(dir)).toEqual([expect.objectContaining({ id, delivery: 'declined', needsYou: false })]);

    const send = vi.fn(async () => {});
    await expect(deliverCosResult(id, digest, send, dir)).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(declineCosDraft(id, digest, dir)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(send).not.toHaveBeenCalled();
    // A decline is final: reconcile only handles sending or uncertain claims.
    await expect(reconcileCosDelivery(id, 'retry', { runsDir: dir })).rejects.toThrow('Delivery is declined');
    expect((await cosStatus(id, dir)).delivery).toBe('declined');
  });

  it('refuses a draft with no draft yet and an unknown job', async () => {
    await expect(declineCosDraft(id, 'c'.repeat(64), dir)).rejects.toThrow('Explicit decline');
    await expect(declineCosDraft(`cos-${'f'.repeat(32)}`, 'c'.repeat(64), dir)).rejects.toThrow('Unknown chief-of-staff job');
    await expect(declineCosDraft('not-an-id', 'c'.repeat(64), dir)).rejects.toThrow('Invalid chief-of-staff job id');
  });

  it('never overwrites a sending, sent or uncertain claim', async () => {
    const { digest } = await draft();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn(async () => gate);
    const delivering = deliverCosResult(id, digest, send, dir);
    while (!send.mock.calls.length) await new Promise(resolve => setTimeout(resolve, 1));
    await expect(declineCosDraft(id, digest, dir)).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await cosStatus(id, dir)).delivery).toBe('sending');
    release();
    await delivering;
    await expect(declineCosDraft(id, digest, dir)).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await cosStatus(id, dir)).delivery).toBe('sent');
    expect(send).toHaveBeenCalledOnce();
  });

  it('keeps uncertain after a failed send', async () => {
    const { digest } = await draft();
    await expect(deliverCosResult(id, digest, async () => { throw new Error('fake failure'); }, dir)).rejects.toThrow('fake failure');
    await expect(declineCosDraft(id, digest, dir)).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await cosStatus(id, dir)).delivery).toBe('uncertain');
  });

  it('lets exactly one of a concurrent decline and send claim the draft', async () => {
    const { digest } = await draft();
    const send = vi.fn(async () => {});
    const results = await Promise.allSettled([declineCosDraft(id, digest, dir), deliverCosResult(id, digest, send, dir)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const { delivery } = await cosStatus(id, dir);
    expect(send).toHaveBeenCalledTimes(delivery === 'declined' ? 0 : 1);
  });
});

describe('phm fleet cos-decline', () => {
  it('is registered and dispatched by phm fleet', async () => {
    const loaded = await FLEET_SUBCOMMAND_LOADERS['cos-decline']!();
    expect(loaded.cmdFleetCosDecline).toBe(cmdFleetCosDecline);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleet(['cos-decline', '--help'])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet cos-decline'));

    const { digest } = await draft();
    expect(await cmdFleet(['cos-decline', id, '--digest', digest, '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toEqual({ v: 1, id, delivery: 'declined' });
    expect((await cosStatus(id, dir)).delivery).toBe('declined');
  });

  it('validates arguments before writing and never prints the draft text', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { digest } = await draft();
    for (const args of [[], [id], [id, '--digest'], [id, '--digest', 'bad'], [id, '--digest', digest, '--extra'], ['--digest', digest]]) {
      expect(await cmdFleetCosDecline([...args, '--json'])).toBe(2);
    }
    await expect(stat(claim())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await cmdFleetCosDecline([id, '--digest', 'd'.repeat(64), '--json'])).toBe(1);
    await expect(stat(claim())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await cmdFleetCosDecline([id, '--digest', digest])).toBe(0);
    expect(log.mock.calls.at(-1)![0]).toBe(`declined ${id}`);
    expect(await cmdFleetCosDecline([id, '--digest', digest, '--json'])).toBe(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain('Private draft text');
  });
});
