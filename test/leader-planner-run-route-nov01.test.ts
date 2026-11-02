import { Readable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { it, expect, vi } from 'vitest';
import { handleLeaderApi, setLeaderApiHooksForTest } from '../src/core/verse/leader-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { PlannerRunResult } from '../src/core/fleet/planner-run.js';

it('gates, validates, runs once and excludes overlapping passes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'route-'));
  const result: PlannerRunResult = { v: 1, provider: 'local', outcome: 'ran', exitCode: 0, logPath: null,
    startedAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(), nextResetAt: null, planError: null };
  let finish!: (value: PlannerRunResult) => void;
  const runner = vi.fn(() => new Promise<PlannerRunResult>(resolve => { finish = resolve; }));
  const path = '/api/verse/leader/planner/run';
  async function request(body: unknown = {}, method = 'POST', allowDispatch = true, authorized = true, raw?: string) {
    const req = Object.assign(Readable.from([raw ?? JSON.stringify(body)]), { url: path, method,
      headers: { 'content-type': 'application/json', ...(authorized ? { 'x-ashlr-token': 'local' } : {}) } }) as IncomingMessage;
    let status = 0; let data: unknown;
    const res = { writeHead(code: number) { status = code; }, setHeader() {}, end(text: string) { data = JSON.parse(text); } } as unknown as ServerResponse;
    await handleLeaderApi({ allowDispatch, token: 'local' } as VerseApiContext, req, res, path, method);
    return { status, data };
  }
  try {
    setLeaderApiHooksForTest({ plannerRunsRoot: () => root, plannerRun: runner, now: () => 0 });
    expect((await request({}, 'GET')).status).toBe(405);
    expect((await request({}, 'POST', false)).status).toBe(404);
    expect((await request({}, 'POST', true, false)).status).toBe(401);
    for (const body of [null, [], { reason: 1 }, { reason: 'x'.repeat(201) }, { promptPath: '/other' }]) expect((await request(body)).status).toBe(400);
    for (const raw of ['', '{']) expect((await request({}, 'POST', true, true, raw)).status).toBe(400);
    expect((await request()).data).toMatchObject({ error: 'no-slate' });
    await mkdir(join(root, 'queue'));
    const file = join(root, 'queue/planner-candidates.json');
    await writeFile(file, JSON.stringify({ v: 1, candidates: [] }));
    expect((await request()).data).toMatchObject({ error: 'no-prompt-declared' });
    expect(runner).not.toHaveBeenCalled();
    await writeFile(file, JSON.stringify({ v: 1, candidates: [{ provider: 'local', argv: ['unused'] }], promptPath: '/prompt' }));
    const pending = request({ reason: 'manual' });
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    expect(await request()).toEqual({ status: 409, data: { error: 'pass-in-flight', startedAt: result.startedAt } });
    finish(result);
    expect(await pending).toEqual({ status: 200, data: result });
    expect(runner.mock.calls[0]).toEqual([{ runsRoot: root, candidates: [{ provider: 'local', argv: ['unused'] }], lastProvider: '', promptPath: '/prompt', now: 0 }]);
  } finally { setLeaderApiHooksForTest({}); await rm(root, { recursive: true, force: true }); }
});
