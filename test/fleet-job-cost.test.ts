/**
 * RQ-APPCOST-11-JOBBREAKDOWN — fleet.job.cost.v1 per-call cost projection.
 *
 * Contract:
 *   - calls come only from metrics/api-spend.jsonl rows naming the job
 *     (job/job_id/id); rows for other jobs are never counted.
 *   - every field is real or null ('unknown'): no fabricated tokens or costs.
 *   - jobs.jsonl finish rows contribute worker-reported tokens_total.
 *   - sources degrade independently; malformed lines mark their own ledger
 *     'degraded' while valid rows still parse.
 *   - bounded no-follow reads: a symlinked ledger degrades, never follows.
 *   - `phm job cost <id> [--json]` prints the same projection; GET
 *     /api/fleet/job/cost?id=<J> serves it on the loopback server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';

import { getFleetJobCost, type FleetJobCostV1 } from '../src/core/fleet/runs-job-cost.js';
import { cmdJob } from '../src/cli/job.js';
import { makeCfg } from './helpers/h1-fixture.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

const ANCHOR = new Date('2026-11-02T12:00:00Z');
const opts = (runsDir: string) => ({ runsDir, now: () => ANCHOR }) as const;

let scratch: string;
let openHandles: Array<{ close(): Promise<void> }>;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'runs-job-cost-'));
  openHandles = [];
});

afterEach(async () => {
  for (const h of openHandles) {
    try { await h.close(); } catch { /* ignore */ }
  }
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

