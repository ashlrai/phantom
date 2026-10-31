import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetJobRead } from '../src/cli/fleet-job-read.js';
import { getFleetJobDetail } from '../src/core/fleet/runs-job-detail.js';
import { getFleetJobChanges } from '../src/core/fleet/runs-job-changes.js';
import type { GitRunner } from '../src/core/verse/git-ops.js';

let home: string;
let runs: string;
let output: string[];
let stdout: string;
let stderr: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'job-follow-'));
  runs = join(home, 'runs');
  await mkdir(runs);
  output = []; stdout = ''; stderr = '';
  vi.spyOn(console, 'log').mockImplementation((message: unknown) => { output.push(String(message)); });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { stderr += String(chunk); return true; });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });

describe('fleet job watch', () => {
  it('reads successive real detail and log artifacts even with publish evidence', async () => {
    await writeFile(join(runs, 'JOB1.publish'), 'RESULT PR https://example.invalid/1\n');
    await writeFile(join(runs, 'JOB1.log'), 'first line\n');
    const detail = (id: string) => getFleetJobDetail(id, { runsDir: runs });
    for (const mode of [[], ['--log']]) {
      const controller = new AbortController();
      let waits = 0;
      const wait = vi.fn(async (ms: number, signal: AbortSignal) => {
        expect(ms).toBe(1000);
        expect(signal).toBe(controller.signal);
        if (++waits === 1) await writeFile(join(runs, 'JOB1.log'), 'second line\n');
        else controller.abort();
      });
      await writeFile(join(runs, 'JOB1.log'), 'first line\n');
      expect(await cmdFleetJobRead(['JOB1', ...mode, '--watch', '--json', '--interval-ms', '1000'], { detail, changes: getFleetJobChanges }, { signal: controller.signal, wait })).toBe(0);
      const snapshots = output.map(line => JSON.parse(line) as { log: { tail: string[] } });
      expect(snapshots.map(job => job.log.tail)).toEqual([['first line'], ['second line']]);
      expect(wait).toHaveBeenCalledTimes(2);
      output = [];
    }
  });

  it('reads successive changes through the existing worktree projection', async () => {
    const worktree = join(home, 'worktree');
    await mkdir(worktree);
    await writeFile(join(runs, 'JOB1.base'), `abcdef0 fake-branch ${worktree}\n`);
    let file = 'first.ts';
    const runner: GitRunner = async (_bin, args) => ({ code: 0, stdout: args[0] === 'diff' ? `1\t0\t${file}\0` : '', stderr: '', timedOut: false, truncated: false, missing: false });
    const changes = (id: string) => getFleetJobChanges(id, { runsDir: runs, homeDir: home, runner });
    const controller = new AbortController();
    let waits = 0;
    expect(await cmdFleetJobRead(['JOB1', '--changes', '--json', '--watch'], { detail: getFleetJobDetail, changes }, {
      signal: controller.signal,
      wait: async ms => { expect(ms).toBe(5000); if (++waits === 1) file = 'second.ts'; else controller.abort(); },
    })).toBe(0);
    expect(output.map(line => JSON.parse(line).files[0].path)).toEqual(['first.ts', 'second.ts']);
  });

  it('labels plain log snapshots and retries a transient error with a stable JSON diagnostic', async () => {
    await writeFile(join(runs, 'JOB1.log'), 'working\n');
    const read = (id: string) => getFleetJobDetail(id, { runsDir: runs, now: () => new Date('2026-01-01T00:00:00Z') });
    const controller = new AbortController();
    let calls = 0;
    const detail = vi.fn(async (id: string) => { if (++calls === 2) throw new Error('fake private exception'); return read(id); });
    let waits = 0;
    const wait = async () => { if (++waits === 3) controller.abort(); };
    expect(await cmdFleetJobRead(['JOB1', '--watch', '--json'], { detail, changes: getFleetJobChanges }, { signal: controller.signal, wait })).toBe(0);
    expect(output.map(line => JSON.parse(line).schema)).toEqual(['fleet.job.v1', 'fleet.job.error.v1', 'fleet.job.v1']);
    expect(JSON.parse(output[1]!)).toEqual({ schema: 'fleet.job.error.v1', error: 'fleet job unavailable' });
    expect(output.join('')).not.toContain('fake private exception');
    const stop = new AbortController();
    let logWaits = 0;
    expect(await cmdFleetJobRead(['JOB1', '--watch', '--log'], { detail: read, changes: getFleetJobChanges }, {
      signal: stop.signal, wait: async () => { if (++logWaits === 2) stop.abort(); },
    })).toBe(0);
    expect(stdout).toContain('--- Fleet job JOB1 log snapshot 1 (2026-01-01T00:00:00.000Z) ---\nworking\n');
    expect(stdout).toContain('--- Fleet job JOB1 log snapshot 2 (2026-01-01T00:00:00.000Z) ---\nworking\n');
    expect(stderr).toContain('Log: live; health: healthy; truncated: no');
  });

  it('rejects invalid options before reads, including with help', async () => {
    const detail = vi.fn<typeof getFleetJobDetail>();
    const changes = vi.fn<typeof getFleetJobChanges>();
    for (const args of [
      ['JOB1', '--interval-ms', '1000'], ['JOB1', '--watch', '--interval-ms'],
      ['JOB1', '--watch', '--interval-ms', '999'], ['JOB1', '--watch', '--interval-ms', '60001'],
      ['JOB1', '--watch', '--interval-ms', '1e3'], ['--help', '--watch', '--interval-ms', '1000', '--interval-ms', '1000'],
      ['JOB1', '--watch', '--watch'], ['JOB1', '--watch', '--changes', '--log'],
    ]) expect(await cmdFleetJobRead(args, { detail, changes })).toBe(2);
    expect(detail).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('stops on %s and removes both process listeners', async signal => {
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const detail = (id: string) => getFleetJobDetail(id, { runsDir: runs });
    const result = cmdFleetJobRead(['JOB1', '--watch'], { detail, changes: getFleetJobChanges }, {
      wait: async (_ms, abort) => { process.emit(signal); expect(abort.aborted).toBe(true); },
    });
    expect(await result).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
    expect(output).toHaveLength(1);
  });

  it('interrupts the default wait when the injected signal aborts', async () => {
    const controller = new AbortController();
    const detail = async (id: string) => {
      const job = await getFleetJobDetail(id, { runsDir: runs });
      setTimeout(() => controller.abort(), 10);
      return job;
    };
    expect(await cmdFleetJobRead(['JOB1', '--watch', '--interval-ms', '60000'], { detail, changes: getFleetJobChanges }, { signal: controller.signal })).toBe(0);
    expect(output).toHaveLength(1);
  }, 2000);
});
