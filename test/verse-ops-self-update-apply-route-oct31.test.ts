import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createOpsApi } from '../src/core/verse/ops-api.js';
import * as applyModule from '../src/core/verse/self-update-apply.js';
import type { SelfUpdateApplyResult } from '../src/core/verse/self-update-apply.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { VERSE_OPS_SELF_UPDATE_PATH as PATH } from '../src/core/verse/ops-types.js';

const result: SelfUpdateApplyResult = {
  v: 1, startedAt: '2026-10-31T12:00:00.000Z', finishedAt: '2026-10-31T12:00:00.000Z',
  outcome: 'already-current', reason: null, fromCommit: 'a'.repeat(40), toCommit: 'a'.repeat(40),
  steps: [{ name: 'ahead', ok: true, ms: 0, note: 'already up to date' }],
  restart: { required: false, mode: 'manual' },
};

async function request(api: ReturnType<typeof createOpsApi>, body: unknown = { action: 'apply' },
  opts: { get?: boolean; token?: boolean; dispatch?: boolean; contentType?: string } = {}) {
  const req = Readable.from(opts.get ? [] : [JSON.stringify(body)]) as IncomingMessage;
  req.url = PATH;
  req.headers = { 'content-type': opts.contentType ?? 'application/json', ...(opts.token === false ? {} : { 'x-ashlr-token': 'fixture-token' }) };
  let status = 0;
  let wire: unknown;
  const res = {
    writeHead(code: number) { status = code; },
    end(text: string) { wire = JSON.parse(text); },
  } as ServerResponse;
  const ctx = { token: 'fixture-token', allowDispatch: opts.dispatch ?? true } as VerseApiContext;
  await api(ctx, req, res, PATH, opts.get ? 'GET' : 'POST');
  return { status, wire };
}

