import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig, WebServerHandle } from '../src/core/types.js';
import { startServer } from '../src/core/web/server.js';

// Requests from the home panes and mounted shell; see the named UI modules.
const HOME_GETS = [
  '/api/verse/activity', // shell/useActivity
  '/api/verse/fleet/runs', // shell/fleet-needs-you-query, Feed
  '/api/verse/agent-bus/needs-mason', // shell/FleetNeedsYouRows
  '/api/verse/fleet/ci-runs?hours=24', // shell/fleet-ci-runs-query
  '/api/verse/leader/resources/resets', // shell/usage-resets-query
  '/api/verse/fleet/control/remote-pending', // shell/phone-pending-query
  '/api/verse/runs-history/main-health', // shell/main-health-query
  '/api/verse/runs-history/lane-streaks', // shell/lane-streak-query
  '/api/verse/runs-history/stuck-fixes', // shell/stuck-fixes-query
  '/api/verse/fleet/self-tick', // shell/self-tick-query
  '/api/verse/app/update-status', // shell/app-update-line
  '/api/verse/ops/self-update', // sections/update-status-queries
  '/api/verse/cloud', // resources/resources-queries
  '/api/verse/devin', // resources/ResourcesBar
  '/api/verse/resources/credit-pools', // resources/credit-pools-query
  '/api/verse/leader/resources/usage-history', // resources/SpendDown
  '/api/verse/observe', // resources/ResourcesBar
  '/api/verse/proactive-agents', // resources/ResourcesBar
  '/api/verse/leader/thread?limit=50', // leader/thread-data, Feed
  '/api/verse/leader/office', // leader-thread/leader-office-data
  '/api/verse/agent-bus?after=0&limit=50', // Feed
] as const;

// These reads stay hidden until dispatch is on. A read session must not open them.
const DISPATCH_HIDDEN = [
  '/api/verse/comms/owner-thread?limit=100',
  '/api/verse/comms/owner-thread/status',
  '/api/verse/comms/gmail-triage/archive-plan',
  '/api/verse/release/stages',
  '/api/verse/comms/inbox?limit=20',
  '/api/verse/fleet/comms-status',
  '/api/verse/fleet/library-files',
  '/api/verse/fleet/handoffs',
  '/api/verse/cos/memory',
] as const;

let root: string;
let runs: string;
let server: WebServerHandle;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'verse-first-run-'));
  runs = await mkdtemp(join(root, 'runs-'));
  const home = await mkdtemp(join(root, 'home-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('ASHLR_RUNS_DIR', runs);
  vi.stubEnv('ASHLR_HOME', join(home, '.ashlr'));
  const cfg: AshlrConfig = { version: 1, roots: [], editor: 'cursor', staleDays: 30,
    categories: {}, tidyRules: [], keepers: [], models: { lmstudio: '', ollama: '', providerChain: [] }, telemetry: {}, tools: {} };
  server = await startServer(cfg, { port: 0, open: false, allowDispatch: false }, { readProjections: null });
}, 30000);
afterAll(async () => {
  if (server) await server.close();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});
describe('first run with an empty runs directory', () => {
  const proof = 'ab'.repeat(32);
  let cookie = '';
  beforeAll(async () => {
    const session = await fetch(`${server.url}/api/session`, {
      method: 'POST',
      headers: { 'x-ashlr-token': server.readToken, 'x-ashlr-read-client': proof },
    });
    expect(session.status).toBe(204);
    const setCookie = session.headers.get('set-cookie') ?? '';
    cookie = setCookie.split(';', 1)[0] ?? '';
    expect(cookie.startsWith('ashlr_read_session=')).toBe(true);
  });
  it.each(HOME_GETS)('%s returns JSON without an error state', async path => {
    const response = await fetch(`${server.url}${path}`, {
      headers: { cookie, 'x-ashlr-read-client': proof },
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status, path).toBeGreaterThanOrEqual(200);
    expect(response.status, path).toBeLessThan(300);
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'sourceState' in body) {
      expect(['degraded', 'error']).not.toContain((body as { sourceState: unknown }).sourceState);
    }
  }, 10000);
  it.each(DISPATCH_HIDDEN)('%s stays not found while dispatch is off', async path => {
    const response = await fetch(`${server.url}${path}`, {
      headers: { cookie, 'x-ashlr-read-client': proof },
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status, path).toBe(404);
    expect(await response.json()).toEqual({ error: 'not found' });
  }, 10000);
  it('does not create files in the runs directory', async () => {
    expect(await readdir(runs)).toEqual([]);
  });
});
