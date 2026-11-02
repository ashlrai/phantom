import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGuardianResume } from '../src/cli/fleet-guardian-resume.js';
import { readGuardianDrainCheckpoint, writeGuardianDrainCheckpoint } from '../src/core/fleet/guardian-drain-checkpoint.js';
import { GUARDIAN_DRAIN_SESSION_PREFIX } from '../src/core/fleet/guardian-drain-session.js';
import type { GuardianDrainSummary } from '../src/core/fleet/guardian-retry-drain.js';
import type { GuardianVerifyExclusiveResult } from '../src/core/fleet/guardian-verify-exclusive.js';

// All paths and shas are synthetic; the injected select/prepare/verify seams
// never touch real hosts and never spawn verification processes.
type Summary = GuardianDrainSummary & { session: string | null };
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

async function setup() {
  const session = await mkdtemp(join(tmpdir(), 'guardian-resume-src-')); dirs.push(session);
  const parent = await mkdtemp(join(tmpdir(), 'guardian-resume-out-')); dirs.push(parent);
  const latest = join(session, 'guardian-drain-attempt-2.json');
  await writeFile(latest, 'original-verified-state', { mode: 0o600 });
  writeGuardianDrainCheckpoint(session, { version: 1, latestOutput: latest, repo: '/fake/repo-alpha',
    sha: 'a'.repeat(40), completedAt: '2026-11-01T23:31:00.000Z' });
  const manifest = join(session, 'manifest.json'); await writeFile(manifest, '[]'); // placeholder; the injected seam never reads it
  let selected = 0;
  const select = vi.fn(async () => ({ repo: `/fake/repo-${++selected}`, sha: String(selected).repeat(40) }));
  // 'wx' keeps the core drain's exclusive-create, never-overwrite contract.
  const prepare = vi.fn(async (o: { outputState: string }) => {
    await writeFile(o.outputState, `state-for-${o.outputState}`, { flag: 'wx' });
    return { removed: 0, retained: 0, nextAction: 'synthetic' };
  });
  const ran = { state: 'ran', summary: { deadlineExceeded: false, cancelled: false } } as unknown as GuardianVerifyExclusiveResult;
  const verify = vi.fn(async () => ran);
  const args = ['--checkpoint-dir', session, '--manifest', manifest, '--output-dir', parent,
    '--max-retries', '2', '--timeout-ms', '60000'];
  const checkpointFile = join(session, 'guardian-drain-latest.json');
  return { session, parent, latest, args, select, prepare, verify, checkpointFile };
}

async function run(args: string[], deps: Parameters<typeof cmdFleetGuardianResume>[1]) {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((v?: unknown) => { lines.push(String(v)); });
  try { return { code: await cmdFleetGuardianResume(args, deps), json: lines.map(l => JSON.parse(l) as Summary) }; }
  finally { spy.mockRestore(); }
}

const outputs = async (parent: string) => readdir(parent).catch(() => [] as string[]);

