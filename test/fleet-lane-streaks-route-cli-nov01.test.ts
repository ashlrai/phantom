/**
 * The lane-streaks detector on the wire: `GET /api/verse/runs-history/
 * lane-streaks` (deps injected, no server, no real files) and
 * `ashlr fleet lane-streaks` (deps injected). Fixture ids and lanes only.
 */
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  createRunsHistoryApi,
  VERSE_RUNS_HISTORY_LANE_STREAKS_PATH as PATH,
  VERSE_RUNS_HISTORY_PATH,
  type RunsHistoryApiDeps,
} from '../src/core/verse/runs-history-api.js';
import { cmdFleetLaneStreaks } from '../src/cli/fleet-lane-streaks.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const ctx = { token: 'fixture-token', allowDispatch: false } as VerseApiContext;

/** `YYYY-MM-DD HH:MM:SS` in the log's wall-clock convention, msAgo back from now. */
const stamp = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');
const MIN = 60_000;

/** Three claude-api launches ending empty inside a 60-minute window. */
const burningLog = () => [
  `${stamp(55 * MIN)} LAUNCH RQ-RT1A103123Q8 phantom-secrets claude-api mid`,
  `${stamp(50 * MIN)} EMPTY_DONE RQ-RT1A103123Q8`,
  `${stamp(45 * MIN)} LAUNCH RQ-RT2A103123Q8 phantom-secrets claude-api mid`,
  `${stamp(40 * MIN)} EMPTY_DONE RQ-RT2A103123Q8`,
  `${stamp(35 * MIN)} LAUNCH RQ-RT3A103123Q8 phantom-secrets claude-api mid`,
  `${stamp(25 * MIN)} EMPTY_DONE RQ-RT3A103123Q8`,
].join('\n');

/** Fixed-clock fixture mirroring the Nov 1 incident for exact text output. */
const NOV01 = [
  '2026-11-01 05:34:12 LAUNCH RQ-PS9A103123Q8 phantom-secrets claude-api mid',
  '2026-11-01 05:43:16 LAUNCH RQ-PS10A103123Q8 phantom-secrets claude-api mid',
  '2026-11-01 05:44:12 EMPTY_DONE RQ-PS9A103123Q8',
  '2026-11-01 05:45:30 LAUNCH RQ-PS11A103123Q8 phantom-secrets claude-api mid',
  '2026-11-01 05:55:30 EMPTY_DONE RQ-PS11A103123Q8',
  '2026-11-01 05:56:21 EMPTY_DONE RQ-PS10A103123Q8',
].join('\n');
const NOV01_NOW = Date.parse('2026-11-01T06:00:00Z');

const deps = (over: Partial<RunsHistoryApiDeps> = {}): RunsHistoryApiDeps => ({
  sample: vi.fn(async () => true),
  readHistory: vi.fn(async () => { throw new Error('unused'); }),
  readDispatchEvents: vi.fn(async () => burningLog()),
  ...over,
});

async function call(method: string, url = PATH, d: RunsHistoryApiDeps = deps()) {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method, url, headers: {} });
  req.end();
  let status = 0;
  let payload = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const handled = await createRunsHistoryApi(d)(ctx, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, json: payload ? (JSON.parse(payload) as Record<string, unknown>) : null };
}

describe('GET /api/verse/runs-history/lane-streaks', () => {
  it('answers the pinned shape with the burning lane first at minutes=60', async () => {
    const result = await call('GET', `${PATH}?minutes=60`);
    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ v: 1, source: 'ok', windowMinutes: 60 });
    expect(Number.isFinite(Date.parse(result.json!.generatedAt as string))).toBe(true);
    expect(result.json!.lanes).toEqual([
      expect.objectContaining({
        lane: 'claude-api', verdict: 'burning', launches: 3, ended: 3,
        empties: 3, published: 0, running: 0, lastEmptyJob: 'RQ-RT3A103123Q8',
      }),
    ]);
  });

  it('defaults minutes to 90 and rejects other query keys', async () => {
    const result = await call('GET');
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ windowMinutes: 90 });
    for (const url of [`${PATH}?minutes=5`, `${PATH}?minutes=abc`, `${PATH}?minutes=1441`, `${PATH}?hours=2`]) {
      const bad = await call('GET', url);
      expect(bad.status).toBe(400);
      expect(bad.json).toMatchObject({ code: 'VERSE_INVALID' });
    }
  });

  it('answers 405 on other methods and false on other paths', async () => {
    expect((await call('POST')).status).toBe(405);
    expect((await call('GET', VERSE_RUNS_HISTORY_PATH)).handled).toBe(true);
    expect((await call('GET', '/api/verse/runs-history/other')).handled).toBe(false);
  });

  it('answers 200 unavailable on a null or throwing read', async () => {
    for (const readDispatchEvents of [async () => null, async () => { throw new Error('gone'); }]) {
      const result = await call('GET', `${PATH}?minutes=60`, deps({ readDispatchEvents }));
      expect(result.status).toBe(200);
      expect(result.json).toMatchObject({ v: 1, source: 'unavailable', windowMinutes: 60, lanes: [] });
    }
  });
});

describe('ashlr fleet lane-streaks', () => {
  const run = async (args: string[], readDispatchEvents: () => Promise<string | null>) => {
    const lines: string[] = [];
    const code = await cmdFleetLaneStreaks(args, {
      readDispatchEvents,
      now: () => NOV01_NOW,
      out: (line) => lines.push(line),
    });
    return { code, lines };
  };

  it('--json prints the pinned shape and exits 2 while a lane burns', async () => {
    const { code, lines } = await run(['--json'], async () => NOV01);
    expect(code).toBe(2);
    expect(lines).toHaveLength(1);
    const report = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(report).toMatchObject({ v: 1, source: 'ok', windowMinutes: 90, malformedLines: 0 });
    expect(report.lanes).toEqual([
      expect.objectContaining({ lane: 'claude-api', verdict: 'burning', launches: 3, empties: 3, published: 0 }),
    ]);
  });

  it('prints one line per lane in text mode', async () => {
    const { code, lines } = await run([], async () => NOV01);
    expect(code).toBe(2);
    expect(lines).toEqual([
      'claude-api  burning  3 launches, 3 empty, 0 published, median 10 min, last RQ-PS10A103123Q8 05:56',
    ]);
  });

  it('exits 0 when nothing is burning and on an unavailable log', async () => {
    const ok = await run(['--json'], async () => '2026-11-01 05:50:00 LAUNCH RQ-OK1A103123Q8 phantom devin high\n');
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.lines[0]!) as { lanes: unknown[] }).toMatchObject({
      lanes: [expect.objectContaining({ lane: 'devin', verdict: 'ok', running: 1 })],
    });
    const unavailable = await run([], async () => null);
    expect(unavailable.code).toBe(0);
    expect(unavailable.lines).toEqual(['lane-streaks: dispatch events unavailable']);
  });

  it('exits 1 on a bad flag or value and 0 on --help', async () => {
    for (const args of [['--bogus'], ['--minutes'], ['--minutes', '5'], ['--minutes', 'abc']]) {
      expect((await run(args, async () => NOV01)).code).toBe(1);
    }
    const help = await run(['--help'], async () => { throw new Error('must not read'); });
    expect(help.code).toBe(0);
    expect(help.lines[0]).toContain('lane-streaks');
  });

  it('honors --minutes N', async () => {
    const { lines } = await run(['--json', '--minutes', '15'], async () => NOV01);
    const report = JSON.parse(lines[0]!) as { windowMinutes: number };
    expect(report.windowMinutes).toBe(15);
  });
});
