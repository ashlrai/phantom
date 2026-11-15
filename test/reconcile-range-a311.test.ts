/** Preserves PR #3510's `fleet cos-work` contract: dry run by default, --apply to act. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCosWork } from '../src/cli/fleet-cos-work.js';
import { queueCosEnvelope } from '../src/core/cos/intake.js';

let runsDir: string;
beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'cos-work-a311-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(runsDir, { recursive: true, force: true });
});

const enqueue = (): Promise<string> => queueCosEnvelope({
  channel: 'cli', verifiedSenderId: 'cos-local', body: 'Prepare a fake weekly brief',
  receivedAt: '2026-01-01T00:00:00.000Z', dedupeKey: 'b'.repeat(64),
}, runsDir);

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { output: (t: string) => out.push(t), error: (t: string) => err.push(t) } };
}

describe('fleet cos-work dry run and --apply', () => {
  it('defaults to a dry run that reports pending work and never spawns', async () => {
    const id = await enqueue();
    const spawn = vi.fn();
    const { out, deps } = capture();
    expect(await cmdFleetCosWork(['--runs-dir', runsDir, '--json'], { ...deps, spawn })).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual({ v: 1, mode: 'dry-run', pending: 1, next: id });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('prints a plain dry-run line and reports an empty queue', async () => {
    const { out, deps } = capture();
    expect(await cmdFleetCosWork(['--runs-dir', runsDir], deps)).toBe(0);
    expect(out).toEqual(['pending=0 next=none']);
  });

  it('with --apply and no workable job exits 0 as idle', async () => {
    const { out, deps } = capture();
    expect(await cmdFleetCosWork(['--apply', '--runs-dir', runsDir, '--json'], deps)).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual({ outcome: 'idle' });
  });

  it('rejects a relative --runs-dir, a repeated --apply and unknown flags with exit 2', async () => {
    for (const args of [['--runs-dir', 'relative/dir'], ['--apply', '--apply'], ['--bogus']]) {
      const { out, err, deps } = capture();
      expect(await cmdFleetCosWork(args, deps)).toBe(2);
      expect(out).toEqual([]);
      expect(err[0]).toContain('Usage: ashlr fleet cos-work [--apply] [--runs-dir <abs>] [--json]');
    }
  });

  it('documents the flags under --help', async () => {
    const { out, deps } = capture();
    expect(await cmdFleetCosWork(['--help'], deps)).toBe(0);
    expect(out[0]).toContain('--apply');
    expect(out[0]).toContain('Dry run by default');
  });
});
