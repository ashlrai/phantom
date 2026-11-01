import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
afterEach(() => vi.restoreAllMocks());
it('documents explicit configuration and failure semantics through cmdFleet', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleet(['planner', 'run', '--help'])).toBe(0);
  expect(log.mock.calls[0]![0]).toContain('timeoutMs');
  expect(log.mock.calls[0]![0]).toContain('No retry after launch');
});
it('rejects missing paths, unknown arguments, malformed config and missing prompt with JSON only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fake-planner-cli-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const config = join(root, 'config.json'); await writeFile(config, '{bad fake json');
    for (const args of [[], ['--wat'], ['--config', config, '--prompt-file', join(root, 'missing')]]) {
      expect(await cmdFleet(['planner', 'run', ...args, '--json'])).toBe(1);
      expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ status: 'failed', exitCode: null });
    }
    await writeFile(config, JSON.stringify({ timeoutMs: 0, candidates: [] }));
    expect(await cmdFleet(['planner', 'run', '--config', config, '--prompt-file', config, '--json'])).toBe(1);
    await writeFile(config, JSON.stringify({ timeoutMs: 10, candidates: [{ provider: 'fake', executable: process.execPath, argv: [], cwd: root, runsRoot: root, CODEX_HOME: join(homedir(), '.codex') }] }));
    expect(await cmdFleet(['planner', 'run', '--config', config, '--prompt-file', config, '--json'])).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
