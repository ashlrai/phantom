import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetImessageTasks } from '../src/cli/fleet-imessage-tasks.js';
import { defaultConfig } from '../src/core/config.js';
import { cancelTeammateTask, enqueueTeammateTask, listTeammateTasks, runTeammateTasks } from '../src/core/comms/imessage-teammate-tasks.js';
import { QueueStore } from '../src/core/queue/store.js';

let runsDir: string, queue: QueueStore, unrelated: string;
const send = vi.fn(async (): Promise<'accepted'> => 'accepted');
const reconcile = vi.fn(async () => { throw new Error('No transport reconciliation allowed'); });
const cfg = defaultConfig();
const input = { jobId: 'FAKE-CANCEL-453', peer: 'dot', kind: 'research', scope: 'Private fake scope',
  repo: 'fixture/example', format: 'Fake deliverable', deadline: '2099-01-01T00:00:00Z' } as const;
const opts = () => ({ runsDir, apply: true, approved: () => 'fake-handle', send, reconcile });
const statePath = () => join(runsDir, 'imessage', 'teammate-tasks.json');
const bytes = () => [readFileSync(statePath(), 'utf8'), readFileSync(queue.path, 'utf8')];
const cli = (args: string[], output = vi.fn()) => cmdFleetImessageTasks(args, {
  output, config: () => { throw new Error('No config access'); },
  cancel: (id, options) => cancelTeammateTask(id, { ...options, runsDir }),
});
beforeEach(async () => {
  runsDir = mkdtempSync(join(tmpdir(), 'imsg-cancel-453-'));
  vi.stubEnv('HOME', runsDir); vi.stubEnv('ASHLR_RUNS_DIR', runsDir); vi.stubEnv('PHANTOM_STACKSYNC', 'off');
  queue = new QueueStore(join(runsDir, 'queue'));
  await queue.add({ id: 'FAKE-OTHER', status: 'READY', priority: 'P2', tier: 'work', repo: 'fixture/example',
    scope: 'Unrelated fixture', acceptance: 'Fake evidence', deps: [], claims: [] });
  unrelated = JSON.stringify((await queue.read()).jobs[0]);
  await enqueueTeammateTask(input, cfg, opts());
});
afterEach(async () => {
  expect(send).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled();
  expect(JSON.stringify((await queue.read()).jobs[0])).toBe(unrelated);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(runsDir, { recursive: true, force: true });
});
it('CLI previews without writes; applies, reloads, repeats, and never revives the same envelope', async () => {
  const before = bytes(), output = vi.fn();
  for (const flags of [[], ['--dry-run']]) expect(await cli(['cancel', '--job', input.jobId, ...flags])).toBe(0);
  expect(bytes()).toEqual(before);
  expect(await cli(['cancel', '--job', input.jobId, '--apply', '--json'], output)).toBe(0);
  const cancelled = bytes();
  expect(JSON.parse(cancelled[0]).tasks[0]).toEqual({ ...JSON.parse(before[0]).tasks[0], state: 'cancelled' });
  expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ state: 'cancelled', dryRun: false });
  expect(output.mock.calls[0][0]).not.toMatch(/Private fake scope|Fake deliverable|fake-handle|summary/);
  expect(listTeammateTasks({ runsDir }).tasks[0]).toMatchObject({ state: 'cancelled', token: JSON.parse(before[0]).tasks[0].token });
  expect(await cli(['cancel', '--job', input.jobId, '--apply', '--json'], output)).toBe(0);
  expect(output.mock.calls[1][0]).toBe(output.mock.calls[0][0]); expect(bytes()).toEqual(cancelled);
  expect((await enqueueTeammateTask(input, cfg, opts())).state).toBe('cancelled');
  await expect(enqueueTeammateTask({ ...input, scope: 'Different fake scope' }, cfg, opts())).rejects.toThrow('different envelope');
  expect((await runTeammateTasks(cfg, opts())).pending).toBe(0);
  expect((await queue.read()).jobs[1]).toMatchObject({ status: 'BLOCKED', blockedReason: 'Operator withdrew unsent teammate task', claims: [{ owner: 'imsg:dot', finishedAt: expect.any(String) }] });
  expect(existsSync(join(runsDir, 'metrics', 'jobs.jsonl'))).toBe(false);
});
it.each(['cancel', 'drain'])('repairs a failure after tombstone through %s without transport', async repair => {
  vi.spyOn(QueueStore.prototype, 'finish').mockRejectedValueOnce(new Error('private injected fault'));
  const output = vi.fn();
  expect(await cli(['cancel', '--job', input.jobId, '--apply', '--json'], output)).toBe(1);
  expect(output.mock.calls[0][0]).not.toContain('private injected fault');
  expect(listTeammateTasks({ runsDir }).tasks[0].state).toBe('cancelled');
  expect((await queue.read()).jobs[1].status).toBe('CLAIMED');
  if (repair === 'cancel') expect((await cancelTeammateTask(input.jobId, opts())).state).toBe('cancelled');
  else expect((await runTeammateTasks(cfg, opts())).pending).toBe(0);
  expect((await queue.read()).jobs[1].status).toBe('BLOCKED');
  expect(existsSync(join(runsDir, 'metrics', 'jobs.jsonl'))).toBe(false);
});
it.each(['sending', 'pending', 'replied', 'expired', 'attempt', 'receipt', 'metric', 'journal', 'elapsed', 'owner', 'envelope'])('refuses %s without mutation', async boundary => {
  const store = JSON.parse(readFileSync(statePath(), 'utf8')), task = store.tasks[0];
  if (['sending', 'pending', 'replied', 'expired'].includes(boundary)) task.state = boundary;
  if (['sending', 'pending', 'replied', 'attempt'].includes(boundary)) task.attemptedAt = 0;
  if (['pending', 'replied', 'receipt'].includes(boundary)) task.receipt = { rowid: 1, sent: true, delivered: true, error: 0 };
  if (boundary === 'replied') task.result = { rowid: 2, status: 'DONE', summary: 'Fake summary', at: 1 };
  if (boundary === 'metric') task.metrics = ['launch'];
  if (boundary === 'elapsed') task.deadline = '2000-01-01T00:00:00Z';
  if (boundary === 'journal') { mkdirSync(join(runsDir, 'metrics')); writeFileSync(join(runsDir, 'metrics', 'jobs.jsonl'), JSON.stringify({ event: 'launch', job: input.jobId }) + '\n', { mode: 0o600 }); }
  if (boundary === 'owner' || boundary === 'envelope') {
    const doc = await queue.read();
    if (boundary === 'owner') doc.jobs[1].claims[0].owner = 'fake-other-owner'; else doc.jobs[1].acceptance = 'Other fake envelope';
    writeFileSync(queue.path, JSON.stringify(doc));
  }
  writeFileSync(statePath(), JSON.stringify(store)); const before = bytes();
  expect((await cancelTeammateTask(input.jobId, opts())).state).toBe('refused'); expect(bytes()).toEqual(before);
});
it('validates real CLI and core arguments before I/O and reports missing IDs', async () => {
  const before = bytes(), cancel = vi.fn(), config = vi.fn(), output = vi.fn();
  for (const args of [[], ['--job', '../bad'], ['--job', input.jobId, '--apply', '--dry-run'], ['--job', input.jobId, '--scope', 'fake']])
    expect(await cmdFleetImessageTasks(['cancel', ...args], { cancel, config, output })).toBe(2);
  expect(cancel).not.toHaveBeenCalled(); expect(config).not.toHaveBeenCalled();
  await expect(cancelTeammateTask('../bad', { runsDir: '/nonexistent-fake-root', apply: true })).rejects.toThrow('Invalid teammate job id');
  expect(await cli(['cancel', '--job', 'FAKE-MISSING', '--apply'])).toBe(1);
  expect((await cancelTeammateTask('FAKE-MISSING', { runsDir })).reason).toContain('not found'); expect(bytes()).toEqual(before);
});

it('fails closed on unavailable launch evidence without exposing its contents', async () => {
  mkdirSync(join(runsDir, 'metrics'));
  writeFileSync(join(runsDir, 'metrics', 'jobs.jsonl'), 'fake private malformed evidence\n', { mode: 0o600 });
  const before = bytes();
  await expect(cancelTeammateTask(input.jobId, opts())).rejects.toThrow('Teammate launch evidence unavailable');
  expect(bytes()).toEqual(before);
});
