import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendInboxEntry } from '../src/core/fleet/mason-inbox.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_PATH as RUNS, VERSE_FLEET_RUNS_INBOX_PATH as INBOX } from '../src/core/verse/fleet-runs-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const workers = [{ job: 'fake-job', repo: 'fake/repo', lane: 'fake-lane', tier: 'fake-tier', ageSeconds: 3 }];
const token = 'fake-test-token';
const makeApi = () => createFleetRunsApi({
  readRunsDir: async () => { throw new Error('fake unavailable'); },
  listWorkers: async () => ({ workers, leaders: [], orchestratorAgents: 1 }),
  codexPersonal: async () => null,
  mergedLastHour: async () => ({ count: 0, items: [] }),
});

async function request(api: ReturnType<typeof makeApi>, path: string, method = 'GET', body?: object) {
  const req = Readable.from(method === 'POST' ? [JSON.stringify(body)] : []) as unknown as IncomingMessage;
  req.url = path;
  req.method = method;
  req.headers = { 'content-type': 'application/json', 'x-ashlr-token': token };
  let status = 0;
  let wire: unknown;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; },
    end(text: string) { wire = JSON.parse(text); },
  } as unknown as ServerResponse;
  const handled = await api({ token, allowDispatch: true } as VerseApiContext, req, res, path.split('?')[0]!, method);
  return { handled, status, wire };
}

describe('fleet composite with the real inbox reader', () => {
  let home: string;
  let originalHome: string | undefined;
  beforeEach(async () => {
    originalHome = process.env.HOME;
    home = await mkdtemp(join(tmpdir(), 'fake-fleet-inbox-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it('shows a persisted entry on first launch with only composite public fields', async () => {
    const appended = await appendInboxEntry('fake shared order', {
      source: 'Fake desktop', now: () => new Date('2026-10-31T12:00:00Z'),
    });
    expect(appended.ok).toBe(true);
    const api = makeApi();
    expect(await request(api, RUNS)).toMatchObject({ handled: true, status: 200, wire: {
      sources: { inbox: 'healthy', workers: 'healthy' }, workers,
      inbox: [{ at: '2026-10-31 08:00', source: 'Fake desktop', text: 'fake shared order' }],
    } });
    const composite = (await request(api, RUNS)).wire as { inbox: object[] };
    expect(Object.keys(composite.inbox[0]!).sort()).toEqual(['at', 'source', 'text']);
    expect(await request(api, INBOX)).toMatchObject({ status: 200, wire: {
      sourceState: 'healthy', entries: [{ at: '2026-10-31 08:00', source: 'Fake desktop', priority: 'P0', text: 'fake shared order' }],
    } });
  });

  it('preserves missing health and invalidates the composite after a real POST', async () => {
    const api = makeApi();
    expect(await request(api, RUNS)).toMatchObject({ status: 200, wire: { sources: { inbox: 'missing', workers: 'healthy' }, inbox: [], workers } });
    expect(await request(api, INBOX)).toMatchObject({ status: 200, wire: { sourceState: 'missing', entries: [] } });
    expect(await request(api, INBOX, 'POST', { text: 'fake posted order', source: 'Fake desktop' })).toMatchObject({ status: 201, wire: { ok: true, accepted: true } });
    expect(await request(api, RUNS)).toMatchObject({ status: 200, wire: { sources: { inbox: 'healthy' }, inbox: [{ source: 'Fake desktop', text: 'fake posted order' }] } });
    expect(await request(api, INBOX)).toMatchObject({ status: 200, wire: { sourceState: 'healthy', entries: [{ text: 'fake posted order', priority: 'P0' }] } });
  });

  it('isolates an unreadable inbox source from healthy workers', async () => {
    const runsDir = join(home, '.ashlr-runs');
    // A regular file in place of the runs directory yields ENOTDIR on read.
    await writeFile(runsDir, 'fake corrupt source');
    expect(await request(makeApi(), RUNS)).toMatchObject({ status: 200, wire: {
      sources: { inbox: 'degraded', workers: 'healthy' }, inbox: [], workers,
    } });
  });
});
