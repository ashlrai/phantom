import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetImessageTasks } from '../src/cli/fleet-imessage-tasks.js';
import { cmdFleetTeammateTasks } from '../src/cli/fleet-teammate-tasks.js';
import { defaultConfig } from '../src/core/config.js';
import { enqueueTeammateTask, listTeammateTasks } from '../src/core/comms/imessage-teammate-tasks.js';
import { imessageStateDir } from '../src/core/integrations/imessage.js';

let runsDir: string;
const privateFields = { scope: 'FAKE_PRIVATE_SCOPE_466', summary: 'FAKE_PRIVATE_SUMMARY_466',
  handle: 'FAKE_PRIVATE_HANDLE_466', path: '/FAKE_PRIVATE_PATH_466' };
const send = vi.fn(() => { throw new Error('No send allowed'); });
const config = vi.fn(() => { throw new Error('No config read allowed'); });
beforeEach(async () => {
  runsDir = mkdtempSync(join(tmpdir(), 'exact-list-466-'));
  vi.clearAllMocks();
  for (const [index, jobId] of ['FAKE-466-A', 'FAKE-466-B', 'FAKE-466-B-extra'].entries()) {
    await enqueueTeammateTask({ jobId, peer: index === 1 ? 'instinct' : 'dot', kind: 'research',
      scope: privateFields.scope, repo: 'fixture/example', format: 'Fake refs', deadline: '2099-01-01T00:00:00Z' },
    defaultConfig(), { runsDir, apply: true, approved: () => 'fake@example.test', send });
  }
});
afterEach(() => {
  expect(config).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  rmSync(runsDir, { recursive: true, force: true });
});
it.each([cmdFleetImessageTasks, cmdFleetTeammateTasks])('selects persisted exact tasks through %s', async command => {
  const ledger = join(imessageStateDir(runsDir), 'teammate-tasks.json');
  const before = readFileSync(ledger, 'utf8');
  const list = vi.fn(() => {
    const report = listTeammateTasks({ runsDir });
    return { ...report, ...privateFields, tasks: report.tasks.map(task => ({ ...task, ...privateFields,
      receipt: { rowid: 1, sent: true, delivered: false, error: 0, ...privateFields },
      result: { rowid: 2, status: 'DONE' as const, at: 1, evidence: 'peer-reported', ...privateFields } })) };
  });
  for (const flags of [[], ['--json']]) {
    const output = vi.fn();
    expect(await command(['list', '--job', 'FAKE-466-B', ...flags], { list, config, output })).toBe(0);
    const raw = output.mock.calls[0][0]; const report = JSON.parse(raw);
    expect(report).toMatchObject({ selection: { jobId: 'FAKE-466-B' }, matched: true, state: 'healthy',
      coverage: 'local-evidence-only-peer-reported-results-unverified', claimKeyEvidence: 'label-only-queue-binding-unverified' });
    expect(report.tasks.map((task: { jobId: string }) => task.jobId)).toEqual(['FAKE-466-B']);
    expect(report.tasks[0]).toMatchObject({ peer: 'instinct', state: 'queued' });
    for (const value of ['FAKE_PRIVATE_', runsDir, ...JSON.parse(before).tasks.map((task: { token: string }) => task.token)])
      expect(raw).not.toContain(value);
    expect(await command(['list', '--job', 'FAKE-466-UNKNOWN', ...flags], { list, config, output })).toBe(0);
    expect(JSON.parse(output.mock.lastCall![0])).toMatchObject({ matched: false, tasks: [], selection: { jobId: 'FAKE-466-UNKNOWN' } });
  }
  expect(readFileSync(ledger, 'utf8')).toBe(before);
  expect(list).toHaveBeenCalledTimes(4); expect(list).toHaveBeenCalledWith();
});
it.each([[], ['bad/job'], [''], ['x'.repeat(81)], ['FAKE-466-B', '--job', 'FAKE-466-A']])('rejects selector %j before collection', async (...selector) => {
  const list = vi.fn(() => listTeammateTasks({ runsDir }));
  expect(await cmdFleetImessageTasks(['list', '--json', '--job', ...selector], { list, config, output: vi.fn() })).toBe(2);
  expect(list).not.toHaveBeenCalled();
});
it('keeps a failed persisted read unavailable rather than reporting no match', async () => {
  writeFileSync(join(imessageStateDir(runsDir), 'teammate-tasks.json'), 'invalid ledger');
  const list = vi.fn(() => listTeammateTasks({ runsDir })); const output = vi.fn();
  expect(await cmdFleetImessageTasks(['list', '--job', 'FAKE-466-B', '--json'], { list, config, output })).toBe(1);
  expect(list).toHaveBeenCalledOnce();
  expect(JSON.parse(output.mock.calls[0][0])).toEqual({ error: 'Teammate task operation unavailable; check configuration and task state.' });
  expect(output.mock.calls[0][0]).not.toContain('matched');
});
it.each(['unavailable', 'error', 'refused'])('does not turn a %s report into a miss', async state => {
  const output = vi.fn();
  expect(await cmdFleetImessageTasks(['list', '--job', 'FAKE-466-B', '--json'], {
    list: () => ({ state, schema: 'fixture', tasks: [] }), config, output,
  })).toBe(1);
  expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ state, matched: null, tasks: [] });
});
