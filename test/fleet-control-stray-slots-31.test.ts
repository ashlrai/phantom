import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { handleFleetControlApi, setFleetControlDepsForTest } from '../src/core/verse/fleet-control-api.js';
import { defaultFleetControlDeps } from '../src/core/fleet/fleet-control.js';
import {
  VERSE_FLEET_CONTROL_STRAY_SLOTS_PATH as PATH,
  type StrayJob,
  type StrayProcess,
  type StrayReaders,
  type StraySlotsV1,
} from '../src/core/fleet/stray-slots.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const job = (id: string, lane = 'devin', finished = true): StrayJob => ({ id, lane, finished, worktree: `/fake-worktrees/${id}` });
const proc = (pid: number, command: string, cwd: string | null = null): StrayProcess => ({ pid, command, cwd, elapsed: '02:00' });
const readers = (jobs: StrayJob[], processes: StrayProcess[]): StrayReaders => ({
  readJobs: async () => jobs, readProcesses: async () => processes,
});

afterEach(() => { setFleetControlDepsForTest(null); vi.restoreAllMocks(); });

async function call(method = 'GET', url = PATH, path = PATH) {
  let status = 0, payload = '';
  const req = { url, method } as IncomingMessage;
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(body: string) { payload = body; },
  } as unknown as ServerResponse;
  const handled = await handleFleetControlApi({} as VerseApiContext, req, res, path, method);
  return { handled, status, raw: payload, body: payload ? JSON.parse(payload) as StraySlotsV1 : null };
}

it('reports one lost slot for a finished job whose worktree still has a process, zero for a clean one', async () => {
  setFleetControlDepsForTest({ ...defaultFleetControlDeps(), strayReaders: readers(
    [job('RQ-PHX-FAKE1', 'devin'), job('RQ-PHX-FAKE2', 'codex-personal')],
    [proc(4321, 'esbuild --service=0.28', '/fake-worktrees/RQ-PHX-FAKE1')],
  ) });
  const result = await call();
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ v: 1, generatedAt: expect.any(String), source: 'ok', lanes: [
    { lane: 'codex-personal', slotsLost: 0, strays: [] },
    { lane: 'devin', slotsLost: 1, strays: [{ job: 'RQ-PHX-FAKE1', pid: 4321, ageSeconds: 120 }] },
  ] });
  expect(new Date(result.body!.generatedAt).toISOString()).toBe(result.body!.generatedAt);
});

it('answers source unavailable with status 200, never a 500, when a reader throws', async () => {
  for (const key of ['readJobs', 'readProcesses'] as const) {
    setFleetControlDepsForTest({ ...defaultFleetControlDeps(), strayReaders: {
      ...readers([], []), [key]: async () => { throw new Error('fake private detail'); },
    } });
    const result = await call();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ v: 1, generatedAt: expect.any(String), source: 'unavailable', lanes: [] });
    expect(result.raw).not.toContain('fake private detail');
  }
});

it('reports an empty healthy report when no jobs match', async () => {
  setFleetControlDepsForTest({ ...defaultFleetControlDeps(), strayReaders: readers([], [proc(4321, 'node elsewhere', '/other')]) });
  expect(await call()).toMatchObject({ status: 200, body: { source: 'ok', lanes: [] } });
});

it('rejects writes and queries before reading and ignores unrelated paths', async () => {
  const readJobs = vi.fn(readers([], []).readJobs);
  const readProcesses = vi.fn(readers([], []).readProcesses);
  setFleetControlDepsForTest({ ...defaultFleetControlDeps(), strayReaders: { readJobs, readProcesses } });
  expect((await call('POST')).status).toBe(405);
  expect((await call('DELETE')).status).toBe(405);
  expect((await call('GET', `${PATH}?extra=1`)).status).toBe(400);
  expect((await call('GET', '/api/verse/fleet/control/stray-slots', '/unrelated')).handled).toBe(false);
  expect(readJobs).not.toHaveBeenCalled();
  expect(readProcesses).not.toHaveBeenCalled();
});
