import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readGuardianDrainCheckpoint } from '../src/core/fleet/guardian-drain-checkpoint.js';
import { drainGuardianInfraRetries, type GuardianDrainDeps } from '../src/core/fleet/guardian-retry-drain.js';
import type { GuardianVerifyExclusiveResult } from '../src/core/fleet/guardian-verify-exclusive.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-prepare-stop-')); dirs.push(dir);
  const sourceState = join(dir, 'source.json');
  const stopParent = join(dir, 'stop-parent');
  await mkdir(stopParent);
  await writeFile(sourceState, 'original', { mode: 0o600 });
  const options = { manifest: join(dir, 'manifest'), sourceState, outputDir: dir,
    stopFile: join(stopParent, 'stop'), maxRetries: 1, timeoutMs: 60000, apply: true };
  const select = vi.fn(async () => ({ repo: '/fake/repo', sha: 'a'.repeat(40) }));
  const ran = { state: 'ran', summary: { deadlineExceeded: false, cancelled: false } } as GuardianVerifyExclusiveResult;
  const verify = vi.fn(async () => ran);
  const prepareFile = async (outputState: string) => { await writeFile(outputState, 'prepared', { mode: 0o600 }); };
  return { dir, sourceState, stopParent, options, select, verify, prepareFile };
}

it.each(['stop', 'cancelled', 'unsafe', 'deadline'] as const)(
  'halts after preparation on %s without launching verification or checkpointing', async reason => {
    const f = await fixture();
    const controller = new AbortController();
    let time = 0;
    const prepare: NonNullable<GuardianDrainDeps['prepare']> = async ({ outputState }) => {
      await f.prepareFile(outputState);
      if (reason === 'stop') await writeFile(f.options.stopFile, 'stop');
      if (reason === 'cancelled') controller.abort();
      if (reason === 'unsafe') { await rm(f.stopParent, { recursive: true }); await writeFile(f.stopParent, 'not a directory'); }
      if (reason === 'deadline') time = 60000;
    };
    const result = await drainGuardianInfraRetries({ ...f.options, signal: controller.signal, now: () => time }, { ...f, prepare });
    expect(result).toMatchObject({ termination: reason === 'stop' ? 'stopped' : reason, attempts: 1,
      verified: 0, refused: 0, latestOutput: null, attempted: [{ repo: '/fake/repo', sha: 'a'.repeat(40) }] });
    expect(f.verify).not.toHaveBeenCalled();
    expect(readGuardianDrainCheckpoint(f.dir)).toBeNull();
    expect(await readFile(f.sourceState, 'utf8')).toBe('original');
    expect(await readFile(join(f.dir, 'guardian-drain-attempt-1.json'), 'utf8')).toBe('prepared');
  },
);

it('verifies and checkpoints when no stop file appears', async () => {
  const f = await fixture();
  const prepare: NonNullable<GuardianDrainDeps['prepare']> = async ({ outputState }) => f.prepareFile(outputState);
  const result = await drainGuardianInfraRetries(f.options, { ...f, prepare });
  expect(result).toMatchObject({ termination: 'max-retries', attempts: 1, verified: 1,
    latestOutput: join(f.dir, 'guardian-drain-attempt-1.json') });
  expect(f.verify).toHaveBeenCalledTimes(1);
  expect(readGuardianDrainCheckpoint(f.dir)?.latestOutput).toBe(result.latestOutput);
  expect(await readFile(f.sourceState, 'utf8')).toBe('original');
});
