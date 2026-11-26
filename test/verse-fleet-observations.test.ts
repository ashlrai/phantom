import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadConfigReadOnly } from '../src/core/config.js';
import { emptyState } from '../src/core/drive/nodes/state.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { loadSensorReport } from '../src/core/observe/read.js';
import { recordClaudeApiGrantObservation } from '../src/core/resources/claude-api-grant.js';
import type { WebServerHandle } from '../src/core/types.js';
import { readSseAuth, startServer } from './helpers/authenticated-web-server.js';

let root: string;
let runs: string;
let home: string;
let server: WebServerHandle | undefined;
const control = '/api/verse/fleet/control';
const now = Date.now() - 1000;
const at = new Date(now).toISOString();
const reset = new Date(now + 86400_000).toISOString();

function json(path: string, value: unknown) {
  return writeFile(path, JSON.stringify(value));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'verse-fleet-'));
  runs = join(root, 'fleet-runs');
  home = join(root, '.ashlr');
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_HOME', home);
  vi.stubEnv('ASHLR_RUNS_DIR', runs);
  for (const dir of [join(runs, 'queue/run'), join(runs, 'metrics'), join(home, 'node-pool')]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  await json(join(runs, 'queue/status.json'), {
    schema: 'dispatchd.status.v1', last_tick: at, paused: null, mem_free_pct: 40,
    lanes: { claude: { running: 2, target: 6, queued: 1, hard_cap: 8, held: false } },
    budget: { claude: { weekly_used_pct: 45, observed_at: at, reset_at: reset, source: 'claude-usage' },
      'codex-personal': { weekly_used_pct: 25, as_of: now / 1000, reset_at: Date.parse(reset) / 1000 } },
  });
  await json(join(runs, 'queue/slots.json'), { claude: { target: 6, floor: 0, ceiling: 8 } });
  await writeFile(join(runs, 'queue/ready.tsv'), 'RQ-WAIT\tphantom\tclaude\tfrontier\tgoal=synthetic\n');
  await writeFile(join(runs, 'metrics/jobs.jsonl'), JSON.stringify({ event: 'launch', ts: at, job: 'RQ-OPEN', lane: 'claude' }) + '\n');
  await json(join(home, 'node-pool/primary-mirror.json'), {
    ...emptyState(), observedAt: now, sequence: 3,
    nodes: ['pro', 'muse', 'air'].map((nodeId, i) => ({ nodeId, session: i + 1, heartbeatAt: now, expiresAt: now + 300_000, slots: 2 })),
  });
});

afterEach(async () => {
  try { await server?.close(); } finally {
    server = undefined;
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it('serves dispatch, queue and machine observations from the configured runs and node roots', async () => {
  expect(appendBusInbox({ id: 'note-1', from: 'planner', to: 'worker', priority: 'P2', ttl: 60_000,
    body: { text: 'fixture private text' }, channel: 'bus', channel_ref: 'note-1', external: false,
    sender: { agent_id: 'planner', vendor: 'claude', human: false, team: true } }, { now: () => now }).status).toBe('posted');
  server = await startServer(loadConfigReadOnly(), { port: 0, open: false, allowDispatch: false });
  const { query, headers } = await readSseAuth(server);
  const url = `http://127.0.0.1:${server.port}`;
  const get = async (path: string) => {
    const response = await fetch(url + path, { headers: { ...headers, 'x-ashlr-read-client': query.slice(8) } });
    expect(response.status, path).toBe(200);
    return response.json();
  };
  expect((await fetch(url + control + '/compute')).status).toBe(401);
  expect(await get(control + '/compute')).toMatchObject({
    dispatcherAt: at, nodes: expect.arrayContaining(['pro', 'muse', 'air'].map(id => expect.objectContaining({ id }))),
    lanes: { claude: { hardCap: 8, quotaOk: null } },
  });
  expect(await get(control + '/sessions')).toMatchObject({
    mapSessions: expect.arrayContaining([expect.objectContaining({ job: 'RQ-WAIT', mapState: 'queued', nodeId: null })]),
  });
  expect(await get('/api/fleet/lanes')).toMatchObject({
    lanes: expect.arrayContaining([expect.objectContaining({ lane: 'claude', liveJobs: 2, queueDepth: 1, slotTarget: 6,
      startsInWindow: 1, hold: expect.objectContaining({ held: false }), credit: expect.objectContaining({ remainingPct: 55, observedAt: at, resetAt: reset }) })]),
  });
  const map = await get(control + '/map');
  expect(map).toMatchObject({ sources: { messages: 'available' }, unmappedMessages: 1, tree: { leader: { dispatcher: { lastTick: at } } } });
  expect(JSON.stringify(map)).not.toContain('fixture private text');
  const stream = await fetch(url + '/api/events' + query + '&topics=fleet-compute', {
    headers, signal: AbortSignal.timeout(8000),
  });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  try {
    let text = '';
    while (!text.includes('event: fleet-compute')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString('utf8');
    }
    expect(text).toContain('event: fleet-compute\ndata: {"refresh":true}');
  } finally {
    await reader.cancel();
  }
}, 15_000);

it('projects local resource readings with no resource-live sidecar and expires them', async () => {
  const accounts = join(home, 'account-connections');
  await mkdir(accounts, { mode: 0o700 });
  expect(recordClaudeApiGrantObservation(accounts, {
    v: 1, kind: 'claude-api-promotion-history', observationId: 'fixture-grant', cycleId: null, binding: null,
    remainingUsdMicros: '75000000', totalUsdMicros: '100000000', capturedAt: at,
    expiry: { precision: 'instant', date: reset.slice(0, 10), timezone: 'UTC', instant: reset }, evidenceDigest: 'd'.repeat(64),
  }, now).ok).toBe(true);
  expect(await loadSensorReport(now + 1)).toMatchObject({
    lanes: expect.arrayContaining([
      expect.objectContaining({ lane: 'claude-max', used: 45, remaining: 55, observedAt: at, resetAt: reset }),
      expect.objectContaining({ lane: 'codex-personal', used: 25, remaining: 75 }),
      ...(process.platform === 'win32' ? [] : [expect.objectContaining({ lane: 'claude-api', used: 25, remaining: 75 })]),
    ]),
  });
  expect(await loadSensorReport(now + 16 * 60_000)).toMatchObject({
    lanes: expect.arrayContaining(['claude-max', 'codex-personal', 'claude-api'].map(lane =>
      expect.objectContaining({ lane, used: null, remaining: null, source: 'unmeasured' }))),
  });
});
