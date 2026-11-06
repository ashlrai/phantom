/**
 * RQ-PHX-SELFTICKNEEDSYOU02 — GET /api/verse/fleet/self-tick: the read-only
 * projection of queue/self-tick-last.json for the desktop Needs-you list.
 * An empty runs dir answers last:null, a written record answers the ok view,
 * garbage answers unreadable, and the route never takes the self-tick lock.
 * Everything runs against a temp dir under os.tmpdir(), never ~/.ashlr-runs.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFleetSelfTickApi, VERSE_FLEET_SELF_TICK_PATH as PATH } from '../src/core/verse/fleet-self-tick-api.js';
import { SELF_TICK_LAST, writeSelfTickLast } from '../src/core/fleet/self-tick-last.js';
import { SELF_TICK_LOCK, type SelfTickReport } from '../src/core/fleet/self-tick.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import { mountedApiModules, setMountedApiModulesForTest, type VerseApiContext } from '../src/core/verse/verse-api.js';

async function call(api: ApiModule, url = PATH, method = 'GET') {
  let status = 404, text = '';
  const req = Object.assign(new PassThrough(), { url, method }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {} } as VerseApiContext, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, body: text ? JSON.parse(text) : null, text };
}

const AT = '2026-11-01T12:00:00Z';
const NOW = Date.parse(AT) + 300_000;

const report = (state: SelfTickReport['state'] = 'ran'): SelfTickReport => ({
  v: 1,
  at: AT,
  mode: 'apply',
  state,
  // A 'busy' report never ran a step — the lock was contended.
  steps: state === 'busy' ? [] : [
    { step: 'reset-release', state: 'ok', exitCode: 0, report: null },
    { step: 'lane-autohold', state: 'failed', exitCode: 1, report: { error: 'boom' } },
    { step: 'planner-tick', state: 'ok', exitCode: 0, report: null },
  ],
});

let runsDir: string;
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'self-tick-api-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

describe('fleet self-tick read route', () => {
  it('returns last:null on an empty runs dir', async () => {
    const result = await call(createFleetSelfTickApi({ runsDir, now: () => NOW }));
    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ v: 1, last: null });
  });

  it('returns the ok view for a written record', async () => {
    writeSelfTickLast(runsDir, report());
    const result = await call(createFleetSelfTickApi({ runsDir, now: () => NOW }));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      v: 1,
      last: {
        state: 'ok', at: AT, mode: 'apply', ranState: 'ran',
        ageSeconds: 300, failedSteps: ['lane-autohold'],
      },
    });
  });

  it('returns a busy ranState as ok without failed steps', async () => {
    writeSelfTickLast(runsDir, report('busy'));
    const result = await call(createFleetSelfTickApi({ runsDir, now: () => NOW }));
    expect(result.body).toMatchObject({ last: { state: 'ok', ranState: 'busy', failedSteps: [] } });
  });

  it('returns unreadable for a garbage record file', async () => {
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    writeFileSync(join(runsDir, SELF_TICK_LAST), 'not json {');
    const result = await call(createFleetSelfTickApi({ runsDir, now: () => NOW }));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ v: 1, last: { state: 'unreadable' } });
  });

  it('never creates the self-tick lock', async () => {
    const api = createFleetSelfTickApi({ runsDir, now: () => NOW });
    await call(api);
    writeSelfTickLast(runsDir, report());
    await call(api);
    expect(existsSync(join(runsDir, SELF_TICK_LOCK))).toBe(false);
  });

  it('declines other methods and foreign paths without reading', async () => {
    const api = createFleetSelfTickApi({ runsDir });
    // POST is handled since RQ-PHX-SELFTICKRUNNOW02, but this ctx carries no
    // dispatch allowance, so the mutation gate answers 404 before any run.
    expect(await call(api, PATH, 'POST')).toMatchObject({ handled: true, status: 404 });
    expect((await call(api, PATH, 'HEAD')).handled).toBe(false);
    expect((await call(api, '/api/verse/fleet/memory')).handled).toBe(false);
  });

  it('is mounted next to fleet-memory and answers through the default loader', async () => {
    setMountedApiModulesForTest(null);
    const ids = mountedApiModules().map((m) => m.id);
    expect(ids.indexOf('fleet-self-tick')).toBe(ids.indexOf('fleet-standby') + 1);
    const previous = process.env.ASHLR_RUNS_DIR;
    process.env.ASHLR_RUNS_DIR = runsDir;
    try {
      const entry = mountedApiModules().find((m) => m.id === 'fleet-self-tick')!;
      const result = await call(await entry.load());
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ v: 1, last: null });
    } finally {
      if (previous === undefined) delete process.env.ASHLR_RUNS_DIR;
      else process.env.ASHLR_RUNS_DIR = previous;
    }
  });
});
