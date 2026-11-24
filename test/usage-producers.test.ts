import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cmdUsageProducers } from '../src/cli/usage-producers.js';
import { createFleetUsageProducersApi } from '../src/core/verse/fleet-usage-producers-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { buildUsageProducers, usageProducersHours, usageProducersText, type LoopRecord } from '../src/core/fleet/usage-producers.js';

const NOW = Date.parse('2026-11-18T20:00:00Z');
const ago = (minutes: number) => NOW - minutes * 60_000;
const iso = (minutes: number) => new Date(ago(minutes)).toISOString();
const pr = (n: number) => `https://github.com/ashlrai/phantom/pull/${n}`;
const row = (event: string, minutes: number, extra: Record<string, unknown>) => JSON.stringify({ event, ts: iso(minutes), ...extra });
// Loop logs are written with `date`, so the clock reads back in local time.
const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (minutes: number) => { const d = new Date(ago(minutes)); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const start = (job: string, minutes: number, model: string) => `${stamp(minutes)} start ${job} repo=phantom model=${model} base=abc123`;
const publish = (job: string, minutes: number, n: number) => `${stamp(minutes)} publish ${job} repo=phantom RESULT PR ${pr(n)}`;

const LEDGER = [
  row('launch', 300, { job: 'RQ-A1', lane: 'zai', model: 'glm' }),
  row('launch', 200, { job: 'RQ-A2', lane: 'zai', model: 'glm' }),
  row('launch', 100, { job: 'RQ-B1', lane: 'claude', model: 'sonnet' }),
  row('finish', 90, { job: 'RQ-B1', wall_s: 600 }),
  row('publish', 90, { job: 'RQ-B1', url: pr(1) }),
  row('outcome', 20, { url: pr(1), state: 'MERGED' }),
  row('outcome', 20, { url: pr(2), state: 'OPEN' }),
  // Too old for a six hour window.
  row('launch', 3000, { job: 'RQ-OLD', lane: 'codex', model: 'gpt' }),
].join('\n');

const DESK: LoopRecord = { name: 'claude-desk', hasLedger: true, log: [
  start('RQ-CL-DESK-1', 180, 'sonnet'), publish('RQ-CL-DESK-1', 170, 2),
  start('RQ-CL-DESK-2', 60, 'sonnet'), start('RQ-CL-DESK-3', 30, 'opus'),
].join('\n') };
const DOCS: LoopRecord = { name: 'claude-docs', hasLedger: true, log: [start('RQ-CL-DOCS-1', 45, 'haiku'), publish('RQ-CL-DOCS-1', 40, 3)].join('\n') };

const build = (ledger: string | null, loops: LoopRecord[] = [], hours = 6) => buildUsageProducers({ ledger, loops, now: NOW, hours });
const find = (report: ReturnType<typeof build>, name: string) => report.producers.find(p => p.producer === name);

describe('buildUsageProducers', () => {
  it('lists dispatcher lanes and each outside loop separately with job and PR counts', () => {
    const report = build(LEDGER, [DESK, DOCS]);
    expect(report.schema).toBe('fleet.usage-producers.v1');
    expect(report.producers.map(p => [p.producer, p.kind, p.jobs_started])).toEqual([
      ['claude-desk', 'loop', 3], ['zai', 'dispatcher-lane', 2], ['claude', 'dispatcher-lane', 1], ['claude-docs', 'loop', 1],
    ]);
    expect(find(report, 'claude-desk')).toMatchObject({ models: ['opus', 'sonnet'], wall_minutes: 10, prs_published: 1, prs_merged: 0 });
    expect(find(report, 'claude-docs')).toMatchObject({ models: ['haiku'], wall_minutes: 5, prs_published: 1, prs_merged: 0 });
    expect(find(report, 'claude')).toMatchObject({ models: ['sonnet'], wall_minutes: 10, prs_published: 1, prs_merged: 1 });
    // The old codex launch is outside the window.
    expect(find(report, 'codex')).toBeUndefined();
  });

  it('says unknown, never 0, where no record says', () => {
    const report = build(LEDGER, [DESK, DOCS]);
    // No finish row for either zai job, and the lane's rows name no PR outcome of its own.
    expect(find(report, 'zai')).toMatchObject({ jobs_started: 2, models: ['glm'], wall_minutes: 'unknown', prs_published: 0 });
    // Without any outcome row at all, merged is unknown for every producer.
    const bare = build([row('launch', 10, { job: 'RQ-X', lane: 'zai' }), row('publish', 5, { job: 'RQ-X', url: pr(9) })].join('\n'), [DESK]);
    expect(find(bare, 'zai')).toMatchObject({ models: 'unknown', wall_minutes: 'unknown', prs_published: 1, prs_merged: 'unknown' });
    expect(find(bare, 'claude-desk')?.prs_merged).toBe('unknown');
    // Without any publish row, a lane's PR count is unknown rather than 0.
    const noPublish = build(row('launch', 10, { job: 'RQ-X', lane: 'zai' }));
    expect(find(noPublish, 'zai')).toMatchObject({ prs_published: 'unknown', prs_merged: 'unknown' });
  });

  it('puts leader and unreadable loops under gaps, and an unreadable metrics file under dispatcher', () => {
    const report = build(LEDGER, [{ name: 'claude-lost', hasLedger: true, log: null }, { name: 'other', hasLedger: false, log: 'nothing here' }]);
    expect(report.gaps.map(g => g.producer)).toEqual(['claude-lost', 'leader']);
    expect(report.producers.some(p => p.producer === 'other')).toBe(false);
    const dead = build(null, [DESK]);
    expect(dead.metrics).toBe('unreadable');
    expect(dead.gaps[0]).toMatchObject({ producer: 'dispatcher' });
    expect(dead.producers.map(p => p.producer)).toEqual(['claude-desk']);
    // A lane named leader is a producer, not a gap.
    expect(build(row('launch', 10, { job: 'RQ-L', lane: 'leader' })).gaps).toEqual([]);
  });

  it('counts a loop that started nothing in the window as 0 jobs, from a readable log', () => {
    const report = build(LEDGER, [{ name: 'claude-desk2', hasLedger: true, log: start('RQ-CL-DESK2-1', 2000, 'sonnet') }]);
    expect(find(report, 'claude-desk2')).toMatchObject({ jobs_started: 0, models: 'unknown', prs_published: 0, wall_minutes: 'unknown' });
  });

  it('prints plain text with a table and the gaps', () => {
    const text = usageProducersText(build(LEDGER, [DESK])).join('\n');
    expect(text).toContain('claude-desk');
    expect(text).toContain('unknown');
    expect(text).toContain('leader: no per-pass record');
  });
});

describe('usageProducersHours', () => {
  it('reads minutes, hours and days, and refuses the rest', () => {
    expect(usageProducersHours()).toBe(6);
    expect(usageProducersHours('90m')).toBe(1.5);
    expect(usageProducersHours('2d')).toBe(48);
    expect(usageProducersHours('12')).toBe(12);
    for (const bad of ['0', '8d', 'abc', '-1h', '1.5h', '']) expect(usageProducersHours(bad), bad).toBeNull();
  });
});

describe('phm usage producers and the API on a runs dir', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'producers-'));
    await mkdir(join(dir, 'metrics'), { recursive: true });
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'), `${LEDGER}\n`);
    await writeFile(join(dir, 'claude-desk.log'), `${DESK.log}\n`);
    await writeFile(join(dir, 'claude-desk-ledger.tsv'), 'x\n');
    await writeFile(join(dir, 'claude-docs.log'), `${DOCS.log}\n`);
    await writeFile(join(dir, 'unrelated.log'), 'plain words\n');
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('prints JSON with both loops and the lanes, and the plain table without --json', async () => {
    const lines: string[] = [];
    const code = await cmdUsageProducers(['--json', '--runs-dir', dir, '--since', '6h'], { now: () => NOW, out: l => lines.push(l) });
    expect(code).toBe(0);
    const report = JSON.parse(lines[0]!);
    expect(report.producers.map((p: { producer: string }) => p.producer).sort()).toEqual(['claude', 'claude-desk', 'claude-docs', 'zai']);
    const text: string[] = [];
    expect(await cmdUsageProducers(['--runs-dir', dir], { now: () => NOW, out: l => text.push(l) })).toBe(0);
    expect(text.join('\n')).toContain('claude-docs');
  });

  it('exits 1 when the metrics file is missing and 2 on a bad option', async () => {
    const quiet = { now: () => NOW, out: () => {}, err: () => {} };
    expect(await cmdUsageProducers(['--runs-dir', join(dir, 'nowhere')], quiet)).toBe(1);
    expect(await cmdUsageProducers(['--since', 'soon'], quiet)).toBe(2);
    expect(await cmdUsageProducers(['--bogus'], quiet)).toBe(2);
  });

  it('serves the same report on GET /api/verse/fleet/usage/producers', async () => {
    const handler = createFleetUsageProducersApi({ runsDir: dir, now: () => NOW });
    const call = async (path: string, method = 'GET') => {
      let status = 0, body = '';
      const res = { statusCode: 0, setHeader() {}, writeHead(code: number) { status = code; return this; }, end(chunk?: string) { body = chunk ?? ''; } } as unknown as ServerResponse;
      const req = Object.assign(Readable.from([]), { url: path, method, headers: {} }) as unknown as IncomingMessage;
      const handled = await handler({} as VerseApiContext, req, res, path.split('?')[0]!, method);
      return { handled, status: status || res.statusCode, body };
    };
    const ok = await call('/api/verse/fleet/usage/producers?since=6h');
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).producers.map((p: { producer: string }) => p.producer)).toContain('claude-docs');
    expect((await call('/api/verse/fleet/usage/producers?since=soon')).status).toBe(400);
    expect((await call('/api/verse/fleet/usage/producers', 'POST')).status).toBe(405);
    expect((await call('/api/verse/fleet/usage/other')).handled).toBe(false);
  });
});
