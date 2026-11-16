import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import * as command from '../src/cli/fleet-imessage-tasks.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { defaultConfig } from '../src/core/config.js';
import { enqueueTeammateTask, runTeammateTasks } from '../src/core/comms/imessage-teammate-tasks.js';

const input = { peer: 'dot', jobId: 'FAKE-451', kind: 'research', scope: 'Review fake fixture',
  repo: 'fixture/example', format: 'Evidence refs', deadline: '2099-01-01T00:00:00Z' } as const;
const enqueue = ['enqueue', '--peer', input.peer, '--job', input.jobId, '--kind', input.kind,
  '--scope', input.scope, '--repo', input.repo, '--format', input.format, '--deadline', input.deadline];
function fixture() {
  return { config: vi.fn(defaultConfig), output: vi.fn(),
    enqueue: vi.fn(async () => ({ state: 'planned' })), dispatch: vi.fn(async () => ({ state: 'healthy' })),
    list: vi.fn(() => ({ state: 'healthy', tasks: [] })), peers: vi.fn(() => ({ peers: [] })) };
}
describe('recovered fleet imessage-tasks operator commands', () => {
  it('exports the handler selected by the fleet convention', async () => {
    expect(resolveFleetSubcommand('imessage-tasks')).toEqual({
      module: './fleet-imessage-tasks.js', exportName: 'cmdFleetImessageTasks' });
    expect(command.cmdFleetImessageTasks).toBeTypeOf('function');
    const output = vi.fn();
    expect(await cmdFleet(['imessage-tasks', '--help'], { 'imessage-tasks': async () => ({
      cmdFleetImessageTasks: (args: string[]) => command.cmdFleetImessageTasks(args, { output }),
    }) })).toBe(0);
    expect(output.mock.calls[0][0]).toContain('phm fleet imessage-tasks');
  });
  it.each([[], ['--dry-run'], ['--apply']])('preserves enqueue fields and explicit apply %j', async (...flags) => {
    const deps = fixture();
    expect(await command.cmdFleetImessageTasks([...enqueue, '--pr', '1', '--pr', '9007199254740991', ...flags], deps)).toBe(0);
    expect(deps.enqueue).toHaveBeenCalledWith({ ...input, prRefs: [1, Number.MAX_SAFE_INTEGER] },
      expect.any(Object), { apply: flags.includes('--apply') });
    expect(deps.dispatch).not.toHaveBeenCalled();
  });
  it.each([[], ['--dry-run'], ['--apply']])('dispatch previews unless explicitly applied %j', async (...flags) => {
    const deps = fixture();
    expect(await command.cmdFleetImessageTasks(['dispatch', ...flags], deps)).toBe(0);
    expect(deps.dispatch).toHaveBeenCalledWith(expect.any(Object), { apply: flags.includes('--apply') });
  });
  it.each(['list', 'peers'] as const)('%s only calls its read API', async op => {
    const deps = fixture();
    expect(await command.cmdFleetImessageTasks([op, '--json'], deps)).toBe(0);
    expect(deps[op]).toHaveBeenCalledWith();
    for (const name of ['config', 'enqueue', 'dispatch', op === 'list' ? 'peers' : 'list'] as const)
      expect(deps[name]).not.toHaveBeenCalled();
  });
  it.each([
    [], ['unknown'], ['list', '--apply'], ['peers', '--dry-run'], ['dispatch', '--peer', 'dot'],
    ['dispatch', '--apply', '--dry-run'], ['list', 'extra'], ['list', '--json', '--json'],
    ...['--unknown', '--peer=instinct'].map(flag => [...enqueue, flag]),
    ...[['--deadline', 'bad'], ['--scope', ''], ['--repo', 'invalid'], ['--peer', 'fake'],
      ['--deadline', '2000-01-01T00:00:00Z'], ['--scope', 'x'.repeat(1201)]].map(([key, value]) =>
      enqueue.map((arg, index) => enqueue[index - 1] === key ? value : arg)),
    ...['0', '-1', '1.5', '01', '9007199254740992', '1e2'].map(pr => [...enqueue, '--pr', pr]),
    [...enqueue, '--pr', '1', '--pr', '1'], ['enqueue'], [...enqueue, '--job'],
  ])('rejects malformed argv without config or ledger access: %j', async (...args) => {
    const deps = fixture();
    expect(await command.cmdFleetImessageTasks(args, deps)).toBe(2);
    for (const name of ['config', 'enqueue', 'dispatch', 'list', 'peers'] as const)
      expect(deps[name]).not.toHaveBeenCalled();
  });
  it.each(['error', 'unavailable', 'refused', 'pending'])('preserves status exit behavior: %s', async state => {
    expect(await command.cmdFleetImessageTasks(['list'], { list: () => ({ state, tasks: [], schema: 'fake' }),
      output: vi.fn() })).toBe(state === 'pending' ? 0 : 1);
  });
  it('scrubs operational failures and serves renamed help without reads', async () => {
    const deps = fixture(); deps.list.mockImplementation(() => { throw new Error('private fixture detail'); });
    expect(await command.cmdFleetImessageTasks(['list', '--json'], deps)).toBe(1);
    expect(deps.output.mock.calls[0][0]).not.toContain('private fixture detail');
    deps.output.mockClear();
    expect(await command.cmdFleetImessageTasks(['--help'], deps)).toBe(0);
    expect(deps.output.mock.calls[0][0]).toContain('phm fleet imessage-tasks');
    expect(deps.config).not.toHaveBeenCalled();
  });
  it('previews the real ledger in an empty temporary root without reserving or sending', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'imsg-451-'));
    const send = vi.fn(() => { throw new Error('No transport allowed'); });
    const output = vi.fn();
    try {
      const deps = { output, config: defaultConfig,
        enqueue: (data: Parameters<typeof enqueueTeammateTask>[0], cfg: ReturnType<typeof defaultConfig>, options: object) =>
          enqueueTeammateTask(data, cfg, { ...options, runsDir, approved: () => null, send }),
        dispatch: (cfg: ReturnType<typeof defaultConfig>, options: object) => runTeammateTasks(cfg, { ...options, runsDir, send }) };
      expect(await command.cmdFleetImessageTasks([...enqueue, '--json'], deps)).toBe(0);
      expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ state: 'planned', dryRun: true });
      expect(await command.cmdFleetImessageTasks(['dispatch', '--json'], deps)).toBe(0);
      expect(JSON.parse(output.mock.calls[1][0])).toMatchObject({ tasks: [], dryRun: true, sent: 0 });
      expect(readdirSync(runsDir)).toEqual([]);
      expect(send).not.toHaveBeenCalled();
    } finally { rmSync(runsDir, { recursive: true, force: true }); }
  });
});
