/**
 * RQ-PHX-SESSIONGUIDANCEIORECOVER224S — recovery of the durable
 * session-guidance backend from PR #3297: src/core/fleet/session-guidance-io.ts
 * plus the `fleet guidance` CLI verb. These tests drive the real
 * CLI-to-filesystem path against temporary runs dirs: append writes one
 * scrubbed record under queue/guidance at 0700/0600, read folds it back as
 * honestly 'queued', a consumer ack line (appended by the test, as
 * dispatchd/launch.sh will) moves it through the existing pure fold, and
 * invalid ids, symlinked targets and missing state refuse or degrade
 * without writes. Nothing here touches a real ~/.ashlr-runs.
 */
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdFleetGuidance } from '../src/cli/fleet-guidance.js';
import { GUIDANCE_DIR } from '../src/core/fleet/session-guidance.js';

const JOB = 'RQ-PHX-RECOVER-1';
const NOW = () => Date.parse('2026-11-12T12:00:00.000Z');

let runsDir: string;
let out: string[];
let err: string[];
const deps = () => ({ runsDir, now: NOW, output: (t: string) => out.push(t), error: (t: string) => err.push(t) });
const guidanceFile = (job = JOB) => join(runsDir, GUIDANCE_DIR, `${job}.jsonl`);
const lastJson = <T>(lines: string[]): T => JSON.parse(lines[lines.length - 1]!) as T;

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'guidance-recover-'));
  out = [];
  err = [];
});
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

describe('fleet guidance append/read', () => {
  it('appends one scrubbed record and reads it back as queued', async () => {
    const code = await cmdFleetGuidance(['append', JOB, '--text', 'please rebase onto master', '--json'], deps());
    expect(code).toBe(0);
    const appended = lastJson<{ ok: boolean; id: string; state: string; strategy: string }>(out);
    expect(appended).toMatchObject({ ok: true, state: 'queued', strategy: 'requeue' });

    const dirStat = await stat(join(runsDir, GUIDANCE_DIR));
    const fileStat = await stat(guidanceFile());
    expect(dirStat.mode & 0o777).toBe(0o700);
    expect(fileStat.mode & 0o777).toBe(0o600);

    out = [];
    expect(await cmdFleetGuidance(['read', JOB, '--json'], deps())).toBe(0);
    const read = lastJson<{ sourceState: string; pending: number; entries: { id: string; state: string; text: string }[] }>(out);
    expect(read.sourceState).toBe('healthy');
    expect(read.pending).toBe(1);
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]).toMatchObject({ id: appended.id, state: 'queued', text: 'please rebase onto master' });
  });

  it('accepts positional text words and a --source label', async () => {
    expect(await cmdFleetGuidance(['append', JOB, 'hold', 'the', 'merge', '--source', 'fleet-test', '--json'], deps())).toBe(0);
    out = [];
    await cmdFleetGuidance(['read', JOB, '--json'], deps());
    const read = lastJson<{ entries: { source: string; text: string }[] }>(out);
    expect(read.entries[0]).toMatchObject({ source: 'fleet-test', text: 'hold the merge' });
  });

  it('reflects a consumer ack through the existing fold', async () => {
    await cmdFleetGuidance(['append', JOB, 'first', '--json'], deps());
    const id = lastJson<{ id: string }>(out).id;
    await appendFile(guidanceFile(), JSON.stringify({ v: 1, type: 'ack', id, at: '2026-11-12T12:05:00.000Z', state: 'delivered', turn: 3 }) + '\n');
    out = [];
    await cmdFleetGuidance(['read', JOB, '--json'], deps());
    const read = lastJson<{ pending: number; entries: { state: string; turn: number | null }[] }>(out);
    expect(read.pending).toBe(0);
    expect(read.entries[0]).toMatchObject({ state: 'delivered', turn: 3 });
  });

  it('lists sessions with honest pending counts', async () => {
    await cmdFleetGuidance(['append', JOB, 'note', '--json'], deps());
    out = [];
    expect(await cmdFleetGuidance(['list', '--json'], deps())).toBe(0);
    const list = lastJson<{ sourceState: string; sessions: { job: string; pending: number | null }[] }>(out);
    expect(list.sourceState).toBe('healthy');
    expect(list.sessions).toEqual([expect.objectContaining({ job: JOB, pending: 1 })]);
  });
});

describe('fleet guidance refusals and degraded state', () => {
  it('refuses an invalid job id and traversal without writing', async () => {
    for (const job of ['../escape', 'a/b', 'a..b', 'bad id']) {
      expect(await cmdFleetGuidance(['append', job, 'note', '--json'], deps())).not.toBe(0);
      expect(await cmdFleetGuidance(['read', job, '--json'], deps())).not.toBe(0);
    }
    await expect(readFile(guidanceFile('../escape'), 'utf8')).rejects.toThrow();
    await expect(stat(join(runsDir, GUIDANCE_DIR))).rejects.toThrow();
  });

  it('refuses to follow a symlinked guidance file and leaves the target untouched', async () => {
    await mkdir(join(runsDir, GUIDANCE_DIR), { recursive: true });
    const target = join(runsDir, 'elsewhere.jsonl');
    await writeFile(target, 'keep me\n', 'utf8');
    await symlink(target, guidanceFile());
    expect(await cmdFleetGuidance(['append', JOB, 'note', '--json'], deps())).toBe(1);
    expect(lastJson<{ ok: boolean; code: string }>(out)).toEqual({ ok: false, code: 'unsafe-file' });
    expect(await readFile(target, 'utf8')).toBe('keep me\n');
  });

  it('answers missing for a job with no file and missing for an absent runs dir', async () => {
    out = [];
    await cmdFleetGuidance(['read', JOB, '--json'], deps());
    expect(lastJson<{ sourceState: string; entries: unknown[] }>(out)).toMatchObject({ sourceState: 'missing', entries: [] });
    out = [];
    const empty = await mkdtemp(join(tmpdir(), 'guidance-empty-'));
    try {
      await cmdFleetGuidance(['list', '--json'], { runsDir: empty, now: NOW, output: (t) => out.push(t), error: (t) => err.push(t) });
      expect(lastJson<{ sourceState: string; sessions: unknown[] }>(out)).toMatchObject({ sourceState: 'missing', sessions: [] });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('refuses empty text and bad flags with exit 2', async () => {
    expect(await cmdFleetGuidance(['append', JOB, '--text', '   '], deps())).toBe(2);
    expect(await cmdFleetGuidance(['append', JOB, '--bogus'], deps())).toBe(2);
    expect(await cmdFleetGuidance(['bogus'], deps())).toBe(2);
    expect(await cmdFleetGuidance(['append'], deps())).toBe(2);
    expect(await stat(join(runsDir, GUIDANCE_DIR)).catch(() => null)).toBeNull();
  });

  it('refuses to write through a symlinked guidance directory', async () => {
    const real = await mkdtemp(join(tmpdir(), 'guidance-real-'));
    try {
      await mkdir(join(runsDir, 'queue'));
      await symlink(real, join(runsDir, GUIDANCE_DIR));
      expect(await cmdFleetGuidance(['append', JOB, 'note', '--json'], deps())).toBe(1);
      expect(lastJson<{ ok: boolean; code: string }>(out)).toEqual({ ok: false, code: 'unsafe-file' });
      await expect(readFile(join(real, `${JOB}.jsonl`), 'utf8')).rejects.toThrow();
    } finally {
      await rm(real, { recursive: true, force: true });
    }
  });
});