describe('ops self-update apply route Oct 31', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['sidecar-supervised', true, 'updated', true],
    ['sidecar-supervised', false, 'updated', false],
    ['manual', true, 'updated', false],
    ['sidecar-supervised', true, 'already-current', false],
  ] as const)('default apply handles mode=%s restart=%s outcome=%s', async (mode, restart, outcome, scheduled) => {
    vi.spyOn(applyModule, 'detectRestartMode').mockReturnValue(mode);
    const apply = vi.spyOn(applyModule, 'applySelfUpdate').mockResolvedValue({
      ...result, outcome, restart: { required: outcome === 'updated', mode },
    });
    const schedule = vi.spyOn(applyModule, 'scheduleRestart').mockReturnValue({ scheduled: true, at: null });
    const api = createOpsApi({ selfUpdate: { repoRoot: () => '/fixture' } });
    expect((await request(api, { action: 'apply', restart })).status).toBe(200);
    expect(apply).toHaveBeenCalledExactlyOnceWith({
      runner: applyModule.realSelfUpdateRunner, repoRoot: '/fixture', cliEntry: '/fixture/dist/cli/index.js',
    });
    expect(schedule).toHaveBeenCalledTimes(scheduled ? 1 : 0);
  });

  it('refuses an unavailable repository without running the updater', async () => {
    const apply = vi.spyOn(applyModule, 'applySelfUpdate');
    const response = await request(createOpsApi({ selfUpdate: { repoRoot: () => null } }));
    expect(response.status).toBe(200);
    expect(response.wire).toMatchObject({ action: 'apply', outcome: 'refused', reason: 'Repository unavailable' });
    expect(apply).not.toHaveBeenCalled();
  });
  it.each(['already-current', 'refused', 'updated', 'failed'] as const)('returns the %s result and defaults restart to true', async (outcome) => {
    const value = { ...result, outcome };
    const apply = vi.fn(async () => value);
    expect(await request(createOpsApi({ selfUpdateApply: apply }))).toEqual({ status: 200, wire: { ...value, action: 'apply' } });
    expect(apply).toHaveBeenCalledExactlyOnceWith({ restart: true });
  });

  it('forwards restart false', async () => {
    const apply = vi.fn(async () => result);
    await request(createOpsApi({ selfUpdateApply: apply }), { action: 'apply', restart: false });
    expect(apply).toHaveBeenCalledExactlyOnceWith({ restart: false });
  });

  it('refreshes status after apply within the cache window', async () => {
    let root: string | null = null;
    const repoRoot = vi.fn(() => root);
    const api = createOpsApi({ now: () => 0, selfUpdate: {
      repoRoot, readPackageVersion: () => '3.30.0', statFetchHead: () => null,
      runGit: async () => ({ code: 1, stdout: '' }),
    }, selfUpdateApply: async () => { root = '/fixture'; return result; } });
    expect((await request(api, null, { get: true })).wire).toMatchObject({ repoRoot: false });
    await request(api, null, { get: true });
    expect(repoRoot).toHaveBeenCalledTimes(1);
    await request(api);
    expect((await request(api, null, { get: true })).wire).toMatchObject({ repoRoot: true });
    expect(repoRoot).toHaveBeenCalledTimes(2);
  });

  it('keeps the mutation and dispatch gates', async () => {
    const apply = vi.fn(async () => result);
    const api = createOpsApi({ selfUpdateApply: apply });
    expect((await request(api, undefined, { token: false })).status).toBe(401);
    expect((await request(api, undefined, { dispatch: false })).status).toBe(404);
    expect((await request(api, undefined, { contentType: 'text/plain' })).status).toBe(415);
    expect(apply).not.toHaveBeenCalled();
  });

  it.each([{ action: 'nuke' }, { action: 'apply', restart: 'false' }, { action: 'apply', extra: true },
    { action: 'fetch', restart: false }, [], null])('rejects invalid body %j', async (body) => {
    const apply = vi.fn(async () => result);
    const response = await request(createOpsApi({ selfUpdateApply: apply }), body);
    expect(response.status).toBe(400);
    expect(response.wire).toMatchObject({ code: 'VERSE_INVALID', error: expect.stringContaining('action:"apply"') });
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects overlapping apply then accepts another after completion', async () => {
    let resolve!: (value: SelfUpdateApplyResult) => void;
    let entered!: () => void;
    const started = new Promise<void>((done) => { entered = done; });
    const pending = new Promise<SelfUpdateApplyResult>((done) => { resolve = done; });
    const apply = vi.fn(() => { entered(); return pending; });
    const api = createOpsApi({ selfUpdateApply: apply });
    const first = request(api);
    await started;
    expect(await request(api)).toEqual({ status: 409, wire: { error: 'busy' } });
    expect(apply).toHaveBeenCalledTimes(1);
    resolve(result);
    expect((await first).status).toBe(200);
    expect((await request(api)).status).toBe(200);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('clears the busy guard and cached status even when the seam rejects', async () => {
    const repoRoot = vi.fn(() => null);
    const apply = vi.fn().mockRejectedValueOnce(new Error('fixture failure')).mockResolvedValue(result);
    const api = createOpsApi({ selfUpdate: { repoRoot }, selfUpdateApply: apply });
    await request(api, null, { get: true });
    await expect(request(api)).rejects.toThrow('fixture failure');
    await request(api, null, { get: true });
    expect(repoRoot).toHaveBeenCalledTimes(2);
    expect((await request(api)).status).toBe(200);
  });

  it('scrubs diagnostics before sending them', async () => {
    const api = createOpsApi({ selfUpdateApply: async () => ({ ...result,
      reason: 'password=fixture-password', steps: [{ name: 'update', ok: false, ms: 1, note: 'token=fixture-secret' }],
    }) });
    const response = await request(api);
    expect(JSON.stringify(response.wire)).not.toContain('fixture-secret');
    expect(JSON.stringify(response.wire)).not.toContain('fixture-password');
  });

  it('preserves fetch behavior', async () => {
    const runGit = vi.fn(async () => ({ code: 0, stdout: '' }));
    const apply = vi.fn(async () => result);
    const api = createOpsApi({ selfUpdateApply: apply, selfUpdate: { repoRoot: () => '/fixture', runGit, now: () => 0 } });
    expect(await request(api, { action: 'fetch' })).toEqual({ status: 200,
      wire: { ok: true, action: 'fetch', fetchedAt: '1970-01-01T00:00:00.000Z', reason: null } });
    expect(runGit).toHaveBeenCalledExactlyOnceWith(['fetch', '--quiet', 'origin', 'master'], '/fixture');
    expect(apply).not.toHaveBeenCalled();
  });
});
