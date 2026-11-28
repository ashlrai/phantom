import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { cmdFleetLaunches } from '../src/cli/fleet-launches.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

it('agrees across the CLI and API for retries, merges, missing and empty metrics', async () => {
  const runs = await mkdtemp(join(tmpdir(), 'launch-contract-'));
  const now = Date.parse('2026-11-22T12:00:00Z');
  const path = '/api/verse/fleet/runs/launches';
  const read = async () => {
    const output: string[] = [];
    const code = await cmdFleetLaunches(['--runs-dir', runs, '--json'], { now: () => now, out: line => output.push(line), err: () => {} });
    const cli = JSON.parse(output.join('\n'));
    const api = createFleetRunsApi({ runsDir: runs, now: () => now });
    const req = Readable.from([]) as unknown as IncomingMessage;
    req.url = path; req.method = 'GET'; req.headers = {};
    let body: unknown, status = 0;
    const res = { headersSent: false, writeHead(value: number) { status = value; }, end(text: string) { body = JSON.parse(text); } } as unknown as ServerResponse;
    expect(await api({ cfg: {}, token: 'fake', allowDispatch: false } as VerseApiContext, req, res, path, 'GET')).toBe(true);
    expect(status).toBe(200);
    expect(body).toEqual(cli);
    return { code, report: cli };
  };
  try {
    const missing = await read();
    expect(missing.code).toBe(1);
    expect(missing.report).toMatchObject({ metrics: 'unreadable', starts: null, relaunches: {}, repeat_jobs: [] });
    await mkdir(join(runs, 'metrics'));
    const file = join(runs, 'metrics', 'jobs.jsonl');
    await writeFile(file, '');
    const empty = await read();
    expect(empty.code).toBe(0);
    expect(empty.report).toMatchObject({ metrics: 'ok', starts: 0, relaunches: {}, repeat_jobs: [] });
    const row = (event: string, minutes: number, extra: object) => JSON.stringify({ event, ts: new Date(now - minutes * 60_000).toISOString(), ...extra });
    const url = 'https://github.com/example/example/pull/1';
    await writeFile(file, [
      row('launch', 90, { job: 'fake-retry', lane: 'alpha' }),
      row('launch', 80, { job: 'fake-retry', lane: 'beta' }),
      row('launch', 70, { job: 'fake-retry', lane: 'beta' }),
      row('launch', 60, { job: 'fake-merged', lane: 'alpha' }),
      row('publish', 50, { job: 'fake-merged', url }),
      row('outcome', 40, { job: 'fake-merged', url, state: 'MERGED' }),
      row('outcome', 30, { job: 'fake-merged', url, state: 'MERGED' }),
    ].join('\n'));
    const { code, report } = await read();
    expect(code).toBe(0);
    expect(report.starts).toBe(4);
    expect(report.relaunches['fake-retry'].launches).toBe(3);
    expect(report.relaunches['fake-retry'].lanes).toEqual(['beta', 'alpha']);
    expect(report.repeat_jobs.map((job: { job: string }) => job.job)).toEqual(['fake-retry']);
    expect(report.relaunches['fake-merged'].merged).toBe(1);
    expect(report.lanes.find((lane: { lane: string }) => lane.lane === 'alpha')).toMatchObject({ starts_24h: 1, merged_24h: 1, starts_per_merged_pr: 1 });
    expect(report.lanes.find((lane: { lane: string }) => lane.lane === 'beta')).toMatchObject({ starts_24h: 3, merged_24h: 0, starts_per_merged_pr: null });
  } finally { await rm(runs, { recursive: true, force: true }); }
});
