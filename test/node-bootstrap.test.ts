import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdNode } from '../src/cli/node.js';

// Every capability the planner must avoid fails immediately if invoked.
vi.mock('node:child_process', () => ({
  exec: () => { throw new Error('No processes in the planner'); },
  execFile: () => { throw new Error('No processes in the planner'); },
  spawn: () => { throw new Error('No processes in the planner'); },
}));
vi.mock('node:fs', () => ({
  readFileSync: () => { throw new Error('No host reads in the planner'); },
  writeFileSync: () => { throw new Error('No writes in the planner'); },
}));
vi.mock('node:fs/promises', () => ({
  readFile: () => { throw new Error('No host reads in the planner'); },
  writeFile: () => { throw new Error('No writes in the planner'); },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function capture() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetch = vi.fn(() => { throw new Error('No network in the planner'); });
  vi.stubGlobal('fetch', fetch);
  return { log, error, fetch };
}

describe('node bootstrap dry-run', () => {
  it('prints an ordered, explicitly non-executable registry handoff without I/O', async () => {
    const { log, error, fetch } = capture();
    expect(await cmdNode(['bootstrap', '--dry-run'])).toBe(0);
    const output = log.mock.calls.map(([line]) => line).join('\n');
    expect(output).toContain('dry-run only');
    expect(output).toContain('30%');
    expect(output).toContain('20 GB');
    expect(output).toContain('device-code');
    expect(output).toContain('Registry join (STUB)');
    expect(output).toContain('Lease handshake (STUB)');
    expect(output.indexOf('Registry join')).toBeLessThan(output.indexOf('Lease handshake'));
    expect(output).toContain('Never self-renew offline');
    expect(error).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('emits one machine-readable plan with no claim of readiness', async () => {
    const { log, fetch } = capture();
    expect(await cmdNode(['bootstrap', '--json', '--dry-run'])).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    const plan = JSON.parse(log.mock.calls[0]![0] as string);
    expect(plan).toMatchObject({
      schemaVersion: 1, dryRun: true, executable: false,
      registry: { status: 'stub', dependency: 'RQ-DRIVER-NODES-1-LEASE' },
      template: 'contrib/nodes/lima/phantom-node.yaml',
    });
    expect(plan.steps.length).toBeGreaterThan(5);
    expect(plan).not.toHaveProperty('ready');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [], ['bootstrap'], ['bootstrap', '--execute'], ['join', '--dry-run'],
    ['bootstrap', '--dry-run', '--execute'], ['bootstrap', '--dry-run', '--token=private'],
    ['bootstrap', '--dry-run', '--dry-run'], ['bootstrap', '--dry-run', 'unexpected'],
    ['bootstrap', '--dry-run', '--json', '--json'],
  ])('refuses unsupported invocation %j without echoing arguments', async (...args: string[]) => {
    const { log, error, fetch } = capture();
    expect(await cmdNode(args)).toBe(2);
    expect([...log.mock.calls, ...error.mock.calls].flat().join(' ')).not.toContain('private');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns structured usage errors when JSON is requested', async () => {
    const { log, error } = capture();
    expect(await cmdNode(['bootstrap', '--json'])).toBe(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ executable: false });
    expect(error).not.toHaveBeenCalled();
  });

  it.each([['--help'], ['bootstrap', '-h'], ['bootstrap', '--execute', '--help']])(
    'help never acts: %j', async (...args: string[]) => {
      const { log, error, fetch } = capture();
      expect(await cmdNode(args)).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: phm node bootstrap --dry-run'));
      expect(error).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
