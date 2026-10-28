import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDevinUsageReader, DEVIN_USAGE_TTL_MS, withDevinUsage } from '../src/core/fabric/readers/devin-usage.js';
import { DEVIN_USAGE_WORKER } from '../src/core/fabric/readers/devin-usage-worker.js';
import { scrubSecrets } from '../src/core/util/scrub.js';

const exec = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: exec }));

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const after = Date.parse('2026-10-01T08:00:00.000Z') / 1000;
const before = Date.parse('2026-11-01T08:00:00.000Z') / 1000;
const token = () => ['cog', '_', 'TEST', 'x'.repeat(32)].join('');
const pages = () => [
  { items: [{ after, before }], has_next_page: false },
  { items: [{ scope: 'org', org_id: 'org-TEST', cycle_acu_limit: 100 }], has_next_page: false },
  { total_acus: 40, consumption_by_date: [{ date: after, acus: 40, acus_by_product: { devin: 25, cascade: 15 } }] },
];

async function worker(options: { key?: string; org?: string; bodies?: unknown[]; status?: number; retry?: string; error?: Error } = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logs: unknown[] = [];
  const bodies = options.bodies ?? pages();
  const fetch = vi.fn(async () => {
    if (options.error) throw options.error;
    return { status: options.status ?? 200, headers: { get: () => options.retry ?? null }, text: async () => JSON.stringify(bodies.shift()) };
  });
  class Clock extends Date { static override now() { return NOW; } }
  await runInNewContext(DEVIN_USAGE_WORKER, {
    Date: Clock, AbortSignal, fetch,
    process: { env: { DEVIN_API_KEY: options.key ?? token(), DEVIN_ORG_ID: options.org ?? 'org-TEST' },
      stdout: { write: (s: string) => stdout.push(s) }, stderr: { write: (s: string) => stderr.push(s) } },
    console: { log: (...s: unknown[]) => logs.push(s), warn: (...s: unknown[]) => logs.push(s), error: (...s: unknown[]) => logs.push(s) },
  });
  return { value: JSON.parse(stdout.join('')), text: stdout.join(''), stderr, logs, fetch };
}

afterEach(() => vi.restoreAllMocks());

describe('custodied Devin usage worker', () => {
  it('reads the current cycle, matching organization limit and Devin product usage', async () => {
    const result = await worker();
    expect(result.value).toEqual({ pool: 'devin', acuUsed: 25, acuLimit: 100, pctUsed: 25,
      resetAt: '2026-11-01T08:00:00.000Z', source: 'devin-api-v3-org-cycle', fetchedAt: new Date(NOW).toISOString() });
    expect(result.fetch).toHaveBeenCalledTimes(3);
    const calls = result.fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[2]![0]).toBe(`https://api.devin.ai/v3/organizations/org-TEST/consumption/daily?time_after=${after}&time_before=${before}`);
    expect(calls.every(([, init]) => init.method === 'GET' && init.redirect === 'error' && init.signal instanceof AbortSignal)).toBe(true);
    expect(calls.every(([, init]) => (init.headers as Record<string, string>)['Authorization'] === `Bearer ${token()}`)).toBe(true);
  });
  it.each(['', 'phm_TEST'])('fails closed for an absent or unresolved key (%s)', async key => {
    const result = await worker({ key });
    expect(result.value).toEqual({ status: 'unknown', reason: 'missing-key' });
    expect(result.fetch).not.toHaveBeenCalled();
  });
  it('requires an organization without contacting the API', async () => {
    const result = await worker({ org: '' });
    expect(result.value.reason).toBe('missing-organization');
    expect(result.fetch).not.toHaveBeenCalled();
  });
  it.each([[401, 'unauthorized'], [403, 'forbidden'], [404, 'api-unavailable'], [500, 'api-unavailable']])('handles HTTP %s', async (status, reason) => {
    expect((await worker({ status: status as number })).value).toEqual({ status: 'unknown', reason });
  });
  it.each(['600', new Date(NOW + 600_000).toUTCString()])('honors Retry-After %s', async retry => {
    expect((await worker({ status: 429, retry })).value).toEqual({ status: 'unknown', reason: 'rate-limited', retryAt: NOW + 600_000 });
  });
  it('uses five minutes for invalid retry-after', async () => {
    expect((await worker({ status: 429, retry: 'invalid' })).value.retryAt).toBe(NOW + DEVIN_USAGE_TTL_MS);
  });
  it.each([null, {}, { items: 'bad' }, { items: [{ after: 1, before: 'bad' }] }])('rejects malformed cycles', async body => {
    expect((await worker({ bodies: [body] })).value.reason).toBe('malformed-body');
  });
  it('does not infer a reset from a historical cycle', async () => {
    expect((await worker({ bodies: [{ items: [{ after: 1, before: 2 }] }] })).value.reason).toBe('unknown-cycle');
  });
  it('does not borrow the limit of another organization', async () => {
    const bodies = pages(); bodies[1] = { items: [], has_next_page: false };
    expect((await worker({ bodies })).value.reason).toBe('unknown-limit');
  });
  it('requires a Devin product breakdown instead of treating total ACUs as Devin', async () => {
    const bodies: unknown[] = pages(); bodies[2] = { total_acus: 40, consumption_by_date: [{ date: after, acus: 40 }] };
    expect((await worker({ bodies })).value.reason).toBe('malformed-body');
  });
  it('handles zero limits without an infinite percentage', async () => {
    const bodies: unknown[] = pages(); bodies[1] = { items: [{ scope: 'org', org_id: 'org-TEST', cycle_acu_limit: 0 }] };
    expect((await worker({ bodies })).value.pctUsed).toBeNull();
  });
  it('follows pagination and rejects looping cursors', async () => {
    const bodies: unknown[] = pages();
    bodies.splice(0, 0, { items: [], has_next_page: true, end_cursor: 'next' });
    const result = await worker({ bodies });
    expect(result.value.acuUsed).toBe(25);
    expect(result.fetch).toHaveBeenCalledTimes(4);
    expect((await worker({ bodies: [
      { items: [], has_next_page: true, end_cursor: 'same' },
      { items: [], has_next_page: true, end_cursor: 'same' },
    ] })).value.reason).toBe('malformed-body');
  });
  it('never emits token-shaped strings from provider bodies or network errors', async () => {
    const secret = token();
    for (const options of [{ error: new Error(secret) }, { bodies: [{ items: secret }] }, { status: 401, bodies: [{ detail: secret }] }, {}]) {
      const result = await worker(options);
      const output = JSON.stringify([result.text, result.stderr, result.logs]);
      expect(output.includes(secret)).toBe(false);
      expect(scrubSecrets(output)).toBe(output);
      expect(result.stderr).toEqual([]);
      expect(result.logs).toEqual([]);
    }
  });
});

