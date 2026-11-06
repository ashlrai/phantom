import { Readable } from 'node:stream';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleLeaderApi, setLeaderApiHooksForTest } from '../src/core/verse/leader-api.js';
import { planPlannerPass } from '../src/core/fleet/planner-run.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

// Delegating mock: every test drives the real planPlannerPass except the
// 'unavailable' case, which needs the plan read to throw.
vi.mock('../src/core/fleet/planner-run.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/core/fleet/planner-run.js')>();
  return { ...mod, planPlannerPass: vi.fn(mod.planPlannerPass) };
});
const planMock = vi.mocked(planPlannerPass);

// Fixed local-time clock: Oct 31 18:00. Fixture rows sit before it; the
// advertised account reset (Nov 7 15:16 local) sits after it.
const now = new Date(2026, 9, 31, 18, 0, 0).getTime();
const RESET_LOCAL = new Date(2026, 10, 7, 15, 16);
const CANDIDATES = [
  { provider: 'codex-personal', argv: ['echo'] },
  { provider: 'claude-api', argv: ['echo'] },
];
const USAGE_LIMIT_LOG = [
  'planner pass starting',
  "ERROR: You've hit your usage limit. Upgrade to Pro (https://example.invalid/pro) or try again at Nov 7th, 2026 3:16 PM.",
].join('\n');
const LIMITED_EVENTS = [
  '2026-10-31 13:00:00 LEADER fixups=2 bets=3 reaps=0 ignored=0 free_gb=137',
  '2026-10-31 14:14:03 LEADER codex-personal rc=1',
].join('\n');

const PATH = '/api/verse/leader/planner/plan';
const slateFile = (dir: string) => join(dir, 'queue', 'planner-candidates.json');

async function runsRoot(opts: { slate?: string; events?: string; runLog?: string } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'planner-plan-'));
  await mkdir(join(dir, 'queue'), { recursive: true });
  await mkdir(join(dir, 'supervisor'), { recursive: true });
  if (opts.slate !== undefined) await writeFile(slateFile(dir), opts.slate);
  if (opts.events !== undefined) await writeFile(join(dir, 'queue/dispatch-events.log'), `${opts.events}\n`);
  if (opts.runLog !== undefined) await writeFile(join(dir, 'supervisor/run.20261031-1414.log'), opts.runLog);
  return dir;
}
const slate = (candidates: { provider: string; argv: string[] }[], lastProvider?: string): string =>
  JSON.stringify({ v: 1, candidates, ...(lastProvider === undefined ? {} : { lastProvider }) });

async function request(url: string, method = 'GET') {
  const req = Object.assign(Readable.from([]), { url, method, headers: {} }) as unknown as IncomingMessage;
  let status = 0;
  let body: unknown = null;
  const res = {
    writeHead(code: number) { status = code; },
    setHeader() {},
    end(text: string) { body = JSON.parse(text); },
  } as unknown as ServerResponse;
  const handled = await handleLeaderApi({} as VerseApiContext, req, res, url.split('?')[0]!, method);
  return { handled, status, body };
}

const dirs: string[] = [];
async function setup(opts: Parameters<typeof runsRoot>[0]): Promise<void> {
  const dir = await runsRoot(opts);
  dirs.push(dir);
  setLeaderApiHooksForTest({ plannerRunsRoot: () => dir, now: () => now });
}
afterEach(async () => {
  setLeaderApiHooksForTest({});
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe('GET /api/verse/leader/planner/plan', () => {
  it('picks the next non-limited login when the last provider is usage-limited', async () => {
    await setup({
      slate: slate(CANDIDATES, 'codex-personal'),
      events: LIMITED_EVENTS,
      runLog: USAGE_LIMIT_LOG,
    });
    const res = await request(PATH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      v: 1,
      source: 'ok',
      choice: { provider: 'claude-api', reason: 'unread' },
      nextResetAt: RESET_LOCAL.toISOString(),
      limited: [{ provider: 'codex-personal', status: 'usage-limit', until: expect.stringMatching(/^2026-11-07T15:16/) }],
      health: [{ provider: 'codex-personal', status: 'failing', reason: 'usage-limit' }],
    });
    expect((res.body as { path: string }).path).toMatch(/planner-candidates\.json$/);
    expect(planMock).toHaveBeenCalled();
  });

  it('reports a healthy next pass on the last provider', async () => {
    await setup({
      slate: slate(CANDIDATES, 'codex-personal'),
      events: '2026-10-31 17:48:00 LEADER codex-personal ok',
    });
    const res = await request(PATH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      source: 'ok',
      choice: { provider: 'codex-personal', reason: 'ok' },
      nextResetAt: null,
      limited: [],
      health: [{ provider: 'codex-personal', status: 'ok' }],
    });
  });

  it('returns null choice and the earliest reset when every candidate is limited', async () => {
    // planPlannerPass files the single newest health reading under
    // lastProvider, so "every candidate limited" means every candidate entry
    // is that provider — the same shape fleet-planner-run's own test uses.
    await setup({
      slate: slate([{ provider: 'codex-personal', argv: ['echo'] }, { provider: 'codex-personal', argv: ['echo'] }], 'codex-personal'),
      events: LIMITED_EVENTS,
      runLog: USAGE_LIMIT_LOG,
    });
    const res = await request(PATH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      source: 'ok',
      choice: null,
      nextResetAt: RESET_LOCAL.toISOString(),
      limited: [{ provider: 'codex-personal', status: 'usage-limit', until: expect.stringMatching(/^2026-11-07T15:16/) }],
      health: [{ provider: 'codex-personal', status: 'failing', reason: 'usage-limit' }],
    });
  });

  it('returns the health rows with source missing when there is no slate file', async () => {
    await setup({ events: LIMITED_EVENTS, runLog: USAGE_LIMIT_LOG });
    const res = await request(PATH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      source: 'missing',
      choice: null,
      nextResetAt: null,
      limited: [],
      health: [{ provider: null, status: 'failing', reason: 'usage-limit' }],
    });
  });

  it('returns source invalid for a malformed slate file', async () => {
    await setup({ slate: 'not json', events: LIMITED_EVENTS, runLog: USAGE_LIMIT_LOG });
    const res = await request(PATH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'invalid', choice: null, limited: [] });
  });

  it('returns source unavailable when the plan read throws', async () => {
    await setup({ slate: slate(CANDIDATES, 'codex-personal') });
    planMock.mockRejectedValueOnce(new Error('boom'));
    const res = await request(PATH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'unavailable', choice: null, limited: [], health: [] });
  });

  it('rejects query strings and other methods', async () => {
    await setup({});
    expect((await request(`${PATH}?x=1`)).status).toBe(400);
    expect((await request(`${PATH}?`)).status).toBe(400);
    expect((await request(PATH, 'POST')).status).toBe(405);
  });
});
