import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpsApi, type OpsSelfUpdateWithApplying } from '../src/core/verse/ops-api.js';
import * as applyModule from '../src/core/verse/self-update-apply.js';
import type { SelfUpdateRunResult } from '../src/core/verse/self-update-apply.js';
import { VERSE_OPS_SELF_UPDATE_PATH as PATH } from '../src/core/verse/ops-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

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

describe('self-update applying status', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports a pending apply immediately, even with cached repository facts', async () => {
    let resolve!: (result: SelfUpdateRunResult) => void;
    let entered!: () => void;
    const started = new Promise<void>((done) => { entered = done; });
    const pending = new Promise<SelfUpdateRunResult>((done) => { resolve = done; });
    const originalApply = applyModule.applySelfUpdate;
    vi.spyOn(applyModule, 'applySelfUpdate').mockImplementation((deps) => originalApply({
      ...deps, runner: { run: () => { entered(); return pending; } },
    }));
    const repoRoot = vi.fn(() => '/fixture');
    const api = createOpsApi({ now: () => 0, selfUpdate: {
      repoRoot, readPackageVersion: () => '3.30.0', statFetchHead: () => null,
      runGit: async () => ({ code: 1, stdout: '' }),
    } });

    expect((await request(api, null, { get: true })).wire).toMatchObject({ applying: null });
    const first = request(api);
    try {
      await started;
      const callsBeforeGet = repoRoot.mock.calls.length;
      const response = await request(api, null, { get: true });
      const applying = (response.wire as OpsSelfUpdateWithApplying).applying;
      expect(response.status).toBe(200);
      expect(applying).not.toBeNull();
      expect(new Date(applying!.startedAt).toISOString()).toBe(applying!.startedAt);
      expect(repoRoot).toHaveBeenCalledTimes(callsBeforeGet);
      expect(await request(api)).toEqual({ status: 409, wire: { error: 'busy' } });
    } finally {
      resolve({ code: 0, stdout: ' M fixture\n', stderr: '', timedOut: false });
      await first;
    }
    expect((await request(api, null, { get: true })).wire).toMatchObject({ applying: null });
  });

  it('clears the applying state after a rejected apply', async () => {
    let calls = 0;
    const apply = applyModule.applySelfUpdate({
      repoRoot: '/fixture', cliEntry: '/fixture/cli.js',
      runner: { run: async () => { throw new Error('unexpected runner call'); } },
      now: () => { if (calls++ === 0) return 0; throw new Error('fixture clock failure'); },
    });
    expect(applyModule.selfUpdateApplyInProgress()).toEqual({ startedAt: '1970-01-01T00:00:00.000Z' });
    await expect(apply).rejects.toThrow('fixture clock failure');
    expect(applyModule.selfUpdateApplyInProgress()).toBeNull();
  });
});
