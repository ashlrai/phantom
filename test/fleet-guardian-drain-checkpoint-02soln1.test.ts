import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { drainGuardianInfraRetries, type GuardianDrainDeps } from '../src/core/fleet/guardian-retry-drain.js';
import { readGuardianDrainCheckpoint } from '../src/core/fleet/guardian-drain-checkpoint.js';
import type { GuardianVerifyExclusiveResult } from '../src/core/fleet/guardian-verify-exclusive.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) { await chmod(dir, 0o700); await rm(dir, { recursive: true, force: true }); } });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-checkpoint-')); dirs.push(dir);
  const sourceState = join(dir, 'source.json'); await writeFile(sourceState, 'original');
  const options = { manifest: join(dir, 'manifest'), sourceState, outputDir: dir, maxRetries: 2, timeoutMs: 60000, apply: true };
  let n = 0;
  const select = vi.fn(async () => ({ repo: `/fake/repo-${++n}`, sha: String(n).repeat(40) }));
  const prepare = vi.fn(async ({ outputState }: { outputState: string }) => { await writeFile(outputState, 'prepared', { flag: 'wx' }); }) as NonNullable<GuardianDrainDeps['prepare']>;
  const ran = { state: 'ran', summary: { deadlineExceeded: false, cancelled: false, checks: [{ status: 'failed' }] } } as unknown as GuardianVerifyExclusiveResult;
  const verify = vi.fn(async () => ran);
  return { dir, sourceState, options, select, prepare, verify, ran };
}

it('hands the second completed attempt to a restarted supervisor', async () => {
  const f = await fixture();
  const result = await drainGuardianInfraRetries(f.options, f);
  const checkpoint = readGuardianDrainCheckpoint(f.dir);
  expect(result).toMatchObject({ verified: 2, latestOutput: join(f.dir, 'guardian-drain-attempt-2.json') });
  expect(checkpoint).toMatchObject({ version: 1, latestOutput: result.latestOutput, repo: '/fake/repo-2', sha: '2'.repeat(40) });
  expect(await readFile(f.sourceState, 'utf8')).toBe('original');
  const nextDir = await mkdtemp(join(tmpdir(), 'guardian-restart-')); dirs.push(nextDir);
  const select = vi.fn(async () => null);
  await drainGuardianInfraRetries({ ...f.options, sourceState: checkpoint!.latestOutput, outputDir: nextDir }, { ...f, select });
  expect(select.mock.calls[0][0].sourceState).toBe(result.latestOutput);
});

it('does not advance after a refusal', async () => {
  const f = await fixture(); let calls = 0;
  const verify = vi.fn(async () => ++calls === 1 ? f.ran : ({ state: 'refused', reason: 'busy' } as GuardianVerifyExclusiveResult));
  expect(await drainGuardianInfraRetries(f.options, { ...f, verify })).toMatchObject({ termination: 'refused', verified: 1, refused: 1 });
  expect(readGuardianDrainCheckpoint(f.dir)?.latestOutput).toBe(join(f.dir, 'guardian-drain-attempt-1.json'));
});

it('does not write for preview, no work, stop, or preparation failure', async () => {
  for (const mode of ['preview', 'no-work', 'stop', 'prepare']) {
    const f = await fixture(); const stopFile = join(f.dir, 'stop');
    if (mode === 'stop') await writeFile(stopFile, 'stop');
    const select = mode === 'no-work' ? vi.fn(async () => null) : f.select;
    const prepare = mode === 'prepare' ? vi.fn(async () => { throw new Error('failed'); }) : f.prepare;
    await drainGuardianInfraRetries({ ...f.options, apply: mode !== 'preview', stopFile }, { ...f, select, prepare });
    expect(readGuardianDrainCheckpoint(f.dir)).toBeNull();
  }
});

it('stops admission on persistence failure while retaining completion and the prior checkpoint', async () => {
  const f = await fixture(); let calls = 0;
  const verify = vi.fn(async () => { if (++calls === 2) await chmod(f.dir, 0o500); return f.ran; });
  const result = await drainGuardianInfraRetries({ ...f.options, maxRetries: 3 }, { ...f, verify });
  await chmod(f.dir, 0o700);
  expect(result).toMatchObject({ termination: 'unsafe', attempts: 2, verified: 2, latestOutput: join(f.dir, 'guardian-drain-attempt-2.json') });
  expect(verify).toHaveBeenCalledTimes(2);
  expect(readGuardianDrainCheckpoint(f.dir)?.latestOutput).toBe(join(f.dir, 'guardian-drain-attempt-1.json'));
});

it('rejects malformed, oversized, outside-directory and symlinked checkpoints', async () => {
  const f = await fixture(); const path = join(f.dir, 'guardian-drain-latest.json');
  for (const data of ['{', 'x'.repeat(16385), JSON.stringify({ version: 1, latestOutput: '/outside/guardian-drain-attempt-1.json', repo: '/fake/repo', sha: 'a'.repeat(40), completedAt: new Date().toISOString() })]) {
    await writeFile(path, data, { mode: 0o600 }); expect(() => readGuardianDrainCheckpoint(f.dir)).toThrow();
  }
  await rm(path); await symlink(f.sourceState, path); expect(() => readGuardianDrainCheckpoint(f.dir)).toThrow();
});
