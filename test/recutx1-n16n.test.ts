import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import { cancelTeammateTask, enqueueTeammateTask, type TeammateTaskInput } from '../src/core/comms/imessage-teammate-tasks.js';
import { QueueStore } from '../src/core/queue/store.js';
import { readFleetImessageTasks } from '../src/mcp/fleet-imessage-tasks.js';

let runsDir: string;
beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'recutx1-n16n-'));
  vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
  vi.stubEnv('PHANTOM_STACKSYNC', 'off');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(runsDir, { recursive: true, force: true });
});

it.each(['missing', 'corrupt'] as const)('keeps a withdrawn task historical after %s queue evidence recovers', async loss => {
  const transport = vi.fn(async () => { throw new Error('Fake transport must never run'); });
  const options = { runsDir, apply: true, send: transport, reconcile: transport,
    approved: (senderId: string) => senderId === 'imessage:e2e0809f8676fb7d' ? 'imessage:fake-recutx1-peer' : null };
  const cfg = { comms: { enabled: true } } as AshlrConfig;
  const input: TeammateTaskInput = { jobId: 'RQ-FAKE-RECUTX1', peer: 'dot', kind: 'research',
    repo: 'fixture/example', scope: 'FAKE_PRIVATE_SCOPE_RECUTX1', format: 'FAKE_PRIVATE_FORMAT_RECUTX1',
    prRefs: [1], deadline: '2099-01-01T00:00:00Z' };
  await enqueueTeammateTask(input, cfg, options);
  const sibling = { ...input, jobId: 'RQ-FAKE-RECUTX1-SIBLING' };
  await enqueueTeammateTask(sibling, cfg, options);
  expect(await cancelTeammateTask(input.jobId, options)).toMatchObject({ state: 'cancelled' });

  const queuePath = new QueueStore(join(runsDir, 'queue')).path;
  const ledgerPath = join(runsDir, 'imessage', 'teammate-tasks.json');
  const settled = [readFileSync(queuePath, 'utf8'), readFileSync(ledgerPath, 'utf8')];
  const read = () => readFleetImessageTasks({ jobId: input.jobId, limit: 1 }, { runsDir });
  if (loss === 'missing') rmSync(queuePath);
  else writeFileSync(queuePath, '{FAKE_BROKEN_QUEUE');

  const degraded = await read();
  expect(degraded).toMatchObject({ sourceState: 'ok', ledgerState: 'present', matched: true,
    queueState: loss === 'missing' ? 'ok' : 'unavailable' });
  expect(degraded.tasks).toHaveLength(1);
  expect(degraded.tasks![0]).toMatchObject({ jobId: input.jobId, state: 'cancelled',
    queueBinding: loss === 'missing' ? 'missing' : 'unavailable', queueClaim: null });
  if (loss === 'missing') {
    expect(await cancelTeammateTask(input.jobId, options)).toMatchObject({ state: 'refused' });
    expect(existsSync(queuePath)).toBe(false);
  } else {
    await expect(cancelTeammateTask(input.jobId, options)).rejects.toThrow();
    expect(readFileSync(queuePath, 'utf8')).toBe('{FAKE_BROKEN_QUEUE');
  }
  expect(readFileSync(ledgerPath, 'utf8')).toBe(settled[1]);

  writeFileSync(queuePath, settled[0]);
  const recovered = await read();
  expect(recovered.tasks).toHaveLength(1);
  expect(recovered.tasks![0]).toMatchObject({ jobId: input.jobId, state: 'cancelled',
    queueBinding: 'bound', queueClaim: 'finished', transportReceipt: null, result: null });
  expect(await cancelTeammateTask(input.jobId, options)).toMatchObject({ state: 'cancelled' });
  const siblingReport = await readFleetImessageTasks({ jobId: sibling.jobId, limit: 1 }, { runsDir });
  expect(siblingReport.tasks![0]).toMatchObject({ state: 'queued', queueBinding: 'bound', queueClaim: 'active' });
  expect([readFileSync(queuePath, 'utf8'), readFileSync(ledgerPath, 'utf8')]).toEqual(settled);
  // Reopening the store must preserve the original single finished claim.
  const job = (await new QueueStore(join(runsDir, 'queue')).read()).jobs.find(row => row.id === input.jobId)!;
  expect(job.status).toBe('BLOCKED');
  expect(job.claims).toHaveLength(1);
  expect(job.claims[0]).toMatchObject({ owner: 'imsg:dot', finishedAt: expect.any(String) });
  const tokens = (JSON.parse(settled[1]) as { tasks: { token: string }[] }).tasks.map(task => task.token);
  for (const report of [degraded, recovered, siblingReport]) {
    for (const marker of [...tokens, input.scope, input.format, 'FAKE_BROKEN_QUEUE', '"token"', '"scope"', '"format"'])
      expect(JSON.stringify(report)).not.toContain(marker);
  }
  expect(transport).not.toHaveBeenCalled();
});