describe('Devin usage cache and fleet resource integration', () => {
  it('launches only through Phantom Secrets and captures subprocess diagnostics', async () => {
    const reading = (await worker()).text;
    exec.mockImplementationOnce((...args: unknown[]) => {
      const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
      callback(null, reading, token());
    });
    const log = vi.spyOn(console, 'log'); const warn = vi.spyOn(console, 'warn');
    const result = await createDevinUsageReader()();
    expect('pool' in result && result.pool).toBe('devin');
    const [command, args, options] = exec.mock.calls.at(-1)!;
    expect(command).toBe('phantom');
    expect(args.slice(0, 3)).toEqual(['exec', '--', process.execPath]);
    expect(args.slice(3)).toEqual(['-e', DEVIN_USAGE_WORKER]);
    expect(JSON.stringify(args).includes(token())).toBe(false);
    expect(options).toMatchObject({ timeout: 45_000, maxBuffer: 65536 });
    expect(options).not.toHaveProperty('stdio');
    expect(options).not.toHaveProperty('shell');
    expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
    exec.mockImplementationOnce((...args: unknown[]) => {
      const callback = args[3] as (error: Error, stdout: string, stderr: string) => void;
      callback(new Error(token()), token(), token());
    });
    expect(await createDevinUsageReader()()).toEqual({ status: 'unknown', reason: 'custody-unavailable' });
  });
  it('coalesces concurrent reads, caches five minutes and returns independent records', async () => {
    let time = NOW;
    const run = vi.fn(async () => (await worker()).text);
    const read = createDevinUsageReader({ run, now: () => time });
    const [a, b] = await Promise.all([read(), read()]);
    expect(a).toEqual(b); expect(a).not.toBe(b);
    time += DEVIN_USAGE_TTL_MS - 1; await read(); expect(run).toHaveBeenCalledTimes(1);
    time += 1; await read(); expect(run).toHaveBeenCalledTimes(2);
  });
  it('caches unknown states and respects backoff beyond five minutes', async () => {
    let time = NOW;
    const run = vi.fn(async () => JSON.stringify({ status: 'unknown', reason: 'rate-limited', retryAt: NOW + 600_000 }));
    const read = createDevinUsageReader({ run, now: () => time });
    expect(await read()).toEqual({ status: 'unknown', reason: 'rate-limited' });
    time += 599_999; await read(); expect(run).toHaveBeenCalledTimes(1);
    time += 1; await read(); expect(run).toHaveBeenCalledTimes(2);
  });
  it('discards subprocess errors and untrusted output without logging', async () => {
    const log = vi.spyOn(console, 'log'); const warn = vi.spyOn(console, 'warn'); const error = vi.spyOn(console, 'error');
    for (const run of [async () => { throw new Error(token()); }, async () => token(), async () => JSON.stringify({ status: 'unknown', reason: token() })]) {
      const result = await createDevinUsageReader({ run })();
      expect('status' in result && result.status).toBe('unknown');
      expect(JSON.stringify(result).includes(token())).toBe(false);
    }
    expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });
  it('merges Devin into the resource view while preserving other fields', async () => {
    const fleet = { resources: { codex: { pctUsed: 10 } }, generatedAt: 'TEST' };
    const reading = (await worker()).value;
    expect(await withDevinUsage(fleet, async () => reading)).toEqual({ ...fleet, resources: { ...fleet.resources, devin: reading } });
    expect(fleet.resources).not.toHaveProperty('devin');
    expect((await withDevinUsage({}, async () => { throw new Error(token()); })).resources.devin).toEqual({ status: 'unknown', reason: 'reader-unavailable' });
  });
});
