import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetWaitJobs, type FleetWaitJobsDeps } from '../src/cli/fleet-wait-jobs.js';
import { getFleetJobDetail } from '../src/core/fleet/runs-job-detail.js';
import { getFleetJobText } from '../src/core/fleet/runs-job-texts.js';

const publication = 'RESULT PR https://github.com/example/fake/pull/123\nTEST failed (fake fixture)\n';
const args = (...jobs: string[]) => [...jobs.flatMap(job => ['--job', job]), '--timeout-ms', '3000', '--interval-ms', '1000', '--json'];

describe('fleet wait-jobs notes readiness', () => {
  let runsDir: string;
  let time: number;
  let output: string[];
  let deps: FleetWaitJobsDeps;
  const result = () => JSON.parse(output.at(-1)!);
  const write = (job: string, suffix: string, body: string) => writeFile(join(runsDir, `${job}.${suffix}`), body);

  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), 'fleet-join-notes-'));
    time = 0;
    output = [];
    deps = {
      now: () => time,
      wait: async ms => { time += ms; },
      read: job => getFleetJobDetail(job, { runsDir }),
      readNotes: job => getFleetJobText(job, 'notes', { runsDir }),
      output: line => output.push(line),
    };
  });
  afterEach(async () => { vi.useRealTimers(); await rm(runsDir, { recursive: true, force: true }); });

  it('waits for late notes on every published upstream job and retains order', async () => {
    await Promise.all(['JOB-A', 'JOB-B'].map(job => write(job, 'publish', publication)));
    const snapshots: string[] = [];
    const readNotes = deps.readNotes!;
    deps.readNotes = async (job, signal) => {
      const notes = await readNotes(job, signal);
      snapshots.push(`${time}:${job}:${notes.state}`);
      return notes;
    };
    deps.wait = async ms => {
      time += ms;
      await write(time === 1000 ? 'JOB-B' : 'JOB-A', 'notes.md', 'Fake handoff details');
    };
    expect(await cmdFleetWaitJobs([...args('JOB-A', 'JOB-B'), '--require-notes'], deps)).toBe(0);
    expect(time).toBe(2000);
    expect(snapshots).toContain('0:JOB-A:missing');
    expect(snapshots).toContain('0:JOB-B:missing');
    expect(result()).toMatchObject({ outcome: 'published', jobs: [
      { job: 'JOB-A', state: 'published', notes: { state: 'ok', source: 'notes', bytes: 20, truncated: false } },
      { job: 'JOB-B', state: 'published', notes: { state: 'ok', source: 'notes' } },
    ] });
    expect(output.join('')).not.toContain('Fake handoff details');
  });

  it('preserves legacy output and succeeds without reading notes', async () => {
    await write('JOB-A', 'publish', publication);
    deps.readNotes = vi.fn(() => { throw new Error('must not read notes'); });
    expect(await cmdFleetWaitJobs(args('JOB-A'), deps)).toBe(0);
    expect(deps.readNotes).not.toHaveBeenCalled();
    expect(result().jobs[0]).toEqual({
      job: 'JOB-A', state: 'published', artifactState: 'published',
      sources: { launch: 'missing', base: 'missing', meta: 'missing', publish: 'healthy', log: 'missing' },
      prUrl: 'https://github.com/example/fake/pull/123', processLiveness: 'not-checked',
    });
  });

  it.each(['', '  \n\t'])('keeps empty notes pending to the deadline even when a body exists: %j', async empty => {
    await write('JOB-A', 'publish', publication);
    await write('JOB-A', 'notes.md', empty);
    await write('JOB-A', 'body.md', 'Body must not override an existing notes file');
    expect(await cmdFleetWaitJobs([...args('JOB-A'), '--require-notes'], deps)).toBe(3);
    expect(time).toBe(3000);
    expect(result()).toMatchObject({ outcome: 'timed-out', jobs: [{ state: 'pending', artifactState: 'published', notes: {
      state: 'empty', source: 'notes', bytes: Buffer.byteLength(empty), truncated: false,
    } }] });
  });

  it('times out with missing notes and reports missing evidence', async () => {
    await write('JOB-A', 'publish', publication);
    expect(await cmdFleetWaitJobs([...args('JOB-A'), '--require-notes'], deps)).toBe(3);
    expect(time).toBe(3000);
    expect(result().jobs[0]).toMatchObject({ state: 'pending', notes: { state: 'missing', source: null, bytes: null, truncated: false } });
  });

  it('does not release when notes arrive at the deadline', async () => {
    await write('JOB-A', 'publish', publication);
    deps.wait = async ms => {
      time += ms;
      if (time === 3000) await write('JOB-A', 'notes.md', 'Too late for this join');
    };
    expect(await cmdFleetWaitJobs([...args('JOB-A'), '--require-notes'], deps)).toBe(3);
    expect(result().jobs[0]).toMatchObject({ state: 'pending', notes: { state: 'missing' } });
  });

  it('accepts retained body fallback and reports bounded-read truncation', async () => {
    await write('JOB-A', 'publish', publication);
    await write('JOB-A', 'body.md', 'x '.repeat(40000));
    expect(await cmdFleetWaitJobs([...args('JOB-A'), '--require-notes'], deps)).toBe(0);
    expect(result().jobs[0].notes).toEqual({ state: 'ok', source: 'body', bytes: 80000, truncated: true });
    expect(output.join('')).not.toContain('x x x');
  });

  it.each(['directory', 'symlink'])('fails unavailable for unreadable notes (%s)', async kind => {
    await write('JOB-A', 'publish', publication);
    if (kind === 'directory') await mkdir(join(runsDir, 'JOB-A.notes.md'));
    else {
      await write('JOB-A', 'body.md', 'Fake fallback');
      await symlink(join(runsDir, 'JOB-A.body.md'), join(runsDir, 'JOB-A.notes.md'));
    }
    expect(await cmdFleetWaitJobs([...args('JOB-A'), '--require-notes'], deps)).toBe(4);
    expect(result().jobs[0]).toMatchObject({ state: 'unavailable', notes: { state: 'unreadable', source: null } });
  });

  it('fails unavailable on a rejected notes read without exposing the error', async () => {
    await write('JOB-A', 'publish', publication);
    deps.readNotes = async () => { throw new Error('fake private diagnostic'); };
    expect(await cmdFleetWaitJobs([...args('JOB-A'), '--require-notes'], deps)).toBe(4);
    expect(result().jobs[0]).toMatchObject({ state: 'unavailable', notes: { state: 'unreadable' } });
    expect(output.join('')).not.toContain('fake private diagnostic');
  });

  it('does not treat notes as publication evidence or infer test success', async () => {
    await write('JOB-A', 'notes.md', 'Fake handoff');
    const notesRead = vi.fn(deps.readNotes!);
    deps.readNotes = notesRead;
    expect(await cmdFleetWaitJobs([...args('JOB-A'), '--require-notes'], deps)).toBe(3);
    expect(notesRead).not.toHaveBeenCalled();
    expect(result().jobs[0]).toMatchObject({ state: 'pending', notes: { state: 'not-checked' } });
    time = 0;
    await write('JOB-A', 'publish', 'RESULT PR https://github.com/example/fake/pull/123\n');
    expect(await cmdFleetWaitJobs([...args('JOB-A'), '--require-notes'], deps)).toBe(4);
    expect(notesRead).not.toHaveBeenCalled();
    time = 0;
    await write('JOB-A', 'publish', publication);
    expect(await cmdFleetWaitJobs([...args('JOB-A'), '--require-notes'], deps)).toBe(0);
  });

  it('rechecks publication while notes are pending, including a newer attempt', async () => {
    await write('JOB-A', 'publish', publication);
    deps.wait = async ms => {
      time += ms;
      if (time === 1000) {
        const old = new Date(1000);
        await utimes(join(runsDir, 'JOB-A.publish'), old, old);
        await write('JOB-A', 'launch', 'launched JOB-A work pid 123 base abcd\n');
        await write('JOB-A', 'log', 'New attempt\n');
        await write('JOB-A', 'notes.md', 'Fake old handoff');
      }
    };
    expect(await cmdFleetWaitJobs([...args('JOB-A'), '--require-notes'], deps)).toBe(3);
    expect(result().jobs[0]).toMatchObject({ state: 'pending', artifactState: 'running', notes: { state: 'not-checked' } });
  });

  it('interrupts a pending notes read and detaches listeners', async () => {
    await write('JOB-A', 'publish', publication);
    const external = new AbortController();
    const signals: AbortSignal[] = [];
    deps.signal = external.signal;
    deps.readNotes = (_job, signal) => {
      signals.push(signal);
      external.abort();
      return new Promise(() => {});
    };
    expect(await cmdFleetWaitJobs([...args('JOB-A'), '--require-notes'], deps)).toBe(130);
    expect(result()).toMatchObject({ outcome: 'interrupted', jobs: [{ state: 'pending' }] });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(getEventListeners(signals[0]!, 'abort')).toHaveLength(0);
    expect(getEventListeners(external.signal, 'abort')).toHaveLength(0);
  });

  it('bounds notes reads at four and stops them at the overall deadline', async () => {
    await Promise.all(['JOB-A', 'JOB-B', 'JOB-C', 'JOB-D', 'JOB-E'].map(job => write(job, 'publish', publication)));
    vi.useFakeTimers();
    let started = 0;
    let allStarted!: () => void;
    const ready = new Promise<void>(resolve => { allStarted = resolve; });
    const signals: AbortSignal[] = [];
    deps.readNotes = (_job, signal) => {
      signals.push(signal);
      if (++started === 4) allStarted();
      return new Promise(() => {});
    };
    const pending = cmdFleetWaitJobs([...args('JOB-A', 'JOB-B', 'JOB-C', 'JOB-D', 'JOB-E'), '--require-notes'], deps);
    await ready;
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toBe(3);
    expect(started).toBe(4);
    expect(signals.every(signal => signal.aborted && getEventListeners(signal, 'abort').length === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects duplicate notes flags before reading artifacts', async () => {
    const read = vi.fn(deps.read!);
    deps.read = read;
    expect(await cmdFleetWaitJobs([...args('JOB-A'), '--require-notes', '--require-notes'], deps)).toBe(2);
    expect(read).not.toHaveBeenCalled();
  });
});
