import { expect, it, vi } from 'vitest';
import { isJobCommand, runTelegramJobCommand } from '../src/core/comms/telegram-job-command.js';

const report = { applied: true, moved: [{ id: 'RQ-PHX-FAKEJOB01', toLane: 'devin', toTier: 'work' }] };
const deps = () => ({
  stopJob: vi.fn(async () => ({ outcome: 'stopped', pids: [1] })),
  reassignQueuedJobs: vi.fn(async () => report),
});

it('defaults changedBy to telegram and honours an explicit value', async () => {
  const d = deps();
  await runTelegramJobCommand('/reassign RQ-PHX-FAKEJOB01 devin work', d as never);
  expect(d.reassignQueuedJobs).toHaveBeenLastCalledWith(expect.anything(), { changedBy: 'telegram' });
  await runTelegramJobCommand('/stop RQ-PHX-FAKEJOB01', d as never);
  expect(d.stopJob).toHaveBeenLastCalledWith('RQ-PHX-FAKEJOB01', { by: 'telegram' });
  await runTelegramJobCommand('/reassign RQ-PHX-FAKEJOB01 devin work', { ...d, changedBy: 'desktop' } as never);
  expect(d.reassignQueuedJobs).toHaveBeenLastCalledWith(expect.anything(), { changedBy: 'desktop' });
});

it('isJobCommand matches only /stop and /reassign prefixes', () => {
  expect(isJobCommand('/stop RQ-PHX-FAKEJOB01')).toBe(true);
  expect(isJobCommand('  /reassign')).toBe(true);
  expect(isJobCommand('/stopper x')).toBe(false);
  expect(isJobCommand('please /stop it')).toBe(false);
});