async function runsDir(files: Record<string, string>): Promise<string> {
  const dir = join(scratch, `runs-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(dir, 'metrics'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, 'metrics', name), content);
  }
  return dir;
}

const SPEND = [
  { ts: '2026-11-02T08:00:00Z', job: 'RQ-COST-1', lane: 'claude-api', model: 'claude-test-a', input_tokens: 100, output_tokens: 20, is_error: false, cost_usd: 1.25 },
  { ts: '2026-11-02T09:00:00Z', job: 'RQ-COST-1', model: 'claude-test-b', input_tokens: 30, output_tokens: 5, is_error: true, cost_estimated: true },
  { ts: '2026-11-02T10:00:00Z', job: 'RQ-OTHER-9', model: 'claude-test-a', input_tokens: 7, output_tokens: 3, usd: 0.5 },
  { ts: '2026-11-02T11:00:00Z', model: 'claude-test-a', cost: 0.25 },
].map(row => JSON.stringify(row)).join('\n') + '\n';

// ---------------------------------------------------------------------------
// getFleetJobCost — argument guards
// ---------------------------------------------------------------------------

describe('getFleetJobCost guards', () => {
  it('rejects a bad id and a relative runsDir', async () => {
    await expect(getFleetJobCost('../etc', { runsDir: scratch })).rejects.toThrow('invalid fleet job id');
    await expect(getFleetJobCost('JOB1', { runsDir: 'relative/dir' })).rejects.toThrow('absolute path');
  });
});

// ---------------------------------------------------------------------------
// getFleetJobCost — projection
// ---------------------------------------------------------------------------

describe('getFleetJobCost', () => {
  it('returns per-call rows for the job only, with real numbers or null', async () => {
    const dir = await runsDir({ 'api-spend.jsonl': SPEND });
    const cost = await getFleetJobCost('RQ-COST-1', opts(dir));
    expect(cost.schema).toBe('fleet.job.cost.v1');
    expect(cost.generatedAt).toBe(ANCHOR.toISOString());
    expect(cost.calls).toHaveLength(2);
    expect(cost.calls[0]).toEqual({
      at: '2026-11-02T08:00:00Z', model: 'claude-test-a', lane: 'claude-api',
      inputTokens: 100, outputTokens: 20, costUsd: 1.25, estimated: false, error: false,
    });
    expect(cost.calls[1]).toMatchObject({ model: 'claude-test-b', inputTokens: 30, costUsd: null, estimated: true, error: true });
    expect(cost.totals).toEqual({
      calls: 2, errors: 1, inputTokens: 130, outputTokens: 25, costUsd: 1.25,
      reported: { inputTokens: 2, outputTokens: 2, costUsd: 1 },
    });
    expect(cost.sources.apiSpend).toBe('healthy');
    expect(cost.sources.jobs).toBe('missing');
    expect(cost.truncated).toBe(false);
  });

  it('accepts job_id/id aliases and at/timestamp, usd/cost, camel token fields', async () => {
    const rows = [
      { at: '2026-11-02T08:00:00Z', job_id: 'RQ-COST-2', model: 'm-1', inputTokens: 4, outputTokens: 2, usd: 0.01 },
      { timestamp: '2026-11-02T09:00:00Z', id: 'RQ-COST-2', model: 'm-2', input_tokens: 8, output_tokens: 6, cost: 0.02 },
    ].map(row => JSON.stringify(row)).join('\n') + '\n';
    const dir = await runsDir({ 'api-spend.jsonl': rows });
    const cost = await getFleetJobCost('RQ-COST-2', opts(dir));
    expect(cost.calls.map(call => call.model)).toEqual(['m-1', 'm-2']);
    expect(cost.totals).toMatchObject({ calls: 2, inputTokens: 12, outputTokens: 8, costUsd: 0.03 });
  });

  it('orders calls by timestamp and leaves null timestamps last', async () => {
    const rows = [
      { job: 'RQ-COST-3', model: 'late', ts: '2026-11-02T09:00:00Z' },
      { job: 'RQ-COST-3', model: 'no-time' },
      { job: 'RQ-COST-3', model: 'early', ts: '2026-11-02T07:00:00Z' },
    ].map(row => JSON.stringify(row)).join('\n') + '\n';
    const dir = await runsDir({ 'api-spend.jsonl': rows });
    const cost = await getFleetJobCost('RQ-COST-3', opts(dir));
    expect(cost.calls.map(call => call.model)).toEqual(['early', 'late', 'no-time']);
    expect(cost.totals.inputTokens).toBeNull();
    expect(cost.totals.costUsd).toBeNull();
  });

  it('drops control bytes and unsafe labels from row fields', async () => {
    const rows = [
      { ts: '2026-11-02T08:00:00Z', job: 'RQ-COST-4', model: 'sk-ant-' + 'a'.repeat(40), input_tokens: 1 },
      { ts: '2026-11-02T08:01:00Z', job: 'RQ-COST-4', model: 'bad model name', input_tokens: 2 },
    ].map(row => JSON.stringify(row)).join('\n') + '\n';
    const dir = await runsDir({ 'api-spend.jsonl': rows });
    const cost = await getFleetJobCost('RQ-COST-4', opts(dir));
    expect(cost.calls.map(call => call.model)).toEqual([null, null]);
    expect(cost.totals.inputTokens).toBe(3);
  });

  it('marks a ledger with malformed lines degraded but still parses valid rows', async () => {
    const dir = await runsDir({
      'api-spend.jsonl': `not-json\n${JSON.stringify({ ts: '2026-11-02T08:00:00Z', job: 'RQ-COST-5', input_tokens: 3 })}\n`,
    });
    const cost = await getFleetJobCost('RQ-COST-5', opts(dir));
    expect(cost.sources.apiSpend).toBe('degraded');
    expect(cost.calls).toHaveLength(1);
    expect(cost.totals.inputTokens).toBe(3);
  });

  it('degrades a symlinked ledger instead of following it', async () => {
    const dir = join(scratch, 'runs-symlink');
    await mkdir(join(dir, 'metrics'), { recursive: true });
    const outside = join(scratch, 'outside.jsonl');
    await writeFile(outside, JSON.stringify({ job: 'RQ-COST-6', input_tokens: 9 }) + '\n');
    await symlink(outside, join(dir, 'metrics', 'api-spend.jsonl'));
    const cost = await getFleetJobCost('RQ-COST-6', opts(dir));
    expect(cost.sources.apiSpend).toBe('degraded');
    expect(cost.calls).toHaveLength(0);
  });

  it('sums worker-reported tokens_total from finish events in jobs.jsonl', async () => {
    const dir = await runsDir({
      'jobs.jsonl': [
        { event: 'launch', job_id: 'RQ-COST-7', ts: '2026-11-02T08:00:00Z' },
        { event: 'finish', job_id: 'RQ-COST-7', ts: '2026-11-02T09:00:00Z', tokens_total: 182000 },
        { event: 'finish', job_id: 'RQ-COST-7', ts: '2026-11-02T09:30:00Z', tokens_total: 55 },
        { event: 'finish', job_id: 'RQ-OTHER', ts: '2026-11-02T09:00:00Z', tokens_total: 7 },
      ].map(row => JSON.stringify(row)).join('\n') + '\n',
    });
    const cost = await getFleetJobCost('RQ-COST-7', opts(dir));
    expect(cost.jobTotals).toEqual({ finishes: 2, tokensTotal: 182055 });
    expect(cost.sources.jobs).toBe('healthy');
  });

  it('marks the projection truncated when a ledger exceeds the read window', async () => {
    const dir = await runsDir({
      'api-spend.jsonl': 'x'.repeat(2048) + '\n' + JSON.stringify({ ts: '2026-11-02T08:00:00Z', job: 'RQ-COST-8', input_tokens: 1 }) + '\n',
    });
    const cost = await getFleetJobCost('RQ-COST-8', { ...opts(dir), maxBytes: 256 });
    expect(cost.truncated).toBe(true);
    expect(cost.calls).toHaveLength(1);
  });

  it('reports a well-formed id over empty ledgers as unknown, not an error', async () => {
    const dir = await runsDir({});
    const cost = await getFleetJobCost('RQ-NOTHING', opts(dir));
    expect(cost.calls).toEqual([]);
    expect(cost.totals).toMatchObject({ calls: 0, inputTokens: null, costUsd: null });
    expect(cost.jobTotals).toEqual({ finishes: 0, tokensTotal: null });
    expect(cost.sources).toEqual({ apiSpend: 'missing', jobs: 'missing' });
  });
});

// ---------------------------------------------------------------------------
// phm job cost — CLI surface
// ---------------------------------------------------------------------------

describe('cmdJob', () => {
  it('prints the JSON projection with --json and human lines without', async () => {
    const dir = await runsDir({ 'api-spend.jsonl': SPEND });
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdJob(['cost', 'RQ-COST-1', '--runs-dir', dir, '--json'])).toBe(0);
    const parsed = JSON.parse(String(out.mock.calls[0]![0])) as FleetJobCostV1;
    expect(parsed.schema).toBe('fleet.job.cost.v1');
    expect(parsed.calls).toHaveLength(2);
    expect(parsed.totals.costUsd).toBe(1.25);

    out.mockClear();
    expect(await cmdJob(['cost', 'RQ-COST-1', '--runs-dir', dir])).toBe(0);
    const text = String(out.mock.calls[0]![0]);
    expect(text).toContain('Job RQ-COST-1: 2 calls, 130 in / 25 out, cost $1.2500 (priced 1/2)');
    expect(text).toContain('claude-test-a  100→20  $1.2500');
    expect(text).toContain('claude-test-b  30→5  unknown (estimated) [error]');
  });

  it('says unknown rather than fabricating numbers', async () => {
    const dir = await runsDir({ 'api-spend.jsonl': JSON.stringify({ job: 'RQ-COST-9', model: 'm' }) + '\n' });
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdJob(['cost', 'RQ-COST-9', '--runs-dir', dir])).toBe(0);
    const text = String(out.mock.calls[0]![0]);
    expect(text).toContain('unknown in / unknown out, cost unknown');
    expect(text).toContain('unknown→unknown  unknown');
  });

  it('reports no evidence for an unseen job and exits 0', async () => {
    const dir = await runsDir({});
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdJob(['cost', 'RQ-COST-0', '--runs-dir', dir])).toBe(0);
    expect(String(out.mock.calls[0]![0])).toContain('No cost evidence recorded for this job.');
  });

  it('refuses bad usage with exit 2 and help with 0', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const args of [
      ['cost'], ['cost', 'bad id'], ['cost', '../etc'], ['cost', 'JOB1', 'JOB2'],
      ['cost', 'JOB1', '--bogus'], ['cost', 'JOB1', '--json', '--json'],
      ['cost', 'JOB1', '--runs-dir', 'relative'], ['cost', 'JOB1', '--runs-dir'],
      ['peek', 'JOB1'],
    ] as string[][]) {
      expect(await cmdJob(args)).toBe(2);
    }
    expect(await cmdJob([])).toBe(0);
    expect(await cmdJob(['--help'])).toBe(0);
    expect(await cmdJob(['cost', '--help'])).toBe(0);
    expect(err).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/fleet/job/cost — loopback route serves the same projection.
// ---------------------------------------------------------------------------

describe('GET /api/fleet/job/cost', () => {
  function get(url: string, port: number): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolvePromise, reject) => {
      const parsed = new URL(url);
      const req = http.request(
        {
          hostname: parsed.hostname, port, path: parsed.pathname + parsed.search,
          method: 'GET', headers: { Host: `127.0.0.1:${port}`, ...readAuthHeaders(port) },
        },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => { data += c.toString(); });
          res.on('end', () => resolvePromise({ statusCode: res.statusCode ?? 0, body: data }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('serves fleet.job.cost.v1 on the loopback server and 400s on a bad id', async () => {
    const runs = join(homedir(), '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await writeFile(join(runs, 'metrics', 'api-spend.jsonl'), SPEND);

    const h = await startServer(makeCfg(), { port: 0, open: false, allowDispatch: false });
    openHandles.push(h);

    const res = await get(`${h.url}/api/fleet/job/cost?id=RQ-COST-1`, h.port);
    expect(res.statusCode).toBe(200);
    const cost = JSON.parse(res.body) as FleetJobCostV1;
    expect(cost.schema).toBe('fleet.job.cost.v1');
    expect(cost.job).toBe('RQ-COST-1');
    expect(cost.calls).toHaveLength(2);
    expect(cost.totals.costUsd).toBe(1.25);

    expect((await get(`${h.url}/api/fleet/job/cost`, h.port)).statusCode).toBe(400);
    expect((await get(`${h.url}/api/fleet/job/cost?id=${encodeURIComponent('../etc')}`, h.port)).statusCode).toBe(400);
    const empty = JSON.parse((await get(`${h.url}/api/fleet/job/cost?id=NOJOBHERE`, h.port)).body) as FleetJobCostV1;
    expect(empty.calls).toEqual([]);
  });
});
