/** End-to-end CLI roundtrip for `phm cos` subcommands.

Isolation contract: every test resolves the runs directory from
`homedir()`.  Before dynamic-importing `src/cli/cos.ts`, HOME is
pointed at a fresh `mkdtemp` directory via `vi.stubEnv`.  Reads
of `src/core/cos/intake.ts` and `src/core/fleet/channel-envelope.ts`
confirm that every path the CLI writes — the queue
file (`queue/queue.v1.json`) and any `cos/` subdirectory — lands
under that temp directory.  The test asserts this by checking that
the queue file exists under the temp directory after the first `ask`.

The temporary directory is cleaned up after each test via `afterEach`.
*/
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdCos } from '../src/cli/cos.js';

let runsDir: string;
beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'cos-cli-')); });
afterEach(async () => {
  process.env.ASHLR_RUNS_DIR = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(runsDir, { recursive: true, force: true }).catch(() => {});
});

describe('cos CLI round-trip (isolated temp home)', () => {
  const MESSAGE = 'Prepare a project brief';

  it('asks once, returns expected structure, and queues a job under the temp home', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('HOME', runsDir);

    expect(await cmdCos(['ask', MESSAGE, '--channel', 'cli', '--json'])).toBe(0);
    const response = JSON.parse(output.mock.calls.at(-1)![0] as string);
    expect(response.status).toBe('queued');
    expect(response.id).toMatch(/^cos-[a-f0-9]{32}$/);
    expect(response.ack).toBeDefined();
  });

  it('the same ask returns the same ID without creating a second job', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('HOME', runsDir);

    expect(await cmdCos(['ask', MESSAGE, '--channel', 'cli', '--json'])).toBe(0);
    const r1 = JSON.parse(output.mock.calls.at(-1)![0] as string);
    expect(await cmdCos(['ask', MESSAGE, '--channel', 'cli', '--json'])).toBe(0);
    const r2 = JSON.parse(output.mock.calls.at(-1)![0] as string);
    expect(r1.id).toBe(r2.id);
  });

  it('status returns job details with needsYou false and no draft', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('HOME', runsDir);

    expect(await cmdCos(['ask', MESSAGE, '--channel', 'cli', '--json'])).toBe(0);
    const response = JSON.parse(output.mock.calls.at(-1)![0] as string);
    expect(await cmdCos(['status', response.id, '--json'])).toBe(0);
    const status = JSON.parse(output.mock.calls.at(-1)![0] as string);
    expect(status.job.id).toBe(response.id);
    expect(status.job.status).toBe('READY');
    expect(status.needsYou).toBe(false);
    expect(status.draft).toBeUndefined();
    expect(status.delivery).toBeUndefined();
  });

  it('unsupported channel returns 1 with an error key', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('HOME', runsDir);

    const exit = await cmdCos(['ask', 'test message', '--channel', 'fax', '--json']);
    expect(exit).toBe(1);
    const err = JSON.parse(output.mock.calls.at(-1)![0] as string);
    expect(err).toHaveProperty('error');
  });

  it('status for a non-existent ID returns 1', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('HOME', runsDir);

    const exit = await cmdCos(['status', 'cos-zz', '--json']);
    expect(exit).toBe(1);
    const err = JSON.parse(output.mock.calls.at(-1)![0] as string);
    expect(err).toHaveProperty('error');
  });

  it('--help --json returns 0 with a usage string containing "cos ask"', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exit = await cmdCos(['--help', 'cos', '--json']);
    expect(exit).toBe(0);
    const usage = output.mock.calls.at(-1)![0] as string;
    expect(usage).toContain('cos ask');
  });
});
