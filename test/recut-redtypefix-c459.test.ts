import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { declineCosDraft } from '../src/core/cos/decline.js';
import { draftCosResult, queueCosEnvelope } from '../src/core/cos/intake.js';
import { listCosTasks } from '../src/core/cos/list.js';

/**
 * RQ-PHX-REDTYPEFIXC459 — supersedes #4259 (RQ-PHX-RECONCILEDECLINE09STM1).
 * The source PR widened the cos delivery union with 'declined' but its
 * list.ts summary type lacked the member, failing typecheck at
 * list.ts(48,33) TS2322. Master carries the fix as the shared CosDelivery
 * type; this drives listCosTasks — the real boundary — over a declined job.
 */

let dir: string;
let id: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cos-redtypefix-c459-'));
  id = await queueCosEnvelope({ channel: 'desktop', verifiedSenderId: 'sender-a',
    body: 'Prepare the weekly brief', receivedAt: '2026-11-16T00:00:00Z',
    dedupeKey: 'c'.repeat(64) }, dir);
});

afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('listCosTasks over a declined chief-of-staff job', () => {
  it('reports the declined claim through the list boundary', async () => {
    const { digest } = await draftCosResult(id, 'Draft reply body', dir);
    await declineCosDraft(id, digest, dir);
    const tasks = await listCosTasks(dir);
    const task = tasks.find(task => task.id === id);
    expect(task).toMatchObject({ id, delivery: 'declined', needsYou: false, hasDraft: true });
  });

  it('reports a job with no delivery claim as delivery null', async () => {
    const tasks = await listCosTasks(dir);
    const task = tasks.find(task => task.id === id);
    expect(task).toMatchObject({ id, delivery: null, needsYou: false, hasDraft: false });
  });
});
