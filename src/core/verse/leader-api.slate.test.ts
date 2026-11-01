import { Readable } from 'node:stream';
import { realpath, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { handleLeaderApi, setLeaderApiHooksForTest } from './leader-api.js';
import type { VerseApiContext } from './verse-api.js';
import type { PlannerRunResult } from '../fleet/planner-run.js';
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, existsSync: (path: string) => /\/(codex|claude)$/.test(path) ? path === '/opt/homebrew/bin/codex' : original.existsSync(path) };
});
it('declares a preset through the gated route and hands the saved slate to planner/run', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'slate-route-')));
  const result: PlannerRunResult = { v: 1, provider: 'codex-personal', outcome: 'ran', exitCode: 0, logPath: null, startedAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(), nextResetAt: null, planError: null };
  const runner = vi.fn(async () => result);
  async function request(method = 'GET', body: unknown = {}, suffix = '/slate', query = '', authorized = true, allowDispatch = true) {
    const path = '/api/verse/leader/planner' + suffix;
    const req = Object.assign(Readable.from([JSON.stringify(body)]), { url: path + query, headers: { 'content-type': 'application/json', ...(authorized ? { 'x-ashlr-token': 'local' } : {}) } }) as IncomingMessage;
    let status = 0; let data = {};
    const res = { writeHead(code: number) { status = code; }, setHeader() {}, end(text: string) { data = JSON.parse(text); } } as unknown as ServerResponse;
    await handleLeaderApi({ allowDispatch, token: 'local' } as VerseApiContext, req, res, path, method);
    return { status, data };
  }
  try {
    setLeaderApiHooksForTest({ plannerRunsRoot: () => root, plannerRun: runner });
    expect((await request()).data).toMatchObject({ source: 'missing', promptPath: null, candidates: [] });
    expect((await request('GET', {}, '/slate', '?')).status).toBe(400);
    expect((await request('DELETE')).status).toBe(405);
    expect((await request('POST', {}, '/slate', '', false)).status).toBe(401);
    expect((await request('POST', {}, '/slate', '', true, false)).status).toBe(404);
    for (const body of [{}, { presets: [] }, { presets: ['unknown'] }, { presets: ['claude', 'claude'] }, { presets: ['codex-personal'], extra: 1 }, { presets: ['codex-personal'], promptPath: 'relative' }, { presets: ['codex-personal'], promptPath: null }]) expect((await request('POST', body)).status).toBe(400);
    expect(await request('POST', { presets: ['codex-personal'] })).toMatchObject({ status: 409, data: { error: 'no-brief' } });
    const promptPath = join(root, 'queue', 'planner-brief.prompt');
    await mkdir(join(root, 'queue'), { mode: 0o700 });
    await writeFile(promptPath, 'Plan a pass.');
    expect(await request('POST', { presets: ['claude'] })).toMatchObject({ status: 409, data: { error: 'preset-unavailable', preset: 'claude' } });
    expect(await request('POST', { presets: ['codex-personal'] })).toEqual({ status: 200, data: { v: 1, status: 'written', candidateCount: 1, promptPath } });
    expect(await request('POST', { presets: ['codex-personal'], promptPath })).toMatchObject({ status: 200, data: { status: 'unchanged' } });
    const get = await request();
    expect(get.data).toMatchObject({ source: 'ok', promptPath, promptExists: true, candidates: [{ provider: 'codex-personal', preset: 'codex-personal', argvLength: 12 }] });
    expect(JSON.stringify(get.data)).not.toContain('CODEX_HOME');
    expect(await request('POST', {}, '/run')).toEqual({ status: 200, data: result });
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ runsRoot: root, promptPath, candidates: [expect.objectContaining({ provider: 'codex-personal' })] }));
    await writeFile(join(root, 'queue', 'planner-candidates.json'), '{}');
    expect((await request()).data).toMatchObject({ source: 'invalid', candidates: [] });
  } finally { setLeaderApiHooksForTest({}); await rm(root, { recursive: true, force: true }); }
});
