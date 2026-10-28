import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, symlinkSync, unlinkSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readReplayFleet, recordFleetSession, replayFleetSession, ReplayHarnessError,
  type ReplayAdapter, type ReplayContext, type ReplayRunner,
} from '../../src/fleet/replay.js';
import { encodeReplayFleet } from '../../src/fleet/replay-codec.js';

let root: string;
let path: string;
const input = { task: 'RQ-REPLAY-1', repo: 'phantom' };
const options = () => ({ path, jobId: 'job-1', input });
const unused: ReplayAdapter = vi.fn(async () => null);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-replay-'));
  path = join(root, 'capture', 'fleet.json');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('fleet bridge record/replay', () => {
  it('replays a failed job repeatedly from disk without live effects or file changes', async () => {
    const adapter = vi.fn<ReplayAdapter>(async (operation) => {
      if (operation === 'clock.now') return '2026-10-26T10:00:00Z';
      if (operation === 'random.id') return 'attempt-42';
      if (operation === 'model.reply') return { tool: 'verify', args: ['typecheck'] };
      throw Object.assign(new Error('compiler failed'), { code: 'EXIT_2' });
    });
    const run: ReplayRunner = async ({ input, call }) => {
      const at = await call('clock.now', null);
      const attempt = await call('random.id', null);
      const reply = await call('model.reply', { input, at, attempt });
      return call('bridge.verify', reply);
    };
    const recorded = await recordFleetSession(options(), run, adapter);
    expect(recorded).toEqual({ status: 'threw', error: { name: 'Error', message: 'compiler failed', code: 'EXIT_2' } });
    expect(adapter).toHaveBeenCalledTimes(4);
    adapter.mockImplementation(async () => { throw new Error('live adapter must never run'); });
    const bytes = readFileSync(path, 'utf8');
    expect(await replayFleetSession(options(), run)).toEqual(recorded);
    expect(await replayFleetSession(options(), run)).toEqual(recorded);
    expect(adapter).toHaveBeenCalledTimes(4);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    expect(bytes).not.toContain('stack');
    expect(existsSync(`${path}.replay-lock`)).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, 'capture')).mode & 0o777).toBe(0o700);
    }
  });

  it('persists a pending request before the adapter and isolates caller mutations', async () => {
    const value = { list: ['original'] };
    const args = { first: 1, second: 2 };
    const adapter: ReplayAdapter = async (_operation, received) => {
      const capture = readReplayFleet(path).sessions[0];
      expect(capture.outcome).toBeNull();
      expect(capture.calls[0]).toEqual({ operation: 'tool.run', input: args, outcome: null });
      (received as Record<string, unknown>).first = 99;
      return value;
    };
    const recorded = await recordFleetSession(options(), async ({ call }) => {
      const result = await call('tool.run', args);
      args.first = 88;
      value.list[0] = 'mutated';
      return result;
    }, adapter);
    expect(recorded).toEqual({ status: 'returned', value: { list: ['original'] } });
    expect(await replayFleetSession(options(), async ({ call }) => call('tool.run', { second: 2, first: 1 })))
      .toEqual(recorded);
  });

  it('records caught adapter failures and subsequent successful calls', async () => {
    const run: ReplayRunner = async ({ call }) => {
      try { await call('tool.fail', null); } catch (error) {
        expect(error).toMatchObject({ name: 'RangeError', message: 'out of range', code: 'RANGE' });
      }
      return call('tool.recover', null);
    };
    const recorded = await recordFleetSession(options(), run, async (op) => {
      if (op === 'tool.fail') throw Object.assign(new RangeError('out of range'), { code: 'RANGE' });
      return { recovered: true };
    });
    expect(await replayFleetSession(options(), run)).toEqual(recorded);
  });

  it.each(['operation', 'input', 'missing', 'extra', 'result', 'caught'])('refuses %s drift', async (kind) => {
    await recordFleetSession(options(), async ({ call }) => call('tool.run', { n: 1 }), async () => 7);
    const changed: ReplayRunner = async ({ call }) => {
      if (kind === 'missing') return 7;
      if (kind === 'caught') {
        try { await call('wrong', null); } catch { /* mismatch must remain sticky */ }
        return 7;
      }
      const result = await call(kind === 'operation' ? 'tool.other' : 'tool.run', { n: kind === 'input' ? 2 : 1 });
      if (kind === 'extra') await call('tool.extra', null);
      return kind === 'result' ? 8 : result;
    };
    await expect(replayFleetSession(options(), changed)).rejects.toMatchObject({ code: 'mismatch' });
  });

  it('preserves multiple job attempts and refuses duplicate IDs without invoking the runner', async () => {
    await recordFleetSession(options(), async () => 1, unused);
    await recordFleetSession({ ...options(), jobId: 'job-2' }, async () => 2, unused);
    expect(readReplayFleet(path).sessions.map((s) => s.jobId)).toEqual(['job-1', 'job-2']);
    expect(await replayFleetSession({ path, jobId: 'job-2' }, async () => 2)).toEqual({ status: 'returned', value: 2 });
    const runner = vi.fn(async () => 3);
    await expect(recordFleetSession(options(), runner, unused)).rejects.toMatchObject({ code: 'invalid' });
    await expect(replayFleetSession({ path, jobId: 'absent' }, runner)).rejects.toMatchObject({ code: 'invalid' });
    expect(runner).not.toHaveBeenCalled();
    expect(readReplayFleet(path).sessions).toHaveLength(2);
  });

  it('refuses concurrent writers while retaining the original recording', async () => {
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const first = recordFleetSession(options(), async () => { entered(); await gate; return 1; }, unused);
    await ready;
    await expect(recordFleetSession({ ...options(), jobId: 'job-2' }, async () => 2, unused))
      .rejects.toMatchObject({ code: 'busy' });
    resume();
    await first;
    expect(readReplayFleet(path).sessions).toHaveLength(1);
  });

  it('poisons a recording when concurrent calls are attempted, even if caught', async () => {
    const runner: ReplayRunner = async ({ call }) => {
      const first = call('first', null);
      const second = call('second', null);
      await Promise.allSettled([first, second]);
      return null;
    };
    const adapter = vi.fn(async () => 1);
    await expect(recordFleetSession(options(), runner, adapter)).rejects.toBeInstanceOf(ReplayHarnessError);
    expect(adapter).toHaveBeenCalledTimes(1);
    await expect(replayFleetSession(options(), runner)).rejects.toMatchObject({ code: 'incomplete' });
  });

  it('refuses concurrent replay of a serial capture even when errors are caught', async () => {
    await recordFleetSession(options(), async ({ call }) => {
      await call('first', null);
      await call('second', null);
      return 1;
    }, async () => null);
    await expect(replayFleetSession(options(), async ({ call }) => {
      await Promise.allSettled([call('first', null), call('second', null)]);
      return 1;
    })).rejects.toMatchObject({ code: 'mismatch' });
  });

  it.each(['removed', 'replaced'])('refuses saves after its writer lock is %s', async (kind) => {
    await expect(recordFleetSession(options(), async () => {
      // Rename keeps the original inode alive, so replacement identity differs
      // even on filesystems that eagerly reuse an unlinked inode number.
      if (kind === 'removed') unlinkSync(`${path}.replay-lock`);
      else {
        renameSync(`${path}.replay-lock`, join(root, 'old-lock'));
        writeFileSync(`${path}.replay-lock`, 'another writer');
      }
      return 1;
    }, unused)).rejects.toMatchObject({ code: 'storage', message: 'Fleet replay refused: storage' });
    expect(readReplayFleet(path).sessions[0].outcome).toBeNull();
    if (kind === 'replaced') expect(readFileSync(`${path}.replay-lock`, 'utf8')).toBe('another writer');
  });

  it('preserves an incomplete capture when saving an effect result fails', async () => {
    const saved = join(root, 'before-save.json');
    await expect(recordFleetSession(options(), async ({ call }) => {
      try { await call('tool', null); } catch { /* storage faults cannot become success */ }
      return 1;
    }, async () => {
      renameSync(path, saved);
      mkdirSync(path);
      return 1;
    })).rejects.toMatchObject({ code: 'storage' });
    expect(readReplayFleet(saved).sessions[0].calls[0].outcome).toBeNull();
    expect(existsSync(`${path}.replay-lock`)).toBe(false);
  });

  it('rejects a runner that finishes with an outstanding call and drains it before unlocking', async () => {
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let pending: Promise<unknown> | undefined;
    const recording = recordFleetSession(options(), async ({ call }) => {
      pending = call('late', null).catch(() => null);
      return null;
    }, async () => { await gate; return 1; });
    const assertion = expect(recording).rejects.toMatchObject({ code: 'incomplete' });
    expect(existsSync(`${path}.replay-lock`)).toBe(true);
    resume();
    await assertion;
    await pending;
    await expect(replayFleetSession(options(), async () => null)).rejects.toMatchObject({ code: 'incomplete' });
    expect(existsSync(`${path}.replay-lock`)).toBe(false);
  });

  it('prevents captured contexts from executing after completion', async () => {
    let context!: ReplayContext;
    const adapter = vi.fn(async () => null);
    await recordFleetSession(options(), async (ctx) => { context = ctx; return null; }, adapter);
    await expect(context.call('late', null)).rejects.toBeInstanceOf(ReplayHarnessError);
    expect(adapter).not.toHaveBeenCalled();
    await replayFleetSession(options(), async (ctx) => { context = ctx; return null; });
    await expect(context.call('late', null)).rejects.toMatchObject({ code: 'mismatch' });
  });

  it.each(['truncated', 'tampered', 'version', 'unrelated'])('refuses %s files without overwriting', async (kind) => {
    await recordFleetSession(options(), async () => 1, unused);
    let bytes = readFileSync(path, 'utf8');
    if (kind === 'truncated') bytes = bytes.slice(0, -20);
    if (kind === 'tampered') bytes = bytes.replace('"value":1', '"value":2');
    if (kind === 'version') bytes = bytes.replace('replay/v1', 'replay/v2');
    if (kind === 'unrelated') bytes = '{"jobs":[]}';
    writeFileSync(path, bytes);
    await expect(replayFleetSession(options(), async () => 1)).rejects.toMatchObject({ code: 'invalid' });
    await expect(recordFleetSession({ ...options(), jobId: 'job-2' }, async () => 2, unused)).rejects.toMatchObject({ code: 'invalid' });
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });

  it('refuses persisted interrupted sessions before invoking any replay code', async () => {
    await recordFleetSession(options(), async () => 1, unused);
    const fleet = readReplayFleet(path);
    fleet.sessions[0].outcome = null;
    fleet.sessions[0].calls.push({ operation: 'unknown-effect', input: null, outcome: null });
    writeFileSync(path, encodeReplayFleet(fleet));
    const runner = vi.fn(async () => null);
    await expect(replayFleetSession(options(), runner)).rejects.toMatchObject({ code: 'incomplete' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('refuses symlink files and directories without changing their targets', async () => {
    await recordFleetSession(options(), async () => 1, unused);
    const original = readFileSync(path, 'utf8');
    const link = join(root, 'link.json');
    symlinkSync(path, link);
    await expect(replayFleetSession({ path: link, jobId: 'job-1' }, async () => 1)).rejects.toMatchObject({ code: 'storage' });
    await expect(recordFleetSession({ ...options(), path: link }, async () => 1, unused)).rejects.toMatchObject({ code: 'storage' });
    const directoryLink = join(root, 'linked');
    symlinkSync(join(root, 'capture'), directoryLink, 'dir');
    await expect(recordFleetSession({ ...options(), path: join(directoryLink, 'new.json') }, async () => 1, unused))
      .rejects.toMatchObject({ code: 'storage' });
    expect(readFileSync(path, 'utf8')).toBe(original);
  });
});
