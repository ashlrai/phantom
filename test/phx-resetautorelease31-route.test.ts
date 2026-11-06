/**
 * PHX-RESETAUTORELEASE31 — route contract for GET /api/verse/ops/reset-releases
 * and for arming the reset-release loop from the self-update GET the desktop
 * gear badge polls. Temp runs dir via ASHLR_RUNS_DIR; the loop is stopped and
 * the env restored after every test.
 */
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createOpsApi, type OpsApiDeps } from '../src/core/verse/ops-api.js';
import { VERSE_OPS_RESET_RELEASES_PATH, VERSE_OPS_SELF_UPDATE_PATH } from '../src/core/verse/ops-types.js';
import { getResetReleaseState, stopResetReleaseLoopForTest } from '../src/core/fleet/usage-reset-release.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';

const TOKEN = 'ops-reset-token';
const NOW_MS = Date.parse('2026-10-31T19:28:00Z');
const NOW_ISO = new Date(NOW_MS).toISOString();
const T0 = Date.parse('2026-10-31T19:00:00Z');
const READING = '2026-10-31T19:10:00Z';
const HELD_UNTIL = '2026-11-04T00:00:00Z';

let runsDir: string;
beforeEach(async () => {
  stopResetReleaseLoopForTest();
  runsDir = await mkdtemp(join(tmpdir(), 'reset-release-route-'));
  await mkdir(join(runsDir, 'queue'));
  vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
});
afterEach(async () => {
  stopResetReleaseLoopForTest();
  vi.unstubAllEnvs();
  await rm(runsDir, { recursive: true, force: true });
});

async function seedHeldLane() {
  await writeFile(join(runsDir, 'queue/slots.json'), JSON.stringify({
    'lane-a': { target: 2, floor: 0, ceiling: 4, held: true,
      held_reason: `autobackoff fake job=j-1 until=${HELD_UNTIL} src=fake`,
      held_until: HELD_UNTIL, held_by: 'autobackoff', last_change: T0 / 1000 },
  }));
  await writeFile(join(runsDir, 'queue/status.json'), JSON.stringify({
    last_tick: READING, lanes: { 'lane-a': { held: true } }, budget: { 'lane-a': { weekly_used_pct: 3 } },
  }));
}

const deps = (): OpsApiDeps => ({ now: () => NOW_MS, selfUpdate: { repoRoot: () => null } });

async function request(api: ReturnType<typeof createOpsApi>, options: { path: string; method?: string; allowDispatch?: boolean }): Promise<{ handled: boolean; status: number; wire: Record<string, unknown> | null }> {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.url = options.path;
  req.method = options.method ?? 'GET';
  req.headers = { 'x-ashlr-token': TOKEN };
  let status = 0;
  let wire: Record<string, unknown> | null = null;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; },
    end(text: string) { try { wire = JSON.parse(text); } catch { wire = null; } },
  } as unknown as ServerResponse;
  const ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: options.allowDispatch ?? true } as VerseApiContext;
  const handled = await api(ctx, req, res, options.path.split('?')[0]!, options.method ?? 'GET');
  return { handled, status, wire };
}

it('GET serves the loop state and the audit tail; other methods are 405 and queries are rejected', async () => {
  const api = createOpsApi(deps());
  expect((await request(api, { path: VERSE_OPS_RESET_RELEASES_PATH }))).toMatchObject({
    status: 200,
    wire: { v: 1, generatedAt: NOW_ISO, loop: { started: false, lastRunAt: null, lastResult: null, lastError: null }, releases: [] },
  });
  await writeFile(join(runsDir, 'queue/reset-releases.jsonl'),
    `${JSON.stringify({ v: 1, at: NOW_ISO, lane: 'lane-a', state: 'reset-detected', usedPct: 3, readingAsOf: READING, heldUntil: HELD_UNTIL, by: 'reset-detect', reason: `window reset: reads 3% at ${READING}` })}\n`);
  const seeded = await request(api, { path: VERSE_OPS_RESET_RELEASES_PATH });
  expect(seeded.wire?.releases).toMatchObject([{ lane: 'lane-a', state: 'reset-detected', usedPct: 3, by: 'reset-detect' }]);
  expect((await request(api, { path: VERSE_OPS_RESET_RELEASES_PATH, method: 'POST' })).status).toBe(405);
  expect((await request(api, { path: VERSE_OPS_RESET_RELEASES_PATH, method: 'DELETE' })).status).toBe(405);
  expect((await request(api, { path: `${VERSE_OPS_RESET_RELEASES_PATH}?limit=5` })).status).toBe(400);
  expect((await request(api, { path: '/api/verse/ops/nope' })).handled).toBe(false);
});

it('the self-update GET arms the loop once across two polls when dispatch is allowed, releasing the reset lane', async () => {
  vi.stubEnv('VITEST', ''); // the route skips arming under Vitest; simulate a live desktop
  await seedHeldLane();
  const api = createOpsApi(deps());
  const first = await request(api, { path: VERSE_OPS_SELF_UPDATE_PATH });
  expect(first).toMatchObject({ status: 200, wire: { sourceState: 'unavailable', repoRoot: false } });
  await vi.waitFor(() => expect(getResetReleaseState().lastRunAt).toBe(NOW_ISO));
  const second = await request(api, { path: VERSE_OPS_SELF_UPDATE_PATH });
  expect(second.status).toBe(200);
  const loop = getResetReleaseState();
  expect(loop.started).toBe(true);
  expect(loop.lastResult!.released).toEqual([
    { lane: 'lane-a', state: 'reset-detected', usedPct: 3, readingAsOf: READING, heldUntil: HELD_UNTIL },
  ]);
  // The released lane is narrated by the audit route and the dispatch event line.
  const view = await request(api, { path: VERSE_OPS_RESET_RELEASES_PATH });
  expect(view.wire).toMatchObject({ loop: { started: true, lastRunAt: NOW_ISO }, releases: [{ lane: 'lane-a', by: 'reset-detect' }] });
  expect(await readFile(join(runsDir, 'dispatch-events.log'), 'utf8')).toContain(`LANE_HOLD released lane-a by reset-detect: window reset: reads 3% at ${READING}`);
});

it('the loop is never armed without dispatch or under Vitest', async () => {
  await seedHeldLane();
  const api = createOpsApi(deps());
  expect((await request(api, { path: VERSE_OPS_SELF_UPDATE_PATH, allowDispatch: false })).status).toBe(200);
  expect(getResetReleaseState().started).toBe(false);
  // VITEST is set in this environment — a mutating poll still must not arm.
  expect((await request(api, { path: VERSE_OPS_SELF_UPDATE_PATH })).status).toBe(200);
  expect(getResetReleaseState().started).toBe(false);
});
