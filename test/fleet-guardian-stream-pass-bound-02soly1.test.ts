import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetGuardianContinue } from '../src/cli/fleet-guardian-continue.js';
import { cmdFleetGuardianStreamContinue } from '../src/cli/fleet-guardian-stream-continue.js';

const summary = JSON.stringify({ record: 'summary', mode: 'apply', termination: 'drained',
  attempts: 1, verified: 1, refused: 0, attempted: [], planned: [], latestOutput: null, session: '/tmp/fake-guardian-session' });
const input = ['{"record":"attempt"}\n', '{"record":"pass"}\n', `${summary}\n`];
const loop = ['--duration-ms', '10000', '--interval-ms', '1000'];

afterEach(() => { vi.restoreAllMocks(); });

it('forwards the capped loop arguments and terminal summary unchanged', async () => {
  const args = ['--stdin', '--manifest', '/tmp/fake-manifest', ...loop, '--max-passes', '02', '--json'];
  const delegate = vi.fn(async (_args: string[], deps?: { readInput?: () => Promise<string | Uint8Array> }) => {
    expect(await deps!.readInput!()).toBe(summary);
    return 7;
  });
  expect(await cmdFleetGuardianStreamContinue(args, { input, delegate })).toBe(7);
  expect(delegate).toHaveBeenCalledOnce();
  expect(delegate.mock.calls[0]![0]).toEqual(args);
});

it('rejects malformed argument structure before reading or delegating', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const delegate = vi.fn(async () => 0);
  const read = vi.fn();
  const unread = { [Symbol.asyncIterator]: () => { read(); throw new Error(); } };
  for (const flags of [
    ['--max-passes'], ['--max-passes', ''], ['--max-passes', '--json'],
    ['--max-passes', '1', '--max-passes', '2'], ['--max-passes', '1', '--unknown'],
    ['--max-passes', '1', '--json', '--stream'],
  ]) {
    expect(await cmdFleetGuardianStreamContinue(['--stdin', ...loop, ...flags], { input: unread, delegate })).toBe(2);
  }
  expect(read).not.toHaveBeenCalled();
  expect(delegate).not.toHaveBeenCalled();
});

it('uses the real continuation validator before resuming and forwards a valid cap', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const resume = vi.fn(async () => 9);
  const delegate: typeof cmdFleetGuardianContinue = (args, deps) => cmdFleetGuardianContinue(args, { ...deps, resume });
  for (const flags of [
    [...loop, '--max-passes', '0'], [...loop, '--max-passes', '1.5'],
    ['--max-passes', '1'], ['--duration-ms', '10000', '--max-passes', '1'],
    ['--interval-ms', '1000', '--max-passes', '1'],
  ]) {
    expect(await cmdFleetGuardianStreamContinue(['--stdin', ...flags], { input, delegate })).toBe(2);
  }
  expect(resume).not.toHaveBeenCalled();
  const flags = [...loop, '--max-passes', '2'];
  expect(await cmdFleetGuardianStreamContinue(['--stdin', ...flags], { input, delegate })).toBe(9);
  expect(resume).toHaveBeenCalledOnce();
  expect(resume.mock.calls[0]![0]).toEqual(['--checkpoint-dir', '/tmp/fake-guardian-session', ...flags]);
});
