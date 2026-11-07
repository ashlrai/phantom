import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isLoopbackEndpoint, refuseCloudForImessage } from '../src/core/agents/content-taint.js';
import { queueCosEnvelope } from '../src/core/cos/intake.js';
import { runCosWorkOnce } from '../src/core/cos/worker.js';
import { QueueStore } from '../src/core/queue/store.js';

describe('comms content locality', () => {
  it.each(['http://127.0.0.1:11434', 'https://127.0.0.1/v1', 'http://[::1]:8080/v1'])(
    'accepts explicit loopback %s', endpoint => {
      expect(isLoopbackEndpoint(endpoint)).toBe(true);
      expect(() => refuseCloudForImessage('imessage', endpoint)).not.toThrow();
    });

  it.each([
    undefined, '', 'invalid', 'http://localhost:11434', 'http://0.0.0.0:8080',
    'http://192.168.1.2', 'http://10.0.0.1', 'https://example.com/v1',
    'http://127.0.0.1.example.com', 'http://127.0.0.1@example.com',
    'http://[::ffff:127.0.0.1]', 'http://127.0.0.2', 'http://127.1',
    'http://2130706433', 'http://0x7f000001', 'file://127.0.0.1/model',
    'http://127.0.0.1:99999', 'http://127.0.0.1\\@example.com',
  ])('refuses nonliteral, remote or unknown endpoint %s', endpoint => {
    expect(isLoopbackEndpoint(endpoint)).toBe(false);
    expect(() => refuseCloudForImessage('imessage', endpoint)).toThrow('loopback');
    expect(() => refuseCloudForImessage('email', endpoint)).not.toThrow();
  });

  it('does not expose an endpoint in a refusal', () => {
    expect(() => refuseCloudForImessage(' iMessage ', 'https://example.com/private'))
      .toThrow(/^iMessage content requires a loopback model endpoint$/);
  });

  it.each([false, true])('refuses synthetic iMessage CLI jobs before execution (replay=%s)', async replay => {
    const runsDir = await mkdtemp(join(tmpdir(), 'comms-local-only-'));
    try {
      const id = await queueCosEnvelope({ channel: 'imessage', verifiedSenderId: 'synthetic',
        body: 'Synthetic request', receivedAt: new Date().toISOString(), dedupeKey: 'b'.repeat(64) }, runsDir);
      const store = new QueueStore(join(runsDir, 'queue'), 250);
      let attemptId = id;
      if (replay) {
        const original = (await store.read()).jobs[0]!;
        await store.claim(id, 'test');
        await store.finish(id, 'test', { reason: 'synthetic failure' });
        attemptId = `${id}.replay.synthetic`;
        await store.add({ ...original, id: attemptId, replayOf: id, replayedAt: new Date().toISOString(), status: 'READY' });
      }
      const spawn = vi.fn(() => { throw new Error('must never spawn'); });
      const result = await runCosWorkOnce({ runsDir, spawn,
        candidates: [{ provider: 'local-labelled', argv: ['synthetic-cli'] }] });
      expect(result).toMatchObject({ outcome: 'blocked', id, reason: 'imessage-requires-loopback-endpoint' });
      expect(spawn).not.toHaveBeenCalled();
      expect((await store.read()).jobs.find(job => job.id === attemptId)?.status).toBe('READY');
    } finally { await rm(runsDir, { recursive: true, force: true }); }
  });
});
