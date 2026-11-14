import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { declineCosDraft } from '../src/core/cos/decline.js';
import { cosStatus, deliverCosResult, draftCosResult, queueCosEnvelope } from '../src/core/cos/intake.js';
import { cmdFleetCosDecline } from '../src/cli/fleet-cos-decline.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

describe('chief-of-staff decline', () => {
  let runsDir: string;
  let id: string;
  const deliveryPath = () => join(runsDir, 'cos', `${id}.delivery.json`);
  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), 'cos-decline-'));
    vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
    id = await queueCosEnvelope({ channel: 'desktop', verifiedSenderId: 'fake-operator',
      body: 'Prepare a project brief.', receivedAt: '2026-11-01T00:00:00Z', dedupeKey: 'a'.repeat(64) }, runsDir);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(runsDir, { recursive: true, force: true });
  });
  const draft = () => draftCosResult(id, 'The project brief is ready.', runsDir);

  it('declines the exact draft, clears needs-you and permanently holds the claim', async () => {
    const { digest } = await draft();
    expect((await cosStatus(id, runsDir)).needsYou).toBe(true);
    expect(await declineCosDraft(id, digest, runsDir)).toEqual({ id, delivery: 'declined' });
    expect(JSON.parse(await readFile(deliveryPath(), 'utf8'))).toEqual({ state: 'declined' });
    expect((await stat(deliveryPath())).mode & 0o777).toBe(0o600);
    expect(await cosStatus(id, runsDir)).toMatchObject({ delivery: 'declined', needsYou: false });
    await expect(declineCosDraft(id, digest, runsDir)).rejects.toMatchObject({ code: 'EEXIST' });
    const send = vi.fn(async () => {});
    await expect(deliverCosResult(id, digest, send, runsDir)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(send).not.toHaveBeenCalled();
    expect((await cosStatus(id, runsDir)).delivery).toBe('declined');
  });

  it('refuses stale or malformed digests without writing a claim', async () => {
    await draft();
    for (const digest of ['b'.repeat(64), 'bad', 'A'.repeat(64)]) {
      await expect(declineCosDraft(id, digest, runsDir)).rejects.toThrow('Explicit decline of the current draft is required');
    }
    await expect(stat(deliveryPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses missing drafts and invalid ids without writing a claim', async () => {
    await expect(declineCosDraft(id, 'b'.repeat(64), runsDir)).rejects.toThrow('No chief-of-staff draft');
    await expect(declineCosDraft('../invalid', 'b'.repeat(64), runsDir)).rejects.toThrow('Invalid chief-of-staff job id');
    await expect(stat(deliveryPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses decline after sent delivery and preserves sent state', async () => {
    const { digest } = await draft();
    await deliverCosResult(id, digest, async () => {}, runsDir);
    await expect(declineCosDraft(id, digest, runsDir)).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await cosStatus(id, runsDir)).delivery).toBe('sent');
  });

  it('exposes the registry export and CLI exit codes 0/1/2 with JSON output', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolveFleetSubcommand('cos-decline')?.exportName).toBe('cmdFleetCosDecline');
    expect((await FLEET_SUBCOMMAND_LOADERS['cos-decline']!()).cmdFleetCosDecline).toBe(cmdFleetCosDecline);
    expect(await cmdFleetCosDecline([id, '--digest', 'b'.repeat(64), '--json'])).toBe(1);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({ error: 'No chief-of-staff draft' });
    const { digest } = await draft();
    expect(await cmdFleetCosDecline([id, '--digest', 'b'.repeat(64), '--json'])).toBe(1);
    expect(await cmdFleetCosDecline([id, '--digest', digest, '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({ v: 1, id, delivery: 'declined' });
    expect(await cmdFleetCosDecline([id, '--digest', digest, '--json'])).toBe(1);
    for (const args of [[], [id], [id, '--digest'], [id, '--digest', 'bad'], [id, '--unknown'],
      [id, '--digest', digest, '--digest', digest]]) {
      expect(await cmdFleetCosDecline([...args, '--json'])).toBe(2);
      expect(JSON.parse(log.mock.calls.at(-1)![0])).toHaveProperty('error');
    }
  });
});
