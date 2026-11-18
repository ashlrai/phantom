import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetTeammateTasks } from '../src/cli/fleet-teammate-tasks.js';
import { defaultConfig } from '../src/core/config.js';
import { cancelTeammateTask, enqueueTeammateTask, listTeammateTasks } from '../src/core/comms/imessage-teammate-tasks.js';
import { QueueStore } from '../src/core/queue/store.js';

let runsDir: string;
let output: string[];
const input = { jobId: 'FAKE-WITHDRAW-462', peer: 'dot', kind: 'research', scope: 'Private fixture scope 462',
  repo: 'fixture/example', format: 'Private fixture format 462', deadline: '2099-01-01T00:00:00Z' } as const;
const ledger = () => join(runsDir, 'imessage', 'teammate-tasks.json');
const queue = () => new QueueStore(join(runsDir, 'queue'));
const bytes = () => [readFileSync(ledger(), 'utf8'), readFileSync(queue().path, 'utf8')];
// Each invocation reloads the real stores; only output and approved peer config are fake.
const cli = (args: string[]) => cmdFleetTeammateTasks([...args, '--json'], {
  cancel: (id, options) => cancelTeammateTask(id, { ...options, runsDir }),
  list: () => listTeammateTasks({ runsDir }),
  output: text => output.push(text),
  config: () => { throw new Error('Cancellation/list must not load host config'); },
});
beforeEach(async () => {
  runsDir = mkdtempSync(join(tmpdir(), 'teammate-withdraw-462-')); output = [];
  vi.stubEnv('HOME', runsDir); vi.stubEnv('ASHLR_RUNS_DIR', runsDir); vi.stubEnv('PHANTOM_STACKSYNC', 'off');
  const result = await enqueueTeammateTask(input, defaultConfig(), { runsDir, apply: true, approved: () => 'fixture-peer-462' });
  expect(result.state).toBe('queued');
  expect((await queue().read()).jobs).toHaveLength(1);
});
afterEach(() => {
  try {
    const token = listTeammateTasks({ runsDir }).tasks[0].token;
    for (const text of output) {
      expect(text).not.toMatch(/"(?:token|scope|format|summary)"/);
      for (const privateValue of [token, input.scope, input.format, 'fixture-peer-462']) expect(text).not.toContain(privateValue);
      expect(JSON.parse(text)).toMatchObject({ coverage: 'local-evidence-only-peer-reported-results-unverified',
        claimKeyEvidence: 'label-only-queue-binding-unverified' });
    }
  } finally { vi.unstubAllEnvs(); rmSync(runsDir, { recursive: true, force: true }); }
});
it('previews, withdraws, reloads through the alias, and repeats without duplicate claims', async () => {
  const before = bytes();
  expect(await cli(['cancel', '--job', input.jobId])).toBe(0);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({ state: 'planned', dryRun: true, task: { state: 'queued', result: null } });
  expect(bytes()).toEqual(before);
  expect(await cli(['cancel', '--job', input.jobId, '--apply'])).toBe(0);
  const receipt = output.at(-1)!, cancelled = bytes();
  expect(JSON.parse(receipt)).toMatchObject({ state: 'cancelled', dryRun: false,
    task: { jobId: input.jobId, peer: 'dot', state: 'cancelled', resource: 'imsg:dot', result: null } });
  expect(JSON.parse(cancelled[0]).tasks).toEqual([{ ...JSON.parse(before[0]).tasks[0], state: 'cancelled' }]);
  expect((await queue().read()).jobs).toMatchObject([{ id: input.jobId, status: 'BLOCKED',
    blockedReason: 'Operator withdrew unsent teammate task', claims: [{ owner: 'imsg:dot', finishedAt: expect.any(String) }] }]);
  expect(await cli(['list'])).toBe(0);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({ tasks: [{ jobId: input.jobId, state: 'cancelled', result: null }] });
  expect(await cli(['cancel', '--job', input.jobId, '--apply'])).toBe(0);
  expect(output.at(-1)).toBe(receipt); expect(bytes()).toEqual(cancelled);
  const jobs = (await queue().read()).jobs;
  expect(jobs).toHaveLength(1); expect(jobs[0].claims).toHaveLength(1);
});
it('refuses an attempted task, preserves both stores, and keeps send evidence unverified', async () => {
  // Same hermetic ledger-seeding convention as imessage-task-unsent-cancel-453s.
  const store = JSON.parse(readFileSync(ledger(), 'utf8'));
  Object.assign(store.tasks[0], { state: 'pending', attemptedAt: 1,
    receipt: { rowid: 7, sent: true, delivered: true, error: 0 } });
  writeFileSync(ledger(), JSON.stringify(store));
  const before = bytes();
  expect(await cli(['cancel', '--job', input.jobId, '--apply'])).toBe(1);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({ state: 'refused', reason: 'Cancellation cannot prove a remote stop' });
  expect(bytes()).toEqual(before);
  expect(await cli(['list'])).toBe(0);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({ tasks: [{ state: 'pending', attemptedAt: 1,
    receipt: { rowid: 7, sent: true, delivered: true, error: 0 }, result: null }] });
  expect(bytes()).toEqual(before);
  expect((await queue().read()).jobs[0]).toMatchObject({ status: 'CLAIMED', claims: [{ owner: 'imsg:dot' }] });
});
