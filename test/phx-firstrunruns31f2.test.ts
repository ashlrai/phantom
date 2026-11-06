import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { readInboxEntries } from '../src/core/fleet/mason-inbox.js';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import { listLiveWorkers } from '../src/core/fleet/runs-live-workers.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_INBOX_PATH, VERSE_FLEET_RUNS_PATH } from '../src/core/verse/fleet-runs-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'fake-first-run-'));
  roots.push(root);
  const runsDir = join(root, 'fleet');
  let clock = Date.parse('2026-10-31T00:30:00Z');
  let ps: string | null = null;
  const now = () => clock;
  const api = createFleetRunsApi({
    now,
    readRunsDir: () => readFleetRunsDirState({ runsDir, now }),
    listWorkers: () => listLiveWorkers({ now, runPs: async () => {
      if (ps === null) throw new Error('fake process table unavailable');
      return ps;
    } }),
    readInbox: limit => readInboxEntries({ runsDir, limit }),
    // The unrelated providers are deliberately unavailable; never access a live account or network.
    codexPersonal: async () => { throw new Error('fake provider unavailable'); },
    mergedLastHour: async () => { throw new Error('fake provider unavailable'); },
  });
  return {
    runsDir, api, now,
    advance: (ms: number) => { clock += ms; },
    setPs: (table: string) => { ps = table; },
  };
}

async function get(api: ReturnType<typeof createFleetRunsApi>, path = VERSE_FLEET_RUNS_PATH) {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.url = path;
  req.method = 'GET';
  req.headers = {};
  let status = 0;
  let wire: unknown;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; },
    end(text: string) { wire = JSON.parse(text); },
  } as unknown as ServerResponse;
  const handled = await api({} as VerseApiContext, req, res, path, 'GET');
  return { handled, status, wire };
}

async function populate(runsDir: string) {
  await mkdir(join(runsDir, 'queue'), { recursive: true });
  await mkdir(join(runsDir, 'leader'), { recursive: true });
  await writeFile(join(runsDir, 'queue/status.json'), JSON.stringify({
    last_tick: '2026-10-31T00:30:00Z', paused: false, mem_free_pct: 42,
    lanes: { 'codex-personal': { running: 1, target: 2, queued: 3, held: false } },
  }));
  await writeFile(join(runsDir, 'queue/claimed.tsv'), 'RQ-FAKE-1\tcodex-personal\tfrontier\t00:30\t1793406600\n');
  await writeFile(join(runsDir, 'dispatch-events.log'), '2026-10-31 00:30:00 LAUNCH RQ-FAKE-1\n');
  await writeFile(join(runsDir, 'leader/MASON-INBOX.md'), '## 2026-10-30 20:30 ET (Fake operator, Fake desktop) PRIORITY P0\nFake first-run message\n');
}

describe('desktop fleet first run with real readers', () => {
  it('returns an honest empty snapshot when fleet files and the process table are unavailable', async () => {
    const { api } = await setup();
    const result = await get(api);
    expect(result).toMatchObject({ handled: true, status: 200, wire: {
      sources: { runsDir: 'missing', codex: 'degraded', merges: 'degraded' },
      lanes: [], workers: [], events: [], inbox: [], lastTick: null,
    } });
    expect.soft(result.wire).toMatchObject({ sources: { workers: 'degraded' } });
    expect.soft(result.wire).toMatchObject({ sources: { inbox: 'missing' } });
    expect(await get(api, VERSE_FLEET_RUNS_INBOX_PATH)).toMatchObject({ handled: true, status: 200, wire: { sourceState: 'missing', entries: [] } });
  });

  it('refreshes the same API after files and a worker appear, without unrelated providers', async () => {
    const env = await setup();
    expect(await get(env.api)).toMatchObject({ handled: true, status: 200 });
    await populate(env.runsDir);
    env.setPs('  123 00:42 /fake/bin/launch.sh RQ-FAKE-1 phantom codex-personal frontier\n');
    const cached = await get(env.api);
    expect(cached).toMatchObject({ status: 200, wire: { lanes: [], workers: [] } });
    env.advance(2000);
    const refreshed = await get(env.api);
    expect(refreshed).toMatchObject({ handled: true, status: 200, wire: {
      sources: { runsDir: 'degraded', workers: 'healthy', codex: 'degraded', merges: 'degraded' },
      lastTick: '2026-10-31T00:30:00Z',
      lanes: [{ lane: 'codex-personal', running: 1, target: 2, queued: 3, held: false }],
      workers: [{ job: 'RQ-FAKE-1', repo: 'phantom', lane: 'codex-personal', tier: 'frontier', ageSeconds: 42 }],
      events: [{ at: '2026-10-31T00:30:00Z', kind: 'LAUNCH', text: 'RQ-FAKE-1' }],
    } });
    expect.soft(refreshed.wire).toMatchObject({ sources: { inbox: 'healthy' },
      inbox: [{ at: '2026-10-30 20:30', source: 'Fake desktop', text: 'Fake first-run message' }],
    });
    expect(await readFleetRunsDirState({ runsDir: env.runsDir, now: env.now })).toMatchObject({
      sources: { status: 'healthy', claimed: 'healthy', events: 'healthy', metrics: 'missing' },
      claimed: [{ job: 'RQ-FAKE-1', lane: 'codex-personal', tier: 'frontier' }],
    });
    expect(await get(env.api, VERSE_FLEET_RUNS_INBOX_PATH)).toMatchObject({ status: 200, wire: {
      sourceState: 'healthy', entries: [{ source: 'Fake desktop', text: 'Fake first-run message' }],
    } });
  });
});
