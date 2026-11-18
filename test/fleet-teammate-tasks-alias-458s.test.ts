import { expect, it, vi } from 'vitest';
import { cmdFleetTeammateTasks, type FleetTeammateTasksDeps } from '../src/cli/fleet-teammate-tasks.js';
import { defaultConfig } from '../src/core/config.js';
const hidden = { token: 'FAKE_PRIVATE', scope: 'FAKE_PRIVATE', format: 'FAKE_PRIVATE', unknown: { nested: 'FAKE_PRIVATE' } };
const receipt = { rowid: 1, sent: false, delivered: false, error: 0 };
const result = { rowid: 2, status: 'DONE' as const, at: 1, evidence: 'peer-reported' };
const task = { jobId: 'FAKE-458', peer: 'dot' as const, resource: 'imsg:dot', state: 'queued' as const,
  claimKey: 'queue:imsg.dot.FAKE-458', createdAt: 1, deadline: '2099-01-01T00:00:00Z',
  ...hidden, receipt: { ...receipt, ...hidden }, result: { ...result, ...hidden } };
const enqueue = ['enqueue', '--peer', 'dot', '--job', task.jobId, '--kind', 'research', '--scope', 'Fake scope',
  '--repo', 'fixture/example', '--format', 'Evidence', '--deadline', task.deadline];
it.each([[], ['--json']])('uses safe receipts and compatible operations %j', async (...flags) => {
  const output = vi.fn();
  const list = vi.fn(() => ({ state: 'healthy', tasks: [task], ...hidden }));
  const config = vi.fn(defaultConfig);
  const deps: FleetTeammateTasksDeps = { list, config, output };
  expect(await cmdFleetTeammateTasks(['list', ...flags], deps)).toBe(0);
  const report = JSON.parse(output.mock.calls[0][0]);
  expect(report.tasks).toEqual([{ jobId: task.jobId, peer: task.peer, resource: task.resource, state: task.state,
    claimKey: task.claimKey, createdAt: 1, deadline: task.deadline, receipt, result }]);
  expect(report).toMatchObject({ coverage: 'local-evidence-only-peer-reported-results-unverified', claimKeyEvidence: 'label-only-queue-binding-unverified' });
  expect(output.mock.calls[0][0]).not.toContain('FAKE_PRIVATE'); expect(config).not.toHaveBeenCalled();
  for (const args of [['cancel', '--job', task.jobId], enqueue, ['dispatch'], ['peers']]) {
    const name = args[0] as 'cancel' | 'enqueue' | 'dispatch' | 'peers';
    for (const apply of name === 'peers' ? [false] : [false, true]) {
      const operation = vi.fn(async () => ({ state: 'planned', dryRun: !apply }));
      expect(await cmdFleetTeammateTasks([...args, ...flags, ...(apply ? ['--apply'] : [])], { ...deps, [name]: operation })).toBe(0);
      expect(operation).toHaveBeenCalledTimes(1);
      expect(operation).toHaveBeenCalledWith(...(name === 'peers' ? [] : name === 'cancel' ? [task.jobId, { apply }] : name === 'enqueue' ? [expect.objectContaining({ jobId: task.jobId }), expect.any(Object), { apply }] : [expect.any(Object), { apply }]));
    }
  }
  list.mockImplementation(() => { throw new Error('FAKE_PRIVATE'); });
  expect(await cmdFleetTeammateTasks(['list', ...flags], deps)).toBe(1);
  expect(output.mock.lastCall?.[0]).toContain('operation unavailable'); expect(output.mock.lastCall?.[0]).not.toContain('FAKE_PRIVATE');
  expect(await cmdFleetTeammateTasks(['--help', ...flags], deps)).toBe(0);
  expect(output.mock.lastCall?.[0]).toContain('phm fleet imessage-tasks cancel');
});
it.each([['cancel'], ['cancel', '--job', 'bad/job'], ['cancel', '--job', 'FAKE-458', '--apply', '--dry-run'], ['list', '--apply'], ['dispatch', '--json', '--json'], [...enqueue, '--unknown'], enqueue.map(x => x === 'fixture/example' ? 'bad' : x)])('rejects invalid arguments before access %j', async (...args) => {
  const access = vi.fn(() => { throw new Error('FAKE_PRIVATE'); }); const output = vi.fn();
  expect(await cmdFleetTeammateTasks(args, { config: access, enqueue: access, cancel: access, list: access, dispatch: access, peers: access, output })).toBe(2);
  expect(access).not.toHaveBeenCalled(); expect(output.mock.lastCall?.[0]).not.toContain('FAKE_PRIVATE');
});