describe('guardian-resume checkpoint handoff', () => {
  it('preview finds eligible work from the named checkpoint without writing anything', async () => {
    const o = await setup();
    const checkpointBytes = await readFile(o.checkpointFile);
    const result = await run([...o.args, '--json'], o);
    expect(result.code).toBe(0);
    expect(result.json[0]).toMatchObject({ mode: 'preview', termination: 'planned', attempts: 0, session: 'fresh', latestOutput: null });
    expect(o.select).toHaveBeenCalledTimes(1);
    expect(o.select.mock.calls[0]![0].sourceState).toBe(o.latest);
    expect(o.prepare).not.toHaveBeenCalled();
    expect(o.verify).not.toHaveBeenCalled();
    expect(await outputs(o.parent)).toEqual([]);
    expect(await readFile(o.checkpointFile)).toEqual(checkpointBytes);
    expect(await readFile(o.latest, 'utf8')).toBe('original-verified-state');
  });

  it('apply resumes from the checkpoint state into a distinct fresh session', async () => {
    const o = await setup();
    const checkpointBytes = await readFile(o.checkpointFile);
    const result = await run([...o.args, '--apply', '--json'], o);
    expect(result.code).toBe(0);
    const summary = result.json[0]!;
    expect(summary).toMatchObject({ mode: 'apply', termination: 'max-retries', attempts: 2, verified: 2, refused: 0 });
    const fresh = summary.session!;
    expect(dirname(fresh)).toBe(o.parent);
    expect(fresh).toContain(GUARDIAN_DRAIN_SESSION_PREFIX);
    expect(fresh).not.toBe(o.session);
    expect(summary.latestOutput).toBe(join(fresh, 'guardian-drain-attempt-2.json'));
    // The source chain starts at the checkpoint's verified state, then advances inside the fresh session only.
    expect(o.select.mock.calls.map(([a]) => (a as { sourceState: string }).sourceState))
      .toEqual([o.latest, join(fresh, 'guardian-drain-attempt-1.json')]);
    expect(o.verify.mock.calls.every(([opts]) => dirname((opts as { state: string }).state) === fresh)).toBe(true);
    expect(await readFile(o.checkpointFile)).toEqual(checkpointBytes);
    expect(await readFile(o.latest, 'utf8')).toBe('original-verified-state');
    // Continuity survives another restart: the fresh session carries its own latest checkpoint.
    expect(readGuardianDrainCheckpoint(fresh)).toMatchObject({ version: 1, latestOutput: summary.latestOutput, repo: '/fake/repo-2', sha: '2'.repeat(40) });
  });

  it('a refused verification propagates exit 5 and leaves checkpoint and source state untouched', async () => {
    const o = await setup();
    const verify = vi.fn(async () => ({ state: 'refused', reason: 'occupied' }) as GuardianVerifyExclusiveResult);
    const checkpointBytes = await readFile(o.checkpointFile);
    const result = await run([...o.args, '--apply', '--json'], { select: o.select, prepare: o.prepare, verify });
    expect(result.code).toBe(5);
    expect(result.json[0]).toMatchObject({ mode: 'apply', termination: 'refused', attempts: 1, refused: 1, verified: 0, latestOutput: null });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(await readFile(o.checkpointFile)).toEqual(checkpointBytes);
    expect(await readFile(o.latest, 'utf8')).toBe('original-verified-state');
  });

  it('a preexisting stop file short-circuits before session allocation and propagates the stopped outcome', async () => {
    const o = await setup();
    const stop = join(o.parent, 'stop');
    await writeFile(stop, 'stop');
    const result = await run([...o.args, '--apply', '--stop-file', stop, '--json'], o);
    expect(result.code).toBe(0);
    expect(result.json[0]).toMatchObject({ mode: 'apply', termination: 'stopped', attempts: 0, session: null });
    expect(await readdir(o.parent)).toEqual(['stop']);
    expect(o.select).not.toHaveBeenCalled();
    expect(o.verify).not.toHaveBeenCalled();
  });

  it('absent, corrupt or symlinked checkpoints refuse with fixed output, no verifier and no output session', async () => {
    const o = await setup();
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const applyArgs = [...o.args, '--apply', '--json'];
    await rm(o.checkpointFile);
    expect(await cmdFleetGuardianResume(applyArgs, o)).toBe(3); // absent
    await writeFile(o.checkpointFile, '{', { mode: 0o600 });
    expect(await cmdFleetGuardianResume(applyArgs, o)).toBe(3); // corrupt
    await rm(o.checkpointFile);
    await symlink(o.latest, o.checkpointFile);
    expect(await cmdFleetGuardianResume(applyArgs, o)).toBe(3); // symlinked
    // Snapshot before restore: mockRestore resets recorded call history.
    const messages = err.mock.calls.map(([line]) => String(line));
    err.mockRestore();
    expect(messages).toEqual(Array(3).fill('error: guardian-resume found no valid private checkpoint in --checkpoint-dir\n'));
    expect(await outputs(o.parent)).toEqual([]);
    expect(o.select).not.toHaveBeenCalled();
    expect(o.prepare).not.toHaveBeenCalled();
    expect(o.verify).not.toHaveBeenCalled();
    expect(await readFile(o.latest, 'utf8')).toBe('original-verified-state');
  });

  it('rejects --source-state/--new-session and duplicate, unknown or truncated arguments without reading anything', async () => {
    const o = await setup();
    const relative = o.args.map((v, i) => o.args[i - 1] === '--checkpoint-dir' ? 'relative/dir' : v);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const args of [
      [...o.args, '--source-state', o.latest],
      [...o.args, '--new-session'],
      [...o.args, '--checkpoint-dir', o.session],
      [...o.args, '--apply', '--apply'],
      [...o.args, '--json', '--json'],
      [...o.args, '--bogus', 'x'],
      [...o.args, '--manifest'],
      [...o.args, '--json', '--stream'],
      relative,
    ]) {
      expect(await cmdFleetGuardianResume(args, o), args.join(' ')).toBe(2);
    }
    const messages = err.mock.calls.map(([line]) => String(line));
    err.mockRestore();
    expect(messages.length).toBe(9);
    expect(messages.every(line => line.startsWith('error: '))).toBe(true);
    expect(await outputs(o.parent)).toEqual([]);
    expect(o.select).not.toHaveBeenCalled();
    expect(o.verify).not.toHaveBeenCalled();
  });
});
