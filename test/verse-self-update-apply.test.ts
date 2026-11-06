/**
 * verse self-update apply : every step faked through a scripted runner — no
 * real git, node or npm. The only real I/O is the durable result file, written
 * into a per-test tmpdir (also exercises the tmp + rename atomicity).
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applySelfUpdate,
  detectRestartMode,
  scheduleRestart,
  type SelfUpdateApplyDeps,
  type SelfUpdateRunResult,
  type SelfUpdateRunner,
} from '../src/core/verse/self-update-apply.js';

const CLI_ENTRY = '/repo/phantom/dist/cli/index.js';
const UPDATE_ARGS = `${CLI_ENTRY} update --json`;
const FF = [
  ['status --porcelain', {}],
  ['fetch origin master', {}],
  ['rev-parse HEAD', { stdout: 'aaa111\n' }],
  ['rev-parse origin/master', { stdout: 'bbb222\n' }],
  ['merge-base --is-ancestor HEAD origin/master', {}],
] as const;

interface Call { cmd: string; args: string[]; timeoutMs: number }

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'verse-selfupdate-')); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

/** Ordered playback: `args.join(' ')` must equal each script key; an unscripted call fails as exit 42. */
function depsFor(script: ReadonlyArray<readonly [string, Partial<SelfUpdateRunResult>]>): { deps: SelfUpdateApplyDeps; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...script];
  const runner: SelfUpdateRunner = {
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, timeoutMs: opts.timeoutMs });
      const next = queue.shift();
      return next && args.join(' ') === next[0]
        ? { code: 0, stdout: '', stderr: '', timedOut: false, ...next[1] }
        : { code: 42, stdout: '', stderr: `unscripted call ${cmd} ${args.join(' ')}`, timedOut: false };
    },
  };
  let t = Date.parse('2026-10-31T12:00:00Z');
  const deps: SelfUpdateApplyDeps = { runner, repoRoot: '/repo/phantom', cliEntry: CLI_ENTRY, resultPath: join(home, 'verse', 'self-update-last.json'), now: () => (t += 100) };
  return { deps, calls };
}

describe('applySelfUpdate', () => {
  it('refuses a dirty tree before any fetch runs', async () => {
    const { deps, calls } = depsFor([['status --porcelain', { stdout: ' M src/cli/verse.ts\n' }]]);
    const r = await applySelfUpdate(deps);
    expect([r.outcome, r.reason, r.steps.map((s) => s.name), calls.length]).toEqual(['refused', 'dirty tree', ['status'], 1]);
  });

  it('refuses when origin/master is not a fast-forward (diverged)', async () => {
    const { deps } = depsFor([...FF.slice(0, 4), [FF[4][0], { code: 1 }]]);
    const r = await applySelfUpdate(deps);
    expect([r.outcome, r.reason, r.fromCommit, r.steps.map((s) => s.name)]).toEqual(['refused', 'diverged', 'aaa111', ['status', 'fetch', 'ahead']]);
  });

  it('reports already-current and never reaches the update step when SHAs are equal', async () => {
    const { deps, calls } = depsFor([...FF.slice(0, 3), ['rev-parse origin/master', { stdout: 'aaa111\n' }]]);
    const r = await applySelfUpdate(deps);
    expect([r.outcome, r.reason, r.restart.required]).toEqual(['already-current', null, false]);
    expect(r.steps.map((s) => s.name)).toEqual(['status', 'fetch', 'ahead']);
    expect(calls.map((c) => c.args.join(' '))).not.toContain(UPDATE_ARGS);
  });

  it('applies a fast-forward via the CLI update and writes the result atomically', async () => {
    vi.stubEnv('ASHLR_WEB_PUBLIC', '/app/public');
    const { deps, calls } = depsFor([...FF, [UPDATE_ARGS, { stdout: JSON.stringify({ updated: true, versionAfter: '9.9.9', commitAfter: 'bbb222' }) }]]);
    const r = await applySelfUpdate(deps);
    expect([r.outcome, r.fromCommit, r.toCommit]).toEqual(['updated', 'aaa111', 'bbb222']);
    expect(r.steps.map((s) => s.name)).toEqual(['status', 'fetch', 'ahead', 'update']);
    expect(calls[1]).toMatchObject({ cmd: 'git', args: ['fetch', 'origin', 'master'], timeoutMs: 60_000 });
    expect(calls.at(-1)).toMatchObject({ cmd: process.execPath, args: [CLI_ENTRY, 'update', '--json'], timeoutMs: 600_000 });
    expect(r.restart).toEqual({ required: true, mode: 'sidecar-supervised' });
    const persisted = JSON.parse(await readFile(deps.resultPath!, 'utf8')) as { outcome: string; v: number };
    expect(persisted).toMatchObject({ v: 1, outcome: 'updated' });
    expect((await readdir(dirname(deps.resultPath!))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(existsSync(deps.resultPath!)).toBe(true);
  });

  it('fails with a scrubbed stderr tail when update exits non-zero', async () => {
    const { deps } = depsFor([...FF, [UPDATE_ARGS, { code: 1, stderr: 'npm install failed\ntoken=abc123fake\nmore detail' }]]);
    const r = await applySelfUpdate(deps);
    expect([r.outcome, r.reason]).toEqual(['failed', 'update failed']);
    expect(r.steps.at(-1)!.note).toContain('npm install failed');
    expect(JSON.stringify(r)).not.toContain('abc123fake');
  });

  it('fails with a timedOut note when update exceeds the deadline', async () => {
    const { deps } = depsFor([...FF, [UPDATE_ARGS, { code: null, timedOut: true }]]);
    const r = await applySelfUpdate(deps);
    expect(r.outcome).toBe('failed');
    expect(r.steps.at(-1)).toMatchObject({ name: 'update', ok: false });
    expect(r.steps.at(-1)!.note).toContain('timedOut');
  });

  it('shares one in-flight apply across concurrent callers', async () => {
    const { deps, calls } = depsFor([...FF, [UPDATE_ARGS, { stdout: JSON.stringify({ updated: true, commitAfter: 'bbb222' }) }]]);
    const p1 = applySelfUpdate(deps);
    const p2 = applySelfUpdate(deps);
    expect(p2).toBe(p1);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect([r1 === r2, r1.outcome, calls.length]).toEqual([true, 'updated', 6]);
  });
});

describe('detectRestartMode', () => {
  it('returns sidecar-supervised for either desktop marker, manual otherwise', () => {
    const sidecarArgv = ['ashlr', 'verse', '--port', '7777', '--no-open', '--json', '--remote-config', '/h/.ashlr/verse-remote.json', '--desktop-token-handoff'];
    expect(detectRestartMode({ ASHLR_WEB_PUBLIC: '/app/public' }, [])).toBe('sidecar-supervised');
    expect(detectRestartMode({}, sidecarArgv)).toBe('sidecar-supervised');
    expect(detectRestartMode({}, ['ashlr', 'verse', '--port', '7777', '--no-open', '--json'])).toBe('manual');
    expect(detectRestartMode({ ASHLR_WEB_PUBLIC: '' }, [])).toBe('manual');
  });
});

describe('scheduleRestart', () => {
  it('SIGTERMs the own process after the delay in sidecar mode, never in manual', () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const r = scheduleRestart({ mode: 'sidecar-supervised', kill });
    expect(r).toEqual({ scheduled: true, at: expect.any(String) });
    vi.advanceTimersByTime(749);
    expect(kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(scheduleRestart({ mode: 'manual', kill })).toEqual({ scheduled: false, at: null });
    vi.advanceTimersByTime(10_000);
    expect(kill).toHaveBeenCalledOnce();
  });
});
