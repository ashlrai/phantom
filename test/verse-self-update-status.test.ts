import { describe, expect, it, vi } from 'vitest';
import { fetchOrigin, readSelfUpdateStatus, type SelfUpdateDeps } from '../src/core/verse/self-update-status.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
function fixture(over: SelfUpdateDeps = {}): SelfUpdateDeps {
  return {
    repoRoot: () => '/fixture', readPackageVersion: () => '1.2.3',
    statFetchHead: () => new Date(NOW - 1000), now: () => NOW,
    runGit: async (args) => ({ code: 0, stdout: args[0] === 'status' ? ''
      : args[0] === 'rev-list' ? '0\t3' : args[0] === 'show' ? '2026-10-30T12:00:00Z'
      : args.includes('--abbrev-ref') ? 'master' : 'a'.repeat(40) }),
    ...over,
  };
}

describe('self update status', () => {
  it('reports clean and behind with process facts and no paths', async () => {
    const status = await readSelfUpdateStatus(fixture());
    expect(status).toMatchObject({ sourceState: 'healthy', installedVersion: '1.2.3', repoRoot: true,
      behind: 3, ahead: 0, dirty: false, canFastForward: true, lastFetchAt: new Date(NOW - 1000).toISOString() });
    expect(status.pid).toBe(process.pid);
    expect(status.uptimeSeconds).toBeGreaterThan(0);
    expect(Number.isFinite(Date.parse(status.processStartedAt))).toBe(true);
    expect(JSON.stringify(status)).not.toContain('/fixture');
  });
  it('refuses fast forward for a dirty tree', async () => {
    const base = fixture();
    const status = await readSelfUpdateStatus(fixture({ runGit: async (args, cwd) =>
      args[0] === 'status' ? { code: 0, stdout: ' M file' } : base.runGit!(args, cwd) }));
    expect(status.canFastForward).toBe(false);
  });
  it.each(['reject', 'exit', 'malformed'])('isolates a rev-list failure: %s', async (mode) => {
    const base = fixture();
    const status = await readSelfUpdateStatus(fixture({ runGit: async (args, cwd) => {
      if (args[0] !== 'rev-list') return base.runGit!(args, cwd);
      if (mode === 'reject') throw new Error('/private/path');
      return { code: mode === 'exit' ? 1 : 0, stdout: 'bad' };
    } }));
    expect(status).toMatchObject({ sourceState: 'degraded', ahead: null, behind: null,
      canFastForward: null, headSha: 'a'.repeat(40), dirty: false });
  });
  it.each(['rev-parse', 'show', 'status'])('isolates a failed %s probe', async (command) => {
    const base = fixture();
    const status = await readSelfUpdateStatus(fixture({ runGit: async (args, cwd) =>
      args[0] === command ? { code: 1, stdout: '/private/path' } : base.runGit!(args, cwd) }));
    expect(status.sourceState).toBe('degraded');
    expect(status.behind).toBe(3);
    if (command === 'status') expect(status.dirty).toBeNull();
    if (command === 'show') expect(status.headAt).toBeNull();
    if (command === 'rev-parse') expect(status.headSha).toBeNull();
    expect(JSON.stringify(status)).not.toContain('/private/path');
  });
  it.each(['1 3', '0 0'])('does not fast forward diverged or current HEAD (%s)', async (counts) => {
    const base = fixture();
    const status = await readSelfUpdateStatus(fixture({ runGit: async (args, cwd) =>
      args[0] === 'rev-list' ? { code: 0, stdout: counts } : base.runGit!(args, cwd) }));
    expect(status.canFastForward).toBe(false);
  });
  it('isolates failed metadata reads', async () => {
    const status = await readSelfUpdateStatus(fixture({
      readPackageVersion: () => { throw new Error('/private/package'); },
      statFetchHead: () => { throw new Error('/private/git'); },
    }));
    expect(status).toMatchObject({ sourceState: 'degraded', installedVersion: null, lastFetchAt: null, behind: 3 });
  });
  it('keeps process facts when no repository exists', async () => {
    const runGit = vi.fn();
    const status = await readSelfUpdateStatus(fixture({ repoRoot: () => null, runGit }));
    expect(status).toMatchObject({ sourceState: 'unavailable', repoRoot: false, headSha: null, pid: process.pid });
    expect(status.uptimeSeconds).toBeGreaterThan(0);
    expect(runGit).not.toHaveBeenCalled();
  });
  it('fetches only origin master and reports completion', async () => {
    const runGit = vi.fn(async () => ({ code: 0, stdout: '' }));
    expect(await fetchOrigin(fixture({ runGit }))).toEqual({
      ok: true, action: 'fetch', fetchedAt: new Date(NOW).toISOString(), reason: null,
    });
    expect(runGit).toHaveBeenCalledExactlyOnceWith(['fetch', '--quiet', 'origin', 'master'], '/fixture');
  });
  it.each(['exit', 'reject', 'no-root'])('reports fetch failure without diagnostics: %s', async (mode) => {
    const result = await fetchOrigin(fixture({
      repoRoot: () => mode === 'no-root' ? null : '/fixture',
      runGit: async () => { if (mode === 'reject') throw new Error('/private/path'); return { code: 1, stdout: '/remote' }; },
    }));
    expect(result).toMatchObject({ ok: false, fetchedAt: null });
    expect(JSON.stringify(result)).not.toMatch(/private|remote|fixture/);
  });
});
