import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('../src/core/integrations/secrets.js', async (original) => ({
  ...await original<typeof import('../src/core/integrations/secrets.js')>(),
  credentialExecFile: mocks.execFile,
}));
import { runGhAttempt, runGhAsync } from '../src/core/integrations/github.js';

const cwd = '/synthetic/repo';
/** Answer the execFile callback the way Node would for each failure kind. */
const answer = (error: Record<string, unknown> | null, stdout = '') =>
  mocks.execFile.mockImplementation((_bin: string, _args: string[], _opts: object, callback: (...a: unknown[]) => void) => {
    // Vitest cleanup probes mocks with zero args; only answer real launches.
    if (typeof callback === 'function') {
      callback(error === null ? null : Object.assign(new Error('gh failed'), error), stdout);
    }
    return { pid: 1 };
  });

beforeEach(() => mocks.execFile.mockReset());

describe('runGhAttempt', () => {
  it('returns trimmed stdout on success', async () => {
    answer(null, '  2026-11-22T17:14:53Z\n');
    await expect(runGhAttempt(cwd, ['api', 'x'])).resolves.toEqual({ stdout: '2026-11-22T17:14:53Z', failure: null });
    expect(mocks.execFile).toHaveBeenCalledWith('gh', ['api', 'x'], expect.objectContaining({ cwd, timeout: 8_000 }), expect.any(Function));
  });

  it('classifies a missing binary as spawn, not an unreadable ref', async () => {
    answer({ code: 'ENOENT' });
    await expect(runGhAttempt(cwd, ['api'])).resolves.toEqual({ stdout: null, failure: 'spawn' });
  });

  it('classifies a deadline kill as timeout', async () => {
    answer({ killed: true, signal: 'SIGTERM' });
    await expect(runGhAttempt(cwd, ['pr', 'list'], { timeoutMs: 30_000 })).resolves.toEqual({ stdout: null, failure: 'timeout' });
    expect(mocks.execFile.mock.calls[0]![2]).toMatchObject({ timeout: 30_000 });
  });

  it('classifies a nonzero exit as exit — gh ran and refused', async () => {
    answer({ code: 1 });
    await expect(runGhAttempt(cwd, ['api'])).resolves.toEqual({ stdout: null, failure: 'exit' });
  });

  it('honors an already-aborted signal without spawning', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runGhAttempt(cwd, ['api'], { signal: controller.signal })).resolves.toEqual({ stdout: null, failure: 'aborted' });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('classifies an abort-error exit as aborted', async () => {
    answer({ code: 'ABORT_ERR' });
    await expect(runGhAttempt(cwd, ['api'])).resolves.toEqual({ stdout: null, failure: 'aborted' });
  });

  it('classifies a synchronous launch throw as spawn', async () => {
    mocks.execFile.mockImplementation((...callArgs: unknown[]) => {
      if (callArgs.length === 0) return { pid: 1 }; // vitest cleanup probe
      throw new Error('spawn failed');
    });
    await expect(runGhAttempt(cwd, ['api'])).resolves.toEqual({ stdout: null, failure: 'spawn' });
  });
});

describe('runGhAsync over runGhAttempt', () => {
  it('keeps the string-or-null contract', async () => {
    answer(null, ' ok ');
    await expect(runGhAsync(cwd, ['api'])).resolves.toBe('ok');
    answer({ code: 'ENOENT' });
    await expect(runGhAsync(cwd, ['api', 'other'])).resolves.toBeNull();
    answer({ killed: true });
    await expect(runGhAsync(cwd, ['api', 'third'])).resolves.toBeNull();
  });
});
