/**
 * RQ-PHX-REDDESKFIXC175 — regression for ashlrai/phantom#3193
 * (bridge: RQ-PHX-APPSCARDRECOVERY03).
 *
 * The PR's Quick typecheck failed because its verse-api.ts predated the
 * `goals` workbench family; merged forward it dropped that required entry.
 * The fix replays only the PR's one-line intent onto current master: the
 * mounted `fleet-apps` module is the recovery-aware handler.
 *
 * These tests pin that fix through the real modules — the mounted-module
 * table, the shipped handler over real bus-inbox history, and the row model
 * the desktop AppsCard renders — rather than re-declaring the expectations.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import { handleFleetAppsRecoveryApi } from '../src/core/verse/fleet-apps-recovery-api.js';
import { mountedApiModules, setMountedApiModulesForTest, type VerseApiContext } from '../src/core/verse/verse-api.js';
import { createAppsWatchPublisher } from '../src/core/fleet/apps-watch-bus.js';
import { appRecoveryRow } from '../src/web-ui/routes/verse/fleet-host/apps-recovery-row-model.js';

const RECOVERY = '/api/verse/fleet/apps/recovery';

async function call(api: ApiModule, url = RECOVERY, method = 'GET') {
  let status = 404, text = '';
  const req = Object.assign(new PassThrough(), { url, method }) as IncomingMessage;
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(body: string) { text = body; },
  } as unknown as ServerResponse;
  const handled = await api({ cfg: {} } as VerseApiContext, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, body: text ? JSON.parse(text) : null };
}

let runsDir: string;
let previousRunsDir: string | undefined;
beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'red-desk-c175-'));
  previousRunsDir = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = runsDir;
  setMountedApiModulesForTest(null);
});
afterEach(() => {
  if (previousRunsDir === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = previousRunsDir;
  rmSync(runsDir, { recursive: true, force: true });
});

describe('mounted fleet-apps module (the #3193 fix)', () => {
  it('mounts the recovery-aware handler exactly once through the default loader', async () => {
    const ids = mountedApiModules().map((m) => m.id);
    expect(ids.filter((id) => id === 'fleet-apps')).toHaveLength(1);
    const entry = mountedApiModules().find((m) => m.id === 'fleet-apps')!;
    expect(await entry.load()).toBe(handleFleetAppsRecoveryApi);
  });

  it('serves the recovery projection the AppsCard polls, end to end', async () => {
    const publish = createAppsWatchPublisher(runsDir);
    expect(publish({
      kind: 'apps-watch.summary.v1', apps: ['Codex'], outcome: 'failed',
      cycles: 3, recoveries: 0, consecutiveFailures: 3, totalFailedCycles: 3,
      lastObservedState: [{ app: 'Codex', observedRunning: false }],
    })).toBe(true);
    const entry = mountedApiModules().find((m) => m.id === 'fleet-apps')!;
    const api = await entry.load();
    const res = await call(api);
    expect(res.handled).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body.v).toBe(1);
    expect(res.body.apps).toHaveLength(1);
    expect(res.body.apps[0]).toMatchObject({ app: 'Codex', outcome: 'gave-up' });
    // The row the card renders from this exact body: retryable warning, not quiet.
    expect(appRecoveryRow(res.body, 'Codex')).toMatchObject({
      label: 'recovery gave up', tone: 'warning', canRetry: true,
    });
  });

  it('answers an empty projection for a runs dir with no history', async () => {
    const res = await call(handleFleetAppsRecoveryApi);
    expect(res).toMatchObject({ handled: true, status: 200 });
    expect(res.body).toEqual({ v: 1, apps: [] });
    expect(appRecoveryRow(res.body, 'Codex')).toEqual({
      label: 'no recovery recorded', tone: 'muted', ageText: '', canRetry: false,
    });
  });

  it('refuses writes on the read-only recovery path', async () => {
    expect(await call(handleFleetAppsRecoveryApi, RECOVERY, 'POST')).toMatchObject({ handled: true, status: 405 });
    expect(await call(handleFleetAppsRecoveryApi, RECOVERY, 'PUT')).toMatchObject({ handled: true, status: 405 });
  });

  it('still delegates every sibling fleet-apps path to the app-control module', async () => {
    // POST /action without dispatch permission is the app module's own 404 — proof
    // the request reached handleFleetAppsApi rather than the recovery branch.
    expect(await call(handleFleetAppsRecoveryApi, '/api/verse/fleet/apps/action', 'POST'))
      .toMatchObject({ handled: true, status: 404 });
    expect((await call(handleFleetAppsRecoveryApi, '/api/verse/unrelated')).handled).toBe(false);
  });
});
