/**
 * dispatch-events-path-02 — the lane-streaks route reads the canonical
 * candidate order from dispatch-events-path.ts with real files and the
 * default reader: queue-only works, root-only works, queue wins when both
 * exist, and neither answers `unavailable`. Fake lanes only.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRunsHistoryApi,
  VERSE_RUNS_HISTORY_LANE_STREAKS_PATH as PATH,
  type RunsHistoryApiDeps,
} from '../src/core/verse/runs-history-api.js';
import { dispatchEventsCandidates } from '../src/core/fleet/dispatch-events-path.js';
import { readDispatchEventsLog } from '../src/cli/fleet-lane-streaks.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const ctx = { token: 'fixture-token', allowDispatch: false } as VerseApiContext;
const savedHome = process.env.HOME!;
let home = '';

/** `YYYY-MM-DD HH:MM:SS` five minutes ago in the log's wall-clock convention. */
const stamp = () => new Date(Date.now() - 5 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
const log = (lane: string) => `${stamp()} LAUNCH RQ-FX1A1102X8 fixture-repo ${lane} mid\n`;

async function relocate(): Promise<string> {
  home = await mkdtemp(join(tmpdir(), 'runs-'));
  process.env.HOME = home;
  return join(home, '.ashlr-runs');
}

afterEach(async () => {
  process.env.HOME = savedHome;
  if (home) await rm(home, { recursive: true, force: true });
});

describe('dispatchEventsCandidates', () => {
  it('orders the queue log first and the runs-root log second', () => {
    expect(dispatchEventsCandidates('/runs-fixture')).toEqual([
      join('/runs-fixture', 'queue', 'dispatch-events.log'),
      join('/runs-fixture', 'dispatch-events.log'),
    ]);
  });
});

describe('lane-streaks route with real files', () => {
  const deps: RunsHistoryApiDeps = {
    sample: vi.fn(async () => true),
    readHistory: vi.fn(async () => { throw new Error('unused'); }),
  };

  async function call() {
    const req = new PassThrough() as IncomingMessage & PassThrough;
    Object.assign(req, { method: 'GET', url: `${PATH}?minutes=60`, headers: {} });
    req.end();
    let status = 0;
    let payload = '';
    const res = {
      writeHead(code: number) { status = code; return this; },
      end(chunk?: string) { payload = chunk ?? ''; return this; },
    } as unknown as ServerResponse;
    const handled = await createRunsHistoryApi(deps)(ctx, req, res, PATH, 'GET');
    return { handled, status, json: JSON.parse(payload) as Record<string, unknown> };
  }

  const writeLog = async (relative: string, lane: string) => {
    const file = join(process.env.HOME!, '.ashlr-runs', ...relative.split('/'));
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, log(lane));
  };

  it('reads the queue log when only queue/dispatch-events.log exists', async () => {
    await relocate();
    await writeLog('queue/dispatch-events.log', 'queue-fx-lane');
    const result = await call();
    expect(result.handled).toBe(true);
    expect(result.json).toMatchObject({ v: 1, source: 'ok', windowMinutes: 60 });
    expect(result.json.lanes).toEqual([
      expect.objectContaining({ lane: 'queue-fx-lane', launches: 1 }),
    ]);
  });

  it('falls back to the root log when only dispatch-events.log exists', async () => {
    await relocate();
    await writeLog('dispatch-events.log', 'root-fx-lane');
    const result = await call();
    expect(result.json).toMatchObject({ source: 'ok' });
    expect(result.json.lanes).toEqual([
      expect.objectContaining({ lane: 'root-fx-lane', launches: 1 }),
    ]);
  });

  it('prefers the queue log when both exist', async () => {
    await relocate();
    await writeLog('queue/dispatch-events.log', 'queue-fx-lane');
    await writeLog('dispatch-events.log', 'root-fx-lane');
    const result = await call();
    expect(result.json.lanes).toEqual([
      expect.objectContaining({ lane: 'queue-fx-lane', launches: 1 }),
    ]);
  });

  it('answers unavailable when neither candidate exists', async () => {
    await relocate();
    const result = await call();
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ v: 1, source: 'unavailable', lanes: [] });
  });

  it('the CLI reader follows the same order on an explicit runs dir', async () => {
    const runsDir = await relocate();
    await mkdir(join(runsDir, 'queue'), { recursive: true });
    await writeFile(join(runsDir, 'queue', 'dispatch-events.log'), log('queue-fx-lane'));
    expect(await readDispatchEventsLog(runsDir)).toContain('queue-fx-lane');
  });
});
