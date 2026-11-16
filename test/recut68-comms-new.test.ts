import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { planLogPath, readPlanLogReplies } from '../src/core/fleet/mason-outbox.js';

let runsDir: string;
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'recut68-comms-'));
  await mkdir(join(runsDir, 'leader'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(runsDir, { recursive: true, force: true });
});

it('planLogPath prefers the explicit file, then PHANTOM_PLAN_LOG, then the runs dir', () => {
  vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
  vi.stubEnv('PHANTOM_PLAN_LOG', '');
  expect(planLogPath()).toBe(join(runsDir, 'leader', 'PLAN-LOG.md'));
  vi.stubEnv('PHANTOM_PLAN_LOG', join(runsDir, 'env.md'));
  expect(planLogPath()).toBe(join(runsDir, 'env.md'));
  expect(planLogPath(join(runsDir, 'arg.md'))).toBe(join(runsDir, 'arg.md'));
});

it('readPlanLogReplies reads the --file path and explains a missing PLAN-LOG', async () => {
  const file = join(runsDir, 'leader', 'custom.md');
  await writeFile(file, '## 2026-11-09 09:00 ET\n**Reply for Mason**\nAnswer from a custom file');
  const ok = await readPlanLogReplies({ file });
  expect(ok.sourceState).toBe('healthy');
  expect(ok.entries.map(e => e.text)).toEqual(['Answer from a custom file']);
  const missing = await readPlanLogReplies({ file: join(runsDir, 'leader', 'nope.md') });
  expect(missing.sourceState).toBe('missing');
  expect(missing.entries).toEqual([]);
  expect(missing.reason).toBe(`No PLAN-LOG file at ${join(runsDir, 'leader', 'nope.md')}, so there are no replies yet.`);
});

it('runLeaderCli replies --file prints the reason instead of a bare "No replies yet."', async () => {
  vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
  const { runLeaderCli } = await import('../src/cli/leader.js');
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const file = join(runsDir, 'leader', 'custom.md');
    await writeFile(file, '## 2026-11-09 09:00 ET\n**Reply for Mason**\nFake reply U000FAKE');
    expect(await runLeaderCli(['replies', '--file', file, '--limit', '5'])).toBe(0);
    expect(String(log.mock.calls.at(-1)![0])).toContain('Fake reply U000FAKE');
    expect(await runLeaderCli(['replies', '--file', join(runsDir, 'leader', 'nope.md')])).toBe(0);
    expect(String(log.mock.calls.at(-1)![0])).toContain('No PLAN-LOG file at');
  } finally { log.mockRestore(); }
}, 90_000);
