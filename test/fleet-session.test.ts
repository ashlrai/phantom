import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { followFleetSession, getFleetSession } from '../src/core/fleet/session.js';
import { cmdFleet } from '../src/cli/fleet.js';

let queueDir: string;
const job = 'RQ-SESSION';
async function record(row: object) {
  await appendFile(join(queueDir, 'jobs.jsonl'), JSON.stringify({ job, ...row }) + '\n');
}
beforeEach(async () => {
  queueDir = await mkdtemp(join(tmpdir(), 'fleet-session-'));
  await mkdir(join(queueDir, 'logs'));
});
afterEach(async () => { vi.restoreAllMocks(); await rm(queueDir, { recursive: true, force: true }); });

it('returns finished job metadata, lane, PR, provider links and log via the CLI', async () => {
  await record({ pool: 'codex-personal', repo: 'phantom', tier: 'frontier', to: 'RUNNING',
    codexUrl: 'https://chatgpt.com/codex/tasks/example', devinUrl: 'https://app.devin.ai/sessions/example',
    claudeUrl: 'https://claude.ai/chat/example' });
  await appendFile(join(queueDir, 'jobs.jsonl'), '{broken\n');
  await record({ to: 'LAND', prUrl: 'https://github.com/ashlrai/phantom/pull/42' });
  await writeFile(join(queueDir, 'logs', `${job}.log`), 'checks passed\n');
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleet(['session', job, '--json', '--follow', '--queue-dir', queueDir])).toBe(0);
  expect(output).toHaveBeenCalledTimes(1);
  expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({ job, lane: 'codex-personal',
    repo: 'phantom', tier: 'frontier', status: 'LAND', finished: true,
    prUrl: 'https://github.com/ashlrai/phantom/pull/42', log: 'checks passed\n',
    sessions: { codex: 'https://chatgpt.com/codex/tasks/example', devin: 'https://app.devin.ai/sessions/example', claude: 'https://claude.ai/chat/example' } });
});
it('follows a running job through log creation, append, truncation and completion', async () => {
  await record({ pool: 'devin', status: 'RUNNING' });
  const stream = followFleetSession(job, { queueDir, follow: true, pollMs: 1 });
  expect((await stream.next()).value).toMatchObject({ log: '', finished: false });
  const log = join(queueDir, 'logs', `${job}.log`);
  await writeFile(log, 'working\n');
  expect((await stream.next()).value).toMatchObject({ log: 'working\n' });
  await appendFile(log, 'testing\n');
  expect((await stream.next()).value).toMatchObject({ log: 'working\ntesting\n' });
  await writeFile(log, 'done\n');
  await record({ to: 'COMPLETED' });
  expect((await stream.next()).value).toMatchObject({ log: 'done\n', finished: true });
  expect((await stream.next()).done).toBe(true);
});
it('returns a JSON error and nonzero status for an unknown job', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleet(['session', 'missing', '--json', '--queue-dir', queueDir])).toBe(1);
  expect(JSON.parse(output.mock.calls[0]![0])).toHaveProperty('error');
});
it('bounds log tails, refuses unsafe links and supports cancellation', async () => {
  await record({ status: 'RUNNING', codexUrl: 'https://example.com/?token=private' });
  await writeFile(join(queueDir, 'logs', `${job}.log`), 'old\n'.repeat(20000) + 'latest\n');
  const snapshot = await getFleetSession(job, { queueDir });
  expect(Buffer.byteLength(snapshot.log)).toBeLessThanOrEqual(65536);
  expect(snapshot.log.endsWith('latest\n')).toBe(true);
  expect(snapshot.sessions.codex).toBeNull();
  const controller = new AbortController();
  const stream = followFleetSession(job, { queueDir, follow: true, signal: controller.signal });
  await stream.next();
  controller.abort();
  expect((await stream.next()).done).toBe(true);
});
it('rejects invalid ids and CLI arguments', async () => {
  await expect(getFleetSession('../escape', { queueDir })).rejects.toThrow('invalid job id');
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  expect(await cmdFleet(['session', job, '--json', '--typo'])).toBe(2);
  expect(await cmdFleet(['session', job])).toBe(2);
});
