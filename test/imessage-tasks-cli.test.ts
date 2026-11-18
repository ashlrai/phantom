import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import { cmdIMessageTasks, type IMessageTasksDeps } from '../src/cli/imessage-tasks.js';
import { cmdIMessage } from '../src/cli/imessage.js';

// The public route and every handler test stay entirely outside native transport.
const core = vi.hoisted(() => ({
  enqueueTeammateTask: vi.fn(), listTeammateTasks: vi.fn(),
  runTeammateTasks: vi.fn(), teammateTaskPeers: vi.fn(),
}));
vi.mock('../src/core/comms/imessage-teammate-tasks.js', () => core);

const cfg = { comms: { enabled: true } } as AshlrConfig;
const args = () => ['enqueue', '--peer', 'dot', '--job', 'RQ-CLI-1', '--kind', 'triage',
  '--scope', 'Inspect fixture checks', '--repo', 'example/fixture',
  '--format', 'Evidence links and next steps', '--deadline', '2030-01-01T12:00:00Z'];
const deps = () => ({
  enqueue: core.enqueueTeammateTask, list: core.listTeammateTasks,
  dispatch: core.runTeammateTasks, peers: core.teammateTaskPeers,
  config: vi.fn(() => cfg), output: vi.fn(),
} satisfies IMessageTasksDeps);

beforeEach(() => {
  vi.resetAllMocks();
  core.enqueueTeammateTask.mockResolvedValue({ schema: 'imessage.teammate-tasks.v1', state: 'planned', dryRun: true });
  core.runTeammateTasks.mockResolvedValue({ schema: 'imessage.teammate-tasks.v1', state: 'healthy', dryRun: true, sent: 0, replied: 0 });
  core.listTeammateTasks.mockReturnValue({ schema: 'imessage.teammate-tasks.v1', state: 'healthy', tasks: [] });
  core.teammateTaskPeers.mockReturnValue({ schema: 'imessage.teammate-tasks.v1', peers: [] });
});
afterEach(() => vi.restoreAllMocks());

describe('iMessage task CLI', () => {
  it('previews the exact scoped task by default without requesting dispatch', async () => {
    const d = deps();
    expect(await cmdIMessageTasks([...args(), '--pr', '17', '--pr', '23', '--json'], d)).toBe(0);
    expect(d.enqueue).toHaveBeenCalledExactlyOnceWith({
      jobId: 'RQ-CLI-1', peer: 'dot', kind: 'triage', scope: 'Inspect fixture checks',
      repo: 'example/fixture', prRefs: [17, 23], format: 'Evidence links and next steps',
      deadline: '2030-01-01T12:00:00Z',
    }, cfg, { apply: false });
    expect(d.dispatch).not.toHaveBeenCalled();
    expect(JSON.parse(d.output.mock.calls[0]![0])).toMatchObject({ state: 'planned', dryRun: true });
  });

  it.each([
    ['--apply', true], ['--dry-run', false],
  ] as const)('passes explicit %s to enqueue and dispatch', async (flag, apply) => {
    const d = deps();
    expect(await cmdIMessageTasks([...args(), flag], d)).toBe(0);
    expect(d.enqueue.mock.calls[0]![2]).toEqual({ apply });
    expect(await cmdIMessageTasks(['dispatch', flag], d)).toBe(0);
    expect(d.dispatch).toHaveBeenCalledExactlyOnceWith(cfg, { apply });
  });

  it('defaults dispatch to a preview', async () => {
    const d = deps();
    expect(await cmdIMessageTasks(['dispatch', '--json'], d)).toBe(0);
    expect(d.dispatch).toHaveBeenCalledExactlyOnceWith(cfg, { apply: false });
    expect(d.enqueue).not.toHaveBeenCalled();
  });

  it.each(['list', 'peers'])('reads %s even when config is unavailable', async command => {
    const d = deps();
    d.config.mockImplementation(() => { throw new Error('Config unavailable'); });
    expect(await cmdIMessageTasks([command, '--json'], d)).toBe(0);
    expect(d.config).not.toHaveBeenCalled();
    expect(command === 'list' ? d.list : d.peers).toHaveBeenCalledExactlyOnceWith();
    expect(d.enqueue).not.toHaveBeenCalled();
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    [], ['unknown'], ['list', 'extra'], ['list', '--apply'], ['peers', '--dry-run'],
    ['dispatch', '--scope', 'unexpected'], ['dispatch', '--apply', '--dry-run'],
    ['dispatch', '--json', '--json'], ['dispatch', '--unknown'],
    [...args(), '--peer', 'instinct'], [...args(), '--apply', '--dry-run'],
    [...args(), '--pr', '0'], [...args(), '--pr', '-1'], [...args(), '--pr', '1.5'],
    [...args(), '--pr', '9007199254740992'], [...args(), '--pr', '17', '--pr', '17'],
    args().filter((_, i) => i !== 3 && i !== 4),
    args().map(value => value === 'dot' ? 'unknown-peer' : value),
    args().map(value => value === 'triage' ? 'deploy' : value),
  ].map(invalid => [invalid]))('rejects invalid arguments before config or task I/O: %j', async invalid => {
    const d = deps();
    expect(await cmdIMessageTasks(invalid, d)).toBe(2);
    expect(d.config).not.toHaveBeenCalled();
    for (const fn of [d.enqueue, d.dispatch, d.list, d.peers]) expect(fn).not.toHaveBeenCalled();
  });

  it('prints help without config or task I/O', async () => {
    const d = deps();
    expect(await cmdIMessageTasks(['--help', '--json'], d)).toBe(0);
    expect(JSON.parse(d.output.mock.calls[0]![0]).usage).toContain('phm imessage tasks');
    expect(d.config).not.toHaveBeenCalled();
    expect(d.list).not.toHaveBeenCalled();
  });

  it('never prints raw operational exceptions', async () => {
    const d = deps();
    d.dispatch.mockRejectedValue(new Error('private transport exception body'));
    expect(await cmdIMessageTasks(['dispatch', '--apply', '--json'], d)).toBe(1);
    const text = d.output.mock.calls.map(call => call[0]).join('\n');
    expect(JSON.parse(text)).toEqual({ error: 'Teammate task operation unavailable; check configuration and task state.' });
    expect(text).not.toContain('private transport');
  });

  it.each(['error', 'unavailable', 'refused'])('returns failure for a %s report', async state => {
    const d = deps();
    d.dispatch.mockResolvedValue({ state });
    expect(await cmdIMessageTasks(['dispatch', '--json'], d)).toBe(1);
    expect(JSON.parse(d.output.mock.calls[0]![0])).toEqual({ state });
  });

  it('keeps pending work as a successful operational report', async () => {
    const d = deps();
    d.dispatch.mockResolvedValue({ state: 'pending', pending: 1 });
    expect(await cmdIMessageTasks(['dispatch', '--json'], d)).toBe(0);
  });

  it('routes the public imessage tasks command to the task handler', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdIMessage(['tasks', 'list', '--json'])).toBe(0);
    expect(core.listTeammateTasks).toHaveBeenCalledExactlyOnceWith();
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ tasks: [], state: 'healthy' });
    expect(core.runTeammateTasks).not.toHaveBeenCalled();
  });
});
