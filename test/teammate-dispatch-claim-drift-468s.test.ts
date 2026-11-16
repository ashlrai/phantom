import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import { enqueueTeammateTask, listTeammateTasks, runTeammateTasks } from '../src/core/comms/imessage-teammate-tasks.js';
import { QueueStore } from '../src/core/queue/store.js';

const cfg = { comms: { enabled: true } } as AshlrConfig;
const now = Date.parse('2026-11-15T12:00:00Z');
let runsDir: string;
const send = vi.fn(async (): Promise<'accepted'> => 'accepted');
const reconcile = vi.fn(async () => ({ rowid: 100, sent: true, delivered: true, error: 0 }));
const options = () => ({ runsDir, now: () => now, apply: true, approved: () => 'fixture-handle', send, reconcile });
const queue = () => new QueueStore(join(runsDir, 'queue'));

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'claim-drift-'));
  vi.stubEnv('HOME', runsDir);
  vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
  vi.stubEnv('PHANTOM_STACKSYNC', 'off');
  send.mockClear(); reconcile.mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(runsDir, { recursive: true, force: true }); });

async function reserve() {
  await enqueueTeammateTask({ jobId: 'RQ-FIXTURE-468', peer: 'dot', kind: 'research', scope: 'Fixture scope',
    repo: 'example/fixture', format: 'Fixture report', deadline: new Date(now + 3600000).toISOString() }, cfg, options());
}

describe('dispatch requires the persisted reservation identity', () => {
  it.each(['owner', 'repo', 'scope', 'acceptance'] as const)('refuses %s drift across restarts', async field => {
    await reserve();
    const store = queue();
    const document = await store.read();
    const job = document.jobs[0]!;
    if (field === 'owner') job.claims[job.claims.length - 1]!.owner = 'imsg:instinct';
    if (field === 'repo') job.repo = 'example/other';
    if (field === 'scope') job.scope = 'Competing fixture scope';
    if (field === 'acceptance') job.acceptance = job.acceptance.replace(/[a-f0-9]{32}/, '1'.repeat(32));
    writeFileSync(store.path, JSON.stringify(document), { mode: 0o600 });
    const competing = await queue().read(); // validates the persisted competing record
    for (let restart = 0; restart < 2; restart++) {
      await expect(runTeammateTasks(cfg, options())).rejects.toThrow('Teammate queue claim conflict');
      expect(await queue().read()).toEqual(competing);
      expect(send).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
      const task = listTeammateTasks({ runsDir }).tasks[0]!;
      expect(task.state).toBe('queued');
      expect(task.receipt).toBeUndefined();
      expect(task.metrics).toEqual([]);
      expect(existsSync(join(runsDir, 'metrics', 'jobs.jsonl'))).toBe(false);
    }
  });

  it('sends a matching reservation once and reconciles its receipt', async () => {
    await reserve();
    expect((await runTeammateTasks(cfg, options())).sent).toBe(1);
    expect((await runTeammateTasks(cfg, options())).sent).toBe(0);
    expect(send).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(listTeammateTasks({ runsDir }).tasks[0]).toMatchObject({ state: 'pending', receipt: { sent: true }, metrics: ['launch'] });
  });
});
